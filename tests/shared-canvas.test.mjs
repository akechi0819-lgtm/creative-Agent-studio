import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';

import { createCanvasRuntime } from '../src/canvas/runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('shared Canvas keeps multiple real projects and image bytes across bridge restart and MCP stdio', { timeout: 240_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-lite-shared-canvas-'));
  let runtime = createCanvasRuntime({ root });
  let browser;
  let context;
  let mcpClient;
  let mcpTransport;
  let mcpStderr = '';
  let generationRequests = 0;
  const productFailures = [];
  t.after(async () => {
    await mcpClient?.close().catch(() => {});
    await mcpTransport?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await runtime.stop().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });

  const firstInstance = await runtime.ensure();
  const secondRuntime = createCanvasRuntime({ root });
  const sameInstance = await secondRuntime.ensure();
  assert.equal(firstInstance.instanceId, sameInstance.instanceId, 'multiple runtime handles reuse the same local service');

  const openedFirst = await runtime.open({ browser: false, mode: 'new' });
  assert.equal(openedFirst.running, true);
  assert.ok(openedFirst.openUrl);
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  await allowLocalStudioOrigins(context, [firstInstance.webUrl, firstInstance.bridgeUrl]);
  context.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/__studio/image-proxy/')) generationRequests += 1;
  });

  const firstPage = await context.newPage();
  const firstPageDiagnostics = observePage(firstPage);
  await firstPage.goto(openedFirst.openUrl, { waitUntil: 'domcontentloaded' });
  const firstProjectId = await waitForProjectRoute(firstPage);
  const firstTarget = await waitForCanvasTarget(runtime, firstProjectId, 30_000, firstPageDiagnostics);

  await runtime.call('canvas_create_text_node', { text: '共享项目 A：本地文字' }, firstTarget);
  const pngDataUrl = await makeFixturePng(firstPage);
  const pngBytes = Buffer.from(pngDataUrl.split(',')[1], 'base64');
  assert.ok(pngBytes.length > 0);
  const firstImageId = 'shared-fixture-a';
  const secondImageId = 'shared-fixture-b';
  const importedFirst = await runtime.call('canvas_import_image', { nodeId: firstImageId, title: '测试 PNG A', dataUrl: pngDataUrl }, firstTarget);
  const importedSecond = await runtime.call('canvas_import_image', { nodeId: secondImageId, title: '测试 PNG B', dataUrl: pngDataUrl }, firstTarget);
  assert.equal(importedFirst.operation, 'import');
  assert.equal(importedSecond.operation, 'import');

  const cropped = await runtime.call('canvas_crop_image', {
    nodeId: firstImageId,
    crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
  }, firstTarget);
  assert.equal(cropped.images?.[0]?.width, 2);
  assert.equal(cropped.images?.[0]?.height, 2);
  const stitched = await runtime.call('canvas_stitch_images', {
    nodeIds: [firstImageId, secondImageId],
    direction: 'horizontal',
    gap: 2,
    background: '#ffffff',
  }, firstTarget);
  assert.equal(stitched.images?.[0]?.width, 10);
  assert.equal(stitched.images?.[0]?.height, 4);

  const openedSecond = await runtime.open({ browser: false, mode: 'new' });
  const secondPage = await context.newPage();
  await secondPage.goto(openedSecond.openUrl, { waitUntil: 'domcontentloaded' });
  const secondProjectId = await waitForProjectRoute(secondPage);
  assert.notEqual(secondProjectId, firstProjectId);
  const secondTarget = await waitForCanvasTarget(runtime, secondProjectId);
  await runtime.call('canvas_create_text_node', { text: '共享项目 B：本地文字' }, secondTarget);
  const importedSecondProject = await runtime.call('canvas_import_image', {
    nodeId: 'shared-fixture-project-b', title: '项目 B 测试 PNG', dataUrl: pngDataUrl,
  }, secondTarget);
  assert.equal(importedSecondProject.operation, 'import');

  const liveStatus = await runtime.status();
  assert.deepEqual(new Set(liveStatus.targets.filter((target) => target.hasCanvas).map((target) => target.projectId)), new Set([firstProjectId, secondProjectId]));
  const firstState = await runtime.call('canvas_get_state', {}, firstTarget);
  assert.ok(firstState.nodes.some((node) => node.metadata?.content === '共享项目 A：本地文字'));
  assert.ok(firstState.nodes.some((node) => node.id === cropped.images[0].nodeId));
  assert.ok(firstState.nodes.some((node) => node.id === stitched.images[0].nodeId));

  const historyLaunch = await runtime.open({ browser: false, mode: 'choose' });
  const historyPage = await context.newPage();
  await historyPage.goto(historyLaunch.openUrl, { waitUntil: 'domcontentloaded' });
  await waitUntil(async () => await historyPage.locator('article').count() === 2, { label: '两个历史项目卡片' });
  const firstTargetProjectList = await runtime.call('canvas_list_projects', { page: 1, pageSize: 50 }, firstTarget);

  await context.close();
  context = null;
  await browser.close();
  browser = null;
  await runtime.stop();
  assert.equal((await runtime.status()).running, false);

  runtime = createCanvasRuntime({ root });
  const reopenedInstance = await runtime.ensure();
  const reopenedFirst = await runtime.open({ browser: false, projectId: firstProjectId });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  await allowLocalStudioOrigins(context, [reopenedInstance.webUrl, reopenedInstance.bridgeUrl]);
  context.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/__studio/image-proxy/')) generationRequests += 1;
  });
  const restoredFirstPage = await context.newPage();
  await restoredFirstPage.goto(reopenedFirst.openUrl, { waitUntil: 'domcontentloaded' });
  const restoredFirstTarget = await waitForCanvasTarget(runtime, firstProjectId);
  const restoredFirstState = await runtime.call('canvas_get_state', {}, restoredFirstTarget);
  assert.ok(restoredFirstState.nodes.some((node) => node.metadata?.content === '共享项目 A：本地文字'));
  assert.ok(restoredFirstState.nodes.some((node) => node.id === cropped.images[0].nodeId));
  assert.ok(restoredFirstState.nodes.some((node) => node.id === stitched.images[0].nodeId));

  const restoredHistoryLaunch = await runtime.open({ browser: false, mode: 'choose' });
  const restoredHistoryPage = await context.newPage();
  const restoredHistoryDiagnostics = observePage(restoredHistoryPage);
  await restoredHistoryPage.goto(restoredHistoryLaunch.openUrl, { waitUntil: 'domcontentloaded' });
  await waitUntil(async () => await restoredHistoryPage.locator('article').count() === 2, { label: '重启后的两个历史项目卡片' });
  try {
    await waitUntil(async () => await restoredHistoryPage.locator('article img').count() >= 2, { timeoutMs: 5_000, label: '重启后的两个历史项目缩略图' });
  } catch (error) {
    productFailures.push(`${error.message}; browser=${JSON.stringify(restoredHistoryDiagnostics)}`);
  }
  const restoredThumbnailCount = await restoredHistoryPage.locator('article img').count();
  const createCanvasButton = restoredHistoryPage.locator('button').filter({ hasText: '新建画布' }).first();
  const importCanvasButton = restoredHistoryPage.locator('button').filter({ hasText: '导入画布' }).first();
  await waitUntil(async () => !(await createCanvasButton.isDisabled()) && !(await importCanvasButton.isDisabled()), {
    timeoutMs: 5_000,
    label: '历史页新建与导入按钮启用',
  });
  assert.equal(await createCanvasButton.isDisabled(), false, '历史页新建画布按钮恢复可用');
  assert.equal(await importCanvasButton.isDisabled(), false, '历史页导入画布按钮恢复可用');
  const screenshotPath = path.join(repoRoot, 'docs/evidence/company-lite/shared-history.png');
  await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
  await restoredHistoryPage.screenshot({ path: screenshotPath, fullPage: true });

  mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, 'scripts/canvas-mcp.mjs')],
    env: { STUDIO_DATA_DIR: root },
    stderr: 'pipe',
  });
  mcpTransport.stderr?.on('data', (chunk) => { mcpStderr = (mcpStderr + chunk.toString()).slice(-3000); });
  mcpClient = new Client({ name: 'shared-canvas-integration-test', version: '1.0.0' }, { capabilities: {} });
  await mcpStep('connect', () => mcpClient.connect(mcpTransport), () => mcpStderr);
  const listedTools = await mcpStep('tools/list', () => mcpClient.listTools(), () => mcpStderr);
  const listedNames = new Set(listedTools.tools.map((tool) => tool.name));
  for (const name of ['canvas_status', 'canvas_list_projects', 'canvas_read_image', 'canvas_save_image']) assert.ok(listedNames.has(name), `MCP tools/list includes ${name}`);

  const mcpStatus = parseMcpJson(await mcpStep('canvas_status', () => mcpClient.callTool({ name: 'canvas_status', arguments: {} }), () => mcpStderr));
  assert.equal(mcpStatus.running, true);
  assert.ok(mcpStatus.targets.some((target) => target.projectId === firstProjectId && target.hasCanvas));
  const mcpProjects = parseMcpJson(await mcpStep('canvas_list_projects', () => mcpClient.callTool({
    name: 'canvas_list_projects',
    arguments: { projectId: firstProjectId, clientId: restoredFirstTarget.clientId, page: 1, pageSize: 50 },
  }), () => mcpStderr));
  if (mcpProjects.total !== 2 || !sameMembers(mcpProjects.items.map((item) => item.id), [firstProjectId, secondProjectId])) {
    productFailures.push(`MCP canvas_list_projects returned ${mcpProjects.total} projects after reopen`);
  }

  const readImage = await mcpStep('canvas_read_image', () => mcpClient.callTool({
    name: 'canvas_read_image',
    arguments: { nodeId: firstImageId, projectId: firstProjectId, clientId: restoredFirstTarget.clientId },
  }), () => mcpStderr);
  const imageContent = readImage.content.find((item) => item.type === 'image');
  assert.ok(imageContent, 'canvas_read_image returns MCP image content');
  assert.equal(imageContent.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(imageContent.data, 'base64'), pngBytes);

  const exportedPath = path.join(root, 'exports', 'fixture-round-trip.png');
  const savedImage = parseMcpJson(await mcpStep('canvas_save_image', () => mcpClient.callTool({
    name: 'canvas_save_image',
    arguments: { nodeId: firstImageId, destination: exportedPath, projectId: firstProjectId, clientId: restoredFirstTarget.clientId },
  }), () => mcpStderr));
  assert.equal(savedImage.path, exportedPath);
  assert.deepEqual(await fs.readFile(exportedPath), pngBytes, 'canvas_save_image preserves the imported source bytes');

  const reopenedSecond = await runtime.open({ browser: false, projectId: secondProjectId });
  const restoredSecondPage = await context.newPage();
  await restoredSecondPage.goto(reopenedSecond.openUrl, { waitUntil: 'domcontentloaded' });
  const restoredSecondTarget = await waitForCanvasTarget(runtime, secondProjectId);
  const restoredSecondState = await runtime.call('canvas_get_state', {}, restoredSecondTarget);
  if (!restoredSecondState.nodes.some((node) => node.metadata?.content === '共享项目 B：本地文字')) productFailures.push('project B text node did not survive restart');
  if (!restoredSecondState.nodes.some((node) => node.id === 'shared-fixture-project-b')) productFailures.push('project B image node did not survive restart');
  if (firstTargetProjectList.total !== 2 || !sameMembers(firstTargetProjectList.items.map((item) => item.id), [firstProjectId, secondProjectId])) {
    productFailures.push(`canvas_list_projects from the older tab returned ${firstTargetProjectList.total} projects`);
  }
  if (restoredThumbnailCount < 2) productFailures.push(`history restored ${restoredThumbnailCount} image thumbnails, expected 2`);
  assert.equal(generationRequests, 0, 'the workflow never calls the image generation endpoint');
  assert.deepEqual(productFailures, []);
});

