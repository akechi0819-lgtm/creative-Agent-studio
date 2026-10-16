import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { listenStudioServer } from '../src/web/server.mjs';
import { saveConfig, readConfig } from '../src/web/config.mjs';
import { createCanvasManager } from '../src/web/canvas.mjs';
import { dataRoot } from '../src/canvas/client.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const live = process.argv.includes('--live');
const retryFixture = !live && process.argv.includes('--retry');
const evidenceDir = path.join(repo, live ? 'docs/evidence/p3-reference-images-live' : retryFixture ? 'docs/evidence/p3-reference-images-retry' : 'docs/evidence/p3-reference-images');
await mkdir(evidenceDir, { recursive: true });

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = {
  date: new Date().toISOString(),
  scope: live
    ? '隔离任务与真实 Web/Canvas 图生图链路；Canvas 仅连本地捕获代理，图片请求转发到已配置的真实图片服务'
    : '隔离任务、本地假图片上游、真实 Web UI 与 Canvas 图生图链路；不调用收费或外部模型',
  live,
  status: 'running',
  paidRequests: false,
  checks: [],
};

function resolveLiveEditEndpoint(baseUrl) {
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch { throw new Error('生产图片模型服务地址无效'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('生产图片模型服务地址无效');
  }
  const basePath = endpoint.pathname.replace(/\/+$/, '');
  const versionedPath = basePath.toLowerCase().endsWith('/v1') ? basePath : basePath + '/v1';
  endpoint.pathname = versionedPath + '/images/edits';
  return endpoint.toString();
}

async function readProductionImageConfig() {
  const raw = await readFile(path.join(dataRoot(), 'config', 'studio.json'), 'utf8');
  const fullRecord = JSON.parse(raw);
  const image = fullRecord?.image;
  if (!image || typeof image !== 'object'
    || typeof image.baseUrl !== 'string' || !image.baseUrl.trim()
    || typeof image.model !== 'string' || !image.model.trim()
    || typeof image.apiKey !== 'string' || !image.apiKey.trim()) {
    throw new Error('生产图片模型配置未完整设置');
  }
  return {
    baseUrl: image.baseUrl.trim(),
    model: image.model.trim(),
    apiKey: image.apiKey,
  };
}

let liveImageConfig = null;
let liveEditEndpoint = null;
if (live) {
  try {
    liveImageConfig = await readProductionImageConfig();
    liveEditEndpoint = resolveLiveEditEndpoint(liveImageConfig.baseUrl);
  } catch (error) {
    report.status = 'failed';
    report.error = error.message === '生产图片模型配置未完整设置' || error.message === '生产图片模型服务地址无效'
      ? error.message
      : '无法读取本机生产图片模型配置';
    report.localUpstreamOnly = false;
    await writeFile(path.join(evidenceDir, 'verification.json'), JSON.stringify(report, null, 2));
    console.error(report.error);
    process.exit(1);
  }
}

const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'studio-reference-images-'));
const layoutPath = path.join(repo, 'adapters/dsh/connection-check.png');
const appMarkPath = path.join(repo, 'web/public/brand/whale-artist.png');
const layoutBytes = await readFile(layoutPath);
const appMarkBytes = await readFile(appMarkPath);
const outputBytes = layoutBytes;
const expectedImages = [
  { filename: 'connection-check.png', bytes: layoutBytes, sha256: sha256(layoutBytes), fixtureRole: '版式参考夹具' },
  { filename: 'whale-artist.png', bytes: appMarkBytes, sha256: sha256(appMarkBytes), fixtureRole: '隔离应用图标夹具，不代表用户业务 Logo' },
];

const modelRequests = [];
let modelEditRequests = 0;
let textGenerationRequests = 0;
let liveForwardCount = 0;
let duplicateLiveRequestsBlocked = false;
let multipartCapture = null;
let liveUpstreamEvidence = null;

const imageModel = live ? liveImageConfig.model : 'mock-image';

function safeErrorLabel(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (liveImageConfig?.apiKey && normalized.includes(liveImageConfig.apiKey)) return null;
  return /^[a-zA-Z0-9_.-]{1,100}$/.test(normalized) ? normalized : null;
}

