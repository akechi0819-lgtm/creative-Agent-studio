import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createCanvas } from '@napi-rs/canvas';
import { createCanvasManager } from '../src/web/canvas.mjs';
import { listenStudioServer } from '../src/web/server.mjs';
import { confirmInputs, createTask, readTask, setSheet, taskDirectory } from '../src/creative/tasks.mjs';
import {
  approveVideo,
  confirmVideoPlan,
  executeVideoTask,
  exportVideoTask,
  readVideoOutput,
  recordVideoReview,
} from '../src/creative/video.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const evidenceDir = path.join(repo, 'docs/evidence/video-workflow');
const evidenceFile = path.join(evidenceDir, 'verification.json');
const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'studio-video-workflow-'));
await chmod(isolatedRoot, 0o700);

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fakeKey = `fixture-only-${randomUUID()}`;
const nativePrompt = '隔离验证用合成素材：一枚红色纸风车在纯蓝背景前转动，固定镜头，无文字。';
const workbenchPrompt = '隔离验证工作台版本：同一红色纸风车在纯蓝背景前转动，固定镜头，无文字。';
const imagePrompt = '隔离验证原图片：纯白背景上的蓝色几何圆形，边缘清晰，无其他元素。';
const fakeImageKey = `fixture-image-only-${randomUUID()}`;
const graphFields = [
  'inputConfirmation', 'sheetVersion', 'sheetInputsRevision', 'sheets', 'sheetConfirmation',
  'execution', 'executionHistory', 'reviews', 'reviewHistory', 'finalApproval', 'exports',
];

const previousReport = await readFile(evidenceFile, 'utf8').then(JSON.parse).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const previousRuns = Array.isArray(previousReport?.runs) ? previousReport.runs : [];
for (const oldRun of previousRuns) {
  if (oldRun.status === 'running') {
    oldRun.status = 'interrupted';
    oldRun.finishedAt = new Date().toISOString();
    oldRun.failure = 'Harness was manually interrupted while investigating a local Canvas tool stall; no H3 proxy call had occurred.';
  }
}
const run = {
  attempt: previousRuns.length + 1,
  status: 'running',
  startedAt: new Date().toISOString(),
  paidRequests: false,
  directProviderRequests: 0,
  blockedExternalHosts: [],
  checks: [],
  proxyCalls: [],
};
const report = {
  schemaVersion: 1,
  scope: '真实任务专属 Canvas + 浏览器拦截的本地 H3 替身；不访问供应商、不产生费用。',
  runs: [...previousRuns, run],
};

let browser;
let context;
let canvasPage;
let playbackPage;
let workbenchPage;
let manager;
let app;
let abortController;
let routeFailure;
let mp4Bytes;
let task;
let managerOptions;
let expectedConfig;
let staticDir;
let webUrl;
let pendingObservedResolve;
const pendingObserved = new Promise((resolve) => { pendingObservedResolve = resolve; });
let statusPolls = 0;
let createRequests = 0;
let contentRequests = 0;
let imageRequests = 0;
let abortOnPending = true;
let activePrompt = nativePrompt;
let verificationStage = 'setup';
const pageErrors = [];
const providerStatusCounts = new Map();
const providerTaskIds = [];
let fixturePng;

async function saveReport() {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(evidenceFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await chmod(evidenceFile, 0o600);
}

async function withTimeout(promise, label, timeoutMs = 20_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms.`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function safeError(error) {
  let message = String(error?.message || error?.name || 'video_workflow_verification_failed');
  for (const secret of [fakeKey, expectedConfig?.webUrl, expectedConfig?.openUrl]) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/(?:studioBootstrap=|token=)[a-f0-9]{16,}/gi, '[redacted]')
    .slice(0, 1200);
}

function taskGraph(taskValue) {
  return structuredClone(Object.fromEntries(graphFields.map((key) => [key, taskValue[key] ?? null])));
}

function makeFixturePng() {
  const canvas = createCanvas(640, 800);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#2879c7';
  context.beginPath();
  context.arc(320, 400, 150, 0, Math.PI * 2);
  context.fill();
  return canvas.toBuffer('image/png');
}

async function prepareWorkbenchStatic() {
  staticDir = path.join(isolatedRoot, 'static');
  await mkdir(path.join(staticDir, 'assets'), { recursive: true });
  await cp(path.join(repo, 'web/public'), staticDir, { recursive: true });
  await cp(path.join(repo, 'web/index.html'), path.join(staticDir, 'index.html'));
  await build({
    entryPoints: [path.join(repo, 'web/src/main.jsx')],
    outfile: path.join(staticDir, 'assets/app.js'),
    bundle: true,
    jsx: 'automatic',
    external: ['/brand/*'],
    loader: { '.png': 'file', '.svg': 'file' },
  });
}

async function postJson(endpoint, value) {
  const response = await fetch(`${webUrl}${endpoint}`, {
    method: 'POST',
    headers: { origin: webUrl, 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${endpoint} returned HTTP ${response.status}: ${body.error?.message || body.error || 'request failed'}`);
  return body;
}

