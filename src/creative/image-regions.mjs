import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const KINDS = new Set(['barcode', 'text', 'rectangle']);
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_DETECTIONS = 900;
const MAX_TOTAL_DETECTED = 100_000;
const MAX_RETURNED_REGIONS = 100;
const MAX_EDGE = 32_768;
const MAX_PIXELS = 64 * 1024 * 1024;
const MAX_ANALYSIS_EDGE = 4096;
const MAX_ANALYSIS_PIXELS = 12 * 1024 * 1024;
const MIN_OCR_CONFIDENCE = 50;
const MIN_OCR_LINE_CONFIDENCE = 65;
const OCR_TIMEOUT_MS = 60_000;
const OCR_LANGUAGE_PACKAGES = ['@tesseract.js-data/eng', '@tesseract.js-data/chi_sim'];
const MODEL_FILENAMES = ['eng.traineddata.gz', 'chi_sim.traineddata.gz'];

let canvasModulePromise;
let cvModulePromise;
let ocrQueue = Promise.resolve();

function regionsError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.safeMessage = message;
  return error;
}

function validImageHeader(bytes, mimeType) {
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return false;
}

function headerDimensions(bytes, mimeType) {
  if (mimeType === 'image/png' && bytes.length >= 24) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mimeType !== 'image/jpeg') return null;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (offset + 2 > bytes.length) break;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (startOfFrame.has(marker) && segmentLength >= 7) {
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += segmentLength;
  }
  return null;
}

function normalizeKinds(kinds) {
  const result = kinds === undefined ? [...KINDS] : kinds;
  if (!Array.isArray(result) || result.length < 1 || result.length > KINDS.size
    || result.some((kind) => typeof kind !== 'string' || !KINDS.has(kind))
    || new Set(result).size !== result.length) {
    throw regionsError('ERR_IMAGE_REGIONS_INPUT', '图像区域检测类型无效。');
  }
  return [...result].sort();
}

function validateResult(value, kinds) {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.width) || value.width < 1
    || !Number.isSafeInteger(value.height) || value.height < 1 || !Array.isArray(value.regions)
    || value.regions.length > MAX_DETECTIONS || !Number.isSafeInteger(value.totalDetected)
    || value.totalDetected < value.regions.length || value.totalDetected > MAX_TOTAL_DETECTED
    || typeof value.truncated !== 'boolean') {
    throw regionsError('ERR_IMAGE_REGIONS_RESULT', '本机图像区域检测没有返回有效结果。');
  }
  if (Math.max(value.width, value.height) > MAX_EDGE || value.width * value.height > MAX_PIXELS) {
    throw regionsError('ERR_IMAGE_REGIONS_IMAGE_SIZE', '图像像素尺寸超过本机区域检测上限。');
  }
  const regions = value.regions.map((region) => {
    if (!region || !kinds.includes(region.kind) || !Number.isFinite(region.confidence)
      || region.confidence < 0 || region.confidence > 1
      || !region.bounds || !['x', 'y', 'width', 'height'].every((key) => Number.isSafeInteger(region.bounds[key]))
      || region.bounds.x < 0 || region.bounds.y < 0 || region.bounds.width < 1 || region.bounds.height < 1
      || region.bounds.x + region.bounds.width > value.width || region.bounds.y + region.bounds.height > value.height) {
      throw regionsError('ERR_IMAGE_REGIONS_RESULT', '本机图像区域检测返回了越界或无效区域。');
    }
    const padding = 2;
    const left = Math.max(0, region.bounds.x - padding);
    const top = Math.max(0, region.bounds.y - padding);
    const right = Math.min(value.width, region.bounds.x + region.bounds.width + padding);
    const bottom = Math.min(value.height, region.bounds.y + region.bounds.height + padding);
    return {
      kind: region.kind,
      confidence: region.confidence,
      bounds: { ...region.bounds },
      suggestedBounds: { x: left, y: top, width: right - left, height: bottom - top },
      suggestedPadding: padding,
    };
  });
  return {
    width: value.width,
    height: value.height,
    regions: regions.slice(0, MAX_RETURNED_REGIONS),
    truncated: value.truncated || regions.length > MAX_RETURNED_REGIONS,
    totalDetected: value.totalDetected,
  };
}

async function loadCanvas() {
  canvasModulePromise ??= import('@napi-rs/canvas');
  return canvasModulePromise;
}

async function loadCv() {
  cvModulePromise ??= import('@techstark/opencv-js').then(async (module) => module.default);
  return cvModulePromise;
}

