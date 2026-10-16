import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, '..');
const PNG_FIXTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=',
  'base64',
);
const imageSha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
if (rootIndex >= 0 && (!args[rootIndex + 1] || args[rootIndex + 1].startsWith('--'))) {
  throw new Error('--root 需要一个目录路径。');
}
const root = path.resolve(rootIndex >= 0 ? args[rootIndex + 1] : process.env.STUDIO_REPO_ROOT || defaultRoot);
const launcher = path.join(root, 'scripts', 'launcher.mjs');
await fs.access(launcher);
const { chromium } = createRequire(path.join(root, 'package.json'))('playwright');

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-studio-p4-browser-'));
const isolatedData = path.join(temporaryRoot, 'data');
const fixtureImagePath = path.join(temporaryRoot, 'p4-fixture.png');
const env = { ...process.env, STUDIO_DATA_DIR: isolatedData };
const browserErrors = [];
const allowedLoopbackOrigins = new Set();
const allowedLoopbackRequests = [];
const allowedPromptCatalogRequests = [];
const rejectedExternalRequests = [];
const canvasStorageWrites = new Set();
const contexts = [];
let browser;
let startAttempted = false;
let stopped = false;
let importedNodeId;
let canvasInstance;
let pluginInstance;

async function launcherCommand(command, options = {}) {
  try {
    const result = await execFileAsync(process.execPath, [launcher, ...command], {
      cwd: root,
      env,
      windowsHide: true,
      timeout: options.timeout ?? 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (cause) {
    const code = cause.code || cause.signal || 'unknown error';
    const diagnostic = [cause.stderr, cause.stdout]
      .filter((value) => typeof value === 'string' && value.trim())
      .join('\n')
      .slice(-4000);
    throw new Error(`launcher ${command[0]} failed (${code}).${diagnostic ? `\n${diagnostic}` : ''}`);
  }
}

function jsonFromOutput(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch { /* Ignore progress output and keep looking for the JSON result. */ }
  }
  throw new Error('launcher status did not return a JSON object.');
}

async function status() {
  return jsonFromOutput(await launcherCommand(['status'], { timeout: 10_000 }));
}

function requestEvidence(page, requestUrl, method) {
  const pageUrl = new URL(page.url());
  const targetUrl = new URL(requestUrl);
  return {
    pageUrl: `${pageUrl.origin}${pageUrl.pathname}`,
    requestUrl: `${targetUrl.origin}${targetUrl.pathname}`,
    method,
  };
}

function isAllowedPromptCatalogRequest(url, method) {
  return url.protocol === 'https:'
    && url.hostname === 'raw.githubusercontent.com'
    && /^\/yukkcat\/image-prompts\/main\/dist\/sources\/[^/]+\.json$/.test(url.pathname)
    && !url.search
    && !url.hash
    && method === 'GET';
}

function registerLoopbackOrigin(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), `Expected a loopback URL, got ${url.origin}`);
  allowedLoopbackOrigins.add(url.origin);
  return url.origin;
}

async function waitFor(predicate, description, timeoutMs = 30_000, delayMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`${description}${lastError ? ` (${lastError.message})` : ''}`);
}

async function browserJson(page, pathname, { method = 'GET', body } = {}) {
  return page.evaluate(async ({ requestPath, requestMethod, requestBody }) => {
    const response = await fetch(requestPath, {
      method: requestMethod,
      ...(requestBody === undefined ? {} : {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
      }),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    let payload;
    try { payload = await response.json(); }
    catch { payload = null; }
    return { status: response.status, payload };
  }, { requestPath: pathname, requestMethod: method, requestBody: body });
}

function observePage(page, origin) {
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('request', (request) => {
    let url;
    try { url = new URL(request.url()); } catch { return; }
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    if (url.origin === origin) return;
    const evidence = requestEvidence(page, request.url(), request.method());
    if (allowedLoopbackOrigins.has(url.origin)
        && url.protocol === 'http:'
        && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      allowedLoopbackRequests.push(evidence);
    } else if (isAllowedPromptCatalogRequest(url, request.method())) {
      allowedPromptCatalogRequests.push(evidence);
    } else {
      rejectedExternalRequests.push(evidence);
    }
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/__studio/storage/')
        && response.request().method() === 'PUT' && response.status() < 400) {
      canvasStorageWrites.add(url.pathname.split('/').filter(Boolean)[2] || '');
    }
  });
  return page;
}

async function connectCanvas(instance, taskId) {
  const { health } = await import(pathToFileURL(path.join(root, 'src', 'canvas', 'client.mjs')).href);
  return waitFor(async () => {
    const current = await health(instance);
    return current.targets?.some((target) => target.projectId === taskId && target.hasCanvas) ? current : null;
  }, 'The task Canvas page did not connect to its isolated bridge.', 25_000);
}

async function probeExpectedHealth(url, headers, instanceId) {
  try {
    const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(1200) });
    const body = await response.json().catch(() => null);
    return response.ok && body?.instanceId === instanceId;
  } catch {
    return false;
  }
}

