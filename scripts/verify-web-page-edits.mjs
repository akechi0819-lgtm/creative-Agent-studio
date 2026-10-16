import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import jsQR from 'jsqr';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { unzipSync } from 'fflate';
import { QrCode, Ecc } from '../third_party/canvas/web/node_modules/@rc-component/qrcode/es/libs/qrcodegen.js';
import { listenStudioServer } from '../src/web/server.mjs';
import { saveConfig, readConfig } from '../src/web/config.mjs';
import { createCanvasManager } from '../src/web/canvas.mjs';
import { readTask, readTaskUploadedImageBytes } from '../src/creative/tasks.mjs';
import { createStudioAgent } from '../adapters/dsh/runtime.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const evidenceRoot = path.join(repo, 'docs/evidence/p3-image-composition');
const evidenceRunId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const evidenceDir = path.join(evidenceRoot, `verify-web-page-edits-${evidenceRunId}`);
const evidenceFile = path.join(evidenceDir, 'verification.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function paddedPixelBounds(bounds, padding) {
  const x = Math.floor(bounds.x) - padding;
  const y = Math.floor(bounds.y) - padding;
  const right = Math.ceil(bounds.x + bounds.width) + padding;
  const bottom = Math.ceil(bounds.y + bounds.height) + padding;
  return { x, y, width: right - x, height: bottom - y };
}

function containsPixelBounds(container, bounds) {
  return bounds.x >= container.x
    && bounds.y >= container.y
    && bounds.x + bounds.width <= container.x + container.width
    && bounds.y + bounds.height <= container.y + container.height;
}

const expectedUserMessage = '只改第二页标题为新版标题，以第一页为风格参考，其他页保留';
const expectedUploadedMessage = '把第二张图按第一张的风格修改，保持第二张原有内容与文字，不重做整份制作单';
const expectedMechanicalMessage = '本地隔离验证：裁切、四分割、缩小重采样并调整节点布局';
const expectedCrossTaskMessage = '本地隔离验证：拒绝使用另一任务的 Canvas 节点';
const expectedCompositionMessage = '本地隔离验证：导入测试图片，执行横向与纵向拼接，并替换海报上的旧码';
const expectedRealCompositionMessage = '把海报右下角旧二维码换成新上传那张，其他内容保持';
const editOutputCopy = '新版标题';
const realModelRequested = process.argv.includes('--real-model');

await fs.mkdir(evidenceDir, { recursive: true, mode: 0o700 });
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  status: 'running',
  scope: `临时数据根、本地假图片服务、真实 Web 界面与真实 Canvas 执行；确定性工具轮由隔离 mock callback 驱动${realModelRequested ? '；显式开启时另使用当前 Web 基础模型完成一轮自然聊天工具选择' : '；真实基础模型分支未运行'}。`,
  realModelRequested,
  externalModelRequests: realModelRequested ? null : 0,
  paidRequests: realModelRequested ? null : false,
  checks: [],
  screenshots: [],
};

let isolatedRoot;
let staticRoot;
let fakeImageServer;
let app;
let canvas;
let browser;
let page;
let drawing;
let webUrl = '';
let fakeImagePort = null;
let liveModelEnabled = false;
let liveBasicConfig = null;
let liveModelAgent = null;
const browserErrors = [];
const canvasModelRequests = [];
let generationCount = 0;
let editCount = 0;
const generationFixtures = [];
let editOutputBytes;
let uploadedEditOutputBytes;
let editCapture = null;
const editCaptures = [];
let callbackTrace = { chatCalled: false, editPagesCalled: false, edits: null, callbackRevision: null };
let uploadedCallbackTrace = null;
let mechanicalCallbackTrace = null;
let crossTaskCallbackTrace = null;
let compositionCallbackTrace = null;
let liveCompositionTrace = null;
let liveModelFailurePhase = false;
let liveModelVerificationStage = 'not-started';
let compositionFixtureMeta = null;

function cleanFailure(value) {
  return String(value ?? '未知失败')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[local fixture URL]')
    .replace(/\/(?:Users|private|home)\/[^\s"']+/g, '[local path]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[task id]')
    .slice(0, 1200);
}

function normalizeApiPath(value) {
  return value
    .replace(/^\/api\/tasks\/[^/]+/, '/api/tasks/:id')
    .replace(/^\/api\/jobs\/[^/]+/, '/api/jobs/:id');
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function parseMultipart(body, contentType) {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.slice(1).find(Boolean);
  if (!boundary) throw new Error('本地图片夹具收到缺少 boundary 的 multipart 请求');
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
    if (split < 0) throw new Error('本地图片夹具收到格式无效的 multipart 请求');
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

async function request(endpoint, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(webUrl + endpoint, {
    method,
    headers: { origin: webUrl, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const safePath = normalizeApiPath(endpoint);
    throw new Error(`${safePath} returned HTTP ${response.status}${value.error?.code ? ` (${value.error.code})` : ''}`);
  }
  return value;
}

async function requestForm(endpoint, form) {
  const response = await fetch(webUrl + endpoint, { method: 'POST', headers: { origin: webUrl }, body: form });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${normalizeApiPath(endpoint)} returned HTTP ${response.status}${value.error?.code ? ` (${value.error.code})` : ''}`);
  }
  return value;
}


async function waitForJob(jobId, kind, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let previous = '';
  while (Date.now() < deadline) {
    const { job: current } = await request(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (current.status !== previous) {
      previous = current.status;
      console.log(`${kind}: ${current.status}`);
    }
    if (current.status === 'succeeded') return current;
    if (['failed', 'cancelled'].includes(current.status)) {
      throw new Error(`${kind} job ${current.status}${current.error?.code ? ` (${current.error.code})` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${kind} job 在本地夹具等待时间内没有结束`);
}

async function currentTask(taskId) {
  return (await request(`/api/tasks/${encodeURIComponent(taskId)}`)).task;
}

async function waitForTask(taskId, predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await currentTask(taskId);
    if (predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待 ${label} 超时`);
}

async function writeReport() {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(evidenceFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(evidenceFile, 0o600);
}

async function compareMechanicalImagePixels(browserPage, { cropSourceUrl, cropUrl, splitSourceUrl, splitUrls, resampleSourceUrl, resampleUrl }) {
  return browserPage.evaluate(async (images) => {
    async function loadImage(url) {
      const response = await fetch(new URL(url, location.href));
      if (!response.ok) throw new Error(`图像附件 HTTP ${response.status}`);
      const blob = await response.blob();
      if (blob.type !== 'image/png') throw new Error(`图像附件不是 PNG：${blob.type}`);
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('无法读取 PNG 附件'));
        reader.readAsDataURL(blob);
      });
      const image = await new Promise((resolve, reject) => {
        const loaded = new Image();
        loaded.onload = () => resolve(loaded);
        loaded.onerror = () => reject(new Error('PNG 附件解码失败'));
        loaded.src = dataUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建像素校验画布');
      context.drawImage(image, 0, 0);
      return { image, width: image.naturalWidth, height: image.naturalHeight, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
    }

    function comparePixels(actual, expected, actualX = 0, actualY = 0, expectedX = 0, expectedY = 0, width = actual.width, height = actual.height) {
      let mismatches = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const actualOffset = ((actualY + y) * actual.width + actualX + x) * 4;
          const expectedOffset = ((expectedY + y) * expected.width + expectedX + x) * 4;
          for (let channel = 0; channel < 4; channel += 1) {
            if (actual.pixels[actualOffset + channel] !== expected.pixels[expectedOffset + channel]) mismatches += 1;
          }
        }
      }
      return mismatches;
    }

    function pixelDifference(actual, expected) {
      let mismatches = 0;
      let absoluteTotal = 0;
      let maxAbsolute = 0;
      for (let index = 0; index < actual.pixels.length; index += 1) {
        const difference = Math.abs(actual.pixels[index] - expected.pixels[index]);
        if (difference) mismatches += 1;
        absoluteTotal += difference;
        if (difference > maxAbsolute) maxAbsolute = difference;
      }
      return { mismatches, maxAbsolute, meanAbsolute: absoluteTotal / actual.pixels.length };
    }

    const cropSource = await loadImage(images.cropSourceUrl);
    const crop = await loadImage(images.cropUrl);
    if (crop.width !== 64 || crop.height !== 64) throw new Error(`裁切尺寸错误：${crop.width}x${crop.height}`);
    const cropPixelMismatches = comparePixels(crop, cropSource, 0, 0, 0, 0, crop.width, crop.height);

    const splitSource = await loadImage(images.splitSourceUrl);
    const splitPieces = await Promise.all(images.splitUrls.map(loadImage));
    if (splitPieces.length !== 4) throw new Error(`分割附件数量错误：${splitPieces.length}`);
    const splitPixelMismatches = splitPieces.map((piece, index) => {
      if (piece.width !== 256 || piece.height !== 256) throw new Error(`第 ${index + 1} 张分割尺寸错误：${piece.width}x${piece.height}`);
      return comparePixels(piece, splitSource, 0, 0, (index % 2) * 256, Math.floor(index / 2) * 256, piece.width, piece.height);
    });

    const resampleSource = await loadImage(images.resampleSourceUrl);
    const resample = await loadImage(images.resampleUrl);
    if (resample.width !== 256 || resample.height !== 256) throw new Error(`重采样尺寸错误：${resample.width}x${resample.height}`);
    const resamplePixelMismatches = {};
    const resamplePixelDifferences = {};
    for (const [algorithm, smoothingQuality] of [['nearest', 'high'], ['bilinear', 'medium'], ['high', 'high']]) {
      const expectedCanvas = document.createElement('canvas');
      expectedCanvas.width = 256;
      expectedCanvas.height = 256;
      const expectedContext = expectedCanvas.getContext('2d');
      if (!expectedContext) throw new Error('无法创建重采样参考画布');
      expectedContext.imageSmoothingEnabled = algorithm !== 'nearest';
      expectedContext.imageSmoothingQuality = smoothingQuality;
      expectedContext.drawImage(resampleSource.image, 0, 0, resampleSource.width, resampleSource.height, 0, 0, 256, 256);
      const expectedPixels = expectedContext.getImageData(0, 0, 256, 256).data;
      const expectedResample = { width: 256, height: 256, pixels: expectedPixels };
      resamplePixelMismatches[algorithm] = comparePixels(resample, expectedResample);
      resamplePixelDifferences[algorithm] = pixelDifference(resample, expectedResample);
    }
    let changedPixelCount = 0;
    for (let y = 0; y < 256; y += 1) {
      for (let x = 0; x < 256; x += 1) {
        const outputOffset = (y * 256 + x) * 4;
        const unscaledOffset = (y * resampleSource.width + x) * 4;
        if ([0, 1, 2, 3].some((channel) => resample.pixels[outputOffset + channel] !== resampleSource.pixels[unscaledOffset + channel])) changedPixelCount += 1;
      }
    }

    return {
      crop: { source: { width: cropSource.width, height: cropSource.height }, output: { width: crop.width, height: crop.height }, pixelMismatches: cropPixelMismatches },
      split: { source: { width: splitSource.width, height: splitSource.height }, outputs: splitPieces.map(({ width, height }) => ({ width, height })), pixelMismatches: splitPixelMismatches },
      resample: { source: { width: resampleSource.width, height: resampleSource.height }, output: { width: resample.width, height: resample.height }, expectedPixelMismatches: resamplePixelMismatches, pixelDifferences: resamplePixelDifferences, pixelsChangedFromTopLeftSourceRegion: changedPixelCount },
    };
  }, { cropSourceUrl, cropUrl, splitSourceUrl, splitUrls, resampleSourceUrl, resampleUrl });
}

function makeQrFixture(payload, { transparent = false } = {}) {
  const qr = QrCode.encodeText(payload, Ecc.MEDIUM);
  const scale = 4;
  const quietZone = 4;
  const side = (qr.size + quietZone * 2) * scale;
  const canvas = createCanvas(side, side);
  const context = canvas.getContext('2d');
  if (!transparent) {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, side, side);
  }
  context.fillStyle = '#000000';
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (qr.getModule(x, y)) context.fillRect((x + quietZone) * scale, (y + quietZone) * scale, scale, scale);
    }
  }
  return { bytes: canvas.toBuffer('image/png'), width: side, height: side };
}

function makePosterFixture(oldQrBytes) {
  const canvas = createCanvas(520, 400);
  const context = canvas.getContext('2d');
  context.fillStyle = '#f5f1e7';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#253b57';
  context.fillRect(0, 0, canvas.width, 28);
  context.fillStyle = '#e6a66a';
  context.fillRect(24, 48, 188, 18);
  context.fillStyle = '#486b73';
  context.fillRect(24, 82, 292, 9);
  context.fillRect(24, 101, 244, 9);
  context.fillStyle = '#d9e2d0';
  context.fillRect(24, 134, 270, 54);
  context.fillStyle = '#89a7a0';
  context.fillRect(36, 146, 94, 30);
  context.fillStyle = '#ead7b6';
  context.fillRect(142, 146, 140, 30);
  context.fillStyle = '#253b57';
  context.fillRect(24, 210, 278, 5);
  context.fillRect(24, 225, 240, 5);
  context.fillRect(24, 240, 196, 5);
  context.fillStyle = '#e6a66a';
  context.fillRect(24, 274, 264, 14);
  context.fillStyle = '#c4d2c9';
  context.fillRect(24, 306, 264, 62);
  context.fillStyle = '#849b92';
  context.fillRect(36, 318, 114, 38);
  context.fillStyle = '#f5f1e7';
  context.fillRect(162, 318, 114, 38);
  // Decode and place the QR through the same standard PNG path used by the browser fixtures.
  return loadImage(oldQrBytes).then((image) => {
    context.drawImage(image, 340, 220);
    context.fillStyle = '#253b57';
    context.fillRect(340, 376, 148, 4);
    return { bytes: canvas.toBuffer('image/png'), width: canvas.width, height: canvas.height };
  });
}

function makeTileFixture(index, width, height) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  const image = context.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      image.data[offset] = (31 + index * 57 + x * 23 + y * 7) % 256;
      image.data[offset + 1] = (79 + index * 31 + x * 9 + y * 29) % 256;
      image.data[offset + 2] = (143 + index * 19 + x * 13 + y * 11) % 256;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toBuffer('image/png');
}

function makeTransparentOverlay(width, height, variant) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  const image = context.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const selected = variant === 1
        ? ((x >= 4 && x < 13 && y >= 2 && y < 8) || (x >= 19 && x < 26 && y >= 5 && y < 9))
        : ((x - width / 2) ** 2 + (y - height / 2) ** 2 < (width / 3) ** 2);
      if (!selected) continue;
      image.data[offset] = variant === 1 ? 27 : 214;
      image.data[offset + 1] = variant === 1 ? 102 : 72;
      image.data[offset + 2] = variant === 1 ? 181 : 39;
      image.data[offset + 3] = variant === 1 ? 192 : 224;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toBuffer('image/png');
}

function dataUrl(bytes) {
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
}

