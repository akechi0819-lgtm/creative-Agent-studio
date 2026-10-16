import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { dataRoot } from '../src/canvas/client.mjs';
import { createCanvasManager } from '../src/web/canvas.mjs';
import { listenStudioServer } from '../src/web/server.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const replayIndex = process.argv.indexOf('--replay-response');
const replayPath = replayIndex >= 0 ? process.argv[replayIndex + 1] : null;
const replay = typeof replayPath === 'string' && !replayPath.startsWith('--');
const evidenceDir = path.join(repo, replay ? 'docs/evidence/p3-remote-image-recovery/canvas-replay' : 'docs/evidence/p3-canvas-live-text');
const evidenceFile = path.join(evidenceDir, 'verification.json');
const outputFile = path.join(evidenceDir, 'image.png');
const liveRequested = process.argv.includes('--live');

if (!liveRequested && !replay) {
  console.error('This script can send one paid image request. Re-run explicitly with --live after reviewing the scope.');
  process.exit(2);
}

const previousEvidence = await readFile(evidenceFile, 'utf8').then(JSON.parse).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
if (previousEvidence?.generation?.submissionAttemptStarted) {
  throw new Error('A prior live submission may have reached the provider; refusing to run again.');
}
const existingEvidence = await readdir(evidenceDir).catch((error) => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
if (existingEvidence.some((name) => name !== 'verification.json' || !previousEvidence)) {
  throw new Error('Live evidence already exists; refusing a possible duplicate paid request.');
}
await mkdir(evidenceDir, { recursive: true });

const productionConfigPath = path.join(dataRoot(), 'config', 'studio.json');
let productionRecord;
let replayServer;
let replayGenerationCalls = 0;
try {
  if (replay) {
    const captured = JSON.parse(await readFile(replayPath, 'utf8'));
    assert.ok(captured.data?.some(item => typeof item.url === 'string'), 'Replay requires a captured provider image URL response');
    replayServer = createServer(async (request, response) => {
      for await (const chunk of request) { /* consume the isolated generation request */ }
      if (request.url !== '/v1/images/generations' || request.method !== 'POST') { response.writeHead(404).end(); return; }
      replayGenerationCalls++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(captured));
    });
    await new Promise(resolve => replayServer.listen(0, '127.0.0.1', resolve));
    productionRecord = { revision: 1, image: { baseUrl: `http://127.0.0.1:${replayServer.address().port}/v1`, model: 'gpt-image-2', apiKey: 'isolated-response-replay' } };
  } else productionRecord = JSON.parse(await readFile(productionConfigPath, 'utf8'));
} catch {
  throw new Error('Could not read the production image configuration.');
}
const productionImage = productionRecord?.image;
if (!productionImage || typeof productionImage !== 'object'
  || typeof productionImage.baseUrl !== 'string' || !productionImage.baseUrl.trim()
  || typeof productionImage.model !== 'string' || !productionImage.model.trim()
  || typeof productionImage.apiKey !== 'string' || !productionImage.apiKey) {
  throw new Error('The production image configuration is incomplete.');
}
let parsedImageBase;
try { parsedImageBase = new URL(productionImage.baseUrl); }
catch { throw new Error('The production image configuration is invalid.'); }
if (!['http:', 'https:'].includes(parsedImageBase.protocol)
  || parsedImageBase.username || parsedImageBase.password || parsedImageBase.search || parsedImageBase.hash) {
  throw new Error('The production image configuration is invalid.');
}

const imageConfig = {
  baseUrl: productionImage.baseUrl.trim(),
  model: productionImage.model.trim(),
  apiKey: productionImage.apiKey,
};
const startedAt = new Date().toISOString();
const report = {
  schemaVersion: 1,
  status: 'running',
  startedAt,
  scope: replay ? 'Replay a captured real provider URL response through isolated Web and Canvas; download actual returned image, no new paid generation.' : 'One isolated, one-page text-to-image Web and Canvas execution; no references.',
  externalGenerationRequests: replay ? 0 : 1,
  fixture: { isolatedDataRoot: true, referenceImages: 0 },
  expected: { size: '768x1024', quality: 'low', count: 1 },
  canvasProxy: { routeObserved: false, calls: [] },
  generation: {
    submissionAttemptStarted: false,
    requestCount: 0,
    upstreamStatus: null,
    elapsedMs: null,
    settings: null,
  },
  output: { saved: false, path: path.relative(repo, outputFile), bytes: null, sha256: null },
};

