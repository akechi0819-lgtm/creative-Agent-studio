import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { callCanvasTool, health } from '../src/canvas/client.mjs';
import { attachTaskFiles, createTask } from '../src/creative/tasks.mjs';
import { createCanvasManager } from '../src/web/canvas.mjs';
import { readConfig } from '../src/web/config.mjs';
import { listenStudioServer } from '../src/web/server.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-company-local-canvas-'));
const output = path.resolve('docs/evidence/company-local-canvas');
const previousDataDir = process.env.STUDIO_DATA_DIR;
const previousServicesFile = process.env.STUDIO_COMPANY_SERVICES_FILE;
const servicesFile = path.join(root, 'fixture-company-services.json');
const canvasIndex = new URL('../third_party/canvas/web/dist/index.html', import.meta.url);
const canvasAgent = new URL('../third_party/canvas/canvas-agent/dist/index.js', import.meta.url);
const fixtureImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64');
const imageSha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const contexts = [];
const pageErrors = [];
const unapprovedExternalRequests = [];
const promptCatalogRequests = [];
const companyServiceRequests = [];
const imageProxyRequests = [];
let browser;
let server;
let canvasInstance;

function isLoopback(hostname) {
  const value = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return value === 'localhost' || value === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(value);
}

function isAllowedPromptCatalogRequest(url, method) {
  return url.protocol === 'https:'
    && url.hostname === 'raw.githubusercontent.com'
    && /^\/yukkcat\/image-prompts\/main\/dist\/sources\/[^/]+\.json$/u.test(url.pathname)
    && !url.search
    && !url.hash
    && method === 'GET';
}

async function waitFor(predicate, message, timeoutMs = 30_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (cause) { lastError = cause; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${message}${lastError ? ` (${lastError.message})` : ''}`);
}

async function persistedCanvasProject(page, projectId) {
  return page.evaluate(async (targetProjectId) => {
    const keysResponse = await fetch('/__studio/storage/app_state', { cache: 'no-store' });
    if (!keysResponse.ok) return { status: keysResponse.status, projectIds: [], nodeIds: [] };
    const keys = await keysResponse.json();
    const key = keys.find((value) => value === 'infinite-canvas:canvas_store');
    if (!key) return { status: keysResponse.status, projectIds: [], nodeIds: [] };
    const stored = await fetch(`/__studio/storage/app_state/${encodeURIComponent(key)}`, { cache: 'no-store' });
    if (!stored.ok) return { status: stored.status, projectIds: [], nodeIds: [] };
    try {
      const state = JSON.parse(await stored.text()).state;
      const projects = Array.isArray(state?.projects) ? state.projects : [];
      return {
        status: stored.status,
        projectIds: projects.map((project) => project.id),
        nodeIds: projects.find((project) => project.id === targetProjectId)?.nodes?.map((node) => node.id) ?? [],
      };
    } catch { return { status: stored.status, projectIds: [], nodeIds: [] }; }
  }, projectId);
}

function observe(context) {
  context.on('request', (request) => {
    let url;
    try { url = new URL(request.url()); } catch { return; }
    if (url.hostname === 'library.fixture.test' || url.hostname === 'canvas.fixture.test') {
      companyServiceRequests.push(`${url.protocol}//${url.host}${url.pathname}`);
    }
    if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && !isLoopback(url.hostname)) {
      if (isAllowedPromptCatalogRequest(url, request.method())) promptCatalogRequests.push(url.pathname);
      else unapprovedExternalRequests.push(`${url.protocol}//${url.host}${url.pathname}`);
    }
    if (url.pathname.startsWith('/__studio/image-proxy/')) imageProxyRequests.push(url.pathname);
  });
}

async function createWorkbenchContext(url, taskId) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  contexts.push(context);
  observe(context);
  const page = await context.newPage();
  page.on('pageerror', (cause) => pageErrors.push(cause.message));
  await page.addInitScript((id) => {
    localStorage.setItem('studio.onboardingDismissed', '1');
    localStorage.setItem('studio.activeTask', id);
  }, taskId);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /打开 Canvas/ }).waitFor({ state: 'visible' });
  return { context, page };
}