async function waitForProjectRoute(page) {
  await page.waitForFunction(() => /^\/canvas\/[A-Za-z0-9_-]+$/.test(location.pathname), { timeout: 30_000 });
  return decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1));
}

async function waitForCanvasTarget(runtime, projectId, timeoutMs = 30_000, pageDiagnostics = []) {
  let status;
  try {
    await waitUntil(async () => {
      status = await runtime.status();
      return status.targets.find((target) => target.projectId === projectId && target.hasCanvas);
    }, { timeoutMs, label: `项目 ${projectId} 的 Canvas 连接` });
  } catch (error) {
    status ||= await runtime.status();
    throw new Error(`${error.message}; healthTargets=${JSON.stringify(status.targets)}; browser=${JSON.stringify(pageDiagnostics)}`);
  }
  return status.targets.find((target) => target.projectId === projectId && target.hasCanvas);
}

async function waitUntil(predicate, { timeoutMs = 30_000, intervalMs = 100, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待${label}超时`);
}

async function makeFixturePng(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('fixture canvas context unavailable');
    context.fillStyle = '#e5484d';
    context.fillRect(0, 0, 2, 4);
    context.fillStyle = '#3498db';
    context.fillRect(2, 0, 2, 4);
    return canvas.toDataURL('image/png');
  });
}

function parseMcpJson(result) {
  assert.equal(result.isError, undefined);
  const text = result.content.find((item) => item.type === 'text')?.text;
  assert.ok(text);
  return JSON.parse(text);
}

function sameMembers(actual, expected) {
  return actual.length === expected.length && actual.every((item) => expected.includes(item));
}

async function mcpStep(name, action, getStderr) {
  try {
    return await action();
  } catch (error) {
    throw new Error(`MCP ${name} failed: ${error.message}; stderr=${getStderr()}`);
  }
}

function observePage(page) {
  const diagnostics = [];
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message.slice(0, 240)}`));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.push(`console: ${message.text().slice(0, 240)}`);
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/__studio/') && response.status() >= 400) {
      diagnostics.push(`${response.request().method()} ${url.pathname} HTTP ${response.status()}`);
    }
  });
  return diagnostics;
}

async function allowLocalStudioOrigins(context, values) {
  const origins = new Set(values.map((value) => new URL(value).origin));
  await context.route('**/*', async (route) => {
    const requestOrigin = new URL(route.request().url()).origin;
    if (origins.has(requestOrigin)) return route.continue();
    return route.abort();
  });
}