function genericUpstreamMessage(status, code, type) {
  const label = (code || type || '').toLowerCase();
  if (label === 'upstream_error' || label === 'server_error') return 'Upstream image service error.';
  if (label === 'rate_limit_exceeded' || status === 429) return 'Image service rate limit reached.';
  if (label === 'insufficient_quota') return 'Image service quota is unavailable.';
  if (status === 401 || status === 403) return 'Image service authentication was rejected.';
  if (status === 404) return 'Image edit endpoint was not found.';
  if (status != null && status >= 500) return 'Upstream image service error.';
  if (status != null && status >= 400) return 'Image edit request was rejected.';
  return 'Image edit response received.';
}

function summarizedMultipartCapture() {
  if (!multipartCapture) return null;
  const safeFields = new Set(['model', 'prompt', 'n', 'response_format', 'output_format', 'quality', 'size', 'background']);
  return {
    method: multipartCapture.method,
    path: multipartCapture.path,
    contentType: multipartCapture.contentType,
    bodyByteLength: multipartCapture.bodyByteLength,
    bodySha256: multipartCapture.bodySha256,
    imageField: 'image[]',
    imageCount: multipartCapture.images.length,
    images: multipartCapture.images.map((image) => ({
      field: image.field,
      filename: image.filename,
      mimeType: image.mimeType,
      byteLength: image.byteLength,
      sha256: image.sha256,
      matchesUploadedFixture: expectedImages.some((expected) => expected.sha256 === image.sha256),
    })),
    capturedNonImageFields: multipartCapture.fields.filter((field) => safeFields.has(field.field)),
  };
}