async function openCanvasFromWorkbench(context, page, taskId) {
  const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/tasks/${taskId}/canvas/open`
    && response.request().method() === 'POST');
  const popupPromise = context.waitForEvent('page');
  await page.getByRole('button', { name: /打开 Canvas/ }).click();
  const [response, canvasPage] = await Promise.all([responsePromise, popupPromise]);
  canvasPage.on('pageerror', (cause) => pageErrors.push(cause.message));
  assert.equal(response.status(), 200);
  const opened = await response.json();
  const requestedUrl = new URL(opened.openUrl);
  assert.equal(requestedUrl.protocol, 'http:');
  assert.equal(requestedUrl.hostname, '127.0.0.1');
  assert.equal(requestedUrl.pathname, '/canvas');
  assert.equal(requestedUrl.searchParams.get('projectId'), taskId);
  assert.match(requestedUrl.hash, /^#studioBootstrap=[a-f0-9]{64}$/u);
  await canvasPage.waitForURL((url) => url.pathname === `/canvas/${taskId}` && !url.hash, { timeout: 20_000 });
  await canvasPage.locator('#root').waitFor({ state: 'attached' });
  await canvasPage.waitForFunction(async (targetProjectId) => {
    try {
      const sessionResponse = await fetch('/__studio/session');
      if (!sessionResponse.ok) return false;
      const session = await sessionResponse.json();
      return session.projectId === targetProjectId;
    } catch { return false; }
  }, taskId, { timeout: 30_000 });
  if (!canvasInstance) {
    const instanceFile = path.join(root, 'canvas', taskId, 'canvas-instance.json');
    canvasInstance = JSON.parse(await fs.readFile(instanceFile, 'utf8'));
    for (const endpoint of [canvasInstance.webUrl, canvasInstance.bridgeUrl]) {
      const localEndpoint = new URL(endpoint);
      assert.equal(localEndpoint.protocol, 'http:');
      assert.equal(localEndpoint.hostname, '127.0.0.1');
    }
  }
  await waitFor(async () => {
    const current = await health(canvasInstance);
    return current.targets?.some((target) => target.projectId === taskId && target.hasCanvas) ? current : null;
  }, '本机 Canvas 未连接到公司任务。');
  return { canvasPage, opened };
}

try {
  await Promise.all([fs.access(canvasIndex), fs.access(canvasAgent)]).catch(() => {
    throw new Error('本机 Canvas 尚未构建；请先构建 third_party/canvas/web 与 canvas-agent。');
  });
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(servicesFile, JSON.stringify({
    schemaVersion: 1,
    teedy: { baseUrl: 'https://library.fixture.test' },
  }));
  process.env.STUDIO_DATA_DIR = root;
  process.env.STUDIO_COMPANY_SERVICES_FILE = servicesFile;

  const getConfig = (options = {}) => readConfig({ ...options, root });
  const canvas = createCanvasManager({ root, readConfig: getConfig });
  const task = await createTask({ title: '公司本机 Canvas 隔离验证', brief: '导入并读回合成图片，不生成图片。' }, root);
  const imagePath = path.join(root, 'canvas-import-fixture.png');
  await fs.writeFile(imagePath, fixtureImage, { mode: 0o600 });
  const uploadedTask = await attachTaskFiles(task.id, {
    files: [{ path: imagePath, name: 'canvas-import-fixture.png', mimeType: 'image/png' }],
    title: '本机 Canvas 隔离样例',
    purpose: '只用于本机画布导入与持久化验证。',
  }, { root, expectedRevision: task.revision });
  const imageSource = uploadedTask.sources.at(-1);
  assert.ok(imageSource?.id);
  assert.equal(imageSource.files[0].sha256, imageSha256(fixtureImage));

  server = await listenStudioServer({ root, port: 0, canvas, readConfig: getConfig });
  const workbenchUrl = `http://127.0.0.1:${server.address.port}`;
  browser = await chromium.launch({ headless: true });
  const first = await createWorkbenchContext(workbenchUrl, task.id);
  const firstCanvas = await openCanvasFromWorkbench(first.context, first.page, task.id);

  const operationId = randomUUID();
  const imported = await canvas.mechanicalOperation(task.id, {
    operation: 'import',
    image: { sourceId: imageSource.id, fileOrder: 1 },
    expectedRevision: uploadedTask.revision,
    operationId,
    requestId: randomUUID(),
    callId: operationId,
    userText: '只把隔离测试图片导入当前任务 Canvas。',
  });
  assert.equal(imported.result.operation, 'import');
  const importedNodeId = imported.result.sourceNodeId;
  assert.match(importedNodeId, /^[0-9a-f-]{36}$/iu);

  const firstSnapshot = await callCanvasTool('canvas_get_state', {}, canvasInstance);
  assert.equal(firstSnapshot.projectId, task.id);
  assert.ok(firstSnapshot.nodes.some((node) => node.id === importedNodeId && node.type === 'image'));
  const firstImage = await callCanvasTool('canvas_read_image', { nodeId: importedNodeId }, canvasInstance);
  assert.equal(imageSha256(Buffer.from(firstImage.dataUrl.split(',')[1], 'base64')), imageSha256(fixtureImage));
  const persisted = await waitFor(async () => {
    const state = await persistedCanvasProject(firstCanvas.canvasPage, task.id);
    return state.status === 200 && state.nodeIds.includes(importedNodeId) ? state : null;
  }, 'Canvas 没有把任务项目和导入图片保存到隔离存储。', 15_000);
  assert.ok(persisted.projectIds.includes(task.id));

  await first.context.close();
  const idle = await waitFor(async () => {
    const current = await health(canvasInstance);
    return current.targets?.every((target) => !target.hasCanvas) ? current : null;
  }, '关闭首个浏览器上下文后 Canvas 客户端仍保持连接。', 15_000);
  assert.ok(idle.targets.every((target) => !target.hasCanvas));

  const second = await createWorkbenchContext(workbenchUrl, task.id);
  const secondCanvas = await openCanvasFromWorkbench(second.context, second.page, task.id);
  const restoredSnapshot = await callCanvasTool('canvas_get_state', {}, canvasInstance);
  assert.equal(restoredSnapshot.projectId, task.id);
  assert.ok(restoredSnapshot.nodes.some((node) => node.id === importedNodeId && node.type === 'image'));
  const restoredImage = await callCanvasTool('canvas_read_image', { nodeId: importedNodeId }, canvasInstance);
  assert.equal(imageSha256(Buffer.from(restoredImage.dataUrl.split(',')[1], 'base64')), imageSha256(fixtureImage));

  assert.deepEqual(unapprovedExternalRequests, [], 'the browser flow must not reach company services or unapproved external hosts');
  assert.deepEqual(companyServiceRequests, [], 'the company Canvas endpoint and Teedy fixture must not be contacted');
  assert.deepEqual(imageProxyRequests, [], 'opening and mechanically importing the Canvas must not call image generation');
  assert.deepEqual(pageErrors, []);
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({
    fixtureOnly: true,
    companyWorkbench: true,
    localCanvasPageOpened: true,
    taskScopedCanvasConnected: true,
    syntheticImageImportedAndRead: true,
    projectAndImageRestoredAfterNewBrowserContext: true,
    canvasTaskCommunicationLoopback: true,
    companyServiceRequests: companyServiceRequests.length,
    publicPromptCatalogRequests: promptCatalogRequests.length,
    imageGenerationRequests: imageProxyRequests.length,
    pageErrorCount: pageErrors.length,
  }, null, 2));
  console.log('公司工作台本机 Canvas 隔离回归通过：任务通信均走本机，合成图片导入与读取、关闭并重开后节点和图片字节恢复；未连接公司 Canvas 域名或发送生图请求。公开提示词目录 GET 单独记录。');
} finally {
  await Promise.all(contexts.map((context) => context.close().catch(() => {})));
  await browser?.close().catch(() => {});
  await server?.close();
  await fs.rm(root, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.STUDIO_DATA_DIR;
  else process.env.STUDIO_DATA_DIR = previousDataDir;
  if (previousServicesFile === undefined) delete process.env.STUDIO_COMPANY_SERVICES_FILE;
  else process.env.STUDIO_COMPANY_SERVICES_FILE = previousServicesFile;
}