function analysisSize(width, height) {
  const scale = Math.min(1, MAX_ANALYSIS_EDGE / Math.max(width, height), Math.sqrt(MAX_ANALYSIS_PIXELS / (width * height)));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function decodeRaster(bytes) {
  const { createCanvas, loadImage } = await loadCanvas();
  let image;
  try { image = await loadImage(bytes); }
  catch (cause) { throw regionsError('ERR_IMAGE_REGIONS_FORMAT_UNSUPPORTED', '本机区域检测无法读取该 PNG 或 JPEG 图片。', cause); }
  const { width, height } = image;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || Math.max(width, height) > MAX_EDGE || width * height > MAX_PIXELS) {
    throw regionsError('ERR_IMAGE_REGIONS_IMAGE_SIZE', '图像像素尺寸超过本机区域检测上限。');
  }
  const analysis = analysisSize(width, height);
  const canvas = createCanvas(analysis.width, analysis.height);
  const context = canvas.getContext('2d');
  // Alpha is not meaningful to the local detectors. Composite onto white in
  // this detection-only raster so transparent QR quiet zones stay visible.
  context.fillStyle = '#fff';
  context.fillRect(0, 0, analysis.width, analysis.height);
  context.drawImage(image, 0, 0, analysis.width, analysis.height);
  const pixels = context.getImageData(0, 0, analysis.width, analysis.height).data;
  return { width, height, analysisWidth: analysis.width, analysisHeight: analysis.height, pixels, png: canvas.toBuffer('image/png') };
}

function toSourceBounds(bounds, decoded) {
  const scaleX = decoded.width / decoded.analysisWidth;
  const scaleY = decoded.height / decoded.analysisHeight;
  const left = Math.max(0, Math.floor(bounds.x * scaleX));
  const top = Math.max(0, Math.floor(bounds.y * scaleY));
  const right = Math.min(decoded.width, Math.ceil((bounds.x + bounds.width) * scaleX));
  const bottom = Math.min(decoded.height, Math.ceil((bounds.y + bounds.height) * scaleY));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function rectFromPoints(values, offset, decoded, pointScale = 1) {
  const xs = [];
  const ys = [];
  for (let point = 0; point < 4; point += 1) {
    xs.push(values[offset + point * 2] / pointScale);
    ys.push(values[offset + point * 2 + 1] / pointScale);
  }
  const left = Math.floor(Math.min(...xs));
  const top = Math.floor(Math.min(...ys));
  const right = Math.ceil(Math.max(...xs));
  const bottom = Math.ceil(Math.max(...ys));
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
  return toSourceBounds({ x: left, y: top, width: right - left, height: bottom - top }, decoded);
}

function detectQrBoxes(cv, rgba, decoded) {
  const rgb = new cv.Mat();
  const detector = new cv.QRCodeDetector();
  try {
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    const boxes = [];
    const collect = (source, pointScale) => {
      const points = new cv.Mat();
      try {
        if (!detector.detectMulti(source, points) || points.rows < 1 || points.data32F.length < points.rows * 8) return;
        for (let row = 0; row < points.rows; row += 1) {
          const bounds = rectFromPoints(points.data32F, row * 8, decoded, pointScale);
          if (bounds && !boxes.some((region) => overlapRatio(bounds, region.bounds) > 0.8
            || overlapRatio(region.bounds, bounds) > 0.8)) boxes.push({ kind: 'barcode', confidence: 0.98, bounds });
        }
      } finally {
        points.delete();
      }
    };
    collect(rgb, 1);
    // OpenCV misses very small module grids at their natural raster size. A
    // nearest-neighbor retry doubles only small images, preserving hard edges.
    if (decoded.analysisWidth <= 1800 && decoded.analysisHeight <= 1800
      && decoded.analysisWidth * decoded.analysisHeight <= 4 * 1024 * 1024) {
      const enlarged = new cv.Mat();
      try {
        cv.resize(rgb, enlarged, new cv.Size(decoded.analysisWidth * 2, decoded.analysisHeight * 2), 0, 0, cv.INTER_NEAREST);
        collect(enlarged, 2);
      } finally {
        enlarged.delete();
      }
    }
    return boxes;
  } catch (cause) {
    throw regionsError('ERR_IMAGE_REGIONS_CV_FAILED', '本机二维码区域定位未能完成。', cause);
  } finally {
    detector.delete();
    rgb.delete();
  }
}

function intersectionArea(first, second) {
  const width = Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x));
  const height = Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y));
  return width * height;
}

function overlapRatio(first, second) {
  const area = first.width * first.height;
  return area ? intersectionArea(first, second) / area : 0;
}