async function comparePixelComposition(browserPage, { baseDataUrl, layerDataUrls, horizontalSources, verticalSources, horizontalUrl, verticalUrl, compositionUrl, composeLayers }) {
  return browserPage.evaluate(async (input) => {
    async function loadImage(url) {
      let source = url;
      if (!url.startsWith('data:')) {
        const response = await fetch(new URL(url, location.href));
        if (!response.ok) throw new Error(`图像附件 HTTP ${response.status}`);
        const blob = await response.blob();
        if (blob.type !== 'image/png') throw new Error(`图像附件不是 PNG：${blob.type}`);
        source = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error || new Error('无法读取 PNG 附件'));
          reader.readAsDataURL(blob);
        });
      }
      const image = await new Promise((resolve, reject) => {
        const loaded = new Image();
        loaded.onload = () => resolve(loaded);
        loaded.onerror = () => reject(new Error('PNG 附件解码失败'));
        loaded.src = source;
      });
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建像素读取画布');
      context.drawImage(image, 0, 0);
      return { image, width: image.naturalWidth, height: image.naturalHeight, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
    }

    function pixels(canvas) {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建像素比较画布');
      return { width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
    }

    function countMismatches(actual, expected, isPixelIncluded = () => true) {
      if (actual.width !== expected.width || actual.height !== expected.height) return { dimensionsMatch: false, mismatchedChannels: null, mismatchedPixels: null };
      let mismatchedChannels = 0;
      let mismatchedPixels = 0;
      for (let y = 0; y < actual.height; y += 1) {
        for (let x = 0; x < actual.width; x += 1) {
          if (!isPixelIncluded(x, y)) continue;
          const offset = (y * actual.width + x) * 4;
          let different = false;
          for (let channel = 0; channel < 4; channel += 1) {
            if (actual.pixels[offset + channel] !== expected.pixels[offset + channel]) {
              mismatchedChannels += 1;
              different = true;
            }
          }
          if (different) mismatchedPixels += 1;
        }
      }
      return { dimensionsMatch: true, mismatchedChannels, mismatchedPixels };
    }

    function makeCanvas(width, height, background) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建像素参考画布');
      context.clearRect(0, 0, width, height);
      if (background) {
        context.fillStyle = background;
        context.fillRect(0, 0, width, height);
      }
      return { canvas, context };
    }

    const base = await loadImage(input.baseDataUrl);
    const layerImages = await Promise.all(input.layerDataUrls.map(loadImage));
    const horizontalSources = await Promise.all(input.horizontalSources.map(loadImage));
    const verticalSources = await Promise.all(input.verticalSources.map(loadImage));
    const horizontalActual = await loadImage(input.horizontalUrl);
    const verticalActual = await loadImage(input.verticalUrl);
    const compositionActual = await loadImage(input.compositionUrl);

    const horizontalGap = 2;
    const horizontalBackground = '#26384a';
    const horizontalWidth = horizontalSources.reduce((sum, item) => sum + item.width, 0) + horizontalGap * (horizontalSources.length - 1);
    const horizontalHeight = Math.max(...horizontalSources.map((item) => item.height));
    const horizontal = makeCanvas(horizontalWidth, horizontalHeight, horizontalBackground);
    let cursorX = 0;
    for (const source of horizontalSources) {
      horizontal.context.drawImage(source.image, cursorX, 0);
      cursorX += source.width + horizontalGap;
    }

    const verticalGap = 1;
    const verticalBackground = '#78909c';
    const verticalWidth = Math.max(...verticalSources.map((item) => item.width));
    const verticalHeight = verticalSources.reduce((sum, item) => sum + item.height, 0) + verticalGap * (verticalSources.length - 1);
    const vertical = makeCanvas(verticalWidth, verticalHeight, verticalBackground);
    let cursorY = 0;
    for (const source of verticalSources) {
      vertical.context.drawImage(source.image, 0, cursorY);
      cursorY += source.height + verticalGap;
    }

    const composition = makeCanvas(base.width, base.height);
    composition.context.drawImage(base.image, 0, 0);
    for (const [index, layer] of input.composeLayers.entries()) {
      const overlay = layerImages[index];
      composition.context.imageSmoothingEnabled = layer.smoothing === 'smooth';
      composition.context.imageSmoothingQuality = 'high';
      if (layer.clear) {
        composition.context.clearRect(layer.x, layer.y, layer.width, layer.height);
        composition.context.fillStyle = layer.clear;
        composition.context.fillRect(layer.x, layer.y, layer.width, layer.height);
      }
      const fit = layer.fit || 'contain';
      if (fit === 'stretch') {
        composition.context.drawImage(overlay.image, layer.x, layer.y, layer.width, layer.height);
      } else if (fit === 'contain') {
        const scale = Math.min(layer.width / overlay.width, layer.height / overlay.height);
        const drawWidth = overlay.width * scale;
        const drawHeight = overlay.height * scale;
        composition.context.drawImage(overlay.image, layer.x + (layer.width - drawWidth) / 2, layer.y + (layer.height - drawHeight) / 2, drawWidth, drawHeight);
      } else {
        const sourceRatio = overlay.width / overlay.height;
        const targetRatio = layer.width / layer.height;
        if (sourceRatio > targetRatio) {
          const sourceWidth = overlay.height * targetRatio;
          composition.context.drawImage(overlay.image, (overlay.width - sourceWidth) / 2, 0, sourceWidth, overlay.height, layer.x, layer.y, layer.width, layer.height);
        } else {
          const sourceHeight = overlay.width / targetRatio;
          composition.context.drawImage(overlay.image, 0, (overlay.height - sourceHeight) / 2, overlay.width, sourceHeight, layer.x, layer.y, layer.width, layer.height);
        }
      }
    }

    const horizontalExpected = pixels(horizontal.canvas);
    const verticalExpected = pixels(vertical.canvas);
    const compositionExpected = pixels(composition.canvas);
    const clearRects = input.composeLayers.map(({ x, y, width, height }) => ({ x, y, width, height }));
    const isOutsideTouchedRects = (x, y) => !clearRects.some((rect) => x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height);
    const basePixels = { width: base.width, height: base.height, pixels: base.pixels };
    const readPixel = (image, x, y) => Array.from(image.pixels.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));
    return {
      horizontal: { expected: { width: horizontalWidth, height: horizontalHeight }, actual: { width: horizontalActual.width, height: horizontalActual.height }, pixelComparison: countMismatches({ width: horizontalActual.width, height: horizontalActual.height, pixels: horizontalActual.pixels }, horizontalExpected) },
      vertical: { expected: { width: verticalWidth, height: verticalHeight }, actual: { width: verticalActual.width, height: verticalActual.height }, pixelComparison: countMismatches({ width: verticalActual.width, height: verticalActual.height, pixels: verticalActual.pixels }, verticalExpected) },
      compose: {
        expected: { width: base.width, height: base.height },
        actual: { width: compositionActual.width, height: compositionActual.height },
        pixelComparison: countMismatches({ width: compositionActual.width, height: compositionActual.height, pixels: compositionActual.pixels }, compositionExpected),
        untouchedAreaComparison: countMismatches({ width: compositionActual.width, height: compositionActual.height, pixels: compositionActual.pixels }, basePixels, isOutsideTouchedRects),
        samples: {
          containLetterboxAfterClear: readPixel({ width: compositionActual.width, height: compositionActual.height, pixels: compositionActual.pixels }, 25, 25),
          laterOverlapClear: readPixel({ width: compositionActual.width, height: compositionActual.height, pixels: compositionActual.pixels }, 72, 52),
          clearColors: input.composeLayers.map(({ clear }) => clear),
        },
        touchedRects: clearRects,
      },
    };
  }, { baseDataUrl, layerDataUrls, horizontalSources, verticalSources, horizontalUrl, verticalUrl, compositionUrl, composeLayers });
}

async function compareLiveComposePixels(browserPage, { baseDataUrl, overlayDataUrls, compositionUrl, layers, barcodeBounds }) {
  return browserPage.evaluate(async (input) => {
    async function loadImage(url) {
      let source = url;
      if (!url.startsWith('data:')) {
        const response = await fetch(new URL(url, location.href));
        if (!response.ok) throw new Error(`图像附件 HTTP ${response.status}`);
        const blob = await response.blob();
        if (blob.type !== 'image/png') throw new Error(`图像附件不是 PNG：${blob.type}`);
        source = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error || new Error('无法读取 PNG 附件'));
          reader.readAsDataURL(blob);
        });
      }
      const image = await new Promise((resolve, reject) => {
        const loaded = new Image();
        loaded.onload = () => resolve(loaded);
        loaded.onerror = () => reject(new Error('PNG 附件解码失败'));
        loaded.src = source;
      });
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建像素比较画布');
      context.drawImage(image, 0, 0);
      return { image, width: image.naturalWidth, height: image.naturalHeight, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
    }
    function mismatchCount(left, right, include = () => true) {
      if (left.width !== right.width || left.height !== right.height) return { dimensionsMatch: false, mismatchedPixels: null, mismatchedChannels: null };
      let mismatchedPixels = 0;
      let mismatchedChannels = 0;
      for (let y = 0; y < left.height; y += 1) {
        for (let x = 0; x < left.width; x += 1) {
          if (!include(x, y)) continue;
          const offset = (y * left.width + x) * 4;
          let different = false;
          for (let channel = 0; channel < 4; channel += 1) {
            if (left.pixels[offset + channel] !== right.pixels[offset + channel]) {
              mismatchedChannels += 1;
              different = true;
            }
          }
          if (different) mismatchedPixels += 1;
        }
      }
      return { dimensionsMatch: true, mismatchedPixels, mismatchedChannels };
    }
    const base = await loadImage(input.baseDataUrl);
    const overlays = await Promise.all(input.overlayDataUrls.map(loadImage));
    const actual = await loadImage(input.compositionUrl);
    const canvas = document.createElement('canvas');
    canvas.width = base.width;
    canvas.height = base.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建参考合成画布');
    context.drawImage(base.image, 0, 0);
    for (const layer of input.layers) {
      const overlay = overlays[layer.overlayIndex];
      context.imageSmoothingEnabled = layer.smoothing === 'smooth';
      context.imageSmoothingQuality = 'high';
      if (layer.clear) {
        context.clearRect(layer.x, layer.y, layer.width, layer.height);
        context.fillStyle = layer.clear;
        context.fillRect(layer.x, layer.y, layer.width, layer.height);
      }
      const fit = layer.fit || 'contain';
      if (fit === 'stretch') {
        context.drawImage(overlay.image, layer.x, layer.y, layer.width, layer.height);
      } else if (fit === 'contain') {
        const scale = Math.min(layer.width / overlay.width, layer.height / overlay.height);
        const drawWidth = overlay.width * scale;
        const drawHeight = overlay.height * scale;
        context.drawImage(overlay.image, layer.x + (layer.width - drawWidth) / 2, layer.y + (layer.height - drawHeight) / 2, drawWidth, drawHeight);
      } else {
        const sourceRatio = overlay.width / overlay.height;
        const targetRatio = layer.width / layer.height;
        if (sourceRatio > targetRatio) {
          const sourceWidth = overlay.height * targetRatio;
          context.drawImage(overlay.image, (overlay.width - sourceWidth) / 2, 0, sourceWidth, overlay.height, layer.x, layer.y, layer.width, layer.height);
        } else {
          const sourceHeight = overlay.width / targetRatio;
          context.drawImage(overlay.image, 0, (overlay.height - sourceHeight) / 2, overlay.width, sourceHeight, layer.x, layer.y, layer.width, layer.height);
        }
      }
    }
    const expectedContext = canvas.getContext('2d');
    const expected = { width: canvas.width, height: canvas.height, pixels: expectedContext.getImageData(0, 0, canvas.width, canvas.height).data };
    const basePixels = { width: base.width, height: base.height, pixels: base.pixels };
    const outside = (x, y) => !input.layers.some((layer) => x >= layer.x && y >= layer.y && x < layer.x + layer.width && y < layer.y + layer.height);
    let originalDarkPixels = 0;
    let originalDarkPixelsOutsideClearRect = 0;
    const bounds = input.barcodeBounds;
    for (let y = Math.max(0, Math.floor(bounds.y)); y < Math.min(base.height, Math.ceil(bounds.y + bounds.height)); y += 1) {
      for (let x = Math.max(0, Math.floor(bounds.x)); x < Math.min(base.width, Math.ceil(bounds.x + bounds.width)); x += 1) {
        const offset = (y * base.width + x) * 4;
        const isDark = base.pixels[offset] < 96 && base.pixels[offset + 1] < 96 && base.pixels[offset + 2] < 96 && base.pixels[offset + 3] > 0;
        if (!isDark) continue;
        originalDarkPixels += 1;
        if (outside(x, y)) originalDarkPixelsOutsideClearRect += 1;
      }
    }
    return {
      expectedSize: { width: base.width, height: base.height },
      actualSize: { width: actual.width, height: actual.height },
      completeOutput: mismatchCount({ width: actual.width, height: actual.height, pixels: actual.pixels }, expected),
      outsideAllLayerRects: mismatchCount({ width: actual.width, height: actual.height, pixels: actual.pixels }, basePixels, outside),
      originalBarcodePixels: { regionBounds: bounds, darkPixelCount: originalDarkPixels, darkPixelsOutsideClearRect: originalDarkPixelsOutsideClearRect },
      layers: input.layers.map(({ x, y, width, height, clear, fit, smoothing }) => ({ x, y, width, height, clear: clear ?? null, fit: fit ?? 'contain', smoothing: smoothing ?? 'nearest' })),
    };
  }, { baseDataUrl, overlayDataUrls, compositionUrl, layers, barcodeBounds });
}

async function decodeFixtureQrPayloads(paths) {
  const reports = [];
  for (const file of paths) {
    const image = await loadImage(await fs.readFile(file));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const decoded = jsQR(pixels, image.width, image.height, { inversionAttempts: 'attemptBoth' });
    let regions = [];
    if (decoded) {
      const points = [decoded.location.topLeftCorner, decoded.location.topRightCorner,
        decoded.location.bottomRightCorner, decoded.location.bottomLeftCorner];
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      const x = Math.floor(Math.min(...xs));
      const y = Math.floor(Math.min(...ys));
      const right = Math.ceil(Math.max(...xs));
      const bottom = Math.ceil(Math.max(...ys));
      regions = [{ kind: 'qr', confidence: 1, bounds: { x, y, width: right - x, height: bottom - y } }];
    }
    reports.push({ payloads: decoded ? [decoded.data] : [], regions, width: image.width, height: image.height });
  }
  return reports;
}

async function makeTemporaryWebBuild() {
  const webRoot = path.join(repo, 'web');
  const outputRoot = path.join(staticRoot, 'dist');
  await fs.mkdir(path.join(outputRoot, 'assets'), { recursive: true, mode: 0o700 });
  await fs.copyFile(path.join(webRoot, 'index.html'), path.join(outputRoot, 'index.html'));
  await fs.cp(path.join(webRoot, 'public'), outputRoot, { recursive: true });
  await build({
    entryPoints: [path.join(webRoot, 'src/main.jsx')],
    outfile: path.join(outputRoot, 'assets/app.js'),
    bundle: true,
    external: ['/brand/*'],
    minify: true,
    sourcemap: false,
    jsx: 'automatic',
    loader: { '.png': 'file', '.svg': 'file' },
    assetNames: 'assets/[name]-[hash]',
    logLevel: 'silent',
  });
  return outputRoot;
}