async function saveReport() {
  await writeFile(evidenceFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await chmod(evidenceFile, 0o600);
}

function safeFailure(error) {
  let message = String(error?.message || error || 'Unknown failure');
  for (const secret of [imageConfig.apiKey, imageConfig.baseUrl]) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/(ticket|token|api[_-]?key)=([^&#\s]+)/gi, '$1=[redacted]')
    .slice(0, 1200);
}

function proxyOperation(requestUrl) {
  try {
    const parsed = new URL(requestUrl);
    const prefix = '/__studio/image-proxy/';
    if (!parsed.pathname.startsWith(prefix)) return null;
    let target;
    try { target = new URL(decodeURIComponent(parsed.pathname.slice(prefix.length))); }
    catch { return { operation: 'unknown' }; }
    const pathname = target.pathname.replace(/\/+$/, '');
    if (pathname.endsWith('/images/generations')) return { operation: 'images/generations' };
    if (pathname.endsWith('/images/edits')) return { operation: 'images/edits' };
    if (pathname.endsWith('/models')) return { operation: 'models' };
    return { operation: 'other' };
  } catch { return null; }
}

const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'studio-canvas-live-text-'));
await chmod(isolatedRoot, 0o700);
const readInMemoryConfig = async () => ({
  revision: Number.isInteger(productionRecord.revision) && productionRecord.revision > 0 ? productionRecord.revision : 1,
  basic: { baseUrl: '', model: '', apiKey: '', source: 'custom' },
  image: imageConfig,
});
const canvas = createCanvasManager({ root: isolatedRoot, readConfig: readInMemoryConfig });
let app;
let browser;
let page;
let drawing;
let taskId;
let generationStartedAt = null;
let generationCalls = 0;
let timedOut = false;
const inFlightRequests = new Map();

async function api(endpoint, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(webUrl + endpoint, {
    method,
    headers: { origin: webUrl, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = new Error(`${endpoint.split('/').at(-1)} returned HTTP ${response.status}${value.error?.code ? ` (${value.error.code})` : ''}`);
    failure.status = response.status;
    throw failure;
  }
  return value;
}

async function currentTask() {
  return (await api(`/api/tasks/${encodeURIComponent(taskId)}`)).task;
}

async function waitForJob(jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const current = (await api(`/api/jobs/${encodeURIComponent(jobId)}`)).job;
    if (current.status !== lastStatus) {
      console.log(`Canvas job status: ${current.status}`);
      lastStatus = current.status;
    }
    if (current.status === 'succeeded') return current;
    if (['failed', 'cancelled'].includes(current.status)) {
      const failure = new Error(`Canvas job ${current.status}${current.error?.code ? ` (${current.error.code})` : ''}`);
      failure.jobStatus = current.status;
      throw failure;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  timedOut = true;
  throw new Error('Canvas job did not finish within the 10-minute limit; it will not be replayed.');
}

function collectProxyRequest(request) {
  const operation = proxyOperation(request.url());
  if (!operation) return;
  report.canvasProxy.routeObserved = true;
  const entry = { method: request.method(), operation: operation.operation, httpStatus: null, elapsedMs: null };
  report.canvasProxy.calls.push(entry);
  inFlightRequests.set(request, { entry, startedAt: Date.now() });
  if (entry.method === 'POST' && entry.operation === 'images/generations') {
    generationCalls += 1;
    generationStartedAt ??= Date.now();
    report.generation.requestCount = generationCalls;
    if (generationCalls === 1) {
      try {
        const body = request.postDataJSON();
        report.generation.settings = {
          model: body.model ?? null,
          fieldNames: Object.keys(body),
          size: body.size ?? null,
          quality: body.quality ?? null,
          count: body.n ?? null,
          promptSha256: typeof body.prompt === 'string'
            ? createHash('sha256').update(body.prompt).digest('hex')
            : null,
        };
      } catch {
        report.generation.settings = { captured: false };
      }
    }
  }
}

let webUrl = '';
try {
  await saveReport();
  app = await listenStudioServer({ root: isolatedRoot, canvas, readConfig: readInMemoryConfig, port: 0 });
  webUrl = `http://127.0.0.1:${app.address.port}`;

  const proxy = process.env.HTTPS_PROXY
    ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' }
    : undefined;
  browser = await chromium.launch({ channel: 'chrome', headless: true, proxy });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  context.on('request', collectProxyRequest);
  context.on('response', (response) => {
    const record = inFlightRequests.get(response.request());
    if (!record) return;
    record.entry.httpStatus = response.status();
    record.entry.elapsedMs = Date.now() - record.startedAt;
    if (record.entry.method === 'POST' && record.entry.operation === 'images/generations') {
      report.generation.upstreamStatus = response.status();
      report.generation.elapsedMs = record.entry.elapsedMs;
      if (response.status() >= 400) {
        void response.json().then(body => {
          report.generation.error = { code: safeFailure(body?.error?.code || body?.code || ''), type: safeFailure(body?.error?.type || body?.type || ''), message: safeFailure(body?.error?.message || body?.message || 'Provider rejected the request') };
        }).catch(() => { report.generation.error = { nonJsonResponse: true }; });
      }
    }
    inFlightRequests.delete(response.request());
  });
  context.on('requestfailed', (request) => {
    const record = inFlightRequests.get(request);
    if (!record) return;
    record.entry.elapsedMs = Date.now() - record.startedAt;
    inFlightRequests.delete(request);
  });
  page = await context.newPage();
  page.on('dialog', (dialog) => { void dialog.accept(); });
  await page.goto(webUrl, { waitUntil: 'networkidle' });

  const title = `隔离纯文本生图验证 ${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const created = await api('/api/tasks', {
    title,
    brief: '单页纯文本生图链路验证：白色背景中央一个蓝色实心圆形。',
  });
  taskId = created.task.id;
  let task = await api(`/api/tasks/${encodeURIComponent(taskId)}/confirm-inputs`, {
    expectedRevision: created.task.revision,
    revision: created.task.revision,
    by: '隔离验证脚本',
    note: '仅用于验证纯文本生图浏览器链路。',
  }).then((value) => value.task);
  task = await api(`/api/tasks/${encodeURIComponent(taskId)}/set-sheet`, {
    expectedRevision: task.revision,
    inputRevision: task.inputConfirmation.revision,
    sheet: {
      title: '白底蓝色圆形',
      sourceIds: [],
      pages: [{
        page: 1,
        copy: '●',
        prompt: '纯白背景，画面中央只有一个清晰规整的蓝色实心圆形；扁平简洁图形，不要文字、阴影、渐变或其他元素。',
        size: '768x1024',
        sourceIds: [],
        referenceImages: [],
      }],
    },
  }).then((value) => value.task);
  task = await api(`/api/tasks/${encodeURIComponent(taskId)}/confirm-sheet`, {
    expectedRevision: task.revision,
    version: task.sheetVersion,
    by: '隔离验证脚本',
    note: '仅确认本次隔离任务的单页纯文本制作单。',
  }).then((value) => value.task);
  assert.equal(task.sheetVersion, 1);
  assert.equal(task.sheets.at(-1).pages[0].referenceImages.length, 0);

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: title, exact: true }).click();
  await page.getByRole('tab', { name: '制作单', exact: true }).click();
  await page.screenshot({ path: path.join(evidenceDir, 'workbench.png') });

  const drawingPopup = page.waitForEvent('popup');
  await page.locator('.canvas-open').click();
  drawing = await drawingPopup;
  drawing.on('dialog', (dialog) => { void dialog.accept(); });
  await drawing.waitForURL(/\/canvas(?:\?|\/|#)/, { timeout: 20_000 });
  const canvasDeadline = Date.now() + 30_000;
  while (Date.now() < canvasDeadline && !(await canvas.state(taskId)).clientConnected) {
    await drawing.waitForTimeout(250);
  }
  assert.equal((await canvas.state(taskId)).clientConnected, true, 'Canvas browser must connect to the isolated task.');
  await drawing.screenshot({ path: path.join(evidenceDir, 'canvas-ready.png') });

  const executeResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/execute'));
  report.generation.submissionAttemptStarted = true;
  await saveReport();
  await page.getByRole('button', { name: `确认 v${task.sheetVersion} 并开始绘图`, exact: true }).click();
  const executeBody = await (await executeResponse).json();
  assert.ok(executeBody.job?.id, 'The Web UI should start one Canvas execute job.');
  await waitForJob(executeBody.job.id, 10 * 60_000);

  task = await currentTask();
  assert.equal(task.execution.status, 'succeeded');
  assert.equal(task.execution.pages.length, 1);
  assert.equal(task.execution.pages[0].page, 1);
  assert.equal(task.execution.pages[0].status, 'succeeded');
  const pageImage = task.execution.pages[0].image;
  assert.ok(pageImage?.imageUrl && /^[a-f0-9]{64}$/i.test(pageImage.sha256 || ''), 'The Web task should contain a verified generated image.');
  const imageResponse = await fetch(webUrl + pageImage.imageUrl);
  if (!imageResponse.ok) throw new Error(`Generated image download returned HTTP ${imageResponse.status}.`);
  const imageBytes = Buffer.from(await imageResponse.arrayBuffer());
  const imageSha256 = createHash('sha256').update(imageBytes).digest('hex');
  assert.equal(imageSha256, pageImage.sha256, 'Saved image bytes must match the task SHA-256.');
  assert.deepEqual([...imageBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'The generated output should be a PNG.');
  await writeFile(outputFile, imageBytes, { mode: 0o600 });
  await chmod(outputFile, 0o600);

  assert.equal(report.canvasProxy.routeObserved, true, 'Canvas must use the same-origin image proxy.');
  assert.equal(generationCalls, 1, 'Exactly one text-to-image request should be submitted.');
  assert.equal(report.generation.settings?.size, '768x1024');
  assert.equal(report.generation.settings?.quality, 'low');
  assert.equal(report.generation.settings?.count, 1);
  assert.ok(report.canvasProxy.calls.some((call) => call.method === 'POST' && call.operation === 'images/generations'));
  report.status = 'passed';
  report.finishedAt = new Date().toISOString();
  report.generation.elapsedMs ??= generationStartedAt == null ? null : Date.now() - generationStartedAt;
  report.output = {
    saved: true,
    path: path.relative(repo, outputFile),
    bytes: imageBytes.length,
    sha256: imageSha256,
  };
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: '成品审核', exact: true }).click();
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.review-image-wrap img')];
    return images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0);
  }, undefined, { timeout: 30_000 });
  report.webPreviewVisible = true;
  await page.screenshot({ path: path.join(evidenceDir, 'web-image-visible.png') });
  await drawing.screenshot({ path: path.join(evidenceDir, 'canvas-generated.png') });
} catch (error) {
  report.status = 'failed';
  report.finishedAt = new Date().toISOString();
  report.failure = safeFailure(error);
  if (timedOut) report.timedOutAfterMs = 10 * 60_000;
  if (report.generation.submissionAttemptStarted && !report.generation.elapsedMs && generationStartedAt != null) {
    report.generation.elapsedMs = Date.now() - generationStartedAt;
  }
  process.exitCode = 1;
  console.error(report.failure);
} finally {
  await browser?.close().catch(() => {});
  await app?.close().catch(() => {});
  await canvas.stop().catch(() => {});
  if (replayServer) { replayServer.closeAllConnections(); await new Promise(resolve => replayServer.close(resolve)); report.replayedGenerationCalls = replayGenerationCalls; }
  await rm(isolatedRoot, { recursive: true, force: true }).catch(() => {});
  await saveReport().catch(() => {});
}

console.log(JSON.stringify({
  status: report.status,
  submissionAttemptStarted: report.generation.submissionAttemptStarted,
  proxyRouteObserved: report.canvasProxy.routeObserved,
  generationRequestCount: report.generation.requestCount,
  upstreamStatus: report.generation.upstreamStatus,
  elapsedMs: report.generation.elapsedMs,
  outputBytes: report.output.bytes,
  outputSha256: report.output.sha256,
}));