async function waitForTask(taskId, predicate, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let current;
  while (Date.now() < deadline) {
    current = await readTask(taskId, isolatedRoot);
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${label} timed out; last image status=${current?.execution?.status || 'none'}, video status=${current?.video?.execution?.status || 'none'}.`);
}

function isLocalHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function assertVideoTarget(request) {
  const localUrl = new URL(request.url());
  const prefix = '/__studio/video-proxy/';
  assert.ok(localUrl.pathname.startsWith(prefix), 'video request must use the Studio local proxy');
  const encodedTarget = localUrl.pathname.slice(prefix.length);
  const decodedTarget = decodeURIComponent(encodedTarget);
  const target = new URL(decodedTarget);
  assert.equal(target.origin, 'https://api.osodm.com');
  assert.equal(target.username, '');
  assert.equal(target.password, '');
  assert.equal(target.search, '');
  assert.equal(target.hash, '');
  return { localUrl, target };
}

function assertImageTarget(request) {
  const localUrl = new URL(request.url());
  const prefix = '/__studio/image-proxy/';
  assert.ok(localUrl.pathname.startsWith(prefix), 'image fixture request must use the Studio local proxy');
  const target = new URL(decodeURIComponent(localUrl.pathname.slice(prefix.length)));
  assert.equal(target.origin, 'https://fixture-image.invalid');
  assert.equal(target.username, '');
  assert.equal(target.password, '');
  assert.equal(target.search, '');
  assert.equal(target.hash, '');
  return target;
}

async function fulfillJson(route, status, value) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
}

async function makeSyntheticMp4(page) {
  const generated = await page.evaluate(async () => {
    const mimeType = ['video/mp4;codecs=avc1.42E01E', 'video/mp4'].find((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!mimeType) return { supported: false, mimeType: null, reason: 'Chromium MediaRecorder lacks an MP4 encoder.' };

    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable for the synthetic MP4.');
    const stream = canvas.captureStream(24);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 500_000 });
    const chunks = [];
    recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
    const stopped = new Promise((resolve, reject) => {
      recorder.addEventListener('stop', resolve, { once: true });
      recorder.addEventListener('error', (event) => reject(event.error || new Error('MediaRecorder failed.')), { once: true });
    });
    let frame = 0;
    let timer;
    const draw = () => {
      context.fillStyle = '#163a75';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.save();
      context.translate(canvas.width / 2, canvas.height / 2);
      context.rotate(frame * 0.08);
      context.fillStyle = '#ec4c44';
      context.fillRect(-8, -105, 16, 210);
      context.fillRect(-105, -8, 210, 16);
      context.restore();
      context.fillStyle = '#f5d778';
      context.beginPath();
      context.arc(canvas.width / 2, canvas.height / 2, 12, 0, Math.PI * 2);
      context.fill();
      frame += 1;
      timer = requestAnimationFrame(draw);
    };
    draw();
    recorder.start(100);
    await new Promise((resolve) => setTimeout(resolve, 4000));
    cancelAnimationFrame(timer);
    recorder.stop();
    await stopped;
    for (const track of stream.getTracks()) track.stop();

    const blob = new Blob(chunks, { type: 'video/mp4' });
    if (!blob.size) throw new Error('MediaRecorder returned an empty MP4.');
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not encode the synthetic MP4 for the local route.'));
      reader.readAsDataURL(blob);
    });
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      video.addEventListener('loadedmetadata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('Synthetic MP4 metadata cannot be decoded by Chromium.')), { once: true });
    });
    URL.revokeObjectURL(video.src);
    return {
      supported: true,
      mimeType,
      bytes: blob.size,
      base64: String(dataUrl).split(',').at(-1),
      width: video.videoWidth,
      height: video.videoHeight,
      durationMs: Math.round(video.duration * 1000),
    };
  });

  run.syntheticFixture = {
    supported: generated.supported,
    mimeType: generated.mimeType,
    bytes: generated.bytes ?? null,
    width: generated.width ?? null,
    height: generated.height ?? null,
    durationMs: generated.durationMs ?? null,
    reason: generated.reason ?? null,
  };
  if (!generated.supported) throw new Error(generated.reason || 'This Chromium cannot generate a real synthetic MP4.');
  assert.equal(generated.mimeType.startsWith('video/mp4'), true);
  assert.equal(generated.width, 640);
  assert.equal(generated.height, 360);
  assert.ok(generated.durationMs >= 3000 && generated.durationMs <= 6000, `unexpected synthetic clip duration ${generated.durationMs}ms`);
  mp4Bytes = Buffer.from(generated.base64, 'base64');
  assert.equal(mp4Bytes.toString('ascii', 4, 8), 'ftyp', 'MediaRecorder must produce a real MP4 container');
  run.syntheticFixture.sha256 = digest(mp4Bytes);
  await writeFile(path.join(evidenceDir, `attempt-${String(run.attempt).padStart(2, '0')}-synthetic.mp4`), mp4Bytes, { mode: 0o600 });
  run.checks.push('chromium-generated-and-decoded-real-mp4-fixture');
  await saveReport();
}

async function installProviderRoute() {
  await context.route('**/*', async (route) => {
    const request = route.request();
    let url;
    try { url = new URL(request.url()); }
    catch {
      routeFailure ||= new Error('Canvas made an invalid browser request URL.');
      await route.abort();
      return;
    }

    if (url.pathname.startsWith('/__studio/video-proxy/')) {
      try {
        const { target } = assertVideoTarget(request);
        const method = request.method();
        const endpoint = target.pathname;
        const auth = request.headers().authorization || '';
        assert.equal(auth, '', 'Canvas must keep the H3 key server-side and omit Authorization from the browser proxy request');

        if (method === 'POST' && endpoint === '/v1/videos') {
          createRequests += 1;
          const providerTaskId = `studio-isolated-video-task-${String(createRequests).padStart(2, '0')}`;
          providerTaskIds.push(providerTaskId);
          providerStatusCounts.set(providerTaskId, 0);
          const body = request.postDataJSON();
          const expectedKeys = ['aspect_ratio', 'duration_seconds', 'model', 'operation', 'prompt', 'resolution', 'version'];
          assert.deepEqual(Object.keys(body).sort(), expectedKeys.sort(), 'H3 request must contain only current contract fields');
          assert.deepEqual({
            version: body.version,
            model: body.model,
            operation: body.operation,
            duration_seconds: body.duration_seconds,
            resolution: body.resolution,
            aspect_ratio: body.aspect_ratio,
          }, {
            version: 'video.v1',
            model: 'minimax_h3',
            operation: 'text_to_video',
            duration_seconds: 4,
            resolution: '768',
            aspect_ratio: '16:9',
          });
          assert.equal(typeof body.prompt, 'string');
          assert.equal(body.prompt.includes(activePrompt), true, 'H3 prompt must retain the complete confirmed instruction');
          assert.equal(body.prompt.split(activePrompt).length - 1, 1, 'H3 prompt must not duplicate or accumulate prior instructions');
          run.providerRequests ||= [];
          run.providerRequests.push({
            method,
            endpoint,
            fieldNames: Object.keys(body).sort(),
            version: body.version,
            model: body.model,
            operation: body.operation,
            promptSha256: digest(Buffer.from(body.prompt, 'utf8')),
            promptIncludesConfirmedInstruction: body.prompt.includes(activePrompt),
            confirmedInstructionOccurrences: body.prompt.split(activePrompt).length - 1,
            duration_seconds: body.duration_seconds,
            resolution: body.resolution,
            aspect_ratio: body.aspect_ratio,
            authorizationHeaderPresent: Boolean(auth),
            apiKeyVisibleToBrowser: false,
            providerTaskId,
          });
          run.proxyCalls.push({ method, endpoint, responseStatus: 200 });
          await fulfillJson(route, 200, { id: providerTaskId, status: 'pending' });
          return;
        }

        const statusMatch = /^\/v1\/videos\/([A-Za-z0-9._~-]+)$/.exec(endpoint);
        if (method === 'GET' && statusMatch && providerStatusCounts.has(statusMatch[1])) {
          const providerTaskId = statusMatch[1];
          statusPolls += 1;
          const pollCount = (providerStatusCounts.get(providerTaskId) || 0) + 1;
          providerStatusCounts.set(providerTaskId, pollCount);
          const status = pollCount === 1 ? 'pending' : 'completed';
          run.proxyCalls.push({ method, endpoint, responseStatus: 200, providerStatus: status });
          await fulfillJson(route, 200, { id: providerTaskId, status });
          if (status === 'pending' && abortOnPending) {
            abortOnPending = false;
            pendingObservedResolve();
            setTimeout(() => abortController?.abort(new Error('test: preserve provider pending state')), 75);
          }
          return;
        }

        const contentMatch = /^\/v1\/videos\/([A-Za-z0-9._~-]+)\/content$/.exec(endpoint);
        if (method === 'GET' && contentMatch && providerStatusCounts.has(contentMatch[1])) {
          contentRequests += 1;
          const providerTaskId = contentMatch[1];
          run.proxyCalls.push({ method, endpoint, responseStatus: 200, bytes: mp4Bytes.length });
          await route.fulfill({ status: 200, contentType: 'video/mp4', body: mp4Bytes });
          return;
        }

        throw new Error(`Unexpected intercepted H3 endpoint: ${method} ${endpoint}`);
      } catch (error) {
        routeFailure ||= error;
        await route.abort().catch(() => {});
        return;
      }
    }

    if (url.pathname.startsWith('/__studio/image-proxy/')) {
      try {
        const target = assertImageTarget(request);
        const method = request.method();
        const auth = request.headers().authorization || '';
        assert.equal(auth, `Bearer ${fakeImageKey}`, 'only the isolated fake image key may reach the intercepted local Canvas proxy');
        if (method === 'GET' && target.pathname === '/v1/models') {
          await fulfillJson(route, 200, { data: [{ id: 'fixture-image' }] });
          return;
        }
        if (method === 'POST' && target.pathname === '/v1/images/generations') {
          imageRequests += 1;
          const body = request.postDataJSON();
          assert.equal(body.model, 'fixture-image');
          assert.equal(typeof body.prompt, 'string');
          assert.equal(body.prompt.includes(imagePrompt), true, 'the existing image request must retain its exact fixture prompt');
          run.imageRequest = {
            method,
            endpoint: target.pathname,
            model: body.model,
            size: body.size || null,
            quality: body.quality || null,
            promptSha256: digest(Buffer.from(body.prompt, 'utf8')),
            imageKeySentOnlyToLocalProxy: Boolean(auth),
          };
          await fulfillJson(route, 200, { created: 1, data: [{ b64_json: fixturePng.toString('base64') }] });
          return;
        }
        throw new Error(`Unexpected intercepted image fixture endpoint: ${method} ${target.pathname}`);
      } catch (error) {
        routeFailure ||= error;
        await route.abort().catch(() => {});
        return;
      }
    }

    if (['http:', 'https:'].includes(url.protocol) && isLocalHost(url.hostname)) {
      await route.continue();
      return;
    }
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') {
      await route.continue();
      return;
    }

    run.blockedExternalHosts.push(url.hostname || url.protocol);
    if (url.hostname === 'api.osodm.com') {
      run.directProviderRequests += 1;
      routeFailure ||= new Error('A direct external MiniMax H3 request was blocked; requests must use the task Canvas proxy.');
    }
    if (url.hostname === 'fixture-image.invalid') {
      routeFailure ||= new Error('A direct external image fixture request was blocked; requests must use the task Canvas proxy.');
    }
    await route.abort('blockedbyclient').catch(() => {});
  });
}

async function waitForCanvasConnection(taskId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await manager.state(taskId);
    if (state.state === 'ready' && state.clientConnected) return state;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Isolated Canvas browser did not connect to its task.');
}

async function waitForVideoNode(execution, providerTaskId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let latestState;
  while (Date.now() < deadline) {
    latestState = await managerOptions.tool('canvas_get_state', {}, managerOptions.config);
    const edges = latestState.connections || latestState.edges || [];
    const videoIds = new Set(edges.filter((edge) => edge.fromNodeId === execution.configNodeId).map((edge) => edge.toNodeId));
    const node = latestState.nodes.find((item) => videoIds.has(item.id) && item.type === 'video');
    if (node && node.metadata?.status === 'success'
      && node.metadata?.videoTaskId === providerTaskId && node.metadata?.storageKey) {
      return { node, state: latestState };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Canvas did not finish the original video node; last status: ${latestState?.nodes?.find((item) => item.id === execution.configNodeId)?.metadata?.status || 'unknown'}`);
}