function parseMultipart(body, contentType) {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.slice(1).find(Boolean);
  if (!boundary) throw new Error('Fake model received multipart without a boundary');
  const delimiter = Buffer.from('--' + boundary);
  const separator = Buffer.from('\r\n\r\n');
  const parts = [];
  let cursor = 0;
  while (true) {
    const start = body.indexOf(delimiter, cursor);
    if (start < 0) break;
    let headerStart = start + delimiter.length;
    if (body.subarray(headerStart, headerStart + 2).toString() === '--') break;
    if (body.subarray(headerStart, headerStart + 2).toString() === '\r\n') headerStart += 2;
    const next = body.indexOf(delimiter, headerStart);
    if (next < 0) break;
    let segment = body.subarray(headerStart, next);
    if (segment.subarray(-2).toString() === '\r\n') segment = segment.subarray(0, -2);
    const split = segment.indexOf(separator);
    if (split < 0) throw new Error('Fake model received a malformed multipart part');
    const headers = segment.subarray(0, split).toString('utf8');
    const content = segment.subarray(split + separator.length);
    const disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
    const field = disposition.match(/(?:^|;)\s*name="([^"]*)"/i)?.[1] || '';
    const filename = disposition.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1] || '';
    const mimeType = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || '';
    parts.push({ field, filename, mimeType, bytes: Buffer.from(content) });
    cursor = next;
  }
  return parts;
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const fakeImageServer = createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'authorization,content-type');
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  response.setHeader('access-control-max-age', '600');
  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  modelRequests.push({ method: request.method, path: pathname });
  if (pathname.endsWith('/models')) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: imageModel }, { id: 'mock-base' }] }));
    return;
  }
  if (pathname.endsWith('/images/edits')) {
    modelEditRequests += 1;
    const body = await readRequestBody(request);
    const parts = parseMultipart(body, String(request.headers['content-type'] || ''));
    const images = parts.filter((part) => part.field === 'image[]' || part.field === 'image');
    multipartCapture = {
      method: request.method,
      path: pathname,
      contentType: String(request.headers['content-type'] || ''),
      bodyByteLength: body.length,
      bodySha256: sha256(body),
      fields: parts.filter((part) => !part.field.startsWith('image')).map((part) => ({
        field: part.field,
        value: part.bytes.toString('utf8'),
      })),
      images: images.map((part) => ({
        field: part.field,
        filename: part.filename,
        mimeType: part.mimeType,
        bytes: part.bytes,
        sha256: sha256(part.bytes),
        byteLength: part.bytes.length,
      })),
    };
    report.canvasEditRequest = summarizedMultipartCapture();
    if (live) {
      if (liveForwardCount >= 1) {
        duplicateLiveRequestsBlocked = true;
        if (liveUpstreamEvidence) liveUpstreamEvidence.duplicateRequestsBlocked = true;
        response.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ error: { code: 'duplicate_live_request_blocked', type: 'client_error', message: 'A second live image edit request is blocked.' } }));
        return;
      }
      liveForwardCount += 1;
      report.paidRequests = true;
      const startedAt = Date.now();
      try {
        const upstream = await fetch(liveEditEndpoint, {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + liveImageConfig.apiKey,
            'content-type': String(request.headers['content-type'] || ''),
            ...(typeof request.headers.accept === 'string' ? { accept: request.headers.accept } : {}),
          },
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(live ? 600_000 : 120_000),
        });
        const upstreamBytes = Buffer.from(await upstream.arrayBuffer());
        let upstreamError = {};
        try {
          const parsed = JSON.parse(upstreamBytes.toString('utf8'));
          upstreamError = parsed?.error && typeof parsed.error === 'object' ? parsed.error : {};
        } catch {}
        const errorCode = safeErrorLabel(upstreamError.code);
        const errorType = safeErrorLabel(upstreamError.type);
        liveUpstreamEvidence = {
          httpStatus: upstream.status,
          elapsedMs: Date.now() - startedAt,
          errorCode,
          errorType,
          genericMessage: genericUpstreamMessage(upstream.status, errorCode, errorType),
          forwardedContentType: String(request.headers['content-type'] || ''),
          forwardedBodySha256: sha256(body),
          duplicateRequestsBlocked: false,
        };
        report.liveUpstream = liveUpstreamEvidence;
        response.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') || 'application/json',
          'cache-control': 'no-store',
        });
        response.end(upstreamBytes);
      } catch (error) {
        const errorCode = safeErrorLabel(error?.cause?.code) || safeErrorLabel(error?.code);
        liveUpstreamEvidence = {
          httpStatus: null,
          elapsedMs: Date.now() - startedAt,
          errorCode,
          errorType: safeErrorLabel(error?.name) || 'transport_error',
          genericMessage: 'Could not reach the configured image service.',
          forwardedContentType: String(request.headers['content-type'] || ''),
          forwardedBodySha256: sha256(body),
          duplicateRequestsBlocked: false,
        };
        report.liveUpstream = liveUpstreamEvidence;
        response.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ error: { code: 'upstream_error', type: 'server_error', message: 'Upstream image service error.' } }));
      }
      return;
    }
    if (retryFixture && modelEditRequests === 1) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Isolated first-attempt failure' } }));
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ created: 1, data: [{ b64_json: outputBytes.toString('base64') }] }));
    return;
  }
  if (pathname.endsWith('/images/generations')) {
    textGenerationRequests += 1;
    await readRequestBody(request);
    if (live) {
      response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: { code: 'text_generation_disabled', type: 'client_error', message: 'Live verifier forwards image edits only.' } }));
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ created: 1, data: [{ b64_json: outputBytes.toString('base64') }] }));
    return;
  }
  await readRequestBody(request);
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { message: 'local fixture endpoint not found' } }));
});

await new Promise((resolve) => fakeImageServer.listen(0, '127.0.0.1', resolve));
const fakeImageBaseUrl = 'http://127.0.0.1:' + fakeImageServer.address().port + '/v1';
await saveConfig({
  expectedRevision: 1,
  base: { baseUrl: fakeImageBaseUrl, model: 'mock-base', apiKey: 'fixture-only' },
  image: { baseUrl: fakeImageBaseUrl, model: imageModel, apiKey: 'fixture-only' },
}, { root: isolatedRoot });

