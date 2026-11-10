import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { unzipSync } from 'fflate';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { listenStudioServer } from '../src/web/server.mjs';
import { saveConfig, readConfig } from '../src/web/config.mjs';
import { createCanvasManager } from '../src/web/canvas.mjs';
import { createTask, confirmInputs, setSheet, confirmSheet, readTask, taskDirectory } from '../src/creative/tasks.mjs';
import { executeTask } from '../src/creative/executor.mjs';
import { editTaskPages } from '../src/creative/page-edits.mjs';
import { adoptCanvasResult } from '../src/creative/mechanical-products.mjs';
import { saveLogoVariant } from '../src/creative/canvas-operations.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const evidenceDir = path.join(repo, 'docs/evidence/media-workflows');
const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'studio-media-workflows-'));
const staticDir = path.join(isolatedRoot, 'static');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requests = [];
let imageServer;
let app;
let canvas;
let browser;
let page;
let drawingPage;
let report = { date: new Date().toISOString(), status: 'running', paidRequests: false, realCanvas: true, checks: [] };

async function requestBytes(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function imageRequest(request, bytes) {
  const contentType = String(request.headers['content-type'] || '');
  if (contentType.includes('multipart/form-data')) {
    const parsed = new Request('http://127.0.0.1/image-request', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: bytes,
    });
    const form = await parsed.formData();
    return {
      quality: form.has('quality') ? String(form.get('quality')) : null,
      prompt: String(form.get('prompt') || ''),
      size: String(form.get('size') || ''),
      images: [...form.keys()].filter((key) => key === 'image' || key === 'image[]').length,
    };
  }
  const body = JSON.parse(bytes.toString('utf8'));
  return {
    quality: Object.hasOwn(body, 'quality') ? String(body.quality) : null,
    prompt: String(body.prompt || ''),
    size: String(body.size || ''),
    images: Array.isArray(body.images) ? body.images.length : 0,
  };
}

function fixtureImage(index) {
  const canvas = createCanvas(900, 1200);
  const context = canvas.getContext('2d');
  const palette = ['#e6f0f2', '#f4eadc', '#e6eee2', '#eee7f4', '#f2e5e8'];
  context.fillStyle = palette[index % palette.length];
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = ['#237a91', '#ca7640', '#548351', '#7652a1', '#a74868'][index % 5];
  context.fillRect(72, 170, 756, 230);
  context.fillStyle = '#24313a';
  context.font = 'bold 48px sans-serif';
  context.fillText(`Local fixture ${index + 1}`, 72, 500);
  context.fillStyle = '#52636b';
  context.fillRect(72, 570, 610, 20);
  context.fillRect(72, 620, 510, 20);
  return canvas.toBuffer('image/png');
}

function transparentLogo() {
  const image = createCanvas(16, 16);
  const context = image.getContext('2d');
  context.fillStyle = '#22a45c';
  context.fillRect(5, 5, 6, 6);
  context.globalAlpha = 0.5;
  context.fillRect(2, 8, 1, 1);
  context.globalAlpha = 1;
  return image.toBuffer('image/png');
}

async function pixelAt(dataUrl, x, y) {
  const image = await loadImage(dataUrl);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return [...context.getImageData(x, y, 1, 1).data];
}

function safeError(error) {
  return String(error?.message || error?.name || 'verification_failed')
    .replace(/https?:\/\/[^\s)]+/g, '[local-url]')
    .replace(/(?:studioBootstrap=|token=)[a-f0-9]{16,}/gi, '[redacted]')
    .replace(/fixture-only-secret/g, '[redacted]')
    .slice(0, 1000);
}

async function waitForCanvas(taskId, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await canvas.state(taskId);
    if (state.state === 'ready' && state.clientConnected) return state;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Canvas browser did not connect to the isolated task.');
}

async function readCanvasSnapshot(taskId) {
  const options = await canvas.executionOptions(taskId);
  return options.tool('canvas_get_state', {}, options.config);
}