try {
  verificationStage = 'create-isolated-task';
  await saveReport();

  const readConfig = async () => ({
    revision: 1,
    basic: { baseUrl: '', model: '', apiKey: '', source: 'custom' },
    image: { baseUrl: 'https://fixture-image.invalid/v1', model: 'fixture-image', apiKey: fakeImageKey },
    video: { baseUrl: 'https://api.osodm.com', model: 'minimax_h3', apiKey: fakeKey, apiFormat: 'openai' },
  });
  manager = createCanvasManager({ root: isolatedRoot, readConfig });
  task = await createTask({
    title: `隔离视频验证 ${new Date().toISOString()}`,
    brief: '先保留一张现有图片，再验证独立镜头卡、右侧视频预览与确认交付；所有模型请求均为浏览器拦截的本地替身。',
  }, isolatedRoot);
  task = await confirmInputs(task.id, {
    revision: task.revision,
    by: '隔离验证人员',
    note: '仅用于验证主工作台原图片预览与视频独立流程。',
  }, { root: isolatedRoot });
  verificationStage = 'build-static-and-start-local-servers';
  fixturePng = makeFixturePng();
  run.taskId = task.id;
  await prepareWorkbenchStatic();
  app = await listenStudioServer({ root: isolatedRoot, staticDir, canvas: manager, readConfig, port: 0 });
  webUrl = `http://127.0.0.1:${app.address.port}`;

  expectedConfig = await manager.ensure(task.id);
  console.log('Isolated Canvas supervisor and Web workbench ready.');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block', acceptDownloads: true });
  await installProviderRoute();
  playbackPage = await context.newPage();
  await playbackPage.goto('about:blank');
  await makeSyntheticMp4(playbackPage);
  console.log('Synthetic MP4 is valid and playable.');

  canvasPage = await context.newPage();
  canvasPage.on('pageerror', (error) => pageErrors.push(error.message));
  await canvasPage.goto(expectedConfig.openUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await canvasPage.waitForURL((url) => url.pathname === `/canvas/${task.id}` && !url.hash, { timeout: 30_000 });
  await waitForCanvasConnection(task.id);
  run.checks.push('real-isolated-canvas-browser-connected');
  await canvasPage.screenshot({ path: path.join(evidenceDir, `attempt-${String(run.attempt).padStart(2, '0')}-canvas-ready.png`) });

  task = await setSheet(task.id, {
    title: '保留在视频工作流旁的原图片',
    sourceIds: [],
    pages: [{
      page: 1,
      copy: '蓝色几何圆形',
      prompt: imagePrompt,
      size: '768x1024',
      sourceIds: [],
      referenceImages: [],
    }],
  }, { root: isolatedRoot, expectedRevision: task.revision, inputRevision: task.inputConfirmation.revision });

  managerOptions = await withTimeout(manager.videoExecutionOptions(task.id), 'videoExecutionOptions');
  assert.equal(managerOptions.config.projectId, task.id);
  const beforeSnapshot = await withTimeout(managerOptions.tool('canvas_get_state', {}, managerOptions.config), 'initial canvas_get_state');
  assert.equal(beforeSnapshot.projectId, task.id);
  run.canvasTarget = { projectMatchesTask: beforeSnapshot.projectId === task.id, initialNodes: beforeSnapshot.nodes.length };

  workbenchPage = await context.newPage();
  workbenchPage.on('pageerror', (error) => pageErrors.push(error.message));
  let workbenchDownloadCount = 0;
  workbenchPage.on('download', () => { workbenchDownloadCount += 1; });
  await workbenchPage.addInitScript((taskId) => {
    localStorage.setItem('studio.activeTask', taskId);
    localStorage.setItem('studio.onboardingDismissed', '1');
  }, task.id);
  await workbenchPage.goto(webUrl, { waitUntil: 'domcontentloaded' });
  await workbenchPage.getByRole('heading', { name: task.title, exact: true }).waitFor();
  verificationStage = 'render-existing-task-without-video-plan';
  assert.equal(await workbenchPage.getByRole('region', { name: '视频镜头方案' }).count(), 0, 'an existing task without a video plan should load without a video card');
  assert.deepEqual(pageErrors, [], 'an existing task without video metadata must render cleanly');
  verificationStage = 'confirm-and-generate-original-image-from-workbench';
  await workbenchPage.getByRole('button', { name: '按此方案开始制作', exact: true }).click();
  verificationStage = 'wait-for-original-image-generation';
  task = await waitForTask(task.id, (current) => current.sheetConfirmation?.version === current.sheetVersion
    && current.execution?.version === current.sheetVersion && current.execution?.status === 'succeeded', 'workbench image generation');
  assert.equal(imageRequests, 1, 'the original image preview must come from one local fake image request');
  assert.equal(task.execution.pages.length, 1);
  assert.ok(task.execution.pages[0].image?.sha256);
  const imagePreview = workbenchPage.getByRole('region', { name: '当前任务预览' }).locator('img[alt="第 1 页当前图片"]');
  await imagePreview.waitFor();
  const originalImage = await imagePreview.evaluate((image) => ({
    complete: image.complete,
    width: image.naturalWidth,
    height: image.naturalHeight,
    src: image.currentSrc,
  }));
  assert.equal(originalImage.complete, true);
  assert.equal(originalImage.width, 640);
  assert.equal(originalImage.height, 800);
  run.originalImage = { sha256: task.execution.pages[0].image.sha256, width: originalImage.width, height: originalImage.height };
  run.checks.push('workbench-generated-and-displayed-original-image-before-video');
  await workbenchPage.screenshot({ path: path.join(evidenceDir, `attempt-${String(run.attempt).padStart(2, '0')}-workbench-image.png`), fullPage: true });

  const graphBefore = taskGraph(task);
  verificationStage = 'prepare-native-canvas-video-plan';
  const modelInfo = await manager.videoModelInfo(task.id);
  assert.equal(modelInfo.model, 'studio-video::minimax_h3');
  assert.equal(modelInfo.apiKeyConfigured, true);
  await postJson(`/api/tasks/${encodeURIComponent(task.id)}/write-video-plan`, {
    expectedRevision: task.revision,
    plan: { prompt: nativePrompt, seconds: 4, ratio: '16:9', resolution: '768' },
  });
  task = await readTask(task.id, isolatedRoot);
  assert.equal(task.video.version, 1);
  assert.equal(task.video.plans[0].confirmedAt, null);
  run.nativePlanVersion = task.video.version;
  run.plan = { version: task.video.version, seconds: task.video.plans[0].seconds, ratio: task.video.plans[0].ratio, resolution: task.video.plans[0].resolution };
  await saveReport();
  task = await confirmVideoPlan(task.id, {
    version: task.video.version,
    by: '隔离验证人员',
    note: '隔离测试确认第一版合成视频方案，浏览器请求由本地替身拦截。',
  }, { root: isolatedRoot, expectedRevision: task.revision });

  console.log('Workbench image preview is ready; running native pending/resume validation.');
  abortController = new AbortController();
  const executionPromise = executeVideoTask(task.id, {
    version: task.video.version,
    expectedRevision: task.revision,
    root: isolatedRoot,
    signal: abortController.signal,
    pollMs: 100,
    timeoutMs: 60_000,
    ...managerOptions,
  });
  let firstExecutionFailure;
  try {
    await executionPromise;
    throw new Error('Expected first run to preserve the pending request as uncertain.');
  } catch (error) {
    firstExecutionFailure = error;
  }
  await Promise.race([
    pendingObserved,
    new Promise((_, reject) => setTimeout(() => reject(new Error('H3 fixture did not return pending status within 20 seconds.')), 20_000)),
  ]);
  assert.match(firstExecutionFailure.message, /提交结果未能确认|已提交请求保留原节点|等待视频超时/);
  task = await readTask(task.id, isolatedRoot);
  assert.equal(task.video.execution.status, 'uncertain');
  assert.equal(task.video.execution.submitted, true);
  assert.ok(task.video.execution.submissionIntentAt);
  assert.equal(createRequests, 1, 'initial execution must submit exactly once');
  run.initialExecution = { status: task.video.execution.status, failure: safeError(firstExecutionFailure) };
  run.checks.push('pending-request-retained-as-uncertain-after-interruption');
  await saveReport();

  const nativeProviderTaskId = providerTaskIds[0];
  const { node: completedNode, state: afterGenerationState } = await waitForVideoNode(task.video.execution, nativeProviderTaskId);
  const configNode = afterGenerationState.nodes.find((item) => item.id === task.video.execution.configNodeId);
  const textNode = afterGenerationState.nodes.find((item) => item.id === task.video.execution.textNodeId);
  assert.equal(textNode?.metadata?.content, nativePrompt);
  assert.equal(configNode?.metadata?.generationMode, 'video');
  assert.equal(configNode?.metadata?.size, '16:9');
  assert.equal(configNode?.metadata?.seconds, '4');
  assert.equal(configNode?.metadata?.vquality, '768');
  assert.equal(Object.hasOwn(configNode.metadata, 'generateAudio'), false);
  assert.equal(completedNode.metadata.status, 'success');
  run.canvasVideoNode = {
    id: completedNode.id,
    status: completedNode.metadata.status,
    videoTaskId: completedNode.metadata.videoTaskId,
    storageKey: completedNode.metadata.storageKey,
    width: completedNode.metadata.naturalWidth,
    height: completedNode.metadata.naturalHeight,
    durationMs: completedNode.metadata.durationMs,
    sha256: digest(mp4Bytes),
  };
  run.checks.push('canvas-native-h3-contract-and-success-node-verified');

  const beforeResumeRunCount = createRequests;
  task = await executeVideoTask(task.id, {
    version: task.video.version,
    expectedRevision: task.revision,
    root: isolatedRoot,
    pollMs: 100,
    timeoutMs: 30_000,
    ...managerOptions,
  });
  assert.equal(task.video.execution.status, 'succeeded');
  assert.equal(createRequests, beforeResumeRunCount, 'resume must only query/recover the original Canvas node');
  assert.equal(createRequests, 1);
  assert.ok(statusPolls >= 2, 'fixture should model pending then completed provider status');
  assert.equal(contentRequests, 1);
  run.checks.push('resume-recovered-original-canvas-video-without-resubmission');

  const output = await readVideoOutput(task.id, { root: isolatedRoot });
  assert.deepEqual(output.bytes, mp4Bytes);
  assert.equal(output.sha256, digest(mp4Bytes));
  assert.equal(output.mimeType, 'video/mp4');
  assert.equal(output.width, 640);
  assert.equal(output.height, 360);
  run.recoveredOutput = {
    sha256: output.sha256,
    width: output.width,
    height: output.height,
    durationMs: output.durationMs,
  };
  await saveReport();
  assert.ok(output.durationMs >= 3000 && output.durationMs <= 6000, `manager recovered ${output.durationMs}ms from a ${completedNode.metadata.durationMs}ms Canvas video`);
  assert.ok(Math.abs(output.durationMs - completedNode.metadata.durationMs) <= 250, 'manager duration must match browser-decoded Canvas metadata');
  const taskRootReal = await realpath(taskDirectory(task.id, isolatedRoot));
  const recoveredRelative = path.relative(taskRootReal, output.path);
  assert.ok(recoveredRelative && recoveredRelative !== '..' && !recoveredRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(recoveredRelative), 'recovered output must remain inside the real task directory');
  const mediaRecordPath = path.join(
    isolatedRoot,
    'canvas',
    task.id,
    'storage',
    'media_files',
    `${digest(Buffer.from(task.video.execution.output.storageKey, 'utf8'))}.json`,
  );
  const storedMedia = JSON.parse(await readFile(mediaRecordPath, 'utf8'));
  assert.equal(storedMedia.key, task.video.execution.output.storageKey);
  assert.equal(storedMedia.contentType, 'video/mp4');
  assert.equal(digest(Buffer.from(storedMedia.base64, 'base64')), output.sha256);
  run.storage = {
    canvasRecordFound: true,
    mimeType: storedMedia.contentType,
    bytes: Buffer.from(storedMedia.base64, 'base64').length,
    sha256: output.sha256,
    recoveredPath: path.relative(taskDirectory(task.id, isolatedRoot), output.path).split(path.sep).join('/'),
  };
  run.checks.push('canvas-media-storage-recovered-to-task-output-with-sha-match');

  const playback = await playbackPage.evaluate(async (source) => {
    const video = document.createElement('video');
    video.controls = true;
    video.muted = true;
    video.playsInline = true;
    video.src = source;
    document.body.style.margin = '0';
    document.body.style.background = '#111';
    video.style.width = '960px';
    video.style.maxWidth = '100vw';
    document.body.append(video);
    await new Promise((resolve, reject) => {
      video.addEventListener('loadedmetadata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('Recovered video could not load metadata in Chromium.')), { once: true });
    });
    await video.play();
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Recovered video did not advance during playback.')), 4000);
      const check = () => {
        if (video.currentTime > 0.1) { clearTimeout(deadline); resolve(); }
        else requestAnimationFrame(check);
      };
      check();
    });
    return {
      width: video.videoWidth,
      height: video.videoHeight,
      duration: video.duration,
      durationMs: Math.round(video.duration * 1000),
      currentTime: video.currentTime,
      paused: video.paused,
    };
  }, `data:video/mp4;base64,${output.bytes.toString('base64')}`);
  assert.deepEqual({ width: playback.width, height: playback.height }, { width: 640, height: 360 });
  assert.ok(playback.durationMs >= 3000 && playback.durationMs <= 6000);
  assert.ok(playback.currentTime > 0.1);
  assert.equal(playback.paused, false);
  run.playback = playback;
  run.checks.push('recovered-mp4-loaded-metadata-and-played-in-chromium');
  await playbackPage.screenshot({ path: path.join(evidenceDir, `attempt-${String(run.attempt).padStart(2, '0')}-video-playback.png`) });

  let reviewed = await recordVideoReview(task.id, {
    sha256: output.sha256,
    decision: 'pass',
    reviewer: '隔离验证人员',
    notes: '隔离测试已播放合成视频并核对画面尺寸、时长与文件 SHA-256。',
  }, { root: isolatedRoot, expectedRevision: task.revision });
  reviewed = await approveVideo(task.id, {
    version: reviewed.video.version,
    sha256: output.sha256,
    by: '隔离验证人员',
    note: '隔离测试确认当前合成 MP4 与其 manifest 可导出。',
  }, { root: isolatedRoot, expectedRevision: reviewed.revision });
  const exported = await exportVideoTask(task.id, { root: isolatedRoot, expectedRevision: reviewed.revision });
  task = exported.task;
  const exportedVideoPath = path.join(taskDirectory(task.id, isolatedRoot), exported.export.videoRelativePath);
  const exportedManifestPath = path.join(taskDirectory(task.id, isolatedRoot), exported.export.manifestRelativePath);
  const exportedBytes = await readFile(exportedVideoPath);
  const manifest = JSON.parse(await readFile(exportedManifestPath, 'utf8'));
  assert.equal(digest(exportedBytes), output.sha256);
  assert.deepEqual(exportedBytes, output.bytes);
  assert.equal(manifest.videoVersion, task.video.version);
  assert.equal(manifest.output.sha256, output.sha256);
  assert.equal(manifest.output.mimeType, 'video/mp4');
  assert.deepEqual(manifest.plan, { prompt: nativePrompt, seconds: 4, ratio: '16:9', resolution: '768' });
  assert.equal(Object.hasOwn(manifest.plan, 'generateAudio'), false);
  assert.equal(task.video.exports.length, 1);
  assert.deepEqual(taskGraph(task), graphBefore, 'video workflow must not modify the image/text approval graph');
  run.export = {
    videoRelativePath: exported.export.videoRelativePath,
    manifestRelativePath: exported.export.manifestRelativePath,
    sha256: exported.export.sha256,
    manifestSha256: exported.export.manifestSha256,
    bytes: exportedBytes.length,
    exportCount: task.video.exports.length,
  };
  run.graphUnchanged = true;
  run.checks.push('manual-sha-review-approval-exported-mp4-and-manifest');
  run.checks.push('image-text-graph-fields-remained-deep-equal');

  activePrompt = workbenchPrompt;
  await postJson(`/api/tasks/${encodeURIComponent(task.id)}/write-video-plan`, {
    expectedRevision: task.revision,
    plan: { prompt: workbenchPrompt, seconds: 4, ratio: '16:9', resolution: '768' },
  });
  task = await readTask(task.id, isolatedRoot);
  assert.equal(task.video.version, 2);
  assert.equal(task.video.plans.find((plan) => plan.version === 2)?.confirmedAt, null);
  run.workbenchPlanVersion = task.video.version;
  await workbenchPage.reload({ waitUntil: 'domcontentloaded' });
  await workbenchPage.getByRole('heading', { name: task.title, exact: true }).waitFor();
  const videoPlanCard = workbenchPage.getByRole('region', { name: '视频镜头方案' });
  await videoPlanCard.getByText(workbenchPrompt, { exact: true }).waitFor();
  await workbenchPage.screenshot({ path: path.join(evidenceDir, `attempt-${String(run.attempt).padStart(2, '0')}-workbench-video-plan.png`), fullPage: true });

  await videoPlanCard.getByRole('button', { name: '按此镜头生成', exact: true }).click();
  task = await waitForTask(task.id, (current) => current.video?.version === 2
    && current.video.execution?.version === 2 && current.video.execution?.status === 'succeeded', 'workbench video generation');
  assert.equal(createRequests, 2, 'the workbench should submit one new confirmed H3 request');
  assert.equal(contentRequests, 2);
  assert.equal(task.video.execution.output.sha256, digest(mp4Bytes));
  const uiVideoRegion = workbenchPage.getByRole('region', { name: '独立视频预览' });
  const uiVideo = uiVideoRegion.locator('video[aria-label="视频方案 v2 预览"]');
  await uiVideo.waitFor();
  await workbenchPage.waitForFunction(() => {
    const video = document.querySelector('[aria-label="独立视频预览"] video');
    return Boolean(video && video.readyState >= 1 && video.videoWidth === 640 && video.videoHeight === 360);
  }, null, { timeout: 30_000 });
  const uiPlayback = await uiVideo.evaluate(async (video) => {
    video.muted = true;
    await video.play();
    const deadline = Date.now() + 4000;
    while (video.currentTime <= 0.1 && Date.now() < deadline) await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      controls: video.controls,
      width: video.videoWidth,
      height: video.videoHeight,
      durationMs: Math.round(video.duration * 1000),
      currentTime: video.currentTime,
      paused: video.paused,
    };
  });
  assert.equal(uiPlayback.controls, true);
  assert.deepEqual({ width: uiPlayback.width, height: uiPlayback.height }, { width: 640, height: 360 });
  assert.ok(uiPlayback.currentTime > 0.1, 'Workbench video should play from its recovered task output URL');
  assert.equal(uiPlayback.paused, false);
  const imageAfterVideo = await imagePreview.evaluate((image) => ({
    complete: image.complete,
    width: image.naturalWidth,
    height: image.naturalHeight,
  }));
  assert.deepEqual(imageAfterVideo, { complete: true, width: 640, height: 800 }, 'the original image preview must remain visible beside the video');
  const taskAfterVideo = await readTask(task.id, isolatedRoot);
  assert.equal(taskAfterVideo.execution.pages[0].image.sha256, run.originalImage.sha256);
  const { node: workbenchVideoNode } = await waitForVideoNode(task.video.execution, providerTaskIds[1]);
  await workbenchPage.setViewportSize({ width: 1440, height: 1500 });
  const imageBox = await imagePreview.boundingBox();
  const videoBox = await uiVideo.boundingBox();
  assert.ok(imageBox && imageBox.y >= 0 && imageBox.y + imageBox.height <= 1500, 'original image should be visible in the Workbench evidence capture');
  assert.ok(videoBox && videoBox.y >= 0 && videoBox.y + videoBox.height <= 1500, 'independent video should be visible in the Workbench evidence capture');
  run.workbenchPlayback = { ...uiPlayback, outputSha256: task.video.execution.output.sha256 };
  run.canvasVideoNodes = [run.canvasVideoNode, {
    id: workbenchVideoNode.id,
    status: workbenchVideoNode.metadata.status,
    videoTaskId: workbenchVideoNode.metadata.videoTaskId,
    width: workbenchVideoNode.metadata.naturalWidth,
    height: workbenchVideoNode.metadata.naturalHeight,
    durationMs: workbenchVideoNode.metadata.durationMs,
  }];
  run.checks.push('workbench-displayed-playable-independent-video-with-original-image-retained');
  await workbenchPage.screenshot({ path: path.join(evidenceDir, `attempt-${String(run.attempt).padStart(2, '0')}-workbench-video-preview.png`), fullPage: true });

  const deliveryButton = workbenchPage.getByRole('region', { name: '视频交付确认' })
    .getByRole('button', { name: '确认视频交付并下载', exact: true });
  const [download] = await Promise.all([
    workbenchPage.waitForEvent('download', { timeout: 30_000 }),
    deliveryButton.click(),
  ]);
  assert.match(download.suggestedFilename(), /\.mp4$/iu);
  const downloadPath = await download.path();
  assert.ok(downloadPath, 'the explicit Workbench delivery action should complete a browser download');
  const workbenchExportBytes = await readFile(downloadPath);
  assert.deepEqual(workbenchExportBytes, output.bytes);
  assert.equal(digest(workbenchExportBytes), output.sha256);
  task = await waitForTask(task.id, (current) => current.video?.exports?.length === 2
    && current.video.approval?.version === 2 && current.video.approval?.sha256 === output.sha256, 'workbench video delivery export');
  assert.equal(task.video.exports.at(-1).videoVersion, 2);
  const manifestLink = workbenchPage.getByRole('link', { name: '查看交付清单', exact: true });
  await manifestLink.waitFor();
  const manifestHref = await manifestLink.getAttribute('href');
  assert.match(manifestHref || '', /\/manifest$/u);
  const manifestResponse = await workbenchPage.evaluate(async (href) => {
    const response = await fetch(href);
    return { status: response.status, text: await response.text() };
  }, manifestHref);
  assert.equal(manifestResponse.status, 200);
  const workbenchManifest = JSON.parse(manifestResponse.text);
  assert.equal(workbenchManifest.videoVersion, 2);
  assert.equal(workbenchManifest.output.sha256, output.sha256);
  assert.deepEqual(workbenchManifest.plan, { prompt: workbenchPrompt, seconds: 4, ratio: '16:9', resolution: '768' });
  assert.equal(workbenchDownloadCount, 1, 'only the explicit delivery click should download the video');
  assert.deepEqual(taskGraph(task), graphBefore, 'Workbench video approval must leave the image/text workflow graph unchanged');
  run.workbenchDelivery = {
    downloadName: download.suggestedFilename(),
    sha256: digest(workbenchExportBytes),
    bytes: workbenchExportBytes.length,
    manifestSha256: digest(Buffer.from(manifestResponse.text, 'utf8')),
    videoVersion: workbenchManifest.videoVersion,
    exportCount: task.video.exports.length,
    downloadCountBeforeRefresh: workbenchDownloadCount,
  };
  run.checks.push('workbench-explicit-delivery-downloaded-mp4-and-verified-manifest');

  await canvasPage.reload({ waitUntil: 'domcontentloaded' });
  await waitForCanvasConnection(task.id);
  assert.equal(createRequests, 2, 'Canvas refresh must not resubmit either provider job');
  assert.equal((await readTask(task.id, isolatedRoot)).video.exports.length, 2);
  const downloadCountBeforeReload = workbenchDownloadCount;
  await workbenchPage.reload({ waitUntil: 'domcontentloaded' });
  await workbenchPage.getByRole('heading', { name: task.title, exact: true }).waitFor();
  await workbenchPage.waitForFunction(() => {
    const video = document.querySelector('[aria-label="独立视频预览"] video');
    return Boolean(video && video.readyState >= 1 && video.videoWidth === 640 && video.videoHeight === 360);
  }, null, { timeout: 30_000 });
  const refreshedImage = await workbenchPage.getByRole('region', { name: '当前任务预览' })
    .locator('img[alt="第 1 页当前图片"]').evaluate((image) => ({ complete: image.complete, width: image.naturalWidth, height: image.naturalHeight }));
  assert.deepEqual(refreshedImage, { complete: true, width: 640, height: 800 });
  assert.equal(workbenchDownloadCount, downloadCountBeforeReload, 'refresh must show the export without downloading it again');
  const refreshedTask = await readTask(task.id, isolatedRoot);
  assert.equal(refreshedTask.video.exports.length, 2);
  assert.deepEqual(taskGraph(refreshedTask), graphBefore);
  assert.deepEqual(pageErrors, []);
  assert.equal(routeFailure, undefined, routeFailure?.message);
  assert.equal(run.directProviderRequests, 0, 'the browser must never contact the external MiniMax H3 host directly');
  assert.equal(statusPolls >= 4, true, 'both H3 requests should be polled to completion');
  assert.equal(imageRequests, 1);
  run.checks.push('canvas-and-workbench-refresh-did-not-resubmit-or-redownload');
  run.status = 'passed';
  run.finishedAt = new Date().toISOString();
  await canvasPage.screenshot({ path: path.join(evidenceDir, `attempt-${String(run.attempt).padStart(2, '0')}-canvas-video-complete.png`) });
  await workbenchPage.screenshot({ path: path.join(evidenceDir, `attempt-${String(run.attempt).padStart(2, '0')}-workbench-video-exported.png`), fullPage: true });
  await saveReport();
  console.log(`Video workflow verification passed: ${run.checks.length} checks, ${createRequests} local fake H3 submissions, no paid calls.`);
} catch (error) {
  run.status = 'failed';
  run.finishedAt = new Date().toISOString();
  run.failure = safeError(routeFailure || error);
  run.providerRequestCount = createRequests;
  run.providerStatusPollCount = statusPolls;
  run.contentRequestCount = contentRequests;
  run.externalCallsBlocked = run.blockedExternalHosts.length;
  await saveReport();
  console.error(`Video workflow verification failed: ${run.failure}`);
  run.failureStage = verificationStage;
  run.pageErrors = [...pageErrors];
  run.taskState = await readTask(task?.id, isolatedRoot).then((current) => ({
    revision: current.revision,
    sheetVersion: current.sheetVersion,
    sheetConfirmationVersion: current.sheetConfirmation?.version ?? null,
    executionVersion: current.execution?.version ?? null,
    executionStatus: current.execution?.status ?? null,
    pages: (current.execution?.pages || []).map(({ page, status, submitted, image }) => ({ page, status, submitted: Boolean(submitted), hasImage: Boolean(image?.sha256) })),
  })).catch(() => null);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await app?.close().catch(() => {});
  await manager?.stop().catch(() => {});
  await rm(isolatedRoot, { recursive: true, force: true }).catch(() => {});
  run.finishedAt ||= new Date().toISOString();
  await saveReport().catch(() => {});
}