function detectRectangles(cv, rgba, decoded, barcodeRegions) {
  const gray = new cv.Mat();
  const binary = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
    cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const candidates = [];
    const imageWidth = decoded.analysisWidth;
    const imageHeight = decoded.analysisHeight;
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index);
      const approximation = new cv.Mat();
      try {
        const perimeter = cv.arcLength(contour, true);
        if (perimeter < 1) continue;
        cv.approxPolyDP(contour, approximation, perimeter * 0.025, true);
        if (approximation.rows !== 4 || !cv.isContourConvex(approximation)) continue;
        const rect = cv.boundingRect(approximation);
        const minWidth = imageWidth * 0.05;
        const minHeight = imageHeight * 0.03;
        if (rect.width < minWidth || rect.height < minHeight || rect.width * rect.height < imageWidth * imageHeight * 0.005) continue;
        if (rect.x < imageWidth * 0.01 || rect.y < imageHeight * 0.01
          || rect.x + rect.width > imageWidth * 0.99 || rect.y + rect.height > imageHeight * 0.99) continue;
        const aspect = rect.width / rect.height;
        if (aspect < 0.15 || aspect > 6.7) continue;
        const contourArea = Math.abs(cv.contourArea(contour));
        const fillRatio = contourArea / (rect.width * rect.height);
        if (fillRatio < 0.88) continue;
        const bounds = toSourceBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }, decoded);
        if (barcodeRegions.some((region) => overlapRatio(bounds, region.bounds) > 0.2)) continue;
        const confidence = Math.max(0, Math.min(1, 0.8 + (fillRatio - 0.88) * 0.8));
        candidates.push({ kind: 'rectangle', confidence, bounds });
      } finally {
        approximation.delete();
        contour.delete();
      }
    }
    candidates.sort((first, second) => second.bounds.width * second.bounds.height - first.bounds.width * first.bounds.height);
    const unique = [];
    for (const candidate of candidates) {
      if (!unique.some((region) => overlapRatio(candidate.bounds, region.bounds) > 0.85
        || overlapRatio(region.bounds, candidate.bounds) > 0.85)) unique.push(candidate);
    }
    return unique;
  } catch (cause) {
    if (cause?.code === 'ERR_IMAGE_REGIONS_CV_FAILED') throw cause;
    throw regionsError('ERR_IMAGE_REGIONS_CV_FAILED', '本机矩形区域定位未能完成。', cause);
  } finally {
    hierarchy.delete();
    contours.delete();
    binary.delete();
    gray.delete();
  }
}

function resolveModelSource(packageName, filename) {
  const modelPackage = require(packageName);
  const modelDirectory = path.resolve(path.dirname(modelPackage.langPath), '4.0.0_best_int');
  return path.join(modelDirectory, filename);
}

async function createLocalModelDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-image-region-models-'));
  try {
    await fs.chmod(directory, 0o700).catch(() => {});
    for (let index = 0; index < OCR_LANGUAGE_PACKAGES.length; index += 1) {
      const source = resolveModelSource(OCR_LANGUAGE_PACKAGES[index], MODEL_FILENAMES[index]);
      await fs.copyFile(source, path.join(directory, MODEL_FILENAMES[index]));
    }
    return directory;
  } catch (cause) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw regionsError('ERR_IMAGE_REGIONS_OCR_UNAVAILABLE', '本机文字定位离线模型不可用。', cause);
  }
}