try {
  await fs.writeFile(fixtureImagePath, PNG_FIXTURE, { flag: 'wx' });
  startAttempted = true;
  await launcherCommand(['start', '--no-open', '--port', '0']);
  const running = await waitFor(async () => {
    const value = await status();
    return value.running && typeof value.url === 'string' ? value : null;
  }, 'The isolated Studio service did not become ready.');

  const origin = new URL(running.url);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'The service must bind to loopback.');
  assert.ok(Number(origin.port) > 0, 'The launcher must choose an available dynamic port.');
  assert.notEqual(Number(origin.port), 4310, 'The regression must use a dynamic port, not the existing development port.');
  assert.equal(origin.protocol, 'http:');
  const workbenchOrigin = registerLoopbackOrigin(origin);

  const duplicate = jsonFromOutput(await launcherCommand(['start', '--no-open', '--port', '0']));
  assert.equal(duplicate.running, true);
  assert.equal(duplicate.reused, true, 'A repeated start must reuse the existing local service.');
  assert.equal(duplicate.instanceId, running.instanceId, 'A repeated start must retain the same instance identity.');

  const configPath = path.join(isolatedData, 'config', 'studio.json');
  const fakeBasicKey = 'p4-isolated-basic-fixture-key';
  const fakeImageKey = 'p4-isolated-image-fixture-key';
  browser = await chromium.launch({ headless: true });
  const workbenchContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  contexts.push(workbenchContext);
  const workbenchPage = observePage(await workbenchContext.newPage(), workbenchOrigin);

  const home = await workbenchPage.goto(origin.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  assert.equal(home?.status(), 200, 'The Studio home page must load successfully.');
  await workbenchPage.waitForFunction(() => document.querySelector('#root')?.children.length > 0, null, { timeout: 20_000 });
  assert.match(await workbenchPage.title(), /Creative Studio/);
  assert.ok((await workbenchPage.locator('body').innerText()).trim().length > 0, 'The React workbench must render visible content.');

  const bootstrapResponse = await browserJson(workbenchPage, '/api/bootstrap');
  assert.equal(bootstrapResponse.status, 200, 'The local bootstrap API must respond.');
  assert.ok(bootstrapResponse.payload && typeof bootstrapResponse.payload === 'object');

  const savedConfig = await browserJson(workbenchPage, '/api/config', {
    method: 'POST',
    body: {
      expectedRevision: 1,
      base: { source: 'custom', baseUrl: 'http://127.0.0.1:1/v1', model: 'p4-fixture-basic', apiKey: fakeBasicKey },
      image: { baseUrl: 'http://127.0.0.1:1/v1', model: 'p4-fixture-image', apiKey: fakeImageKey },
    },
  });
  assert.equal(savedConfig.status, 200, 'Fictional basic and image settings must save without a connection test.');
  assert.equal(savedConfig.payload.config.base.apiKeyConfigured, true);
  assert.equal(savedConfig.payload.config.image.apiKeyConfigured, true);
  assert.ok(!JSON.stringify(savedConfig.payload).includes(fakeBasicKey));
  assert.ok(!JSON.stringify(savedConfig.payload).includes(fakeImageKey));
  assert.ok(await fs.stat(configPath), 'The private configuration must be stored under isolated application data.');

  const created = await browserJson(workbenchPage, '/api/tasks', {
    method: 'POST',
    body: { title: 'P4 Windows 隔离回归任务', brief: '仅供本地服务与 Canvas 恢复验证，不用于真实创作。' },
  });
  assert.equal(created.status, 201, 'The workbench must create an isolated synthetic task.');
  const task = created.payload.task;
  assert.match(task.id, /^[0-9a-f-]{36}$/i);

  const { attachTaskFiles } = await import(pathToFileURL(path.join(root, 'src', 'creative', 'tasks.mjs')).href);
  const uploadedTask = await attachTaskFiles(task.id, {
    files: [{ path: fixtureImagePath, name: 'p4-fixture.png', mimeType: 'image/png' }],
    title: '隔离回归合成图片',
    purpose: '仅用于本机机械导入回归。',
  }, { root: isolatedData, expectedRevision: task.revision });
  const imageSource = uploadedTask.sources.at(-1);
  assert.ok(imageSource?.id);
  assert.equal(imageSource.files[0].sha256, imageSha256(PNG_FIXTURE));

  const openedCanvas = await browserJson(workbenchPage, `/api/tasks/${task.id}/canvas/open`, { method: 'POST', body: {} });
  assert.equal(openedCanvas.status, 200, 'The fictional task must start its own Canvas service.');
  assert.equal(openedCanvas.payload.projectId, task.id);
  const instancePath = path.join(isolatedData, 'canvas', task.id, 'canvas-instance.json');
  canvasInstance = JSON.parse(await fs.readFile(instancePath, 'utf8'));
  const modelPluginPath = path.join(isolatedData, 'model-plugin', 'instance.json');
  pluginInstance = JSON.parse(await fs.readFile(modelPluginPath, 'utf8'));
  const canvasOrigin = registerLoopbackOrigin(canvasInstance.webUrl);
  registerLoopbackOrigin(canvasInstance.bridgeUrl);

  const firstCanvasContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  contexts.push(firstCanvasContext);
  const firstCanvasPage = observePage(await firstCanvasContext.newPage(), canvasOrigin);
  await firstCanvasPage.goto(openedCanvas.payload.openUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await firstCanvasPage.waitForURL((url) => url.pathname === `/canvas/${task.id}` && !url.hash, { timeout: 20_000 });
  await connectCanvas(canvasInstance, task.id);

  const { createCanvasManager } = await import(pathToFileURL(path.join(root, 'src', 'web', 'canvas.mjs')).href);
  const { readConfig } = await import(pathToFileURL(path.join(root, 'src', 'web', 'config.mjs')).href);
  const canvasManager = createCanvasManager({
    root: isolatedData,
    readConfig: (options = {}) => readConfig({ ...options, root: isolatedData }),
  });
  const operationId = randomUUID();
  const imported = await canvasManager.mechanicalOperation(task.id, {
    operation: 'import',
    image: { sourceId: imageSource.id, fileOrder: 1 },
    expectedRevision: uploadedTask.revision,
    operationId,
    requestId: randomUUID(),
    callId: operationId,
    userText: '仅将本次隔离回归生成的合成图片导入任务画布。',
  });
  assert.deepEqual(imported.attachments, [], 'Mechanical import must not create a duplicate chat attachment.');
  assert.equal(imported.result.operation, 'import');
  importedNodeId = imported.result.sourceNodeId;
  assert.match(importedNodeId, /^[0-9a-f-]{36}$/i);

  const { callCanvasTool, health } = await import(pathToFileURL(path.join(root, 'src', 'canvas', 'client.mjs')).href);
  const firstSnapshot = await callCanvasTool('canvas_get_state', {}, canvasInstance);
  assert.equal(firstSnapshot.projectId, task.id);
  assert.ok(firstSnapshot.nodes.some((node) => node.id === importedNodeId && node.type === 'image'));
  const firstImage = await callCanvasTool('canvas_read_image', { nodeId: importedNodeId }, canvasInstance);
  const firstImageBytes = Buffer.from(firstImage.dataUrl.split(',')[1], 'base64');
  assert.equal(imageSha256(firstImageBytes), imageSha256(PNG_FIXTURE), 'The imported image must preserve its original pixels.');

  const { verifyQrBrowser } = await import('./p4-qr-browser.mjs');
  await verifyQrBrowser({ root, canvasInstance, callCanvasTool });

  const persistedAppState = await firstCanvasPage.evaluate(async () => {
    const keysResponse = await fetch('/__studio/storage/app_state', { cache: 'no-store', credentials: 'same-origin' });
    if (!keysResponse.ok) return { status: keysResponse.status, values: [] };
    const keys = await keysResponse.json();
    const values = await Promise.all(keys.map(async (key) => {
      const response = await fetch(`/__studio/storage/app_state/${encodeURIComponent(key)}`, { cache: 'no-store', credentials: 'same-origin' });
      return response.ok ? await response.text() : '';
    }));
    return { status: keysResponse.status, values };
  });
  assert.equal(persistedAppState.status, 200, 'Canvas app state must be readable from its isolated storage service.');
  const persistedAppStateText = JSON.stringify(persistedAppState.values);
  assert.ok(!persistedAppStateText.includes(fakeBasicKey) && !persistedAppStateText.includes(fakeImageKey), 'Fictional provider keys must not persist in Canvas browser storage.');
  await waitFor(() => canvasStorageWrites.has('app_state') && canvasStorageWrites.has('image_files'),
    'Canvas did not persist both project state and image bytes through the local storage service.', 15_000);
  assert.ok(canvasStorageWrites.has('app_state'), 'Canvas project state must be saved through the local storage service.');
  assert.ok(canvasStorageWrites.has('image_files'), 'Canvas image bytes must be saved through the local storage service.');

  await firstCanvasContext.close();
  const idleBridge = await waitFor(async () => {
    const value = await health(canvasInstance);
    return value.targets?.every((target) => !target.hasCanvas) ? value : null;
  }, 'The first isolated Canvas browser context did not disconnect.', 15_000);
  assert.ok(idleBridge.targets.every((target) => !target.hasCanvas));

  const reopenedCanvas = await browserJson(workbenchPage, `/api/tasks/${task.id}/canvas/open`, { method: 'POST', body: {} });
  assert.equal(reopenedCanvas.status, 200);
  assert.equal(reopenedCanvas.payload.projectId, task.id);
  const secondCanvasContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  contexts.push(secondCanvasContext);
  const secondCanvasPage = observePage(await secondCanvasContext.newPage(), canvasOrigin);
  await secondCanvasPage.goto(reopenedCanvas.payload.openUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await secondCanvasPage.waitForURL((url) => url.pathname === `/canvas/${task.id}` && !url.hash, { timeout: 20_000 });
  await connectCanvas(canvasInstance, task.id);
  const restoredSnapshot = await callCanvasTool('canvas_get_state', {}, canvasInstance);
  assert.equal(restoredSnapshot.projectId, task.id, 'The new browser context must reconnect to the same task project.');
  assert.ok(restoredSnapshot.nodes.some((node) => node.id === importedNodeId && node.type === 'image'), 'Canvas must restore the imported image node.');
  const restoredImage = await callCanvasTool('canvas_read_image', { nodeId: importedNodeId }, canvasInstance);
  const restoredBytes = Buffer.from(restoredImage.dataUrl.split(',')[1], 'base64');
  assert.equal(imageSha256(restoredBytes), imageSha256(PNG_FIXTURE), 'Canvas must restore the original image bytes in the new browser context.');
  assert.deepEqual(browserErrors, [], 'The workbench and Canvas pages must not produce uncaught runtime errors.');
  console.log(JSON.stringify({
    check: 'browser-network-policy',
    loopbackOrigins: [...allowedLoopbackOrigins].sort(),
    loopbackRequests: allowedLoopbackRequests,
    promptCatalogRequests: allowedPromptCatalogRequests,
    rejectedRequests: rejectedExternalRequests,
  }));
  assert.deepEqual(rejectedExternalRequests, [], 'The browser regression must reject unapproved external or non-GET requests.');

  await Promise.all(contexts.map((context) => context.close().catch(() => {})));
  contexts.length = 0;
  await browser.close();
  browser = null;

  const canvasHealthUrl = `${canvasInstance.webUrl}/__studio/health`;
  const pluginHealthUrl = `${pluginInstance.baseUrl}/health`;
  const stoppedResult = jsonFromOutput(await launcherCommand(['stop'], { timeout: 50_000 }));
  assert.equal(stoppedResult.running, false);
  assert.equal(stoppedResult.stopped, true);
  const stoppedStatus = await waitFor(async () => {
    const value = await status();
    return value.running === false ? value : null;
  }, 'The isolated Studio service did not stop cleanly.', 15_000);
  stopped = stoppedStatus.running === false;

  const healthStillRunning = await waitFor(async () => {
    const [canvasLive, pluginLive] = await Promise.all([
      probeExpectedHealth(canvasHealthUrl, { 'x-studio-token': canvasInstance.token }, canvasInstance.instanceId),
      probeExpectedHealth(pluginHealthUrl, { authorization: `Bearer ${pluginInstance.apiKey}` }, pluginInstance.instanceId),
    ]);
    return !canvasLive && !pluginLive ? { canvasLive, pluginLive } : null;
  }, 'Canvas or model-plugin health remained available after launcher stop.', 15_000);
  assert.equal(healthStillRunning.canvasLive, false);
  assert.equal(healthStillRunning.pluginLive, false);

  console.log('P4 service regression passed: repeat start, fictional config, synthetic task, mechanical Canvas import, new-context image restore, and clean shutdown.');
} finally {
  await Promise.all(contexts.map((context) => context.close().catch(() => {})));
  await browser?.close().catch(() => {});
  if (startAttempted && !stopped) {
    try {
      await launcherCommand(['stop'], { timeout: 50_000 });
    } catch { /* Keep the primary failure while the ephemeral runner is being discarded. */ }
  }
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

assert.ok(stopped, 'The isolated Studio, Canvas, and model-plugin services must stop before temporary data is removed.');
