import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

import { createCanvasRuntime } from '../src/canvas/runtime.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

test('Canvas exposes only image generation while keeping editable text prompt nodes', { timeout: 180_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-lite-image-only-'));
  const runtime = createCanvasRuntime({ root });
  let browser;
  let context;
  let generationRequests = 0;
  t.after(async () => {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await runtime.stop().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });

  const instance = await runtime.ensure();
  const launch = await runtime.open({ browser: false, mode: 'new' });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  await allowLocalStudioOrigins(context, [instance.webUrl, instance.bridgeUrl]);
  const page = await context.newPage();
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/__studio/image-proxy/')) generationRequests += 1;
  });
  await page.goto(launch.openUrl, { waitUntil: 'domcontentloaded' });
  const projectId = await waitForProjectRoute(page);
  const target = await waitForCanvasTarget(runtime, projectId);

  await runtime.call('canvas_create_text_node', { text: '一段可用于生图的文案提示词', x: 80, y: 100 }, target);
  await runtime.call('canvas_create_config_node', { prompt: '生成一张测试图片', x: 480, y: 100 }, target);
  const state = await runtime.call('canvas_get_state', {}, target);
  const textNode = state.nodes.find((node) => node.type === 'text');
  const configNode = state.nodes.find((node) => node.type === 'config');
  assert.ok(textNode, 'Canvas can create a text node');
  assert.ok(configNode, 'Canvas can create an image config node');

  const toolbar = page.locator('[data-canvas-bottom-toolbar]');
  await toolbar.getByRole('button', { name: '文本' }).waitFor({ state: 'visible' });
  assert.equal(await toolbar.getByRole('button', { name: '视频' }).count(), 0, 'toolbar does not expose video generation');
  assert.equal(await toolbar.getByRole('button', { name: '音频' }).count(), 0, 'toolbar does not expose audio generation');
  assert.equal(await toolbar.getByRole('button', { name: '图片' }).count(), 1);
  assert.equal(await toolbar.getByRole('button', { name: '生成配置' }).count(), 1);

  await page.locator(`[data-node-id="${configNode.id}"]`).click({ position: { x: 40, y: 40 } });
  const configPanel = page.locator('[data-canvas-config-node-panel]');
  await configPanel.waitFor({ state: 'visible' });
  assert.equal((await configPanel.locator('.canvas-config-mode').innerText()).trim(), '生图');
  assert.equal(await configPanel.locator('.ant-segmented').count(), 0, 'config panel has no generation-mode selector');
  assert.equal(await configPanel.locator('button').filter({ hasText: /视频|音频/ }).count(), 0, 'config panel does not offer video/audio generation settings');

  const screenshotPath = path.join(repoRoot, 'docs/evidence/company-lite/image-only-controls.png');
  await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  await page.locator(`[data-node-id="${textNode.id}"]`).click({ position: { x: 40, y: 40 } });
  const textPanel = page.locator('[data-canvas-node-prompt-panel="text"]');
  await textPanel.waitFor({ state: 'visible' });
  assert.equal(await textPanel.locator('[aria-label="生成"],[aria-label="Generate"],[aria-label="停止生成"]').count(), 0, 'text prompt panel has no text-generation action');
  assert.equal(await textPanel.locator('.canvas-composer-model-picker').count(), 0, 'text prompt panel does not expose a text model picker');
  await textPanel.locator('[role="textbox"][contenteditable="true"]').fill('改写后的图片提示词');
  await waitUntil(async () => {
    const next = await runtime.call('canvas_get_state', {}, target);
    return next.nodes.find((node) => node.id === textNode.id)?.metadata?.content === '改写后的图片提示词';
  }, 'text node prompt edits to persist');

  const canvas = page.locator('[data-canvas-viewport]');
  const canvasBox = await canvas.boundingBox();
  assert.ok(canvasBox);
  await page.mouse.dblclick(canvasBox.x + canvasBox.width - 60, canvasBox.y + 80);
  const createMenu = page.locator('[data-node-create-menu]');
  await createMenu.waitFor({ state: 'visible' });
  const menuText = await createMenu.innerText();
  assert.match(menuText, /文本/);
  assert.match(menuText, /图片/);
  assert.match(menuText, /生成配置/);
  assert.doesNotMatch(menuText, /视频|音频/);

  assert.equal(generationRequests, 0, 'the UI regression never calls an image generation API');
});

async function waitForProjectRoute(page) {
  await page.waitForFunction(() => /^\/canvas\/[A-Za-z0-9_-]+$/.test(location.pathname), { timeout: 30_000 });
  return decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1));
}

async function waitForCanvasTarget(runtime, projectId, timeoutMs = 30_000) {
  let status;
  await waitUntil(async () => {
    status = await runtime.status();
    return status.targets.find((target) => target.projectId === projectId && target.hasCanvas);
  }, `项目 ${projectId} 的 Canvas 连接`, timeoutMs);
  return status.targets.find((target) => target.projectId === projectId && target.hasCanvas);
}

async function waitUntil(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待${label}超时`);
}

async function allowLocalStudioOrigins(context, values) {
  const origins = new Set(values.map((value) => new URL(value).origin));
  await context.route('**/*', async (route) => {
    const requestOrigin = new URL(route.request().url()).origin;
    if (origins.has(requestOrigin)) return route.continue();
    return route.abort();
  });
}