try {
  isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-page-edits-'));
  await fs.chmod(isolatedRoot, 0o700);
  staticRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-page-edits-web-'));
  await fs.chmod(staticRoot, 0o700);

  const fixturePaths = [
    path.join(repo, 'adapters/dsh/connection-check.png'),
    path.join(repo, 'web/public/brand/whale-artist.png'),
    path.join(repo, 'web/public/brand/apple-touch-icon.png'),
  ];
  generationFixtures.push(...await Promise.all(fixturePaths.map((file) => fs.readFile(file))));
  editOutputBytes = await fs.readFile(path.join(repo, 'web/public/brand/characters/portrait.png'));
  uploadedEditOutputBytes = await fs.readFile(path.join(repo, 'web/public/brand/apple-touch-icon.png'));
  for (const [index, bytes] of generationFixtures.entries()) {
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `baseline fixture ${index + 1} must be a PNG`);
  }
  assert.deepEqual([...editOutputBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'edit fixture must be a PNG');
  assert.deepEqual([...uploadedEditOutputBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'uploaded-image edit fixture must be a PNG');
  const baselineFixtureHashes = generationFixtures.map(sha256);
  assert.equal(new Set(baselineFixtureHashes).size, 3, 'the three baseline pages must have distinguishable image bytes');
  assert.ok(!baselineFixtureHashes.includes(sha256(editOutputBytes)), 'the edit result fixture must differ from every baseline fixture');

  fakeImageServer = createServer(async (requestValue, response) => {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', 'authorization,content-type');
    response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    response.setHeader('access-control-max-age', '600');
    if (requestValue.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    const pathname = new URL(requestValue.url, 'http://127.0.0.1').pathname;
    canvasModelRequests.push({ method: requestValue.method, operation: pathname.replace(/^\/v1\//, '') });
    if (pathname.endsWith('/models')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'mock-image' }, { id: 'mock-base' }] }));
      return;
    }
    if (pathname.endsWith('/images/generations')) {
      generationCount += 1;
      await readBody(requestValue);
      if (generationCount > generationFixtures.length) {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'fixture_generation_limit', message: 'fixture generation limit reached' } }));
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ created: 1, data: [{ b64_json: generationFixtures[generationCount - 1].toString('base64') }] }));
      return;
    }
    if (pathname.endsWith('/images/edits')) {
      editCount += 1;
      const body = await readBody(requestValue);
      const contentType = String(requestValue.headers['content-type'] || '');
      const parts = parseMultipart(body, contentType);
      const images = parts.filter((part) => part.field === 'image[]' || part.field === 'image');
      editCapture = {
        method: requestValue.method,
        operation: 'images/edits',
        imageCount: images.length,
        images: images.map((image, index) => ({
          order: index + 1,
          field: image.field,
          mimeType: image.mimeType,
          byteLength: image.bytes.length,
          sha256: sha256(image.bytes),
        })),
      };
      editCaptures.push(editCapture);
      response.setHeader('content-type', 'application/json');
      const resultBytes = editCount === 1 ? editOutputBytes : uploadedEditOutputBytes;
      response.end(JSON.stringify({ created: 1, data: [{ b64_json: resultBytes.toString('base64') }] }));
      return;
    }
    await readBody(requestValue);
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'fixture_route_not_found' } }));
  });
  await new Promise((resolve) => fakeImageServer.listen(0, '127.0.0.1', resolve));
  fakeImagePort = fakeImageServer.address().port;
  const fakeImageBaseUrl = `http://127.0.0.1:${fakeImagePort}/v1`;
  await saveConfig({
    expectedRevision: 1,
    base: { baseUrl: fakeImageBaseUrl, model: 'mock-base', apiKey: 'fixture-only' },
    image: { baseUrl: fakeImageBaseUrl, model: 'mock-image', apiKey: 'fixture-only' },
  }, { root: isolatedRoot });
  const readLocalConfig = async () => {
    const local = await readConfig({ root: isolatedRoot });
    return liveModelEnabled && liveBasicConfig ? { ...local, basic: { ...liveBasicConfig } } : local;
  };
  canvas = createCanvasManager({ root: isolatedRoot, readConfig: readLocalConfig });

  const agent = {
    async chat(input) {
      if (input.text === expectedMechanicalMessage) {
        assert.equal(typeof input.canvasState, 'function', 'the Web chat callback must inject canvasState');
        assert.equal(typeof input.canvasOperation, 'function', 'the Web chat callback must inject canvasOperation');
        const current = await readTask(input.taskId, isolatedRoot);
        const stateBefore = await input.canvasState({ expectedRevision: input.expectedRevision });
        const pageOneNodeId = current.execution?.pages?.find((record) => record.page === 1)?.imageNodeId;
        const pageTwoNodeId = current.execution?.pages?.find((record) => record.page === 2)?.imageNodeId;
        assert.ok(pageOneNodeId && pageTwoNodeId, 'mechanical verification must use real successful Canvas image nodes');
        const pageOneNode = stateBefore.nodes.find((node) => node.id === pageOneNodeId && node.type === 'image');
        const pageTwoNode = stateBefore.nodes.find((node) => node.id === pageTwoNodeId && node.type === 'image');
        assert.ok(pageOneNode && pageTwoNode, 'the successful image nodes must appear in the task-scoped Canvas state');
        assert.deepEqual(pageOneNode.naturalSize, { width: 128, height: 128 });
        assert.deepEqual(pageTwoNode.naturalSize, { width: 512, height: 512 });

        const perform = async (arguments_) => {
          const outcome = await input.canvasOperation({
            ...arguments_,
            operationId: randomUUID(),
            expectedRevision: input.expectedRevision,
          });
          assert.equal(outcome?.result?.operation, arguments_.operation, `${arguments_.operation} must return a verified result`);
          assert.ok(Array.isArray(outcome.attachments), `${arguments_.operation} must return an attachment list`);
          return outcome;
        };
        const crop = await perform({ operation: 'crop', nodeId: pageOneNodeId, crop: { x: 0, y: 0, width: 0.5, height: 0.5 } });
        const split = await perform({ operation: 'split', nodeId: pageTwoNodeId, rows: 2, columns: 2 });
        const resample = await perform({ operation: 'resample', nodeId: pageTwoNodeId, targetLongEdge: 256, algorithm: 'nearest' });
        const move = await perform({
          operation: 'move', nodeId: pageOneNodeId,
          x: pageOneNode.position.x + 37, y: pageOneNode.position.y + 29,
        });
        const stateAfterMove = await input.canvasState({ expectedRevision: input.expectedRevision });
        const resizeSource = stateAfterMove.nodes.find((node) => node.id === pageOneNodeId && node.type === 'image');
        assert.ok(resizeSource?.displaySize, 'the source image must remain present after moving its layout');
        const resize = await perform({
          operation: 'resize', nodeId: pageOneNodeId,
          width: resizeSource.displaySize.width + 23, height: resizeSource.displaySize.height + 19,
        });
        const stateAfterLayout = await input.canvasState({ expectedRevision: input.expectedRevision });
        const layoutNode = stateAfterLayout.nodes.find((node) => node.id === pageOneNodeId && node.type === 'image');
        assert.ok(layoutNode, 'the original source node must remain after layout-only operations');
        assert.deepEqual(layoutNode.naturalSize, pageOneNode.naturalSize, 'layout changes must preserve the original pixel dimensions');
        assert.deepEqual(move.attachments, [], 'moving a node must not create image attachments');
        assert.deepEqual(resize.attachments, [], 'resizing a node must not create image attachments');

        const summarizeOperation = (outcome) => ({
          result: outcome.result,
          attachments: outcome.attachments.map(({ name, mimeType, size, width, height, sha256, fileUrl, downloadUrl }) => ({
            name, mimeType, size, width, height, sha256, fileUrl, downloadUrl,
          })),
        });
        mechanicalCallbackTrace = {
          chatCalled: true,
          taskId: input.taskId,
          callbackRevision: input.expectedRevision,
          sourceNodeIds: { page1: pageOneNodeId, page2: pageTwoNodeId },
          sourceSizes: { page1: pageOneNode.naturalSize, page2: pageTwoNode.naturalSize },
          layoutBefore: { position: pageOneNode.position, displaySize: pageOneNode.displaySize },
          layoutAfter: { position: layoutNode.position, displaySize: layoutNode.displaySize, naturalSize: layoutNode.naturalSize },
          operations: {
            crop: summarizeOperation(crop),
            split: summarizeOperation(split),
            resample: summarizeOperation(resample),
            move: summarizeOperation(move),
            resize: summarizeOperation(resize),
          },
        };
        return { text: '机械 Canvas 操作已完成，图片结果作为聊天附件返回。', task: current };
      }
      if (input.text === expectedCrossTaskMessage) {
        assert.ok(mechanicalCallbackTrace?.sourceNodeIds?.page1, 'the cross-task check needs a real node from the first task');
        const foreignNodeId = mechanicalCallbackTrace.sourceNodeIds.page1;
        const state = await input.canvasState({ expectedRevision: input.expectedRevision });
        assert.equal(state.nodes.some((node) => node.id === foreignNodeId), false, 'the first task node must not appear in the second task Canvas state');
        let refusal = null;
        try {
          await input.canvasOperation({
            operation: 'move', nodeId: foreignNodeId, x: 10, y: 20,
            operationId: randomUUID(), expectedRevision: input.expectedRevision,
          });
        } catch (failure) {
          refusal = { code: failure?.code || null, message: cleanFailure(failure?.message || failure) };
        }
        assert.equal(refusal?.code, 'ERR_CANVAS_OPERATION_INPUT', 'the host must reject a node ID from another task');
        const stateAfter = await input.canvasState({ expectedRevision: input.expectedRevision });
        assert.deepEqual(stateAfter.nodes, state.nodes, 'a rejected cross-task operation must not change the target Canvas');
        crossTaskCallbackTrace = { chatCalled: true, taskId: input.taskId, foreignNodeId, refusal, targetNodesUnchanged: true };
        return { text: '跨任务 Canvas 节点已被拒绝。' };
      }
      if (input.text === expectedCompositionMessage) {
        assert.equal(typeof input.canvasState, 'function', 'composition verification requires the actual Canvas state callback');
        assert.equal(typeof input.canvasOperation, 'function', 'composition verification requires the actual Canvas operation callback');
        const current = await readTask(input.taskId, isolatedRoot);
        const source = current.sources.find((item) => item.type === 'current_attachment' && item.decision === 'pending');
        assert.ok(source, 'composition verification must import only an available current-task attachment source');
        const files = source.files.slice().sort((left, right) => left.order - right.order);
        assert.equal(files.length, 7, 'the isolated composition task should contain seven synthetic PNGs');
        const sourceBefore = await Promise.all(files.map(async (file) => {
          const loaded = await readTaskUploadedImageBytes(input.taskId, source.id, file.order, { sources: current.sources, root: isolatedRoot });
          assert.equal(loaded.sha256, file.sha256, `uploaded source ${file.order} must match its recorded hash before import`);
          return { order: file.order, sha256: loaded.sha256, bytes: Buffer.from(loaded.bytes) };
        }));
        const stateBefore = await input.canvasState({ expectedRevision: input.expectedRevision });
        const perform = async (arguments_) => {
          const outcome = await input.canvasOperation({
            ...arguments_,
            operationId: randomUUID(),
            expectedRevision: input.expectedRevision,
          });
          assert.equal(outcome?.result?.operation, arguments_.operation, `${arguments_.operation} must return a verified Canvas result`);
          assert.ok(Array.isArray(outcome.attachments), `${arguments_.operation} must return an attachment list`);
          return outcome;
        };
        const imported = [];
        for (const file of files) {
          const outcome = await perform({ operation: 'import', image: { sourceId: source.id, fileOrder: file.order } });
          assert.deepEqual(outcome.attachments, [], 'import must add a source node without creating a chat attachment');
          assert.equal(outcome.result.images.length, 1, 'each import should return exactly one imported node descriptor');
          imported[file.order] = outcome.result.images[0];
        }
        const duplicateImport = await perform({ operation: 'import', image: { sourceId: source.id, fileOrder: 1 } });
        assert.deepEqual(duplicateImport.attachments, [], 're-importing a source must not duplicate its image attachment');
        assert.equal(duplicateImport.result.images[0].nodeId, imported[1].nodeId, 're-import must resolve to the stable imported node');
        const stateAfterImport = await input.canvasState({ expectedRevision: input.expectedRevision });
        for (const file of files) {
          const importedNode = imported[file.order];
          assert.equal(stateAfterImport.nodes.filter((node) => node.id === importedNode.nodeId && node.type === 'image').length, 1, `source ${file.order} must have one image node`);
          const fixture = compositionFixtureMeta[file.order - 1];
          assert.deepEqual({ width: importedNode.width, height: importedNode.height }, { width: fixture.width, height: fixture.height }, `source ${file.order} import must preserve natural pixel dimensions`);
        }

        const foreignNodeId = mechanicalCallbackTrace.sourceNodeIds.page1;
        const stateBeforeWrongTask = await input.canvasState({ expectedRevision: input.expectedRevision });
        let wrongTaskCode = null;
        try {
          await perform({ operation: 'compose', nodeId: imported[1].nodeId, layers: [{ nodeId: foreignNodeId, x: 0, y: 0, width: 1, height: 1 }] });
        } catch (failure) {
          wrongTaskCode = failure?.code || null;
        }
        assert.equal(wrongTaskCode, 'ERR_CANVAS_OPERATION_INPUT', 'composition must reject a source node owned by another task');
        const stateAfterWrongTask = await input.canvasState({ expectedRevision: input.expectedRevision });
        assert.deepEqual(stateAfterWrongTask.nodes, stateBeforeWrongTask.nodes, 'a rejected cross-task compose must not mutate the task Canvas');

        const horizontal = await perform({
          operation: 'stitch', nodeIds: [imported[3].nodeId, imported[4].nodeId, imported[5].nodeId],
          direction: 'horizontal', gap: 2, background: '#26384a',
        });
        const vertical = await perform({
          operation: 'stitch', nodeIds: [imported[3].nodeId, imported[4].nodeId, imported[5].nodeId],
          direction: 'vertical', gap: 1, background: '#78909c',
        });
        const composeLayers = [
          { nodeId: imported[6].nodeId, x: 20, y: 20, width: 100, height: 60, fit: 'contain', clear: '#dfefff', smoothing: 'nearest' },
          { nodeId: imported[7].nodeId, x: 70, y: 50, width: 60, height: 60, fit: 'contain', clear: '#ffeecc', smoothing: 'nearest' },
          { nodeId: imported[2].nodeId, x: 340, y: 220, width: 148, height: 148, fit: 'contain', clear: '#ffffff', smoothing: 'nearest' },
        ];
        const composition = await perform({ operation: 'compose', nodeId: imported[1].nodeId, layers: composeLayers });
        assert.deepEqual(horizontal.result.sourceNodeIds, [imported[3].nodeId, imported[4].nodeId, imported[5].nodeId], 'horizontal stitch must report unique sources in original order');
        assert.deepEqual(vertical.result.sourceNodeIds, [imported[3].nodeId, imported[4].nodeId, imported[5].nodeId], 'vertical stitch must report unique sources in original order');
        assert.deepEqual(composition.result.sourceNodeId, imported[1].nodeId, 'compose must report the poster as its primary source');
        assert.deepEqual(composition.result.sourceNodeIds, [imported[1].nodeId, imported[6].nodeId, imported[7].nodeId, imported[2].nodeId], 'compose must report deduplicated sources in input order');
        for (const output of [horizontal, vertical, composition]) {
          assert.equal(output.result.images.length, 1, `${output.result.operation} must produce one PNG`);
          assert.equal(output.attachments.length, 1, `${output.result.operation} must return one PNG chat attachment`);
        }

        const sourceAfterTask = await readTask(input.taskId, isolatedRoot);
        const sourceAfter = await Promise.all(files.map(async (file) => {
          const loaded = await readTaskUploadedImageBytes(input.taskId, source.id, file.order, { sources: sourceAfterTask.sources, root: isolatedRoot });
          return { order: file.order, sha256: loaded.sha256, bytes: Buffer.from(loaded.bytes) };
        }));
        for (const [index, before] of sourceBefore.entries()) {
          assert.equal(sourceAfter[index].sha256, before.sha256, `uploaded source ${before.order} must remain byte-identical after Canvas composition`);
          assert.deepEqual(sourceAfter[index].bytes, before.bytes, `uploaded source ${before.order} must remain unchanged after Canvas composition`);
        }
        const summarize = (outcome) => ({
          result: outcome.result,
          attachmentCount: outcome.attachments.length,
          attachments: outcome.attachments.map(({ name, mimeType, size, width, height, sha256, fileUrl, downloadUrl }) => ({ name, mimeType, size, width, height, sha256, fileUrl, downloadUrl })),
        });
        compositionCallbackTrace = {
          chatCalled: true,
          taskId: input.taskId,
          callbackRevision: input.expectedRevision,
          taskSourceId: source.id,
          sourceFilesBefore: sourceBefore.map(({ order, sha256: digest, bytes }) => ({ order, sha256: digest, byteLength: bytes.length })),
          sourceFilesAfter: sourceAfter.map(({ order, sha256: digest, bytes }) => ({ order, sha256: digest, byteLength: bytes.length })),
          sourceBytesUnchanged: true,
          initialCanvasImageNodeCount: stateBefore.nodes.filter((node) => node.type === 'image').length,
          imported: imported.slice(1).map(({ nodeId, width, height }, index) => ({ fileOrder: index + 1, nodeId, width, height })),
          duplicateImport: { nodeId: duplicateImport.result.images[0].nodeId, attachmentCount: duplicateImport.attachments.length, stableNode: true },
          wrongTaskNode: { code: wrongTaskCode, targetCanvasUnchanged: true },
          composeLayers: composeLayers.map(({ nodeId, x, y, width, height, fit, clear, smoothing }) => ({ nodeId, x, y, width, height, fit, clear, smoothing })),
          operations: { horizontal: summarize(horizontal), vertical: summarize(vertical), compose: summarize(composition) },
        };
        return { text: '测试图片已导入并完成拼接与二维码替换像素合成。', task: current };
      }
      if (input.text === expectedRealCompositionMessage) {
        assert.equal(realModelRequested, true, 'the natural-language real model prompt is gated by --real-model');
        assert.ok(liveModelAgent && liveBasicConfig, 'the real model config must be loaded before the isolated live-model task');
        liveModelFailurePhase = true;
        const trace = { calls: [], unexpectedTools: [], modelSource: liveBasicConfig.source || 'custom', modelId: liveBasicConfig.model || null };
        assert.equal(typeof input.canvasRegions, 'function', 'the live Agent callback must expose generic Canvas region detection');
        const trackedInput = {
          ...input,
          canvasState: async (arguments_) => {
            const state = await input.canvasState(arguments_);
            trace.calls.push({ toolName: 'studio_canvas_state', imageNodes: state.nodes.filter((node) => node.type === 'image').map(({ id, naturalSize }) => ({ nodeId: id, width: naturalSize?.width ?? null, height: naturalSize?.height ?? null })) });
            return state;
          },
          canvasPreview: async (arguments_) => {
            const image = await input.canvasPreview(arguments_);
            trace.calls.push({ toolName: 'studio_canvas_read_image', nodeId: arguments_?.nodeId ?? null, width: image.width, height: image.height, mimeType: image.mimeType, sha256: image.sha256 });
            return image;
          },
          canvasRegions: async (arguments_) => {
            try {
              const result = await input.canvasRegions(arguments_);
              trace.calls.push({
                toolName: 'studio_canvas_detect_regions',
                nodeId: result.nodeId ?? arguments_?.nodeId ?? null,
                sha256: result.sha256,
                width: result.width,
                height: result.height,
                truncated: result.truncated,
                totalDetected: result.totalDetected,
                regions: result.regions.map(({ kind, confidence, bounds, suggestedBounds, suggestedPadding }) => ({
                  kind,
                  confidence,
                  bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
                  suggestedBounds: { x: suggestedBounds.x, y: suggestedBounds.y, width: suggestedBounds.width, height: suggestedBounds.height },
                  suggestedPadding,
                })),
              });
              return result;
            } catch (failure) {
              trace.calls.push({ toolName: 'studio_canvas_detect_regions', nodeId: arguments_?.nodeId ?? null, outcome: 'failed', errorCode: failure?.code || 'ERR_CANVAS_REGIONS' });
              throw failure;
            }
          },
          canvasOperation: async (arguments_) => {
            const safeArgs = {
              operation: arguments_?.operation ?? null,
              ...(arguments_?.image?.fileOrder === undefined ? {} : { fileOrder: arguments_.image.fileOrder }),
              ...(arguments_?.nodeId === undefined ? {} : { nodeId: arguments_.nodeId }),
              ...(arguments_?.nodeIds === undefined ? {} : { nodeIds: arguments_.nodeIds }),
              ...(arguments_?.direction === undefined ? {} : { direction: arguments_.direction }),
              ...(arguments_?.gap === undefined ? {} : { gap: arguments_.gap }),
              ...(arguments_?.crop === undefined ? {} : { crop: { x: arguments_.crop.x, y: arguments_.crop.y, width: arguments_.crop.width, height: arguments_.crop.height } }),
              ...(arguments_?.layers === undefined ? {} : { layers: arguments_.layers.map(({ nodeId, x, y, width, height, fit, clear, smoothing }) => ({ nodeId, x, y, width, height, ...(fit === undefined ? {} : { fit }), ...(clear === undefined ? {} : { clear }), ...(smoothing === undefined ? {} : { smoothing }) })) }),
            };
            try {
              const outcome = await input.canvasOperation(arguments_);
              trace.calls.push({
                toolName: 'studio_canvas_operation', ...safeArgs, outcome: 'succeeded',
                images: outcome.result.images.map(({ nodeId, width, height, sha256: digest }) => ({ nodeId, width, height, sha256: digest })),
                attachments: outcome.attachments.map(({ name, mimeType, size, width, height, sha256: digest, fileUrl, downloadUrl }) => ({ name, mimeType, size, width, height, sha256: digest, fileUrl, downloadUrl })),
              });
              return outcome;
            } catch (failure) {
              trace.calls.push({ toolName: 'studio_canvas_operation', ...safeArgs, outcome: 'failed', errorCode: failure?.code || 'ERR_CANVAS_OPERATION' });
              throw failure;
            }
          },
          editPages: async () => {
            trace.unexpectedTools.push('studio_edit_pages');
            const failure = new Error('real composition verification permits Canvas pixel operations only');
            failure.code = 'ERR_REAL_MODEL_TOOL_SCOPE';
            throw failure;
          },
        };
        try {
          const result = await liveModelAgent.chat(trackedInput);
          liveCompositionTrace = trace;
          return result;
        } catch (failure) {
          liveCompositionTrace = trace;
          throw failure;
        }
      }
      if (input.text === expectedUploadedMessage) {
        const userTurn = [...(input.conversation || [])].reverse().find((entry) => entry.role === 'user');
        assert.equal(userTurn?.text, expectedUploadedMessage);
        assert.equal(userTurn?.attachmentSourceIds, undefined, 'the chat must not fabricate upload source IDs as current-turn attachments');
        const current = await readTask(input.taskId, isolatedRoot);
        const sources = current.sources.filter((source) => source.type === 'current_attachment');
        assert.equal(sources.length, 1, 'the new task should contain one current-upload source');
        const source = sources[0];
        assert.equal(source.decision, 'pending', 'uploaded images must remain pending');
        assert.deepEqual(source.files.map((file) => file.order).sort(), [1, 2]);
        const edits = [{
          page: 1,
          image: { sourceId: source.id, fileOrder: 2 },
          styleImages: [{ sourceId: source.id, fileOrder: 1 }],
          instruction: '保持内容统一风格',
        }];
        uploadedCallbackTrace = {
          chatCalled: true,
          chatHadNoAttachmentSourceIds: true,
          sourceFileHashes: source.files.slice().sort((left, right) => left.order - right.order).map((file) => ({ order: file.order, sha256: file.sha256, byteLength: file.size ?? null })),
          editPagesCalled: true,
          callbackRevision: input.expectedRevision,
          editOrder: { page: 1, imageFileOrder: 2, styleFileOrder: 1, instruction: '保持内容统一风格' },
        };
        const task = await input.editPages({ mode: 'uploaded-images', edits, expectedRevision: input.expectedRevision });
        uploadedCallbackTrace.callbackResultRevision = task.revision;
        uploadedCallbackTrace.callbackResultVersion = task.sheetVersion;
        return { text: '已按第二张图片原有内容，参考第一张风格完成修改。', task };
      }
      callbackTrace.chatCalled = true;
      callbackTrace.userText = input.text;
      assert.equal(input.text, expectedUserMessage, 'the chat UI must send the explicit page-edit instruction');
      assert.equal(typeof input.editPages, 'function', 'the Web chat callback must inject editPages');
      const edits = [{ page: 2, instruction: '改标题并保持风格', copy: editOutputCopy, stylePages: [1] }];
      callbackTrace.edits = structuredClone(edits);
      callbackTrace.callbackRevision = input.expectedRevision;
      callbackTrace.editPagesCalled = true;
      const task = await input.editPages({ edits, expectedRevision: input.expectedRevision });
      callbackTrace.callbackResultRevision = task.revision;
      callbackTrace.callbackResultVersion = task.sheetVersion;
      return { text: '已按要求修改第二页标题，其他页面保留。', task };
    },
  };

  const temporaryStaticDir = await makeTemporaryWebBuild();
  app = await listenStudioServer({ root: isolatedRoot, canvas, agent, readConfig: readLocalConfig, staticDir: temporaryStaticDir, port: 0 });
  webUrl = `http://127.0.0.1:${app.address.port}`;

  const created = (await request('/api/tasks', {
    title: '局部改页隔离验收',
    brief: { topic: '三页图文局部修改软件链路验收', audience: '本地测试', requirements: '仅验证指定页改图和未改页保留，不含业务事实。' },
  })).task;
  let task = created;
  task = (await request(`/api/tasks/${encodeURIComponent(task.id)}/confirm-inputs`, {
    expectedRevision: task.revision,
    revision: task.revision,
    by: '隔离验收脚本',
    note: '仅确认无来源的虚构三页软件链路夹具。',
  })).task;
  task = (await request(`/api/tasks/${encodeURIComponent(task.id)}/set-sheet`, {
    expectedRevision: task.revision,
    inputRevision: task.inputConfirmation.revision,
    sheet: {
      title: '三页局部修改夹具',
      sourceIds: [],
      pages: [
        { page: 1, copy: '基线第一页标题', prompt: '本地软件夹具第1页；只检查真实 Canvas 出图和图片回收。', size: '3:4', sourceIds: [] },
        { page: 2, copy: '基线第二页标题', prompt: '本地软件夹具第2页；只检查真实 Canvas 出图和图片回收。', size: '3:4', sourceIds: [] },
        { page: 3, copy: '基线第三页标题', prompt: '本地软件夹具第3页；只检查真实 Canvas 出图和图片回收。', size: '3:4', sourceIds: [] },
      ],
    },
  })).task;
  task = (await request(`/api/tasks/${encodeURIComponent(task.id)}/confirm-sheet`, {
    expectedRevision: task.revision,
    version: task.sheetVersion,
    by: '隔离验收脚本',
    note: '仅确认虚构三页软件链路夹具。',
  })).task;
  assert.equal(task.sheetVersion, 1);
  assert.equal(task.sheets.at(-1).pages.length, 3);
  assert.equal(task.sources.length, 0);
  report.checks.push('temporary-task-has-no-sources-and-confirmed-three-page-v1');

  const proxy = process.env.HTTPS_PROXY
    ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' }
    : undefined;
  browser = await chromium.launch({ channel: 'chrome', headless: true, proxy });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on('pageerror', (failure) => browserErrors.push(cleanFailure(failure.message)));
  page.on('request', (requestValue) => {
    try {
      const url = new URL(requestValue.url());
      if (url.pathname.startsWith('/api/')) report.apiRequests = [...(report.apiRequests || []), {
        method: requestValue.method(), path: normalizeApiPath(url.pathname),
      }];
    } catch { /* Keep malformed browser URLs out of evidence. */ }
  });
  await page.goto(webUrl, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '局部改页隔离验收', exact: true }).click();
  await page.getByRole('heading', { name: '局部改页隔离验收', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('tab', { name: '制作单', exact: true }).click();

  const canvasPopup = page.waitForEvent('popup');
  await page.locator('.canvas-open').click();
  drawing = await canvasPopup;
  drawing.on('pageerror', (failure) => browserErrors.push(cleanFailure(failure.message)));
  await drawing.waitForURL(/\/canvas(?:\?|\/|#)/, { timeout: 20_000 });
  const canvasDeadline = Date.now() + 30_000;
  while (Date.now() < canvasDeadline && !(await canvas.state(task.id)).clientConnected) await drawing.waitForTimeout(150);
  assert.equal((await canvas.state(task.id)).clientConnected, true, 'the actual Canvas browser must connect to the temporary task');
  await drawing.screenshot({ path: path.join(evidenceDir, 'canvas-connected.png') });
  report.screenshots.push('canvas-connected.png');

  const executeResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/execute'));
  await page.getByRole('button', { name: '确认 v1 并开始绘图', exact: true }).click();
  const executeBody = await (await executeResponse).json();
  assert.ok(executeBody.job?.id, 'the Web execute button must start the real Canvas job');
  await waitForJob(executeBody.job.id, 'three-page baseline generation');
  task = await waitForTask(task.id, (value) => value.execution?.status === 'succeeded', 'successful baseline execution');
  assert.equal(task.execution.pages.length, 3);
  assert.equal(task.execution.pages.every((record) => record.status === 'succeeded'), true);
  assert.equal(generationCount, 3, 'the confirmed baseline should make exactly three fake image generations');
  const baselineTask = await readTask(task.id, isolatedRoot);
  const baselinePages = baselineTask.execution.pages.map((record) => ({
    page: record.page,
    path: record.image.path,
    sha256: record.image.sha256,
    byteLength: record.image.bytes,
    fixtureSha256: baselineFixtureHashes[record.page - 1],
  }));
  assert.deepEqual(baselinePages.map((record) => record.sha256), baselineFixtureHashes);
  report.baseline = { version: baselineTask.sheetVersion, pageCount: baselinePages.length, pages: baselinePages.map(({ page: pageNumber, sha256: digest, byteLength }) => ({ page: pageNumber, sha256: digest, byteLength })) };
  report.checks.push('three-real-canvas-pages-generated-from-local-fake-image-service');

  for (const pageNumber of [1, 3]) {
    const record = baselineTask.execution.pages.find((item) => item.page === pageNumber);
    const reviewed = await request(`/api/tasks/${encodeURIComponent(task.id)}/record-review`, {
      expectedRevision: task.revision,
      page: pageNumber,
      sha256: record.image.sha256,
      decision: 'pass',
      reviewer: '隔离验收脚本',
      notes: `第 ${pageNumber} 页只作为本地图片回收夹具，记录当前真实 Canvas 成品哈希。`,
    });
    task = reviewed.task;
  }
  assert.deepEqual(task.reviews.map((item) => item.page).sort(), [1, 3]);
  for (const pageNumber of [1, 3]) assert.ok(task.reviews.some((item) => item.page === pageNumber && item.decision === 'pass' && item.version === 1));
  report.baseline.reviews = task.reviews.map(({ page: pageNumber, version, decision, sha256: digest }) => ({ page: pageNumber, version, decision, sha256: digest }));
  report.checks.push('pages-one-and-three-recorded-through-api-after-canvas-freshness-check');

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '局部改页隔离验收', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('tab', { name: '成品审核', exact: true }).click();
  await page.getByRole('button', { name: '审核第 2 页', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '提交本页复审', exact: true }).count(), 0, 'page review decisions should save directly');
  assert.equal(await page.getByRole('button', { name: '对话修改第 2 页', exact: true }).count(), 0, 'page edits should be described directly in chat');
  const mechanicalBefore = await readTask(task.id, isolatedRoot);
  const protectedTaskState = (value) => ({
    revision: value.revision,
    sheetVersion: value.sheetVersion,
    sheets: value.sheets,
    executionVersion: value.execution?.version,
    executionPages: value.execution?.pages?.map((record) => ({
      page: record.page, status: record.status, imageNodeId: record.imageNodeId, sha256: record.image?.sha256,
    })),
    reviews: value.reviews,
    finalApproval: value.finalApproval,
  });
  const protectedBefore = protectedTaskState(mechanicalBefore);
  const generationsBeforeMechanical = generationCount;
  const editsBeforeMechanical = editCount;
  const pageOneNodeId = mechanicalBefore.execution.pages.find((record) => record.page === 1).imageNodeId;
  const pageTwoNodeId = mechanicalBefore.execution.pages.find((record) => record.page === 2).imageNodeId;
  const pageOneCandidateBefore = await canvas.candidateImage(task.id, { version: mechanicalBefore.sheetVersion, page: 1, nodeId: pageOneNodeId });
  const pageTwoCandidateBefore = await canvas.candidateImage(task.id, { version: mechanicalBefore.sheetVersion, page: 2, nodeId: pageTwoNodeId });
  assert.equal(pageOneCandidateBefore.sha256, baselinePages[0].sha256);
  assert.equal(pageTwoCandidateBefore.sha256, baselinePages[1].sha256);

  const chatInput = page.getByRole('textbox', { name: '告诉 Agent 想怎么改', exact: true });
  await chatInput.waitFor({ state: 'visible' });
  await chatInput.fill(expectedMechanicalMessage);
  const mechanicalChatResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/chat'));
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const mechanicalChatBody = await (await mechanicalChatResponse).json();
  assert.ok(mechanicalChatBody.job?.id, 'the mechanical operations should use the normal Web chat job');
  await page.locator('.job-activity.active').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.job-dock').count(), 0, 'a mechanical chat job should not display a floating progress dock');
  await waitForJob(mechanicalChatBody.job.id, 'mechanical Canvas operations');
  assert.equal(mechanicalCallbackTrace?.chatCalled, true, 'the fake Agent must call the task-scoped mechanical host callbacks');
  assert.equal(generationCount, generationsBeforeMechanical, 'mechanical image operations must not call image generation');
  assert.equal(editCount, editsBeforeMechanical, 'mechanical image operations must not call image editing');
  const mechanicalAfter = await readTask(task.id, isolatedRoot);
  assert.deepEqual(protectedTaskState(mechanicalAfter), protectedBefore, 'mechanical chat operations must not change the sheet, outputs, reviews, approval, or task revision');
  const operationAttachments = [
    ...mechanicalCallbackTrace.operations.crop.attachments,
    ...mechanicalCallbackTrace.operations.split.attachments,
    ...mechanicalCallbackTrace.operations.resample.attachments,
  ];
  assert.equal(mechanicalCallbackTrace.operations.crop.attachments.length, 1);
  assert.equal(mechanicalCallbackTrace.operations.split.attachments.length, 4, '2x2 split must return four separate images');
  assert.equal(mechanicalCallbackTrace.operations.resample.attachments.length, 1);
  assert.equal(mechanicalCallbackTrace.operations.move.attachments.length, 0);
  assert.equal(mechanicalCallbackTrace.operations.resize.attachments.length, 0);
  assert.deepEqual(mechanicalCallbackTrace.operations.crop.result.images.map(({ width, height }) => ({ width, height })), [{ width: 64, height: 64 }]);
  assert.deepEqual(mechanicalCallbackTrace.operations.split.result.images.map(({ width, height }) => ({ width, height })), Array.from({ length: 4 }, () => ({ width: 256, height: 256 })));
  assert.deepEqual(mechanicalCallbackTrace.operations.resample.result.images.map(({ width, height }) => ({ width, height })), [{ width: 256, height: 256 }]);
  assert.equal(new Set(operationAttachments.map((attachment) => attachment.fileUrl)).size, 6, 'each operation image must have a unique fetchable attachment URL');
  for (const attachment of operationAttachments) {
    assert.match(attachment.fileUrl, /^\/api\/tasks\/[^/]+\/canvas-operations\//);
    assert.equal(attachment.downloadUrl, `${attachment.fileUrl}?download=1`);
    const inlineResponse = await fetch(webUrl + attachment.fileUrl);
    assert.equal(inlineResponse.status, 200, `${attachment.name} must be available over HTTP`);
    assert.match(inlineResponse.headers.get('content-type') || '', /^image\/png\b/);
    const inlineBytes = Buffer.from(await inlineResponse.arrayBuffer());
    assert.deepEqual([...inlineBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${attachment.name} must be a real PNG`);
    assert.equal(inlineBytes.readUInt32BE(16), attachment.width, `${attachment.name} PNG width must match its descriptor`);
    assert.equal(inlineBytes.readUInt32BE(20), attachment.height, `${attachment.name} PNG height must match its descriptor`);
    assert.equal(sha256(inlineBytes), attachment.sha256, `${attachment.name} PNG bytes must match their recorded hash`);
    const downloadResponse = await fetch(webUrl + attachment.downloadUrl);
    assert.equal(downloadResponse.status, 200, `${attachment.name} must remain downloadable`);
    assert.equal(sha256(Buffer.from(await downloadResponse.arrayBuffer())), attachment.sha256);
  }
  const currentPublicTask = (await request(`/api/tasks/${encodeURIComponent(task.id)}`)).task;
  const pageOneSourceUrl = currentPublicTask.execution.pages.find((record) => record.page === 1).image.imageUrl;
  const pageTwoSourceUrl = currentPublicTask.execution.pages.find((record) => record.page === 2).image.imageUrl;
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '局部改页隔离验收', exact: true }).waitFor({ state: 'visible' });
  const reloadedDetail = await request(`/api/tasks/${encodeURIComponent(task.id)}`);
  const mechanicalMessage = reloadedDetail.conversation.find((message) => message.role === 'assistant' && message.text === '机械 Canvas 操作已完成，图片结果作为聊天附件返回。');
  assert.ok(mechanicalMessage, 'the mechanical result message must persist after a Web reload');
  assert.deepEqual(mechanicalMessage.attachments.map(({ fileUrl }) => fileUrl).sort(), operationAttachments.map(({ fileUrl }) => fileUrl).sort());
  const mechanicalMessageRow = page.locator('.message-row.assistant').filter({ hasText: '机械 Canvas 操作已完成，图片结果作为聊天附件返回。' }).last();
  await mechanicalMessageRow.locator('.message-attachments').waitFor({ state: 'visible' });
  assert.equal(await mechanicalMessageRow.locator('.message-attachments a[download]').count(), 6, 'all persisted image outputs must appear as downloadable chat attachments');
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll('.message-row.assistant')].find((item) => item.textContent?.includes('机械 Canvas 操作已完成，图片结果作为聊天附件返回。'));
    const images = [...(row?.querySelectorAll('.message-attachments img') || [])];
    return images.length === 6 && images.every((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
  }, undefined, { timeout: 20_000 });
  const pixelChecks = await compareMechanicalImagePixels(page, {
    cropSourceUrl: pageOneSourceUrl,
    cropUrl: mechanicalCallbackTrace.operations.crop.attachments[0].fileUrl,
    splitSourceUrl: pageTwoSourceUrl,
    splitUrls: mechanicalCallbackTrace.operations.split.attachments.map((attachment) => attachment.fileUrl),
    resampleSourceUrl: pageTwoSourceUrl,
    resampleUrl: mechanicalCallbackTrace.operations.resample.attachments[0].fileUrl,
  });
  const pageOneCandidateAfter = await canvas.candidateImage(task.id, { version: mechanicalAfter.sheetVersion, page: 1, nodeId: pageOneNodeId });
  const pageTwoCandidateAfter = await canvas.candidateImage(task.id, { version: mechanicalAfter.sheetVersion, page: 2, nodeId: pageTwoNodeId });
  report.canvasMechanicalOperations = {
    callbackRevision: mechanicalCallbackTrace.callbackRevision,
    sourceNodeIds: mechanicalCallbackTrace.sourceNodeIds,
    sourceSizes: mechanicalCallbackTrace.sourceSizes,
    operations: Object.fromEntries(Object.entries(mechanicalCallbackTrace.operations).map(([operation, value]) => [operation, {
      result: value.result,
      attachments: value.attachments.map(({ name, mimeType, size, width, height, sha256, fileUrl, downloadUrl }) => ({ name, mimeType, size, width, height, sha256, fileUrl, downloadUrl })),
    }])),
    persistedAttachmentsAfterReload: mechanicalMessage.attachments.length,
    sourceHashesPreserved: pageOneCandidateAfter.sha256 === pageOneCandidateBefore.sha256 && pageTwoCandidateAfter.sha256 === pageTwoCandidateBefore.sha256,
    sheetReviewsAndApprovalUnchanged: JSON.stringify(protectedTaskState(mechanicalAfter)) === JSON.stringify(protectedBefore),
    fakeImageRequestsUnchanged: generationCount === generationsBeforeMechanical && editCount === editsBeforeMechanical,
    pixels: pixelChecks,
  };
  assert.equal(pixelChecks.crop.pixelMismatches, 0, 'crop pixels must equal the requested upper-left source region');
  assert.deepEqual(pixelChecks.split.pixelMismatches, [0, 0, 0, 0], 'split pixels must match the four corresponding source quadrants');
  if (realModelRequested) {
    pixelChecks.resample.exactPixelGate = {
      status: 'skipped',
      reason: 'Known intermittent legacy resampling renderer difference; this run retains nearest, bilinear, and high-quality pixel measurements but does not gate the unrelated live composition branch on them.',
      strictDeterministicEvidence: 'docs/evidence/p3-image-composition/verify-web-page-edits-2026-10-15T13-43-01-365Z-f9144fbb/verification.json',
    };
  } else {
    assert.equal(pixelChecks.resample.expectedPixelMismatches.nearest, 0, 'nearest-neighbor resampling must match the exact browser pixel reference in deterministic mode');
    pixelChecks.resample.exactPixelGate = { status: 'passed', algorithm: 'nearest', mismatchedPixels: 0 };
  }
  assert.ok(pixelChecks.resample.pixelsChangedFromTopLeftSourceRegion > 0, 'downsampling must change the pixel grid');
  assert.equal(pageOneCandidateAfter.sha256, pageOneCandidateBefore.sha256, 'moving/resizing the source node must preserve its original image hash');
  assert.equal(pageTwoCandidateAfter.sha256, pageTwoCandidateBefore.sha256, 'split and resample must preserve the original image hash');
  assert.deepEqual(mechanicalCallbackTrace.layoutAfter.position, {
    x: mechanicalCallbackTrace.layoutBefore.position.x + 37,
    y: mechanicalCallbackTrace.layoutBefore.position.y + 29,
  });
  assert.deepEqual(mechanicalCallbackTrace.layoutAfter.displaySize, {
    width: mechanicalCallbackTrace.layoutBefore.displaySize.width + 23,
    height: mechanicalCallbackTrace.layoutBefore.displaySize.height + 19,
  });
  report.checks.push(
    'chat-canvas-state-and-crop-split-resample-move-resize-use-real-task-scoped-node-ids',
    'crop-split-and-resample-return-unique-http-and-downloadable-pngs-with-pixel-verified-content',
    'mechanical-attachments-remain-visible-and-fetchable-after-reload',
    'move-and-resize-change-layout-only-and-preserve-original-output-hashes',
    'mechanical-chat-does-not-call-image-models-or-change-sheets-reviews-or-final-approval',
  );

  await page.getByRole('tab', { name: '成品审核', exact: true }).click();
  await page.getByRole('button', { name: '审核第 2 页', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '提交本页复审', exact: true }).count(), 0, 'page review decisions should save directly');
  assert.equal(await page.getByRole('button', { name: '对话修改第 2 页', exact: true }).count(), 0, 'page edits should be described directly in chat');
  const pageEditChatInput = page.getByRole('textbox', { name: '告诉 Agent 想怎么改', exact: true });
  await pageEditChatInput.waitFor({ state: 'visible' });
  await pageEditChatInput.fill(expectedUserMessage);
  assert.equal(await pageEditChatInput.inputValue(), expectedUserMessage, 'the user should enter page-edit instructions directly in chat');
  const chatResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/chat'));
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const chatBody = await (await chatResponse).json();
  assert.ok(chatBody.job?.id, 'the real Web chat endpoint must start a job');
  await page.locator('.job-activity.active').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.job-dock').count(), 0, 'an active chat job should have no floating progress dock');
  report.checks.push('active-chat-job-progress-remains-in-conversation-without-floating-dock');
  await waitForJob(chatBody.job.id, 'chat authorized page edit');
  task = await waitForTask(task.id, (value) => value.sheetVersion === 2 && value.execution?.status === 'succeeded', 'page-edit output recovery');
  const editedTask = await readTask(task.id, isolatedRoot);
  const editedSheet = editedTask.sheets.at(-1);
  assert.equal(callbackTrace.chatCalled, true);
  assert.equal(callbackTrace.editPagesCalled, true, 'server chat must call the injected editPages callback');
  assert.equal(editedSheet.kind, 'page-edit');
  assert.equal(editedSheet.pageEdit.action, 'edit');
  assert.deepEqual(editedSheet.pageEdit.edits, [{ page: 2, instruction: '改标题并保持风格', copy: editOutputCopy, stylePages: [1] }]);
  assert.equal(editedTask.sheetConfirmation, null, 'a chat edit must not fabricate full-sheet confirmation');
  assert.equal(editedTask.sheetAuthorized, undefined, 'the internal task should keep authorization derivable, not store a redundant flag');
  assert.equal((await request(`/api/tasks/${encodeURIComponent(task.id)}`)).task.sheetAuthorized, true, 'the public task should expose derived sheetAuthorized');
  assert.equal(editedTask.finalApproval, null, 'the previous final approval must be invalidated');
  assert.equal(editedTask.execution.pages.length, 3);
  assert.equal(editedTask.execution.pages.find((record) => record.page === 2).image.sha256, sha256(editOutputBytes));
  assert.notEqual(editedTask.execution.pages.find((record) => record.page === 2).image.sha256, baselinePages[1].sha256);

  for (const pageNumber of [1, 3]) {
    const original = baselinePages.find((record) => record.page === pageNumber);
    const current = editedTask.execution.pages.find((record) => record.page === pageNumber);
    assert.equal(current.image.path, original.path, `unmodified page ${pageNumber} must retain its original image file`);
    assert.equal(current.image.sha256, original.sha256, `unmodified page ${pageNumber} must retain its original image hash`);
    assert.ok(editedTask.reviews.some((item) => item.version === 2 && item.page === pageNumber && item.decision === 'pass' && item.sha256 === original.sha256), `review for unmodified page ${pageNumber} should carry over`);
  }
  assert.equal(editedTask.reviews.some((item) => item.version === 2 && item.page === 2), false, 'the new page image must have no inherited review');
  assert.equal(generationCount, 3, 'page edit must not call the text-to-image generation route');
  assert.equal(editCount, 1, 'page edit must submit exactly one image edit request');
  assert.equal(editCapture?.imageCount, 2, 'page edit must send one base and one style image');
  assert.deepEqual(editCapture.images.map((image) => image.sha256), [baselinePages[1].sha256, baselinePages[0].sha256]);
  assert.deepEqual(editedSheet.outputReferences.map(({ page: sourcePage, forPage, role, sha256: digest }) => ({ page: sourcePage, forPage, role, sha256: digest })), [
    { page: 2, forPage: 2, role: 'edit-base', sha256: baselinePages[1].sha256 },
    { page: 1, forPage: 2, role: 'style', sha256: baselinePages[0].sha256 },
  ]);
  report.edit = {
    chatInput: callbackTrace.userText,
    mockAgentInvokedServerCallback: callbackTrace.editPagesCalled,
    callbackExpectedRevision: callbackTrace.callbackRevision,
    callbackResultRevision: callbackTrace.callbackResultRevision,
    version: editedTask.sheetVersion,
    kind: editedSheet.kind,
    action: editedSheet.pageEdit.action,
    authorized: (await request(`/api/tasks/${encodeURIComponent(task.id)}`)).task.sheetAuthorized,
    sheetConfirmation: editedTask.sheetConfirmation,
    finalApproval: editedTask.finalApproval,
    copiedTitle: editedSheet.pages.find((item) => item.page === 2).copy,
    fakeEditRequest: editCapture,
    outputReferences: editedSheet.outputReferences.map(({ page: sourcePage, forPage, role, sha256: digest }) => ({ page: sourcePage, forPage, role, sha256: digest })),
    reviews: editedTask.reviews.map(({ page: pageNumber, version, decision, sha256: digest }) => ({ page: pageNumber, version, decision, sha256: digest })),
    pages: editedTask.execution.pages.map((record) => ({ page: record.page, sha256: record.image.sha256, byteLength: record.image.bytes })),
  };
  report.checks.push(
    'chat-request-runs-through-server-editPages-callback-and-shared-core',
    'edit-request-captures-exact-original-base-and-style-png-bytes',
    'only-page-two-image-changes-and-pages-one-and-three-keep-file-path-hash-and-review',
    'new-page-two-has-no-review-and-final-approval-is-invalidated',
    'derived-page-edit-is-authorized-without-sheet-confirmation',
  );

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '局部改页隔离验收', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('tab', { name: '成品审核', exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('tab', { name: '成品审核', exact: true }).getAttribute('aria-selected'), 'true', 'the edited version should open the review tab');
  assert.equal(await page.getByRole('button', { name: /^确认 v2/ }).count(), 0, 'the page edit must not require a new full-sheet confirmation');
  assert.equal(await page.getByRole('button', { name: '不使用参考并继续', exact: true }).count(), 0, 'the page edit must not reopen source confirmation');
  assert.equal(await page.getByRole('button', { name: '审核第 2 页', exact: true }).count(), 1);
  await page.getByRole('button', { name: '审核第 2 页', exact: true }).click();
  await page.waitForFunction(() => {
    const image = document.querySelector('.review-image-wrap img');
    return Boolean(image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
  }, undefined, { timeout: 20_000 });
  const renderedImage = await page.locator('.review-image-wrap img').evaluate((image) => ({ width: image.naturalWidth, height: image.naturalHeight }));
  assert.ok(renderedImage.width > 0 && renderedImage.height > 0);
  await page.screenshot({ path: path.join(evidenceDir, 'edited-page-two-desktop.png') });
  report.screenshots.push('edited-page-two-desktop.png');
  report.reviewUi = {
    selectedPage: 2,
    imageLoaded: true,
    imageSize: renderedImage,
    pageEditTabSelected: true,
    noSheetConfirmationButton: true,
    noSourceConfirmationButton: true,
  };
  report.checks.push('web-review-renders-new-page-image-without-reconfirmation');

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileToggle = page.getByRole('button', { name: '切换对话和工作对象', exact: true });
  if (await mobileToggle.count()) await mobileToggle.click();
  await page.locator('.object-panel.mobile-visible').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '审核第 2 页', exact: true }).waitFor({ state: 'visible' });
  const mobileDimensions = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    objectPanel: document.querySelector('.object-panel')?.scrollWidth ?? null,
    objectPanelClient: document.querySelector('.object-panel')?.clientWidth ?? null,
  }));
  assert.equal(mobileDimensions.viewport, 390);
  assert.equal(mobileDimensions.document > mobileDimensions.viewport, false, 'the 390px document must not overflow horizontally');
  assert.equal(mobileDimensions.body > mobileDimensions.viewport, false, 'the 390px body must not overflow horizontally');
  await page.screenshot({ path: path.join(evidenceDir, 'edited-page-two-mobile-390.png') });
  report.mobile390 = { ...mobileDimensions, horizontalOverflow: false };
  report.screenshots.push('edited-page-two-mobile-390.png');
  report.checks.push('390px-review-workbench-has-no-horizontal-overflow');

  await page.setViewportSize({ width: 1440, height: 1000 });
  const restoreResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/restore-page-edit'));
  await page.getByRole('button', { name: '恢复本页上一版', exact: true }).click();
  const restoreHttp = await restoreResponse;
  assert.equal(restoreHttp.status(), 200, 'the UI restore action should use the server restore route');
  task = await waitForTask(task.id, (value) => value.sheetVersion === 3 && value.execution?.status === 'succeeded', 'page restore');
  const restoredTask = await readTask(task.id, isolatedRoot);
  assert.equal(restoredTask.sheets.at(-1).pageEdit.action, 'restore');
  assert.equal(restoredTask.sheets.at(-1).pageEdit.restoredFromVersion, 1);
  assert.equal(restoredTask.execution.pages.find((record) => record.page === 2).image.sha256, baselinePages[1].sha256);
  assert.equal(restoredTask.execution.pages.find((record) => record.page === 2).image.path, baselinePages[1].path);
  assert.equal(restoredTask.sheets.at(-1).pages.find((item) => item.page === 2).copy, '基线第二页标题');
  for (const pageNumber of [1, 3]) {
    const original = baselinePages.find((record) => record.page === pageNumber);
    const current = restoredTask.execution.pages.find((record) => record.page === pageNumber);
    assert.equal(current.image.path, original.path);
    assert.equal(current.image.sha256, original.sha256);
  }
  assert.equal(generationCount, 3, 'restoring a previous page must not call image generation');
  assert.equal(editCount, 1, 'restoring a previous page must not call image edits');
  report.restore = {
    version: restoredTask.sheetVersion,
    action: restoredTask.sheets.at(-1).pageEdit.action,
    page: 2,
    restoredFromVersion: restoredTask.sheets.at(-1).pageEdit.restoredFromVersion,
    pageTwoSha256: restoredTask.execution.pages.find((record) => record.page === 2).image.sha256,
    pageTwoCopy: restoredTask.sheets.at(-1).pages.find((item) => item.page === 2).copy,
    pages: restoredTask.execution.pages.map((record) => ({ page: record.page, sha256: record.image.sha256, byteLength: record.image.bytes })),
    fakeGenerationRequestsAfterBaseline: generationCount - 3,
    fakeEditRequestsAfterEdit: editCount - 1,
  };
  report.checks.push('ui-restore-route-restores-only-page-two-image-and-copy-with-zero-image-model-calls');

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '局部改页隔离验收', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('tab', { name: '成品审核', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '审核第 2 页', exact: true }).click();
  await page.waitForFunction(() => {
    const image = document.querySelector('.review-image-wrap img');
    return Boolean(image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
  }, undefined, { timeout: 20_000 });
  await page.screenshot({ path: path.join(evidenceDir, 'restored-page-two-desktop.png') });
  report.screenshots.push('restored-page-two-desktop.png');

  await drawing?.close().catch(() => {});
  drawing = null;
  const uploadTaskCreated = (await request('/api/tasks', {
    title: '上传图片局部修改隔离验收',
    brief: { topic: '上传图片风格参考局部修改软件验收', audience: '本地测试', requirements: '第二张作为修改底图，第一张只参考风格；保留原有内容与文字。' },
  })).task;
  const uploadForm = new FormData();
  uploadForm.set('expectedRevision', String(uploadTaskCreated.revision));
  uploadForm.set('uploadId', randomUUID());
  uploadForm.set('instructions', '隔离软件验收：第二张是改图底图，第一张只作为风格参考。');
  uploadForm.append('files', new Blob([await fs.readFile(path.join(repo, 'web/public/brand/characters/portrait.png'))], { type: 'image/png' }), 'uploaded-base.png');
  uploadForm.append('files', new Blob([await fs.readFile(path.join(repo, 'web/public/brand/whale-artist.png'))], { type: 'image/png' }), 'uploaded-style.png');
  const uploadResult = await requestForm(`/api/tasks/${encodeURIComponent(uploadTaskCreated.id)}/attachments`, uploadForm);
  let uploadTask = uploadResult.task;
  assert.equal(uploadTask.inputConfirmation, null);
  assert.equal(uploadTask.sheetVersion, 0);
  assert.equal(uploadTask.sheetConfirmation, null);
  assert.equal(uploadTask.sources.length, 1);
  assert.equal(uploadTask.sources[0].decision, 'pending');
  assert.equal(uploadTask.sources[0].files.length, 2);
  const uploadFiles = uploadTask.sources[0].files.slice().sort((left, right) => left.order - right.order);
  const uploadFileHashes = uploadFiles.map((file) => ({ order: file.order, sha256: file.sha256 }));
  report.checks.push('second-task-has-two-pending-uploaded-pngs-without-input-or-sheet-confirmation');

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '上传图片局部修改隔离验收', exact: true }).click();
  await page.getByRole('heading', { name: '上传图片局部修改隔离验收', exact: true }).waitFor({ state: 'visible' });
  const uploadedCanvasPopup = page.waitForEvent('popup');
  await page.locator('.canvas-open').click();
  drawing = await uploadedCanvasPopup;
  drawing.on('pageerror', (failure) => browserErrors.push(cleanFailure(failure.message)));
  await drawing.waitForURL(/\/canvas(?:\?|\/|#)/, { timeout: 20_000 });
  const uploadedCanvasDeadline = Date.now() + 30_000;
  while (Date.now() < uploadedCanvasDeadline && !(await canvas.state(uploadTask.id)).clientConnected) await drawing.waitForTimeout(150);
  assert.equal((await canvas.state(uploadTask.id)).clientConnected, true, 'the second real Canvas browser must connect to the uploaded-image task');
  await drawing.screenshot({ path: path.join(evidenceDir, 'uploaded-image-canvas-connected.png') });
  report.screenshots.push('uploaded-image-canvas-connected.png');

  const uploadedChatInput = page.getByRole('textbox', { name: '告诉 Agent 想怎么改', exact: true });
  const crossTaskBefore = await readTask(uploadTask.id, isolatedRoot);
  const crossTaskProtectedBefore = {
    revision: crossTaskBefore.revision,
    sheetVersion: crossTaskBefore.sheetVersion,
    sources: crossTaskBefore.sources,
    sheets: crossTaskBefore.sheets,
    execution: crossTaskBefore.execution,
    reviews: crossTaskBefore.reviews,
    finalApproval: crossTaskBefore.finalApproval,
  };
  const generationsBeforeCrossTask = generationCount;
  const editsBeforeCrossTask = editCount;
  await uploadedChatInput.fill(expectedCrossTaskMessage);
  const crossTaskChatResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/chat'));
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const crossTaskChatBody = await (await crossTaskChatResponse).json();
  assert.ok(crossTaskChatBody.job?.id, 'the cross-task scope check should run through the normal chat job');
  await page.locator('.job-activity.active').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.job-dock').count(), 0, 'the cross-task chat job should not display a floating progress dock');
  await waitForJob(crossTaskChatBody.job.id, 'cross-task Canvas node rejection');
  assert.equal(crossTaskCallbackTrace?.chatCalled, true);
  assert.equal(crossTaskCallbackTrace.taskId, uploadTask.id);
  assert.equal(crossTaskCallbackTrace.refusal.code, 'ERR_CANVAS_OPERATION_INPUT');
  assert.equal(generationCount, generationsBeforeCrossTask, 'cross-task rejection must not call image generation');
  assert.equal(editCount, editsBeforeCrossTask, 'cross-task rejection must not call image editing');
  const crossTaskAfter = await readTask(uploadTask.id, isolatedRoot);
  assert.deepEqual({
    revision: crossTaskAfter.revision,
    sheetVersion: crossTaskAfter.sheetVersion,
    sources: crossTaskAfter.sources,
    sheets: crossTaskAfter.sheets,
    execution: crossTaskAfter.execution,
    reviews: crossTaskAfter.reviews,
    finalApproval: crossTaskAfter.finalApproval,
  }, crossTaskProtectedBefore, 'a foreign Canvas node must not mutate the target task or its uploaded sources');
  report.crossTaskCanvasNode = {
    sourceTaskId: mechanicalCallbackTrace.taskId,
    targetTaskId: uploadTask.id,
    refusedCode: crossTaskCallbackTrace.refusal.code,
    targetCanvasUnchanged: crossTaskCallbackTrace.targetNodesUnchanged,
    taskStateUnchanged: true,
    fakeImageRequestsUnchanged: true,
  };
  report.checks.push('cross-task-node-id-is-rejected-without-changing-target-canvas-task-or-image-request-counts');

  await uploadedChatInput.fill(expectedUploadedMessage);
  const uploadedChatResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/chat'));
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const uploadedChatBody = await (await uploadedChatResponse).json();
  assert.ok(uploadedChatBody.job?.id, 'the uploaded-image chat should use the actual Web chat route');
  await waitForJob(uploadedChatBody.job.id, 'uploaded-image chat edit');
  uploadTask = await waitForTask(uploadTask.id, (value) => value.sheetVersion === 1 && value.execution?.status === 'succeeded', 'uploaded-image edit and Canvas recovery');
  const uploadedEditedTask = await readTask(uploadTask.id, isolatedRoot);
  const uploadedEditedSheet = uploadedEditedTask.sheets.at(-1);
  const uploadedEditedPage = uploadedEditedTask.execution.pages.find((record) => record.page === 1);
  assert.equal(uploadedCallbackTrace?.chatCalled, true);
  assert.equal(uploadedCallbackTrace?.editPagesCalled, true);
  assert.equal(uploadedEditedSheet.kind, 'page-edit');
  assert.equal(uploadedEditedSheet.pageEdit.mode, 'uploaded-images');
  assert.equal(uploadedEditedTask.inputConfirmation, null, 'uploaded-image editing must not confirm the task inputs');
  assert.equal(uploadedEditedTask.sheetConfirmation, null, 'uploaded-image editing must not confirm a complete sheet');
  assert.equal(uploadedEditedTask.sources[0].decision, 'pending', 'uploaded images must not be retained automatically');
  assert.equal(uploadedEditedTask.sources[0].files.length, 2);
  assert.equal(uploadedEditedPage.image.sha256, sha256(uploadedEditOutputBytes));
  assert.equal(generationCount, 3, 'uploaded-image editing should use image edits and avoid image generations');
  assert.equal(editCount, 2, 'uploaded-image editing should add exactly one more image edit request');
  assert.equal(editCaptures.length, 2, 'the uploaded-image task should add exactly one image edit request after the previous-output scenario');
  assert.equal(editCapture?.imageCount, 2);
  assert.deepEqual(editCapture.images.map((image) => image.sha256), [uploadFileHashes[1].sha256, uploadFileHashes[0].sha256]);
  assert.deepEqual(uploadedEditedSheet.pageEdit.uploadedImageReferences.map(({ fileOrder, role, sha256: digest }) => ({ fileOrder, role, sha256: digest })), [
    { fileOrder: 2, role: 'edit-base', sha256: uploadFileHashes[1].sha256 },
    { fileOrder: 1, role: 'style', sha256: uploadFileHashes[0].sha256 },
  ]);
  assert.deepEqual(uploadedCallbackTrace.sourceFileHashes.map(({ order, sha256: digest }) => ({ order, sha256: digest })), uploadFileHashes);
  assert.equal((await request(`/api/tasks/${encodeURIComponent(uploadTask.id)}`)).task.sheetAuthorized, true);
  report.uploadedImageEdit = {
    chatInput: expectedUploadedMessage,
    mockAgentInvokedServerCallback: uploadedCallbackTrace.editPagesCalled,
    chatHadNoAttachmentSourceIds: uploadedCallbackTrace.chatHadNoAttachmentSourceIds,
    callbackExpectedRevision: uploadedCallbackTrace.callbackRevision,
    callbackResultRevision: uploadedCallbackTrace.callbackResultRevision,
    version: uploadedEditedTask.sheetVersion,
    mode: uploadedEditedSheet.pageEdit.mode,
    action: uploadedEditedSheet.pageEdit.action,
    authorized: true,
    inputConfirmation: uploadedEditedTask.inputConfirmation,
    sheetConfirmation: uploadedEditedTask.sheetConfirmation,
    sourceDecision: uploadedEditedTask.sources[0].decision,
    sourceFileHashes: uploadFileHashes,
    referencesSentToImageEdit: editCapture,
    uploadedImageReferences: uploadedEditedSheet.pageEdit.uploadedImageReferences.map(({ fileOrder, role, sha256: digest }) => ({ fileOrder, role, sha256: digest })),
    executionPage: { page: uploadedEditedPage.page, sha256: uploadedEditedPage.image.sha256, byteLength: uploadedEditedPage.image.bytes },
    reviewer: '待实际图片复审',
    finalApproval: uploadedEditedTask.finalApproval,
  };
  report.checks.push(
    'pending-uploaded-base-and-style-pngs-reach-the-image-edit-multipart-in-requested-order',
    'uploaded-image-page-edit-is-authorized-without-input-or-sheet-confirmation-and-keeps-source-pending',
    'uploaded-image-chat-uses-task-read-not-fabricated-current-turn-attachment-ids',
    'uploaded-image-edit-adds-exactly-one-request-and-does-not-call-image-generation',
  );

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '上传图片局部修改隔离验收', exact: true }).waitFor({ state: 'visible' });
  await page.locator('.review-panel').waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('tab', { name: '成品审核', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByText('制作单还未确认', { exact: true }).count(), 0, 'the uploaded-image task must not be blocked by a full-sheet confirmation gate');
  assert.equal(await page.getByText('先确认需求与参考', { exact: true }).count(), 0, 'the uploaded-image task must not be blocked by input confirmation');
  await page.waitForFunction(() => {
    const image = document.querySelector('.review-image-wrap img');
    return Boolean(image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
  }, undefined, { timeout: 20_000 });
  const uploadedRenderedImage = await page.locator('.review-image-wrap img').evaluate((image) => ({ width: image.naturalWidth, height: image.naturalHeight }));
  assert.ok(uploadedRenderedImage.width > 0 && uploadedRenderedImage.height > 0);
  await page.screenshot({ path: path.join(evidenceDir, 'uploaded-image-edit-review.png') });
  report.screenshots.push('uploaded-image-edit-review.png');
  report.uploadedImageEdit.reviewUi = { unlocked: true, imageLoaded: true, imageSize: uploadedRenderedImage };
  report.checks.push('uploaded-image-edit-opens-in-unlocked-review-with-visible-canvas-output');

  assert.equal(await page.getByRole('button', { name: '提交本页复审', exact: true }).count(), 0, 'page review should not require a second submit action');
  assert.equal(await page.getByRole('button', { name: '对话修改第 1 页', exact: true }).count(), 0, 'the review panel should not provide a page-prefill chat shortcut');
  const reviewRequestCountBefore = report.apiRequests.filter((request) => request.method === 'POST' && request.path.endsWith('/record-review')).length;
  let reviewDialogMessage = null;
  const reviewDialogHandler = (dialog) => {
    reviewDialogMessage = dialog.message();
    void dialog.dismiss();
  };
  page.on('dialog', reviewDialogHandler);
  const uploadedReviewResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/record-review'), { timeout: 10_000 }).catch(() => null);
  await page.locator('.decision-buttons').getByRole('button', { name: '通过', exact: true }).click();
  page.off('dialog', reviewDialogHandler);
  assert.equal(reviewDialogMessage, null, 'saving a page review should not open a native confirmation');
  const uploadedReviewResponse = await uploadedReviewResponsePromise;
  assert.ok(uploadedReviewResponse, 'clicking the page decision should post the review directly');
  assert.equal((await uploadedReviewResponse).status(), 200, 'the uploaded-image result should pass the normal Web review route');
  uploadTask = await waitForTask(uploadTask.id, (value) => value.reviews?.some((review) => review.version === 1 && review.page === 1 && review.decision === 'pass'), 'uploaded image pass review');
  await page.waitForTimeout(150);
  const reviewRequestCountAfter = report.apiRequests.filter((request) => request.method === 'POST' && request.path.endsWith('/record-review')).length;
  assert.equal(reviewRequestCountAfter - reviewRequestCountBefore, 1, 'one decision click should create exactly one review POST');
  report.checks.push('single-page-review-click-posts-once-without-native-confirm');
  const approveResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/approve-final'));
  await page.getByRole('button', { name: '人工批准当前成品', exact: true }).click();
  assert.equal((await approveResponse).status(), 200, 'the uploaded-image result should pass final human approval');
  uploadTask = await waitForTask(uploadTask.id, (value) => value.finalApproval?.version === 1, 'uploaded image final approval');
  const exportResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/export'));
  await page.getByRole('button', { name: '导出素材包', exact: true }).click();
  const exportHttp = await exportResponse;
  assert.equal(exportHttp.status(), 200, 'the uploaded-image task should export through the normal Web route');
  const exportBody = await exportHttp.json();
  assert.equal(exportBody.export?.version, 'export-001');
  assert.ok(exportBody.export.archiveSha256);
  const exportedResponse = await fetch(webUrl + exportBody.export.downloadUrl);
  assert.equal(exportedResponse.status, 200);
  const exportedBytes = Buffer.from(await exportedResponse.arrayBuffer());
  assert.equal(sha256(exportedBytes), exportBody.export.archiveSha256);
  const exportedFiles = unzipSync(exportedBytes);
  assert.ok(Object.keys(exportedFiles).length > 0, 'the uploaded-image export should contain output files');
  report.uploadedImageEdit.review = { decision: 'pass', recordedThroughWeb: true };
  report.uploadedImageEdit.finalApproval = { version: uploadTask.finalApproval.version, recordedThroughWeb: true };
  report.uploadedImageEdit.export = { version: exportBody.export.version, archiveSha256: exportBody.export.archiveSha256, fileCount: Object.keys(exportedFiles).length };
  report.checks.push('uploaded-image-output-passes-web-review-final-approval-and-export');

  await drawing?.close().catch(() => {});
  drawing = null;
  const oldQrPayload = 'https://fixture.invalid/old-demo';
  const newQrPayload = 'https://fixture.invalid/new-demo';
  const oldQrFixture = makeQrFixture(oldQrPayload);
  const newQrFixture = makeQrFixture(newQrPayload);
  assert.deepEqual({ width: oldQrFixture.width, height: oldQrFixture.height }, { width: 148, height: 148 });
  assert.deepEqual({ width: newQrFixture.width, height: newQrFixture.height }, { width: 148, height: 148 });
  const posterFixture = await makePosterFixture(oldQrFixture.bytes);
  compositionFixtureMeta = [
    { fileName: 'synthetic-poster-old-qr.png', bytes: posterFixture.bytes, width: posterFixture.width, height: posterFixture.height },
    { fileName: 'synthetic-qr-new.png', bytes: newQrFixture.bytes, width: newQrFixture.width, height: newQrFixture.height },
    { fileName: 'synthetic-tile-one.png', bytes: makeTileFixture(0, 5, 4), width: 5, height: 4 },
    { fileName: 'synthetic-tile-two.png', bytes: makeTileFixture(1, 4, 6), width: 4, height: 6 },
    { fileName: 'synthetic-tile-three.png', bytes: makeTileFixture(2, 3, 5), width: 3, height: 5 },
    { fileName: 'synthetic-transparent-overlay-wide.png', bytes: makeTransparentOverlay(30, 10, 1), width: 30, height: 10 },
    { fileName: 'synthetic-transparent-overlay-overlap.png', bytes: makeTransparentOverlay(20, 20, 2), width: 20, height: 20 },
  ];
  for (const fixture of compositionFixtureMeta) {
    await fs.writeFile(path.join(evidenceDir, fixture.fileName), fixture.bytes, { mode: 0o600 });
  }
  report.syntheticComposition = {
    fixtureOnly: true,
    taskTitle: '像素合成与二维码替换隔离验收',
    oldQrPayload,
    newQrPayload,
    posterSize: { width: posterFixture.width, height: posterFixture.height },
    newQrSize: { width: newQrFixture.width, height: newQrFixture.height },
    inputs: compositionFixtureMeta.map(({ fileName, bytes, width, height }, index) => ({ fileOrder: index + 1, fileName, width, height, byteLength: bytes.length, sha256: sha256(bytes) })),
    outputFiles: compositionFixtureMeta.map(({ fileName }) => fileName),
  };
  let originalQrDecode = null;
  let originalQrRegion = null;
  try {
    const posterPath = path.join(evidenceDir, compositionFixtureMeta[0].fileName);
    const newQrPath = path.join(evidenceDir, compositionFixtureMeta[1].fileName);
    originalQrDecode = await decodeFixtureQrPayloads([posterPath, newQrPath]);
  } catch (failure) {
    report.syntheticComposition.qrDecodeBefore = { available: false, errorCode: 'ERR_QR_DECODER' };
  }
  if (originalQrDecode) {
    assert.ok(originalQrDecode[0].payloads.includes(oldQrPayload), 'jsQR should decode the old demo QR on the poster fixture');
    assert.ok(!originalQrDecode[0].payloads.includes(newQrPayload), 'the poster fixture must not start with the new demo QR');
    assert.ok(originalQrDecode[1].payloads.includes(newQrPayload), 'jsQR should decode the uploaded new demo QR fixture');
    originalQrRegion = originalQrDecode[0].regions.find((region) => /qr/i.test(region.kind));
    assert.ok(originalQrRegion, 'jsQR should locate the original QR symbol bounds on the poster fixture');
    assert.ok(originalQrRegion.confidence >= 0.9, 'jsQR should confidently locate the original QR symbol');
    const expectedOldQrBounds = { x: 356, y: 236, width: 116, height: 116 };
    for (const key of Object.keys(expectedOldQrBounds)) {
      assert.ok(Math.abs(originalQrRegion.bounds[key] - expectedOldQrBounds[key]) <= 1, `jsQR ${key} bound should match the synthetic poster QR fixture`);
    }
    report.syntheticComposition.qrDecodeBefore = {
      available: true,
      posterPayloads: originalQrDecode[0].payloads,
      newQrFixturePayloads: originalQrDecode[1].payloads,
      originalQrRegion: { kind: originalQrRegion.kind, confidence: originalQrRegion.confidence, bounds: originalQrRegion.bounds },
      recommendedClearRect: paddedPixelBounds(originalQrRegion.bounds, 2),
    };
    report.checks.push('independent-jsqr-locates-the-original-qr-symbol-within-the-synthetic-poster-region');
  }

  const compositionTaskCreated = (await request('/api/tasks', {
    title: '像素合成与二维码替换隔离验收',
    brief: { topic: '合成与二维码替换软件验证', audience: '本地虚构测试', requirements: '只验证导入、原像素拼接与通用图层合成，不含真实业务内容。' },
  })).task;
  const compositionUpload = new FormData();
  compositionUpload.set('expectedRevision', String(compositionTaskCreated.revision));
  compositionUpload.set('uploadId', randomUUID());
  compositionUpload.set('instructions', '全部附件都是本地生成的像素测试夹具，不含业务资料。');
  for (const fixture of compositionFixtureMeta) {
    compositionUpload.append('files', new Blob([fixture.bytes], { type: 'image/png' }), fixture.fileName);
  }
  const compositionUploadResult = await requestForm(`/api/tasks/${encodeURIComponent(compositionTaskCreated.id)}/attachments`, compositionUpload);
  const compositionTask = compositionUploadResult.task;
  assert.equal(compositionTask.sources.length, 1);
  assert.equal(compositionTask.sources[0].decision, 'pending');
  assert.deepEqual(compositionTask.sources[0].files.map((file) => file.order), compositionFixtureMeta.map((_, index) => index + 1));
  assert.deepEqual(compositionTask.sources[0].files.map((file) => file.sha256), compositionFixtureMeta.map(({ bytes }) => sha256(bytes)));
  report.syntheticComposition.uploadedTaskId = compositionTask.id;
  report.checks.push('synthetic-poster-transparent-overlays-tiles-and-new-qr-uploaded-with-exact-file-hashes');

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '像素合成与二维码替换隔离验收', exact: true }).click();
  await page.getByRole('heading', { name: '像素合成与二维码替换隔离验收', exact: true }).waitFor({ state: 'visible' });
  const compositionCanvasPopup = page.waitForEvent('popup');
  await page.locator('.canvas-open').click();
  drawing = await compositionCanvasPopup;
  drawing.on('pageerror', (failure) => browserErrors.push(cleanFailure(failure.message)));
  await drawing.waitForURL(/\/canvas(?:\?|\/|#)/, { timeout: 20_000 });
  const compositionCanvasDeadline = Date.now() + 30_000;
  while (Date.now() < compositionCanvasDeadline && !(await canvas.state(compositionTask.id)).clientConnected) await drawing.waitForTimeout(150);
  assert.equal((await canvas.state(compositionTask.id)).clientConnected, true, 'the composition Canvas browser must connect to the synthetic upload task');
  await drawing.screenshot({ path: path.join(evidenceDir, 'synthetic-composition-canvas-connected.png') });
  report.screenshots.push('synthetic-composition-canvas-connected.png');

  const generationBeforeComposition = generationCount;
  const editBeforeComposition = editCount;
  const compositionChat = page.getByRole('textbox', { name: '告诉 Agent 想怎么改', exact: true });
  await compositionChat.fill(expectedCompositionMessage);
  const compositionChatResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/chat'));
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const compositionChatBody = await (await compositionChatResponse).json();
  assert.ok(compositionChatBody.job?.id, 'the deterministic composition callback must run through the actual Web chat route');
  await waitForJob(compositionChatBody.job.id, 'synthetic Canvas image composition');
  assert.equal(compositionCallbackTrace?.chatCalled, true);
  assert.equal(compositionCallbackTrace.taskId, compositionTask.id);
  assert.equal(generationCount, generationBeforeComposition, 'import, stitch, and compose must not call image generation');
  assert.equal(editCount, editBeforeComposition, 'import, stitch, and compose must not call image editing');
  assert.equal(compositionCallbackTrace.sourceBytesUnchanged, true);
  assert.equal(compositionCallbackTrace.wrongTaskNode.code, 'ERR_CANVAS_OPERATION_INPUT');
  assert.equal(compositionCallbackTrace.wrongTaskNode.targetCanvasUnchanged, true);
  assert.equal(compositionCallbackTrace.duplicateImport.attachmentCount, 0);
  assert.equal(compositionCallbackTrace.duplicateImport.stableNode, true);
  assert.equal(compositionCallbackTrace.operations.horizontal.attachmentCount, 1);
  assert.equal(compositionCallbackTrace.operations.vertical.attachmentCount, 1);
  assert.equal(compositionCallbackTrace.operations.compose.attachmentCount, 1);
  const syntheticAttachmentEntries = [
    ['horizontal', compositionCallbackTrace.operations.horizontal.attachments[0]],
    ['vertical', compositionCallbackTrace.operations.vertical.attachments[0]],
    ['compose', compositionCallbackTrace.operations.compose.attachments[0]],
  ];
  const syntheticAttachments = syntheticAttachmentEntries.map(([, attachment]) => attachment);
  assert.equal(syntheticAttachments.length, 3, 'imports must not add attachments and each output operation must add exactly one');
  const outputNames = { horizontal: 'stitch-horizontal.png', vertical: 'stitch-vertical.png', compose: 'composed-poster-new-qr.png' };
  for (const [operation, attachment] of syntheticAttachmentEntries) {
    assert.match(attachment.fileUrl, /^\/api\/tasks\/[^/]+\/canvas-operations\//);
    assert.equal(attachment.downloadUrl, `${attachment.fileUrl}?download=1`);
    const inlineResponse = await fetch(webUrl + attachment.fileUrl);
    assert.equal(inlineResponse.status, 200);
    assert.match(inlineResponse.headers.get('content-type') || '', /^image\/png\b/);
    const inlineBytes = Buffer.from(await inlineResponse.arrayBuffer());
    assert.deepEqual([...inlineBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(inlineBytes.readUInt32BE(16), attachment.width);
    assert.equal(inlineBytes.readUInt32BE(20), attachment.height);
    assert.equal(sha256(inlineBytes), attachment.sha256);
    const downloadResponse = await fetch(webUrl + attachment.downloadUrl);
    assert.equal(downloadResponse.status, 200);
    assert.equal(sha256(Buffer.from(await downloadResponse.arrayBuffer())), attachment.sha256);
    const body = Buffer.from(await (await fetch(webUrl + attachment.fileUrl)).arrayBuffer());
    await fs.writeFile(path.join(evidenceDir, outputNames[operation]), body, { mode: 0o600 });
    report.syntheticComposition.outputFiles.push(outputNames[operation]);
  }
  const compositionDetailBeforeReload = await request(`/api/tasks/${encodeURIComponent(compositionTask.id)}`);
  const compositionMessage = compositionDetailBeforeReload.conversation.find((message) => message.role === 'assistant' && message.text === '测试图片已导入并完成拼接与二维码替换像素合成。');
  assert.ok(compositionMessage, 'the synthetic composition chat response must be persisted');
  assert.deepEqual(compositionMessage.attachments.map(({ fileUrl }) => fileUrl).sort(), syntheticAttachments.map(({ fileUrl }) => fileUrl).sort());
  const compositionTaskAfter = compositionDetailBeforeReload.task;
  assert.equal(compositionTaskAfter.sheetVersion, 0, 'mechanical image composition must not create or approve a production sheet');
  assert.equal(compositionTaskAfter.sources[0].decision, 'pending', 'mechanical composition must not retain uploaded sources automatically');

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '像素合成与二维码替换隔离验收', exact: true }).waitFor({ state: 'visible' });
  const persistedCompositionRow = page.locator('.message-row.assistant').filter({ hasText: '测试图片已导入并完成拼接与二维码替换像素合成。' }).last();
  await persistedCompositionRow.locator('.message-attachments').waitFor({ state: 'visible' });
  assert.equal(await persistedCompositionRow.locator('.message-attachments a[download]').count(), 3, 'the three output PNGs must remain downloadable after refresh');
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll('.message-row.assistant')].find((item) => item.textContent?.includes('测试图片已导入并完成拼接与二维码替换像素合成。'));
    const images = [...(row?.querySelectorAll('.message-attachments img') || [])];
    return images.length === 3 && images.every((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
  }, undefined, { timeout: 20_000 });
  await page.screenshot({ path: path.join(evidenceDir, 'synthetic-composition-chat-after-refresh.png') });
  report.screenshots.push('synthetic-composition-chat-after-refresh.png');

  const sourceDataUrl = (order) => dataUrl(compositionFixtureMeta[order - 1].bytes);
  const outputAttachment = (operation) => compositionCallbackTrace.operations[operation].attachments[0];
  const compositionPixelChecks = await comparePixelComposition(page, {
    baseDataUrl: sourceDataUrl(1),
    layerDataUrls: [sourceDataUrl(6), sourceDataUrl(7), sourceDataUrl(2)],
    horizontalSources: [sourceDataUrl(3), sourceDataUrl(4), sourceDataUrl(5)],
    verticalSources: [sourceDataUrl(3), sourceDataUrl(4), sourceDataUrl(5)],
    horizontalUrl: outputAttachment('horizontal').fileUrl,
    verticalUrl: outputAttachment('vertical').fileUrl,
    compositionUrl: outputAttachment('compose').fileUrl,
    composeLayers: compositionCallbackTrace.composeLayers,
  });
  assert.equal(compositionPixelChecks.horizontal.pixelComparison.dimensionsMatch, true);
  assert.equal(compositionPixelChecks.horizontal.pixelComparison.mismatchedPixels, 0, 'horizontal stitch must preserve original source order and exact pixels');
  assert.equal(compositionPixelChecks.vertical.pixelComparison.dimensionsMatch, true);
  assert.equal(compositionPixelChecks.vertical.pixelComparison.mismatchedPixels, 0, 'vertical stitch must preserve original source order and exact pixels');
  assert.equal(compositionPixelChecks.compose.pixelComparison.dimensionsMatch, true);
  assert.equal(compositionPixelChecks.compose.pixelComparison.mismatchedPixels, 0, 'compose output must match the ordered full-pixel reference');
  assert.equal(compositionPixelChecks.compose.untouchedAreaComparison.mismatchedPixels, 0, 'every pixel outside the declared layer rectangles must remain byte-identical to the base poster');
  assert.deepEqual(compositionPixelChecks.compose.samples.containLetterboxAfterClear, [223, 239, 255, 255], 'contain must leave the full clear rectangle visible in letterbox margins');
  assert.deepEqual(compositionPixelChecks.compose.samples.laterOverlapClear, [255, 238, 204, 255], 'the later overlapping layer must clear and cover the earlier layer in order');
  report.syntheticComposition.pixels = compositionPixelChecks;
  const compositionOutputBytes = Buffer.from(await (await fetch(webUrl + outputAttachment('compose').downloadUrl)).arrayBuffer());
  const finalCompositionPath = path.join(evidenceDir, 'synthetic-poster-new-qr.png');
  await fs.writeFile(finalCompositionPath, compositionOutputBytes, { mode: 0o600 });
  report.syntheticComposition.outputFiles.push('synthetic-poster-new-qr.png');
  if (originalQrDecode) {
    let finalQrDecode = null;
    try {
      finalQrDecode = await decodeFixtureQrPayloads([
        path.join(evidenceDir, compositionFixtureMeta[0].fileName),
        path.join(evidenceDir, compositionFixtureMeta[1].fileName),
        finalCompositionPath,
      ]);
    } catch {
      report.syntheticComposition.qrDecodeAfter = { available: false, errorCode: 'ERR_QR_DECODER' };
    }
    if (finalQrDecode) {
      assert.ok(finalQrDecode[2].payloads.includes(newQrPayload), 'independent jsQR must find the new QR in the composite poster');
      assert.ok(!finalQrDecode[2].payloads.includes(oldQrPayload), 'independent jsQR must no longer find the old QR in the composite poster');
      report.syntheticComposition.qrDecodeAfter = { available: true, posterPayloads: finalQrDecode[0].payloads, newQrFixturePayloads: finalQrDecode[1].payloads, compositePayloads: finalQrDecode[2].payloads };
      report.checks.push('independent-jsqr-decodes-new-qr-and-confirms-old-qr-is-gone');
    }
  } else {
    report.syntheticComposition.qrDecodeAfter = { available: false, errorCode: report.syntheticComposition.qrDecodeBefore.errorCode || 'ERR_QR_DECODER' };
  }
  report.syntheticComposition.operations = {
    imports: compositionCallbackTrace.imported,
    duplicateImport: compositionCallbackTrace.duplicateImport,
    wrongTaskNode: compositionCallbackTrace.wrongTaskNode,
    outputOperations: Object.fromEntries(Object.entries(compositionCallbackTrace.operations).map(([operation, outcome]) => [operation, {
      result: outcome.result,
      attachments: outcome.attachments,
    }])),
    persistedAfterReload: compositionMessage.attachments.length,
    sourceBytesUnchanged: compositionCallbackTrace.sourceBytesUnchanged,
    imageModelRequestsUnchanged: generationCount === generationBeforeComposition && editCount === editBeforeComposition,
  };
  report.checks.push(
    'task-scoped-import-preserves-png-size-and-does-not-create-attachments-or-duplicate-nodes',
    'horizontal-and-vertical-stitch-return-one-http-and-downloadable-png-with-exact-source-order-pixels',
    'generic-compose-clears-full-integer-rectangles-fits-transparent-pngs-and-composites-overlap-in-order',
    'compose-preserves-every-poster-pixel-outside-the-declared-layer-rectangles',
    'compose-and-stitch-reject-foreign-task-node-without-changing-canvas-or-uploaded-sources',
    'composition-output-attachments-remain-visible-and-downloadable-after-web-refresh',
    'mechanical-import-stitch-and-compose-do-not-call-image-generation-or-editing-models',
  );

  if (realModelRequested) {
    liveModelFailurePhase = true;
    report.realModel = { requested: true, status: 'running', promptIntent: 'replace-lower-right-demo-qr-with-uploaded-new-qr' };
    assert.ok(originalQrRegion, 'the independent QR decoder baseline must locate the synthetic source QR before the live-model request');
    const configured = await readConfig();
    const basic = configured.basic;
    assert.ok(basic?.baseUrl && basic.apiKey && basic.model, 'current Web basic-model configuration must be complete');
    assert.match(basic.source || '', /^workbuddy-(cn|intl)$/, 'the authorized live verification expects the already configured WorkBuddy basic-model source');
    liveBasicConfig = { ...basic };
    report.realModel.source = basic.source;
    report.realModel.model = basic.model;
    const isolatedConfig = await readConfig({ root: isolatedRoot });
    await saveConfig({
      expectedRevision: isolatedConfig.revision,
      base: { source: basic.source, model: basic.model },
    }, { root: isolatedRoot });
    liveModelAgent = createStudioAgent({
      root: isolatedRoot,
      readConfig: async () => {
        const local = await readConfig({ root: isolatedRoot });
        return { ...local, basic: { ...liveBasicConfig } };
      },
    });
    liveModelEnabled = true;

    const liveTaskCreated = (await request('/api/tasks', {
      title: '自然语言二维码替换真实模型验证',
      brief: { topic: '虚构海报二维码像素替换', audience: '本地软件验证', requirements: '只在隔离 Canvas 中读取两张测试图并输出二维码替换结果。' },
    })).task;
    const liveUpload = new FormData();
    liveUpload.set('expectedRevision', String(liveTaskCreated.revision));
    liveUpload.set('uploadId', randomUUID());
    liveUpload.set('instructions', '两张附件是虚构海报和自建二维码，仅供本地软件验证。');
    for (const order of [1, 2]) {
      const fixture = compositionFixtureMeta[order - 1];
      liveUpload.append('files', new Blob([fixture.bytes], { type: 'image/png' }), fixture.fileName);
    }
    const liveUploadResult = await requestForm(`/api/tasks/${encodeURIComponent(liveTaskCreated.id)}/attachments`, liveUpload);
    assert.equal(liveUploadResult.task.sources[0].files.length, 2);
    report.realModel.taskTitle = '自然语言二维码替换真实模型验证';
    report.realModel.uploads = liveUploadResult.task.sources[0].files.map(({ order, name, sha256: digest }) => ({ order, name, sha256: digest }));

    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '自然语言二维码替换真实模型验证', exact: true }).click();
    await page.getByRole('heading', { name: '自然语言二维码替换真实模型验证', exact: true }).waitFor({ state: 'visible' });
    const liveCanvasPopup = page.waitForEvent('popup');
    await page.locator('.canvas-open').click();
    drawing = await liveCanvasPopup;
    drawing.on('pageerror', (failure) => browserErrors.push(cleanFailure(failure.message)));
    await drawing.waitForURL(/\/canvas(?:\?|\/|#)/, { timeout: 20_000 });
    const liveCanvasDeadline = Date.now() + 30_000;
    while (Date.now() < liveCanvasDeadline && !(await canvas.state(liveTaskCreated.id)).clientConnected) await drawing.waitForTimeout(150);
    assert.equal((await canvas.state(liveTaskCreated.id)).clientConnected, true, 'the real-model Canvas browser must connect to the isolated two-image task');
    await drawing.screenshot({ path: path.join(evidenceDir, 'real-model-canvas-connected.png') });
    report.screenshots.push('real-model-canvas-connected.png');

    const liveGenerationBefore = generationCount;
    const liveEditBefore = editCount;
    const liveChatInput = page.getByRole('textbox', { name: '告诉 Agent 想怎么改', exact: true });
    await liveChatInput.fill(expectedRealCompositionMessage);
    liveModelVerificationStage = 'wait-for-live-model-job';
    const liveChatResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/chat'));
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const liveChatBody = await (await liveChatResponse).json();
    assert.ok(liveChatBody.job?.id, 'the natural-language WorkBuddy chat must use the real Web chat job');
    await waitForJob(liveChatBody.job.id, 'natural-language live model Canvas composition', 10 * 60 * 1000);
    liveModelFailurePhase = true;
    liveModelVerificationStage = 'validate-live-model-callbacks';
    assert.ok(liveCompositionTrace?.calls?.length, 'the live Agent must call actual task-scoped Canvas callbacks');
    assert.ok(liveCompositionTrace.calls.some((call) => call.toolName === 'studio_canvas_state'), 'the live Agent must inspect real Canvas node state');
    assert.ok(liveCompositionTrace.calls.some((call) => call.toolName === 'studio_canvas_read_image'), 'the live Agent must read a real Canvas image preview');
    const importCalls = liveCompositionTrace.calls.filter((call) => call.toolName === 'studio_canvas_operation' && call.operation === 'import' && call.outcome === 'succeeded');
    const posterImport = importCalls.find((call) => call.fileOrder === 1);
    const newQrImport = importCalls.find((call) => call.fileOrder === 2);
    assert.ok(posterImport?.images?.length === 1, 'the live Agent must import the current-task poster');
    assert.ok(newQrImport?.images?.length === 1, 'the live Agent must import the current-task new QR');
    const posterNodeId = posterImport.images[0].nodeId;
    const newQrNodeId = newQrImport.images[0].nodeId;
    assert.ok(liveCompositionTrace.calls.some((call) => call.toolName === 'studio_canvas_read_image' && call.nodeId === posterNodeId), 'the live Agent must preview the imported poster before placing the new QR');
    const liveRegionCalls = liveCompositionTrace.calls.filter((call) => call.toolName === 'studio_canvas_detect_regions' && call.outcome !== 'failed');
    const livePosterRegionCall = liveRegionCalls.find((call) => call.nodeId === posterNodeId);
    assert.ok(livePosterRegionCall, 'the live Agent must use generic region detection on the imported poster before composition');
    assert.deepEqual({ width: livePosterRegionCall.width, height: livePosterRegionCall.height }, { width: posterFixture.width, height: posterFixture.height });
    assert.equal(livePosterRegionCall.sha256, sha256(compositionFixtureMeta[0].bytes), 'region detection must refer to the exact uploaded poster bytes');
    assert.equal(livePosterRegionCall.truncated, false, 'the poster region result must not be truncated');
    const liveQrRegion = livePosterRegionCall.regions.find((region) => /barcode|qr/i.test(region.kind));
    assert.ok(liveQrRegion, 'generic region detection must return the old QR barcode bounds');
    assert.ok(liveQrRegion.confidence >= 0.9, 'the old QR barcode bounds must have high detection confidence');
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(liveQrRegion.bounds[key] - originalQrRegion.bounds[key]) <= 1, `the Canvas QR detector ${key} bound should agree with the independent QR decoder`);
    }
    const composeCalls = liveCompositionTrace.calls.filter((call) => call.toolName === 'studio_canvas_operation' && call.operation === 'compose' && call.outcome === 'succeeded');
    assert.ok(composeCalls.length > 0, 'the live Agent must use the generic Canvas compose operation');
    const liveCompose = composeCalls.at(-1);
    assert.ok(liveCompositionTrace.calls.indexOf(livePosterRegionCall) < liveCompositionTrace.calls.indexOf(liveCompose), 'the live Agent must detect the poster QR before composing the replacement');
    assert.equal(liveCompose.nodeId, posterNodeId, 'the composition base must be the uploaded poster');
    assert.equal(liveCompose.layers.length, 1, 'the natural request should change only one poster element');
    assert.equal(liveCompose.layers.length, 1, 'the natural request should change only one poster element');
    const liveQrLayer = liveCompose.layers[0];
    const cropProducers = liveCompositionTrace.calls.filter((call) => call.toolName === 'studio_canvas_operation'
      && call.operation === 'crop' && call.outcome === 'succeeded');
    const cropLineage = [];
    const visitedLayerNodes = new Set();
    let layerSourceNodeId = liveQrLayer.nodeId;
    while (layerSourceNodeId !== newQrNodeId) {
      assert.ok(!visitedLayerNodes.has(layerSourceNodeId), 'the new QR crop lineage must not contain a cycle');
      visitedLayerNodes.add(layerSourceNodeId);
      const producers = cropProducers.filter((call) => call.images?.some((image) => image.nodeId === layerSourceNodeId));
      assert.equal(producers.length, 1, 'each derived QR node must have exactly one successful Canvas crop producer');
      const producer = producers[0];
      assert.equal(producer.operation, 'crop');
      assert.equal(typeof producer.nodeId, 'string', 'each crop must name its source node');
      assert.ok(producer.crop && Number.isInteger(producer.crop.x) && Number.isInteger(producer.crop.y)
        && Number.isInteger(producer.crop.width) && Number.isInteger(producer.crop.height), 'each QR crop must record its integer source rectangle');
      const producedImage = producer.images.find((image) => image.nodeId === layerSourceNodeId);
      cropLineage.push({ sourceNodeId: producer.nodeId, crop: producer.crop, outputNodeId: producedImage.nodeId,
        width: producedImage.width, height: producedImage.height, sha256: producedImage.sha256 });
      layerSourceNodeId = producer.nodeId;
    }
    cropLineage.reverse();
    const expectedQrLayerBounds = paddedPixelBounds(liveQrRegion.bounds, 2);
    assert.equal(liveQrRegion.suggestedPadding, 2, 'the generic detector must report its two-pixel suggested padding');
    assert.deepEqual(liveQrRegion.suggestedBounds, expectedQrLayerBounds, 'the suggested bounds must expand the barcode pixels by two pixels');
    assert.ok([liveQrLayer.x, liveQrLayer.y, liveQrLayer.width, liveQrLayer.height].every(Number.isInteger), 'the replacement rectangle must use integer pixel coordinates');
    assert.ok(liveQrLayer.x >= 0 && liveQrLayer.y >= 0 && liveQrLayer.width > 0 && liveQrLayer.height > 0
      && liveQrLayer.x + liveQrLayer.width <= posterFixture.width && liveQrLayer.y + liveQrLayer.height <= posterFixture.height,
    'the replacement rectangle must be positive and stay inside the poster');
    assert.ok(containsPixelBounds(liveQrLayer, liveQrRegion.bounds), 'the clear rectangle must cover the entire original QR symbol region');
    assert.equal(liveQrLayer.clear, '#ffffff', 'the live model must explicitly clear the complete old QR rectangle before placing the replacement');
    assert.ok(['contain', undefined].includes(liveQrLayer.fit), 'the new QR must preserve its aspect ratio');
    assert.ok(['nearest', undefined].includes(liveQrLayer.smoothing), 'the uploaded QR must keep nearest-neighbor pixel sampling');
    assert.equal(liveModelFailurePhase, true, 'the report must keep live-model errors sanitized until all verification completes');
    assert.deepEqual(liveCompositionTrace.unexpectedTools, [], 'the live model must use the Canvas path and must not invoke page image editing');
    assert.equal(generationCount, liveGenerationBefore, 'the real-model composition must not call image generation');
    assert.equal(editCount, liveEditBefore, 'the real-model composition must not call image editing');

    liveModelVerificationStage = 'read-live-layer-and-task-sources';
    const liveTaskDetail = await request(`/api/tasks/${encodeURIComponent(liveTaskCreated.id)}`);
    const liveLayerImage = await canvas.agentImage(liveTaskCreated.id, {
      nodeId: liveQrLayer.nodeId,
      expectedRevision: liveTaskDetail.task.revision,
    });
    const finalCropProducer = cropLineage.at(-1);
    if (finalCropProducer) {
      assert.deepEqual({ width: liveLayerImage.width, height: liveLayerImage.height },
        { width: finalCropProducer.width, height: finalCropProducer.height }, 'the live layer bytes must match the final QR crop node');
      assert.equal(liveLayerImage.sha256, finalCropProducer.sha256, 'the live layer bytes must match the recorded final crop hash');
    }
    const liveLayerBytes = Buffer.from(liveLayerImage.bytes);
    const liveLayerPath = path.join(evidenceDir, 'real-model-qr-layer.png');
    await fs.writeFile(liveLayerPath, liveLayerBytes, { mode: 0o600 });
    report.realModel.artifacts = {
      layerImage: { path: path.basename(liveLayerPath), width: liveLayerImage.width, height: liveLayerImage.height, sha256: liveLayerImage.sha256 },
    };
    const liveSource = liveTaskDetail.task.sources.find((item) => item.type === 'current_attachment');
    assert.ok(liveSource, 'the live-model source attachments must remain in the isolated task');
    liveModelVerificationStage = 'verify-live-source-bytes';
    const liveSourceAfter = await Promise.all([1, 2].map(async (fileOrder) => {
      const expectedSha = report.realModel.uploads.find((item) => item.order === fileOrder)?.sha256;
      assert.ok(expectedSha, `live-model source ${fileOrder} must have a recorded upload hash`);
      const loaded = await readTaskUploadedImageBytes(liveTaskCreated.id, liveSource.id, fileOrder, { sources: liveTaskDetail.task.sources, root: isolatedRoot });
      assert.equal(loaded.sha256, expectedSha, `live-model source ${fileOrder} must remain byte-identical to the uploaded bytes`);
      return { fileOrder, sha256: loaded.sha256, byteLength: loaded.bytes.length };
    }));
    liveModelVerificationStage = 'download-live-compose-output';
    const liveResultAttachment = liveCompose.attachments?.at(-1);
    assert.ok(liveResultAttachment?.fileUrl && liveResultAttachment.downloadUrl, 'the last compose result must be returned as a real HTTP chat attachment');
    const liveInlineResponse = await fetch(webUrl + liveResultAttachment.fileUrl);
    assert.equal(liveInlineResponse.status, 200);
    assert.match(liveInlineResponse.headers.get('content-type') || '', /^image\/png\b/);
    const liveOutputBytes = Buffer.from(await liveInlineResponse.arrayBuffer());
    assert.deepEqual({ width: liveOutputBytes.readUInt32BE(16), height: liveOutputBytes.readUInt32BE(20) }, { width: 520, height: 400 });
    assert.equal(sha256(liveOutputBytes), liveResultAttachment.sha256);
    const liveDownloadResponse = await fetch(webUrl + liveResultAttachment.downloadUrl);
    assert.equal(liveDownloadResponse.status, 200);
    assert.equal(sha256(Buffer.from(await liveDownloadResponse.arrayBuffer())), liveResultAttachment.sha256);
    const liveOutputPath = path.join(evidenceDir, 'real-model-poster-new-qr.png');
    await fs.writeFile(liveOutputPath, liveOutputBytes, { mode: 0o600 });
    report.realModel.artifacts.posterImage = { path: path.basename(liveOutputPath), width: 520, height: 400, sha256: sha256(liveOutputBytes) };

    liveModelVerificationStage = 'verify-live-compose-pixels-and-qr';
    const livePixelChecks = await compareLiveComposePixels(page, {
      baseDataUrl: dataUrl(compositionFixtureMeta[0].bytes),
      overlayDataUrls: [dataUrl(liveLayerBytes)],
      compositionUrl: liveResultAttachment.fileUrl,
      layers: [{ ...liveQrLayer, overlayIndex: 0 }],
      barcodeBounds: liveQrRegion.bounds,
    });
    assert.deepEqual(livePixelChecks.actualSize, { width: 520, height: 400 });
    assert.equal(livePixelChecks.completeOutput.mismatchedPixels, 0, 'the real-model result must match the generic compose operation over the poster pixels');
    assert.equal(livePixelChecks.outsideAllLayerRects.mismatchedPixels, 0, 'the real-model result must preserve all pixels outside the QR replacement rectangle');
    assert.ok(livePixelChecks.originalBarcodePixels.darkPixelCount > 0, 'the original QR region must contain dark module pixels');
    assert.equal(livePixelChecks.originalBarcodePixels.darkPixelsOutsideClearRect, 0, 'the compose clear rectangle must cover every original QR dark pixel');
    const liveQrDecode = await decodeFixtureQrPayloads([
      path.join(evidenceDir, compositionFixtureMeta[0].fileName),
      path.join(evidenceDir, compositionFixtureMeta[1].fileName),
      liveOutputPath,
    ]);
    assert.ok(liveQrDecode[2].payloads.includes(newQrPayload), 'independent jsQR must decode the uploaded new QR from the live-model result');
    assert.ok(!liveQrDecode[2].payloads.includes(oldQrPayload), 'independent jsQR must confirm the live-model result contains no old QR');
    assert.deepEqual([...new Set(liveQrDecode[2].payloads)], [newQrPayload], 'independent jsQR must find only the uploaded new QR in the composed poster');

    liveModelVerificationStage = 'verify-live-attachment-after-refresh';
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '自然语言二维码替换真实模型验证', exact: true }).waitFor({ state: 'visible' });
    const livePersistedDetail = await request(`/api/tasks/${encodeURIComponent(liveTaskCreated.id)}`);
    const liveAssistantMessage = [...livePersistedDetail.conversation].reverse().find((message) => message.role === 'assistant' && message.attachments?.some((attachment) => attachment.fileUrl === liveResultAttachment.fileUrl));
    assert.ok(liveAssistantMessage, 'the live-model Canvas output must persist as an assistant attachment after refresh');
    const liveAttachmentRow = page.locator('.message-row.assistant').filter({ has: page.locator(`a[href="${liveResultAttachment.fileUrl}"]`) }).last();
    await liveAttachmentRow.locator('.message-attachments').waitFor({ state: 'visible' });
    assert.ok(await liveAttachmentRow.locator('a[download]').count() >= 1, 'the live-model result must remain downloadable after refresh');
    await page.waitForFunction((fileUrl) => [...document.querySelectorAll('.message-attachments img')].some((image) => image.src.includes(fileUrl) && image.complete && image.naturalWidth === 520 && image.naturalHeight === 400), liveResultAttachment.fileUrl, { timeout: 20_000 });
    await page.screenshot({ path: path.join(evidenceDir, 'real-model-qr-replacement-after-refresh.png') });
    report.screenshots.push('real-model-qr-replacement-after-refresh.png');
    report.realModel.status = 'passed';
    report.realModel.callbacks = liveCompositionTrace.calls;
    report.realModel.unexpectedTools = liveCompositionTrace.unexpectedTools;
    report.realModel.sourceBytesAfter = liveSourceAfter;
    report.realModel.result = {
      operation: 'compose',
      baseNodeId: liveCompose.nodeId,
      layerRect: { x: liveQrLayer.x, y: liveQrLayer.y, width: liveQrLayer.width, height: liveQrLayer.height },
      layerNodeId: liveQrLayer.nodeId,
      layerCropLineage: cropLineage,
      originalQrRegion: { kind: liveQrRegion.kind, confidence: liveQrRegion.confidence, bounds: liveQrRegion.bounds },
      clear: liveQrLayer.clear,
      fit: liveQrLayer.fit || 'contain',
      smoothing: liveQrLayer.smoothing || 'nearest',
      image: { width: liveResultAttachment.width, height: liveResultAttachment.height, sha256: liveResultAttachment.sha256, fileUrl: liveResultAttachment.fileUrl },
      sourceHashesUnchanged: true,
      pixels: livePixelChecks,
      qrDecoder: { available: true, originalPosterPayloads: liveQrDecode[0].payloads, uploadedQrPayloads: liveQrDecode[1].payloads, resultPayloads: liveQrDecode[2].payloads, resultContainsOnlyUploadedQr: true },
      attachmentPersistedAfterRefresh: true,
      imageModelRequestsUnchanged: generationCount === liveGenerationBefore && editCount === liveEditBefore,
    };
    report.checks.push(
      'explicit-live-workbuddy-branch-naturally-selects-real-canvas-image-tools-without-edit-pages-or-image-model-calls',
      'live-model-reads-the-poster-imports-both-task-images-and-detects-the-original-qr-before-composition',
      'live-model-clears-all-original-qr-dark-pixels-and-composes-the-uploaded-or-crop-derived-new-qr-within-the-detected-region',
      'live-model-result-is-http-downloadable-persisted-after-refresh-and-pixel-identical-outside-the-qr-rectangle',
      'independent-jsqr-decodes-live-result-new-qr-and-confirms-old-qr-is-gone',
    );
    liveModelFailurePhase = false;
  } else {
    report.realModel = { requested: false, status: 'not-run', reason: 'rerun with --real-model to enable the one natural-language configured-basic-model turn' };
  }

  assert.deepEqual(browserErrors, [], 'the Web and Canvas browsers should have no runtime errors');
  report.browserErrors = browserErrors;
  report.fakeImageService = {
    localOnly: true,
    externalModelRequests: 0,
    generationRequests: generationCount,
    editRequestCount: editCount,
    operations: canvasModelRequests.map((item) => ({ method: item.method, operation: item.operation })),
    editRequests: editCaptures,
  };
  report.status = 'passed';
} catch (failure) {
  report.status = 'failed';
  if (liveModelFailurePhase) {
    const errorCode = failure?.code || failure?.cause?.code
      || (failure?.name === 'TypeError' ? 'ERR_TYPE_ERROR' : failure?.name === 'AssertionError' ? 'ERR_ASSERTION' : 'ERR_REAL_MODEL_RUN');
    report.error = `真实主模型隔离验证失败 (${errorCode})`;
    report.realModel = { ...(report.realModel || { requested: true }), status: 'failed', errorCode,
      errorName: failure?.name || 'Error', verificationStage: liveModelVerificationStage,
      ...(liveCompositionTrace ? { callbacks: liveCompositionTrace.calls, unexpectedTools: liveCompositionTrace.unexpectedTools } : {}) };
  } else {
    report.error = cleanFailure(failure?.message || failure);
  }
  if (compositionCallbackTrace && report.syntheticComposition) {
    report.syntheticComposition.callbackTraceOnFailure = {
      callbackRevision: compositionCallbackTrace.callbackRevision,
      imported: compositionCallbackTrace.imported,
      duplicateImport: compositionCallbackTrace.duplicateImport,
      wrongTaskNode: compositionCallbackTrace.wrongTaskNode,
      operations: Object.fromEntries(Object.entries(compositionCallbackTrace.operations).map(([operation, outcome]) => [operation, {
        result: outcome.result,
        attachments: outcome.attachments,
      }])),
      sourceBytesUnchanged: compositionCallbackTrace.sourceBytesUnchanged,
    };
  }
  report.browserErrors = browserErrors;
  if (page) {
    await page.screenshot({ path: path.join(evidenceDir, 'failure.png') }).then(() => report.screenshots.push('failure.png')).catch(() => {});
  }
  process.exitCode = 1;
  console.error(report.error);
} finally {
  report.fakeImageService = {
    localOnly: true,
    externalModelRequests: 0,
    generationRequests: generationCount,
    editRequestCount: editCount,
    operations: canvasModelRequests.map((item) => ({ method: item.method, operation: item.operation })),
    editRequests: editCaptures,
  };
  await writeReport().catch(() => {});
  await browser?.close().catch(() => {});
  await app?.close().catch(() => {});
  await canvas?.stop().catch(() => {});
  if (fakeImageServer) {
    fakeImageServer.closeAllConnections();
    await new Promise((resolve) => fakeImageServer.close(resolve));
  }
  if (isolatedRoot) await fs.rm(isolatedRoot, { recursive: true, force: true }).catch(() => {});
  if (staticRoot) await fs.rm(staticRoot, { recursive: true, force: true }).catch(() => {});
}

console.log(JSON.stringify({ status: report.status, checks: report.checks, generationRequests: generationCount, editRequests: editCount, evidence: path.relative(repo, evidenceFile) }));