async function withOcrSlot(action, signal) {
  const previous = ocrQueue;
  let release;
  const slot = new Promise((resolve) => { release = resolve; });
  ocrQueue = previous.then(() => slot, () => slot);
  let onAbort;
  try {
    if (signal) {
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason || regionsError('ERR_IMAGE_REGIONS_ABORTED', '文字区域检测已取消。'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      await Promise.race([previous, aborted]);
    } else {
      await previous;
    }
  } catch (cause) {
    release();
    throw cause;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
  try { return await action(); }
  finally { release(); }
}

async function recognizeText(png, signal) {
  const { createWorker } = await import('tesseract.js');
  return withOcrSlot(async () => {
    signal?.throwIfAborted();
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(regionsError('ERR_IMAGE_REGIONS_TIMEOUT', '本机文字区域检测超时。')), OCR_TIMEOUT_MS);
    timeout.unref?.();
    const effectiveSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
    let temporaryModels;
    let worker;
    let termination;
    const terminate = () => {
      if (!termination && worker) termination = Promise.resolve(worker.terminate()).catch(() => {});
      return termination || Promise.resolve();
    };
    let onAbort;
    try {
      temporaryModels = await createLocalModelDirectory();
      effectiveSignal.throwIfAborted();
      // Tesseract.js exposes the worker handle only after local core/model
      // initialization. Await startup so cancellation can always terminate a
      // live handle instead of abandoning an initializing worker.
      worker = await createWorker('eng+chi_sim', 1, {
        langPath: temporaryModels,
        cacheMethod: 'none',
        gzip: true,
        logger: () => {},
      });
      effectiveSignal.throwIfAborted();
      let rejectOnAbort;
      const aborted = new Promise((_, reject) => { rejectOnAbort = reject; });
      onAbort = () => {
        rejectOnAbort(effectiveSignal.reason || regionsError('ERR_IMAGE_REGIONS_ABORTED', '文字区域检测已取消。'));
        void terminate();
      };
      effectiveSignal.addEventListener('abort', onAbort, { once: true });
      const recognized = await Promise.race([worker.recognize(png, {}, { blocks: true }), aborted]);
      effectiveSignal.throwIfAborted();
      return recognized?.data?.blocks || [];
    } catch (cause) {
      if (signal?.aborted) throw signal.reason || cause;
      if (timeoutController.signal.aborted) throw timeoutController.signal.reason;
      if (cause?.code?.startsWith('ERR_IMAGE_REGIONS_')) throw cause;
      throw regionsError('ERR_IMAGE_REGIONS_OCR_FAILED', '本机文字区域定位未能完成。', cause);
    } finally {
      if (onAbort) effectiveSignal.removeEventListener('abort', onAbort);
      clearTimeout(timeout);
      await terminate();
      if (temporaryModels) await fs.rm(temporaryModels, { recursive: true, force: true }).catch(() => {});
    }
  }, signal);
}

function tightenToInk(box, decoded) {
  const left = Math.max(0, Math.floor(box.x0));
  const top = Math.max(0, Math.floor(box.y0));
  const right = Math.min(decoded.analysisWidth, Math.ceil(box.x1));
  const bottom = Math.min(decoded.analysisHeight, Math.ceil(box.y1));
  if (right <= left || bottom <= top) return null;

  const border = [];
  for (let x = left; x < right; x += 1) {
    for (const y of [top, bottom - 1]) {
      const offset = (y * decoded.analysisWidth + x) * 4;
      border.push([decoded.pixels[offset], decoded.pixels[offset + 1], decoded.pixels[offset + 2]]);
    }
  }
  for (let y = top + 1; y < bottom - 1; y += 1) {
    for (const x of [left, right - 1]) {
      const offset = (y * decoded.analysisWidth + x) * 4;
      border.push([decoded.pixels[offset], decoded.pixels[offset + 1], decoded.pixels[offset + 2]]);
    }
  }
  const background = [0, 1, 2].map((channel) => {
    const values = border.map((pixel) => pixel[channel]).sort((first, second) => first - second);
    return values[Math.floor(values.length / 2)] ?? 255;
  });
  const thresholdSquared = 34 * 34;
  let inkLeft = right;
  let inkTop = bottom;
  let inkRight = left;
  let inkBottom = top;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * decoded.analysisWidth + x) * 4;
      const red = decoded.pixels[offset] - background[0];
      const green = decoded.pixels[offset + 1] - background[1];
      const blue = decoded.pixels[offset + 2] - background[2];
      if (red * red + green * green + blue * blue < thresholdSquared) continue;
      inkLeft = Math.min(inkLeft, x);
      inkTop = Math.min(inkTop, y);
      inkRight = Math.max(inkRight, x + 1);
      inkBottom = Math.max(inkBottom, y + 1);
    }
  }
  return inkRight > inkLeft && inkBottom > inkTop
    ? { x: inkLeft, y: inkTop, width: inkRight - inkLeft, height: inkBottom - inkTop }
    : { x: left, y: top, width: right - left, height: bottom - top };
}