const readLocalConfig = () => readConfig({ root: isolatedRoot });
const canvas = createCanvasManager({ root: isolatedRoot, readConfig: readLocalConfig });
if (retryFixture) {
  const executionOptions = canvas.executionOptions;
  canvas.executionOptions = async (...args) => {
    const options = await executionOptions(...args);
    const tool = options.tool;
    options.tool = async (name, ...input) => {
      const result = await tool(name, ...input);
      (report.retryToolTrace ||= []).push({ name, keys: Object.keys(result || {}), tasks: result?.tasks?.map(item => ({ status: item.status })), nodes: result?.nodes?.map(item => ({ type: item.type, keys: Object.keys(item.metadata || {}), contentLength: item.metadata?.content?.length, storageKeyPresent: Boolean(item.metadata?.storageKey) })) });
      return result;
    };
    return options;
  };
}
const app = await listenStudioServer({ root: isolatedRoot, canvas, readConfig: readLocalConfig, port: 0 });
const webUrl = 'http://127.0.0.1:' + app.address.port;
let browser;
let page;
let drawing;
const pageErrors = [];

async function request(endpoint, value, method = value === undefined ? 'GET' : 'POST') {
  const isForm = typeof FormData !== 'undefined' && value instanceof FormData;
  const response = await fetch(webUrl + endpoint, {
    method,
    headers: { origin: webUrl, ...(value === undefined || isForm ? {} : { 'content-type': 'application/json' }) },
    ...(value === undefined ? {} : { body: isForm ? value : JSON.stringify(value) }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(endpoint + ': ' + (body.error?.code || response.status) + ' ' + (body.error?.message || 'request failed'));
  return body;
}

async function waitForJob(jobValue) {
  const deadline = Date.now() + (live ? 660_000 : 120_000);
  let previousStatus = '';
  while (Date.now() < deadline) {
    const current = (await request('/api/jobs/' + encodeURIComponent(jobValue.id))).job;
    if (current.status !== previousStatus) {
      console.log(current.kind + ': ' + current.status);
      previousStatus = current.status;
    }
    if (current.status === 'succeeded') return current;
    if (['failed', 'cancelled'].includes(current.status)) {
      throw new Error(current.kind + ' job ' + current.status + ': ' + (current.error?.message || ''));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Local fixture job did not finish in time');
}

async function taskDetail(taskId) {
  return request('/api/tasks/' + encodeURIComponent(taskId));
}

async function waitForTask(taskId, predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await taskDetail(taskId);
    if (predicate(detail.task, detail)) return detail;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for ' + label);
}

async function acceptConfirm(button) {
  const dialogPromise = page.waitForEvent('dialog');
  const clickPromise = button.click();
  const dialog = await dialogPromise;
  assert.equal(dialog.type(), 'confirm');
  const message = dialog.message();
  await dialog.accept();
  await clickPromise;
  return message;
}

try {
  const layoutFixture = await readFile(layoutPath);
  const appMarkFixture = await readFile(appMarkPath);
  assert.deepEqual([sha256(layoutFixture), sha256(appMarkFixture)], expectedImages.map((item) => item.sha256));

  const created = (await request('/api/tasks', {
    title: '本地参考图链路夹具',
    brief: {
      content: '隔离软件验收：制作一张简洁版式测试图，检查参考图片能否随任务传入绘图模型。第二个文件只作为本地应用图标夹具，不是业务 Logo。',
      audience: '本地软件验收',
      goal: '验证真实图片引用链路',
      style: '简洁版式',
      size: '3:4',
      pageCount: 1,
      format: 'poster',
    },
  })).task;
  let task = created;

  const sourceIds = [];
  for (const image of expectedImages) {
    const form = new FormData();
    form.set('expectedRevision', String(task.revision));
    form.set('uploadId', randomUUID());
    form.set('instructions', image.fixtureRole + '；仅用于隔离链路验收，不代表业务内容。');
    form.append('files', new Blob([image.bytes], { type: 'image/png' }), image.filename);
    const uploaded = await request('/api/tasks/' + task.id + '/attachments', form);
    task = uploaded.task;
    assert.equal(uploaded.replayed, false);
    const source = task.sources.find((item) => item.id === uploaded.sourceId);
    assert.ok(source, 'Uploaded fixture must be present in task sources');
    assert.equal(source.files.length, 1);
    assert.equal(source.files[0].sha256, image.sha256);
    assert.equal(source.files[0].mimeType, 'image/png');
    sourceIds.push(source.id);
  }

  const retained = await request('/api/tasks/' + task.id + '/references', {
    expectedRevision: task.revision,
    items: task.sources.map((source, index) => ({
      kind: 'existing',
      id: source.id,
      decision: 'retained',
      purpose: expectedImages[index].fixtureRole,
      factBoundary: '仅用于本地链路测试；不得当作用户业务事实或实际品牌资产。',
    })),
  });
  task = retained.task;
  assert.ok(task.sources.every((source) => source.decision === 'retained'));

  task = (await request('/api/tasks/' + task.id + '/confirm-inputs', {
    expectedRevision: task.revision,
    revision: task.revision,
    by: '本地验收夹具',
    note: '仅确认两份隔离测试图片和虚构需求，用于检查参考图片实际传输链路。',
  })).task;
  assert.ok(task.inputConfirmation);

  const firstImageReference = { sourceId: sourceIds[0], fileOrder: 1 };
  task = (await request('/api/tasks/' + task.id + '/set-sheet', {
    expectedRevision: task.revision,
    inputRevision: task.inputConfirmation.revision,
    sheet: {
      title: '本地参考图链路验收',
      sourceIds: [sourceIds[0]],
      pages: [{
        page: 1,
        copy: '参考图片传输测试',
        prompt: '生成一张简洁、清晰的图像，按已选参考图片进行图生图链路验收；仅使用虚构验收文案。',
        size: '3:4',
        sourceIds: [sourceIds[0]],
        referenceImages: [firstImageReference],
      }],
    },
  })).task;
  assert.equal(task.sheetVersion, 1);
  assert.deepEqual(task.sheets.at(-1).pages[0].referenceImages, [firstImageReference]);
  report.taskId = task.id;
  report.fixtureSources = expectedImages.map((image, index) => ({
    sourceId: sourceIds[index],
    filename: image.filename,
    fileOrder: 1,
    sha256: image.sha256,
    fixtureRole: image.fixtureRole,
    decision: 'retained',
  }));
  report.fixtureLogoNote = 'whale-artist.png is an isolated application icon fixture used only to verify image transport; it is not a user business logo.';
  report.checks.push('web-api-created-isolated-task-and-uploaded-real-png-fixtures', 'retained-source-snapshots-hash-verified', 'initial-v1-sheet-persists-first-reference');

  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined;
  browser = await chromium.launch({ channel: 'chrome', headless: true, proxy });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(webUrl, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '本地参考图链路夹具', exact: true }).click();
  await page.getByRole('heading', { name: '本地参考图链路夹具', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('tab', { name: '制作单', exact: true }).click();

  const layoutCheckbox = page.getByRole('checkbox', { name: /传图 connection-check\.png/ });
  const appMarkCheckbox = page.getByRole('checkbox', { name: /传图 whale-artist\.png/ });
  await layoutCheckbox.waitFor({ state: 'visible' });
  await appMarkCheckbox.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.sheet-reference-choice').count(), 2, 'Both retained PNG files should be selectable thumbnails');
  await page.waitForFunction(() => [...document.querySelectorAll('.sheet-reference-choice img')].length === 2
    && [...document.querySelectorAll('.sheet-reference-choice img')].every((image) => image.complete && image.naturalWidth > 0));
  assert.equal(await layoutCheckbox.isChecked(), true, 'The initial v1 layout reference should appear checked');
  assert.equal(await appMarkCheckbox.isChecked(), false, 'The second retained image should be selectable and initially unchecked');
  await appMarkCheckbox.check();
  assert.equal(await appMarkCheckbox.isChecked(), true);
  await page.locator('.sheet-reference-choice').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidenceDir, 'reference-images-desktop.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  report.checks.push('browser-workbench-renders-retained-image-and-app-mark-thumbnails', 'ui-selects-second-retained-image');

  const setSheetResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/set-sheet'));
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  const savedResponse = await setSheetResponse;
  assert.equal(savedResponse.status(), 200);
  const secondVersionDetail = await waitForTask(task.id, (current) => current.sheetVersion === 2
    && current.sheets.at(-1)?.pages?.[0]?.referenceImages?.length === 2, 'saved referenceImages v2');
  task = secondVersionDetail.task;
  const savedPage = task.sheets.at(-1).pages[0];
  assert.deepEqual(savedPage.referenceImages, [
    firstImageReference,
    { sourceId: sourceIds[1], fileOrder: 1 },
  ]);
  assert.deepEqual(savedPage.sourceIds, sourceIds);
  assert.deepEqual(task.sheets.at(-1).sourceIds, sourceIds);
  assert.equal(task.sheetConfirmation, null, 'Saving a changed reference must leave the new version unconfirmed');
  report.savedVersion = {
    version: task.sheetVersion,
    referenceImages: savedPage.referenceImages,
    pageSourceIds: savedPage.sourceIds,
    sheetSourceIds: task.sheets.at(-1).sourceIds,
    confirmationBeforeUserAction: task.sheetConfirmation,
  };
  report.checks.push('ui-save-creates-v2-with-two-persisted-referenceImages-and-invalidates-confirmation');
  await page.getByRole('button', { name: '确认 v2', exact: true }).waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(evidenceDir, 'reference-images-v2-desktop.png') });

  await page.getByRole('button', { name: '确认 v2', exact: true }).click();
  task = (await waitForTask(task.id, (current) => current.sheetConfirmation?.version === 2, 'v2 confirmation')).task;
  report.checks.push('ui-confirms-the-new-reference-version');

  const canvasPopupPromise = page.waitForEvent('popup');
  await page.locator('.canvas-open').click();
  drawing = await canvasPopupPromise;
  drawing.on('pageerror', (error) => pageErrors.push(error.message));
  await drawing.waitForURL(/\/canvas(?:\?|\/|#)/, { timeout: 20_000 });
  const canvasDeadline = Date.now() + 30_000;
  while (Date.now() < canvasDeadline && !(await canvas.state(task.id)).clientConnected) {
    await drawing.waitForTimeout(150);
  }
  assert.equal((await canvas.state(task.id)).clientConnected, true, 'The isolated Canvas should connect to the selected task');
  await drawing.screenshot({ path: path.join(evidenceDir, 'reference-images-canvas-ready.png') });

  const executeResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/execute'));
  await page.getByRole('button', { name: '确认 v2 并开始绘图', exact: true }).click();
  const executeResult = await (await executeResponse).json();
  assert.ok(executeResult.job?.id, 'UI execute action should create a Web job');
  if (retryFixture) {
    await assert.rejects(waitForJob(executeResult.job), /job failed/);
    await waitForTask(task.id, (current) => current.execution?.pages?.[0]?.status === 'failed', 'first-attempt failure');
    const resumeResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/resume'));
    const retryMessage = await acceptConfirm(page.getByRole('button', { name: '重试失败页并继续', exact: true }));
    assert.match(retryMessage, /重试第 1 页/);
    const retryResponse = await resumeResponse;
    assert.equal((await retryResponse.request().postDataJSON()).retryPage, 1);
    const retried = await retryResponse.json();
    await waitForJob(retried.job);
    report.checks.push('failed-page-primary-button-confirms-and-sends-explicit-retryPage', 'failed-page-retry-completes-with-reference-images');
  } else {
    await waitForJob(executeResult.job);
  }
  const completed = await waitForTask(task.id, (current) => current.execution?.status === 'succeeded', 'Canvas reference-image execution');
  task = completed.task;
  assert.equal(task.execution.pages.length, 1);
  assert.equal(task.execution.pages[0].status, 'succeeded');
  assert.equal(task.execution.pages[0].referenceNodes.length, 2);
  assert.deepEqual(task.execution.pages[0].referenceNodes.map((item) => ({
    sourceId: item.sourceId,
    fileOrder: item.fileOrder,
    sha256: item.sha256,
  })), expectedImages.map((image, index) => ({
    sourceId: sourceIds[index],
    fileOrder: 1,
    sha256: image.sha256,
  })));
  assert.equal(modelEditRequests, retryFixture ? 2 : 1, 'Canvas must submit only the explicitly requested attempts');
  assert.equal(textGenerationRequests, 0, 'Canvas must not fall back to text-only generation');
  assert.equal(multipartCapture?.method, 'POST');
  assert.equal(multipartCapture?.path, '/v1/images/edits');
  assert.equal(multipartCapture?.images.length, 2);
  assert.ok(multipartCapture.images.every((image) => image.field === 'image[]'));
  assert.deepEqual(multipartCapture.images.map((image) => image.sha256), expectedImages.map((image) => image.sha256));
  assert.deepEqual(multipartCapture.images.map((image) => image.byteLength), expectedImages.map((image) => image.bytes.length));
  report.canvasEditRequest = summarizedMultipartCapture();
  report.canvasExecution = {
    status: task.execution.status,
    version: task.execution.version,
    pageCount: task.execution.pages.length,
    referenceNodes: task.execution.pages[0].referenceNodes.map(({ sourceId, fileOrder, sha256: digest }) => ({ sourceId, fileOrder, sha256: digest })),
    outputSha256: task.execution.pages[0].image.sha256,
  };
  report.fakeModelRequests = modelRequests;
  report.checks.push('canvas-posts-two-exact-source-pngs-to-local-images-edits', 'zero-text-only-generation-requests', 'canvas-execution-records-both-reference-nodes');
  if (live) {
    const generatedImagePath = path.join(evidenceDir, 'live-generated-page-1.png');
    const generatedImageResponse = await fetch(webUrl + task.execution.pages[0].image.imageUrl);
    assert.equal(generatedImageResponse.status, 200);
    const generatedImageBytes = Buffer.from(await generatedImageResponse.arrayBuffer());
    assert.equal(sha256(generatedImageBytes), task.execution.pages[0].image.sha256);
    await writeFile(generatedImagePath, generatedImageBytes);
    report.generatedOutput = {
      file: path.basename(generatedImagePath),
      byteLength: generatedImageBytes.length,
      sha256: sha256(generatedImageBytes),
    };
    report.checks.push('actual-recovered-live-image-saved-to-evidence');
  }

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '本地参考图链路夹具', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('tab', { name: '制作单', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '切换对话和工作对象', exact: true }).click();
  await page.locator('.object-panel.mobile-visible').waitFor({ state: 'visible' });
  await page.locator('.sheet-reference-choice').last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(evidenceDir, 'reference-images-mobile.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'The 390px workbench should not overflow horizontally');
  assert.deepEqual(pageErrors, []);
  report.checks.push('1440px-desktop-screenshot', '390px-mobile-screenshot-without-horizontal-overflow', 'no-browser-runtime-errors');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  const redactLiveKey = (value) => {
    const text = String(value ?? '');
    return liveImageConfig?.apiKey ? text.split(liveImageConfig.apiKey).join('[redacted]') : text;
  };
  report.error = redactLiveKey(error.message).replace(/https?:\/\/[^\s]+/g, '[local fixture URL]');
  if (page) {
    report.browserErrors = pageErrors.map(redactLiveKey);
    report.failureView = redactLiveKey(await page.locator('body').innerText().catch(() => '')).slice(0, 5000);
    if (!live) await page.screenshot({ path: path.join(evidenceDir, 'reference-images-failure.png') }).catch(() => {});
  }
  console.error(report.error);
  process.exitCode = 1;
} finally {
  report.fakeModelEditRequests = modelEditRequests;
  report.textGenerationRequests = textGenerationRequests;
  report.liveForwardAttempts = liveForwardCount;
  if (liveUpstreamEvidence) liveUpstreamEvidence.duplicateRequestsBlocked = duplicateLiveRequestsBlocked;
  report.duplicateLiveRequestsBlocked = duplicateLiveRequestsBlocked;
  report.localUpstreamOnly = !live;
  await writeFile(path.join(evidenceDir, 'verification.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  await canvas.stop();
  await app.close();
  fakeImageServer.closeAllConnections();
  await new Promise((resolve) => fakeImageServer.close(resolve));
  await rm(isolatedRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: report.status, checks: report.checks, editRequests: modelEditRequests, textGenerationRequests }));