try {
  await mkdir(evidenceDir, { recursive: true });
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

  imageServer = createServer(async (request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', 'authorization,content-type');
    response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    response.setHeader('cache-control', 'no-store');
    if (request.method === 'OPTIONS') return response.writeHead(204).end();
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && pathname.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ data: [{ id: 'fixture-image' }] }));
    }
    if (request.method === 'POST' && (pathname.endsWith('/images/generations') || pathname.endsWith('/images/edits'))) {
      const operation = pathname.endsWith('/images/edits') ? 'edit' : 'generation';
      const body = await requestBytes(request);
      const captured = await imageRequest(request, body);
      const record = {
        operation,
        quality: captured.quality,
        size: captured.size,
        promptSha256: digest(Buffer.from(captured.prompt, 'utf8')),
        hasEditOneMarker: captured.prompt.includes('EDIT_ONE_ONLY'),
        hasEditTwoMarker: captured.prompt.includes('EDIT_TWO_ONLY'),
        imageCount: captured.images,
      };
      requests.push(record);
      const output = fixtureImage(requests.length - 1);
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ created: 1, data: [{ b64_json: output.toString('base64') }] }));
    }
    if (request.method !== 'GET') await requestBytes(request);
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'local fixture endpoint not found' } }));
  });
  await new Promise((resolve) => imageServer.listen(0, '127.0.0.1', resolve));
  const fakeImageBaseUrl = `http://127.0.0.1:${imageServer.address().port}/v1`;
  await saveConfig({
    expectedRevision: 1,
    base: { baseUrl: fakeImageBaseUrl, apiKey: 'fixture-only-secret', model: 'fixture-base' },
    image: { baseUrl: fakeImageBaseUrl, apiKey: 'fixture-only-secret', model: 'fixture-image' },
  }, { root: isolatedRoot });

  const readLocalConfig = (options = {}) => readConfig({ ...options, root: isolatedRoot });
  canvas = createCanvasManager({ root: isolatedRoot, readConfig: readLocalConfig });
  app = await listenStudioServer({ root: isolatedRoot, staticDir, canvas, readConfig: readLocalConfig, port: 0 });
  const webUrl = `http://127.0.0.1:${app.address.port}`;
  let task = await createTask({ title: '图文与机械成品隔离闭环', brief: { content: '两页图片工作流，全部请求发往本地替身。' } }, isolatedRoot);
  task = await confirmInputs(task.id, { revision: task.revision, by: '测试用户', note: '隔离验证需求和来源。' }, { root: isolatedRoot });
  task = await setSheet(task.id, {
    title: '本地图片链路',
    pages: [
      { page: 1, copy: '主标题与版式样张', prompt: '简洁、清晰的图文样张。', size: '3:4' },
      { page: 2, copy: '高质量设置样张', prompt: '同系列的简洁图文样张。', size: '3:4', quality: 'high' },
    ],
  }, { root: isolatedRoot, expectedRevision: task.revision, inputRevision: task.inputConfirmation.revision });
  task = await confirmSheet(task.id, { version: task.sheetVersion, by: '测试用户', note: '确认隔离制作单。' }, { root: isolatedRoot, expectedRevision: task.revision });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let downloads = 0;
  page.on('download', () => { downloads += 1; });
  await page.addInitScript((taskId) => localStorage.setItem('studio.activeTask', taskId), task.id);
  await page.goto(webUrl);
  await page.getByRole('heading', { name: '图文与机械成品隔离闭环' }).waitFor();

  const prepared = await canvas.ensure(task.id);
  drawingPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await drawingPage.goto(prepared.openUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await drawingPage.waitForURL((url) => url.pathname === `/canvas/${task.id}` && !url.hash, { timeout: 30_000 });
  await waitForCanvas(task.id);

  let options = await canvas.executionOptions(task.id);
  task = await executeTask(task.id, {
    ...options,
    root: isolatedRoot,
    version: task.sheetVersion,
    expectedRevision: task.revision,
    pollMs: 100,
    timeoutMs: 90_000,
  });
  assert.equal(task.execution.status, 'succeeded');
  report.checks.push('real-task-canvas-connected-and-generated');

  for (const [index, marker] of ['EDIT_ONE_ONLY', 'EDIT_TWO_ONLY'].entries()) {
    options = await canvas.executionOptions(task.id);
    task = await editTaskPages(task.id, {
      mode: 'successful-output',
      edits: [{ page: 1, instruction: `${marker}: 只微调标题区域的颜色和间距，保留其他画面。` }],
      authorization: { requestId: randomUUID(), text: `${marker} 已授权，对第 1 页作一次短指令修改。` },
      baseVersion: task.sheetVersion,
      expectedRevision: task.revision,
      root: isolatedRoot,
      ...options,
      pollMs: 100,
      timeoutMs: 90_000,
    });
    assert.equal(task.execution.status, 'succeeded', `edit ${index + 1} must complete`);
  }
  const editCalls = requests.filter((entry) => entry.operation === 'edit');
  assert.equal(editCalls.length, 2);
  assert.equal(editCalls[0].hasEditOneMarker, true);
  assert.equal(editCalls[0].hasEditTwoMarker, false);
  assert.equal(editCalls[1].hasEditOneMarker, false, 'the second request must not accumulate the first instruction');
  assert.equal(editCalls[1].hasEditTwoMarker, true);
  assert.ok(editCalls.every((entry) => entry.quality === null), 'auto quality must remain the provider default and must not be invented in captured request fields');
  report.checks.push('two-successive-short-edits-do-not-accumulate-history');

  const generatedCalls = requests.filter((entry) => entry.operation === 'generation');
  assert.equal(generatedCalls.length, 2);
  assert.deepEqual(generatedCalls.map((entry) => entry.quality), [null, 'high']);
  let snapshot = await readCanvasSnapshot(task.id);
  const canvasQualities = [];
  for (const record of task.execution.pages) {
    const configNode = snapshot.nodes.find((node) => node.id === record.nodeId);
    const configuredQuality = task.sheets.find((sheet) => sheet.version === task.sheetVersion)?.pages.find((entry) => entry.page === record.page)?.quality;
    assert.equal(configNode?.metadata?.quality, configuredQuality);
    canvasQualities.push({ page: record.page, configured: configNode.metadata.quality });
  }
  canvasQualities.sort((left, right) => left.page - right.page);
  assert.deepEqual(canvasQualities.map((entry) => entry.configured), ['auto', 'high']);
  report.checks.push('default-auto-and-explicit-high-quality-reached-canvas');

  const optionsForLogo = await canvas.executionOptions(task.id);
  const basePage = task.execution.pages.find((entry) => entry.page === 1);
  const opaqueOperationId = randomUUID();
  await assert.rejects(canvas.mechanicalOperation(task.id, {
    operation: 'adapt-logo',
    nodeId: basePage.imageNodeId,
    foreground: '#14834a',
    expectedRevision: task.revision,
    operationId: opaqueOperationId,
    requestId: randomUUID(),
    callId: randomUUID(),
    userText: '拒绝不透明画面，不进行白底抠除。',
  }), (error) => error.code === 'ERR_CANVAS_OPERATION_INPUT' && /透明原件/.test(error.message));
  const logoBytes = transparentLogo();
  const logoSourceId = `logo-source-${randomUUID()}`;
  await optionsForLogo.tool('canvas_import_image', {
    nodeId: logoSourceId,
    title: '透明绿标原件',
    dataUrl: `data:image/png;base64,${logoBytes.toString('base64')}`,
  }, optionsForLogo.config);
  const logoOperationId = randomUUID();
  const logoVariant = await canvas.mechanicalOperation(task.id, {
    operation: 'adapt-logo',
    nodeId: logoSourceId,
    foreground: '#14834a',
    outline: { color: '#ffffff', width: 2 },
    expectedRevision: task.revision,
    operationId: logoOperationId,
    requestId: randomUUID(),
    callId: randomUUID(),
    userText: '隔离验收：保留透明绿标 alpha 并加细白边。',
  });
  assert.equal(logoVariant.result.operation, 'adapt-logo');
  assert.equal(logoVariant.result.images[0].padding, 2);
  assert.equal(logoVariant.result.images[0].width, 20);
  assert.equal(logoVariant.result.images[0].height, 20);
  const savedLogo = await saveLogoVariant(task.id, {
    operationId: logoOperationId,
    imageIndex: 0,
    expectedRevision: task.revision,
    title: '隔离验证透明绿标白边',
  }, { root: isolatedRoot });
  assert.equal(savedLogo.asset.status, 'staged');
  assert.equal(savedLogo.asset.source.kind, 'logo-variant');
  assert.equal(savedLogo.asset.source.originalSha256, digest(logoBytes));
  assert.equal(savedLogo.asset.source.outputSha256, logoVariant.result.images[0].sha256);
  const savedAssetResponse = await fetch(`${webUrl}/api/assets/${encodeURIComponent(savedLogo.asset.id)}/files/0`);
  assert.equal(savedAssetResponse.ok, true);
  const reusedLogoBytes = Buffer.from(await savedAssetResponse.arrayBuffer());
  assert.equal(digest(reusedLogoBytes), savedLogo.asset.source.outputSha256);
  const reusedLogoNodeId = `logo-library-reuse-${randomUUID()}`;
  await optionsForLogo.tool('canvas_import_image', {
    nodeId: reusedLogoNodeId,
    title: '从素材库复用的 Logo 变体',
    dataUrl: `data:image/png;base64,${reusedLogoBytes.toString('base64')}`,
  }, optionsForLogo.config);

  const greenOutlineImage = await optionsForLogo.tool('canvas_read_image', { nodeId: logoVariant.result.images[0].nodeId }, optionsForLogo.config);
  const greenCenter = await pixelAt(greenOutlineImage.dataUrl, 9, 9);
  const whiteEdge = await pixelAt(greenOutlineImage.dataUrl, 9, 5);
  const transparentMargin = await pixelAt(greenOutlineImage.dataUrl, 0, 0);
  const greenSemiAlpha = await pixelAt(greenOutlineImage.dataUrl, 4, 10);
  assert.deepEqual(greenCenter, [20, 131, 74, 255]);
  assert.deepEqual(greenSemiAlpha, [20, 131, 74, 127]);
  assert.equal(whiteEdge[0], 255);
  assert.equal(whiteEdge[1], 255);
  assert.equal(whiteEdge[2], 255);
  assert.ok(whiteEdge[3] > 0 && whiteEdge[3] < 255);
  assert.equal(transparentMargin[3], 0);
  const sourceAfterAdaptation = await optionsForLogo.tool('canvas_read_image', { nodeId: logoSourceId }, optionsForLogo.config);
  assert.deepEqual(await pixelAt(sourceAfterAdaptation.dataUrl, 2, 8), [34, 165, 92, 127]);
  assert.deepEqual(await pixelAt(sourceAfterAdaptation.dataUrl, 5, 5), [34, 164, 92, 255]);

  const preserveOperation = await canvas.mechanicalOperation(task.id, {
    operation: 'adapt-logo',
    nodeId: logoSourceId,
    outline: { color: '#ffffff', width: 2 },
    expectedRevision: task.revision,
    operationId: randomUUID(),
    requestId: randomUUID(),
    callId: randomUUID(),
    userText: '隔离验收：不指定前景色时保留 Logo 原始颜色和 alpha。',
  });
  const preservedImage = await optionsForLogo.tool('canvas_read_image', { nodeId: preserveOperation.result.images[0].nodeId }, optionsForLogo.config);
  const preservedCenter = await pixelAt(preservedImage.dataUrl, 7, 7);
  const preservedSemiAlpha = await pixelAt(preservedImage.dataUrl, 4, 10);
  assert.deepEqual(preservedCenter, [34, 164, 92, 255]);
  assert.deepEqual(preservedSemiAlpha, [34, 165, 92, 127]);

  const plateOperation = await canvas.mechanicalOperation(task.id, {
    operation: 'adapt-logo',
    nodeId: logoSourceId,
    foreground: '#ffffff',
    plate: { color: '#007a3d', padding: 4, radius: 5 },
    expectedRevision: task.revision,
    operationId: randomUUID(),
    requestId: randomUUID(),
    callId: randomUUID(),
    userText: '隔离验收：将白色标识放在绿色圆角底牌上。',
  });
  assert.equal(plateOperation.result.images[0].padding, 4);
  const plateImage = await optionsForLogo.tool('canvas_read_image', { nodeId: plateOperation.result.images[0].nodeId }, optionsForLogo.config);
  const whiteLogoCenter = await pixelAt(plateImage.dataUrl, 11, 11);
  const greenPlate = await pixelAt(plateImage.dataUrl, 1, 8);
  const roundedCorner = await pixelAt(plateImage.dataUrl, 0, 0);
  assert.deepEqual(whiteLogoCenter, [255, 255, 255, 255]);
  assert.deepEqual(greenPlate, [0, 122, 61, 255]);
  assert.equal(roundedCorner[3], 0);
  report.checks.push('transparent-logo-outline-rounded-plate-pixel-checks');
  report.checks.push('staged-variant-read-from-library-and-reimported-to-canvas');

  const baseDimensions = { width: 900, height: 1200 };
  const operationId = randomUUID();
  const mechanical = await canvas.mechanicalOperation(task.id, {
    operation: 'compose',
    nodeId: basePage.imageNodeId,
    layers: [{ nodeId: reusedLogoNodeId, x: 760, y: 1060, width: 100, height: 100, fit: 'contain', smoothing: 'smooth' }],
    expectedRevision: task.revision,
    operationId,
    requestId: randomUUID(),
    callId: randomUUID(),
    userText: '隔离验收：把已适配透明 Logo 贴回当前页右下角。',
  });
  assert.equal(mechanical.attachments.length, 1);
  const adopted = await adoptCanvasResult(task.id, {
    operationId,
    imageIndex: 0,
    page: 1,
    requestId: randomUUID(),
    workType: 'mechanical',
    authorization: { by: '测试用户', note: '明确将贴入透明 Logo 的机械合成结果采用为第 1 页正式成品。' },
    expectedRevision: task.revision,
  }, { root: isolatedRoot });
  task = adopted.task;
  const adoptedPage = task.execution.pages.find((entry) => entry.page === 1);
  const fresh = await canvas.assertFresh(task.id, {
    expectedRevision: task.revision,
    version: task.sheetVersion,
    images: [{ page: 1, sha256: adoptedPage.image.sha256 }],
  });
  assert.equal(fresh.ok, true);
  report.checks.push('mechanical-ledger-result-adopted-and-freshness-verified');

  await page.reload();
  await page.getByRole('heading', { name: '图文与机械成品隔离闭环' }).waitFor();
  const preview = page.getByRole('region', { name: '当前任务预览' }).locator('img[alt="第 1 页当前图片"]');
  await preview.waitFor();
  const displayed = await preview.evaluate((image) => ({ complete: image.complete, width: image.naturalWidth, height: image.naturalHeight }));
  assert.equal(displayed.complete, true);
  assert.equal(displayed.width, mechanical.result.images[0].width);
  assert.equal(displayed.height, mechanical.result.images[0].height);

  const downloadEvent = page.waitForEvent('download', { timeout: 30_000 });
  await page.getByRole('button', { name: '确认交付并下载', exact: true }).click();
  const download = await downloadEvent;
  assert.equal(await download.failure(), null);
  const downloadPath = await download.path();
  assert.ok(downloadPath);
  const downloadedZip = await readFile(downloadPath);
  const deliveredTask = await readTask(task.id, isolatedRoot);
  assert.equal(deliveredTask.exports.length, 1);
  assert.equal(digest(downloadedZip), deliveredTask.exports[0].archiveSha256);
  const archive = unzipSync(downloadedZip);
  const manifest = JSON.parse(Buffer.from(archive['manifest.json']).toString('utf8'));
  const exportedImage = manifest.images.find((entry) => entry.page === 1);
  assert.equal(exportedImage.sha256, adoptedPage.image.sha256);
  assert.deepEqual(Buffer.from(archive[exportedImage.path]), await readFile(adoptedPage.image.path));
  assert.equal(manifest.execution.pages.find((entry) => entry.page === 1).productOrigin.operationId, operationId);
  assert.equal(downloads, 1);
  await page.reload();
  await page.getByRole('heading', { name: '图文与机械成品隔离闭环' }).waitFor();
  await page.waitForTimeout(500);
  assert.equal(downloads, 1, 'refresh must not download the confirmed ZIP again');
  assert.deepEqual(pageErrors, []);
  report.checks.push('workbench-preview-delivery-download-and-refresh');
  report.status = 'passed';
  report.imageRequests = requests;
  report.canvasQualities = canvasQualities;
  report.task = { sheetVersion: deliveredTask.sheetVersion, exportedImages: manifest.images.length };
  report.logoAdaptation = {
    sourceSha256: digest(logoBytes),
    greenOutline: { padding: logoVariant.result.images[0].padding, center: greenCenter, semiAlphaPixel: greenSemiAlpha, edge: whiteEdge, transparentMarginAlpha: transparentMargin[3] },
    unchangedForeground: { center: preservedCenter, semiAlphaPixel: preservedSemiAlpha },
    whiteOnGreenPlate: { padding: plateOperation.result.images[0].padding, center: whiteLogoCenter, plate: greenPlate, roundedCornerAlpha: roundedCorner[3] },
    stagedAssetId: savedLogo.asset.id,
    stagedAssetStatus: savedLogo.asset.status,
  };
  report.mechanical = { operation: mechanical.result.operation, imageIndex: 0, sha256: adoptedPage.image.sha256, freshnessVerified: fresh.ok };
  report.download = { count: downloads, archiveSha256: digest(downloadedZip), zipMembers: Object.keys(archive).length };
  await writeFile(path.join(evidenceDir, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  await page.screenshot({ path: path.join(evidenceDir, 'workbench-after-mechanical-adoption.png'), fullPage: true });
  console.log('Media workflow verification passed: real Canvas, local fake image API, mechanical adoption, and ZIP delivery.');
} catch (error) {
  report.status = 'failed';
  report.error = safeError(error);
  report.imageRequests = requests;
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.error(`Media workflow verification failed: ${report.error}`);
  process.exitCode = 1;
} finally {
  await page?.context().close().catch(() => {});
  await drawingPage?.context().close().catch(() => {});
  await browser?.close().catch(() => {});
  await canvas?.stop().catch(() => {});
  await app?.close().catch(() => {});
  if (imageServer) {
    imageServer.closeAllConnections();
    await new Promise((resolve) => imageServer.close(resolve));
  }
  await rm(isolatedRoot, { recursive: true, force: true });
}