function boxesFromOcr(blocks, decoded, barcodeRegions) {
  const regions = [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        if (!Number.isFinite(line.confidence) || line.confidence < MIN_OCR_LINE_CONFIDENCE) continue;
        const words = (line.words || []).filter((word) => Number.isFinite(word.confidence) && word.confidence >= MIN_OCR_CONFIDENCE
          && word.bbox && [word.bbox.x0, word.bbox.y0, word.bbox.x1, word.bbox.y1].every(Number.isFinite)
          && word.bbox.x1 > word.bbox.x0 && word.bbox.y1 > word.bbox.y0);
        if (words.length < 2) continue;
        const inkBoxes = words.map((word) => tightenToInk(word.bbox, decoded)).filter(Boolean);
        const left = Math.min(...inkBoxes.map((box) => box.x));
        const top = Math.min(...inkBoxes.map((box) => box.y));
        const right = Math.max(...inkBoxes.map((box) => box.x + box.width));
        const bottom = Math.max(...inkBoxes.map((box) => box.y + box.height));
        const bounds = toSourceBounds({ x: left, y: top, width: right - left, height: bottom - top }, decoded);
        if (barcodeRegions.some((region) => overlapRatio(bounds, region.bounds) > 0.2)) continue;
        const confidence = words.reduce((sum, word) => sum + word.confidence, 0) / words.length / 100;
        regions.push({ kind: 'text', confidence: Math.max(0, Math.min(1, confidence)), bounds });
      }
    }
  }
  regions.sort((first, second) => first.bounds.y - second.bounds.y || first.bounds.x - second.bounds.x);
  const unique = [];
  for (const region of regions) {
    if (!unique.some((existing) => overlapRatio(region.bounds, existing.bounds) > 0.9
      || overlapRatio(existing.bounds, region.bounds) > 0.9)) unique.push(region);
  }
  return unique;
}

/**
 * Detect geometric QR, OCR line, and outlined rectangle regions locally.
 * QR payloads and recognized text are deliberately discarded; only bounds and
 * confidence leave this module. OCR is offline, serialized, time-limited, and
 * its worker and temporary model copies are removed after each request.
 */
export async function detectImageRegions({ bytes, mimeType, kinds, signal } = {}) {
  const selectedKinds = normalizeKinds(kinds);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw regionsError('ERR_IMAGE_REGIONS_INPUT', '区域检测需要真实图片字节。');
  }
  const imageBytes = Buffer.from(bytes);
  if (!imageBytes.length || imageBytes.length > MAX_INPUT_BYTES) {
    throw regionsError('ERR_IMAGE_REGIONS_IMAGE_SIZE', '图像文件大小超过本机区域检测上限。');
  }
  if (!['image/png', 'image/jpeg'].includes(mimeType) || !validImageHeader(imageBytes, mimeType)) {
    throw regionsError('ERR_IMAGE_REGIONS_FORMAT_UNSUPPORTED', '本机区域检测当前仅支持有效的 PNG 和 JPEG 图片。');
  }
  const dimensions = headerDimensions(imageBytes, mimeType);
  if (!dimensions || !Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height)
    || dimensions.width < 1 || dimensions.height < 1) {
    throw regionsError('ERR_IMAGE_REGIONS_FORMAT_UNSUPPORTED', '本机区域检测无法读取该 PNG 或 JPEG 图片尺寸。');
  }
  if (Math.max(dimensions.width, dimensions.height) > MAX_EDGE || dimensions.width * dimensions.height > MAX_PIXELS) {
    throw regionsError('ERR_IMAGE_REGIONS_IMAGE_SIZE', '图像像素尺寸超过本机区域检测上限。');
  }
  signal?.throwIfAborted();

  const decoded = await decodeRaster(imageBytes);
  signal?.throwIfAborted();
  const cv = await loadCv();
  signal?.throwIfAborted();
  const rgba = new cv.Mat(decoded.analysisHeight, decoded.analysisWidth, cv.CV_8UC4);
  rgba.data.set(decoded.pixels);
  try {
    // QR geometry is also used to prevent OCR/contour modules being reported as
    // text or a rectangle, even when the caller only requested another kind.
    const qrRegions = detectQrBoxes(cv, rgba, decoded);
    const regions = [];
    if (selectedKinds.includes('barcode')) regions.push(...qrRegions);
    if (selectedKinds.includes('text')) {
      const blocks = await recognizeText(decoded.png, signal);
      regions.push(...boxesFromOcr(blocks, decoded, qrRegions));
    }
    if (selectedKinds.includes('rectangle')) regions.push(...detectRectangles(cv, rgba, decoded, qrRegions));
    regions.sort((first, second) => first.kind.localeCompare(second.kind)
      || first.bounds.y - second.bounds.y || first.bounds.x - second.bounds.x);
    signal?.throwIfAborted();
    return validateResult({
      width: decoded.width,
      height: decoded.height,
      regions: regions.slice(0, MAX_DETECTIONS),
      totalDetected: regions.length,
      truncated: regions.length > MAX_DETECTIONS,
    }, selectedKinds);
  } finally {
    rgba.delete();
  }
}

export const imageRegionKinds = Object.freeze([...KINDS]);
