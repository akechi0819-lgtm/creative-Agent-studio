import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import jsQR from 'jsqr';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { QrCode, Ecc } from '../third_party/canvas/web/node_modules/@rc-component/qrcode/es/libs/qrcodegen.js';
import { detectImageRegions } from '../src/creative/image-regions.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'image-regions');
const posterTruth = JSON.parse(await fs.readFile(path.join(FIXTURES, 'poster-mixed.truth.json'), 'utf8'));

async function fixture(name) {
  return fs.readFile(path.join(FIXTURES, name));
}

function area(rect) {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function intersectionOverUnion(first, second) {
  const width = Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x));
  const height = Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y));
  const intersection = width * height;
  const union = area(first) + area(second) - intersection;
  return union ? intersection / union : 0;
}

function matchGeometry(truth, detections, minimumIou) {
  const pairs = truth.flatMap((target, truthIndex) => detections.map((candidate, detectionIndex) => ({
    truthIndex,
    detectionIndex,
    iou: intersectionOverUnion(target, candidate.bounds),
  }))).sort((first, second) => second.iou - first.iou);
  const usedTruth = new Set();
  const usedDetections = new Set();
  for (const pair of pairs) {
    if (pair.iou < minimumIou || usedTruth.has(pair.truthIndex) || usedDetections.has(pair.detectionIndex)) continue;
    usedTruth.add(pair.truthIndex);
    usedDetections.add(pair.detectionIndex);
  }
  return {
    matched: usedTruth.size,
    precision: detections.length ? usedDetections.size / detections.length : 1,
    recall: truth.length ? usedTruth.size / truth.length : 1,
    ious: pairs.filter((pair) => pair.iou >= minimumIou).map((pair) => pair.iou),
  };
}

function assertValidRegions(result) {
  assert.ok(Number.isSafeInteger(result.width) && result.width > 0);
  assert.ok(Number.isSafeInteger(result.height) && result.height > 0);
  assert.ok(result.regions.length <= 100);
  assert.ok(result.totalDetected >= result.regions.length);
  assert.equal(typeof result.truncated, 'boolean');
  for (const region of result.regions) {
    assert.ok(['barcode', 'text', 'rectangle'].includes(region.kind));
    assert.ok(Number.isFinite(region.confidence) && region.confidence >= 0 && region.confidence <= 1);
    for (const key of ['bounds', 'suggestedBounds']) {
      const rect = region[key];
      assert.ok(['x', 'y', 'width', 'height'].every((field) => Number.isSafeInteger(rect[field])));
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0);
      assert.ok(rect.x + rect.width <= result.width && rect.y + rect.height <= result.height);
    }
    assert.equal(region.suggestedPadding, 2);
  }
}

test('image-region detection honors a native cancellation before its first scan completes', async () => {
  const bytes = await fixture('poster-mixed.png');
  const controller = new AbortController();
  const reason = new Error('cancel during initial image scan');
  const pending = detectImageRegions({ bytes, mimeType: 'image/png', kinds: ['barcode'], signal: controller.signal });
  const timer = setTimeout(() => controller.abort(reason), 20);
  try {
    await assert.rejects(
      pending,
      (error) => error === reason,
    );
  } finally {
    clearTimeout(timer);
  }
});

async function asJpeg(png) {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas.toBuffer('image/jpeg', 92);
}

test('PNG and JPEG detect QR, mixed Chinese/English text lines, and an inset frame to fixed IoU/precision/recall gates', async () => {
  const png = await fixture('poster-mixed.png');
  for (const [mimeType, bytes] of [['image/png', png], ['image/jpeg', await asJpeg(png)]]) {
    const result = await detectImageRegions({ bytes, mimeType });
    assertValidRegions(result);
    assert.deepEqual({ width: result.width, height: result.height }, { width: posterTruth.width, height: posterTruth.height });

    const text = result.regions.filter((region) => region.kind === 'text');
    const textMetrics = matchGeometry(posterTruth.textLines, text, 0.5);
    assert.ok(textMetrics.recall >= 0.9, `${mimeType} text recall ${textMetrics.recall}; IoUs: ${textMetrics.ious.join(', ')}`);
    assert.ok(textMetrics.precision >= 0.9, `${mimeType} text precision ${textMetrics.precision}`);

    const barcodes = result.regions.filter((region) => region.kind === 'barcode');
    assert.equal(barcodes.length, 1, `${mimeType} QR count`);
    assert.ok(intersectionOverUnion(posterTruth.barcode, barcodes[0].bounds) >= 0.9, `${mimeType} QR location IoU`);

    const rectangles = result.regions.filter((region) => region.kind === 'rectangle');
    assert.equal(rectangles.length, 1, `${mimeType} frame count`);
    assert.ok(intersectionOverUnion(posterTruth.rectangle, rectangles[0].bounds) >= 0.8, `${mimeType} frame IoU`);

    const serialized = JSON.stringify(result);
    for (const privateString of ['region-fixture-private-001', 'Small type: English poster line', '课程学习目标', '矩形内的中文文字']) {
      assert.ok(!serialized.includes(privateString), `detector result must not contain source text: ${privateString}`);
    }
  }
});

function makeQrCanvas({ width = 760, height = 520, codes }) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#f5f6f3';
  context.fillRect(0, 0, width, height);
  const truth = [];
  for (const specification of codes) {
    const code = QrCode.encodeText(specification.payload, Ecc.MEDIUM);
    const moduleScale = specification.scale;
    const quietZone = 4;
    const side = (code.size + quietZone * 2) * moduleScale;
    const qrCanvas = createCanvas(side, side);
    const qrContext = qrCanvas.getContext('2d');
    qrContext.imageSmoothingEnabled = false;
    qrContext.fillStyle = '#fff';
    qrContext.fillRect(0, 0, side, side);
    qrContext.fillStyle = '#000';
    for (let y = 0; y < code.size; y += 1) {
      for (let x = 0; x < code.size; x += 1) {
        if (code.getModule(x, y)) qrContext.fillRect((x + quietZone) * moduleScale, (y + quietZone) * moduleScale, moduleScale, moduleScale);
      }
    }
    const centerX = specification.centerX;
    const centerY = specification.centerY;
    const radians = specification.rotationDegrees * Math.PI / 180;
    context.save();
    context.translate(centerX, centerY);
    context.rotate(radians);
    context.imageSmoothingEnabled = false;
    context.drawImage(qrCanvas, -side / 2, -side / 2);
    context.restore();
    const activeSide = code.size * moduleScale;
    const envelope = activeSide * (Math.abs(Math.cos(radians)) + Math.abs(Math.sin(radians)));
    truth.push({
      x: centerX - envelope / 2,
      y: centerY - envelope / 2,
      width: envelope,
      height: envelope,
    });
  }
  return { bytes: canvas.toBuffer('image/png'), truth, width, height };
}

const qrScenarios = [
  { name: 'small scale', scale: 2, rotationDegrees: 0 },
  { name: 'medium scale', scale: 3, rotationDegrees: 0 },
  { name: 'large scale', scale: 6, rotationDegrees: 0 },
  { name: 'rotated', scale: 4, rotationDegrees: 17 },
];

for (const scenario of qrScenarios) {
  test(`QR geometry has ≥0.90 IoU at ${scenario.name}`, async () => {
    const qr = makeQrCanvas({ codes: [{ ...scenario, payload: `qr-${scenario.name}-fixture`, centerX: 360, centerY: 250 }] });
    const result = await detectImageRegions({ bytes: qr.bytes, mimeType: 'image/png', kinds: ['barcode'] });
    const detections = result.regions.filter((region) => region.kind === 'barcode');
    assert.equal(detections.length, 1);
    assert.ok(intersectionOverUnion(qr.truth[0], detections[0].bounds) >= 0.9, `${scenario.name} bounds IoU`);
    if (scenario === qrScenarios[0]) {
      const rectangles = await detectImageRegions({ bytes: qr.bytes, mimeType: 'image/png', kinds: ['rectangle'] });
      assert.equal(rectangles.regions.length, 0, 'QR modules do not count as a geometric frame');
    }
  });
}

test('multiple QR codes return two separate locations, including a rotated code', async () => {
  const qr = makeQrCanvas({ codes: [
    { payload: 'multi-code-one', scale: 3, rotationDegrees: 0, centerX: 160, centerY: 140 },
    { payload: 'multi-code-two', scale: 4, rotationDegrees: 21, centerX: 570, centerY: 340 },
  ] });
  const result = await detectImageRegions({ bytes: qr.bytes, mimeType: 'image/png', kinds: ['barcode'] });
  assert.equal(result.regions.length, 2);
  const metrics = matchGeometry(qr.truth, result.regions, 0.9);
  assert.equal(metrics.recall, 1);
  assert.equal(metrics.precision, 1);
});

test('transparent and opaque PNGs of the same QR are detected while source bytes stay unchanged', async () => {
  const payload = 'transparent-qr-detection-fixture';
  const code = QrCode.encodeText(payload, Ecc.MEDIUM);
  const scale = 6;
  const quietZone = 4;
  const side = (code.size + quietZone * 2) * scale;
  const transparentCanvas = createCanvas(side, side);
  const transparentContext = transparentCanvas.getContext('2d');
  transparentContext.fillStyle = '#000';
  for (let y = 0; y < code.size; y += 1) {
    for (let x = 0; x < code.size; x += 1) {
      if (code.getModule(x, y)) {
        transparentContext.fillRect((x + quietZone) * scale, (y + quietZone) * scale, scale, scale);
      }
    }
  }
  const transparentBytes = transparentCanvas.toBuffer('image/png');
  const opaqueCanvas = createCanvas(side, side);
  const opaqueContext = opaqueCanvas.getContext('2d');
  opaqueContext.fillStyle = '#fff';
  opaqueContext.fillRect(0, 0, side, side);
  opaqueContext.drawImage(transparentCanvas, 0, 0);
  const opaqueBytes = opaqueCanvas.toBuffer('image/png');

  const whiteBackgroundDecode = jsQR(opaqueContext.getImageData(0, 0, side, side).data, side, side, {
    inversionAttempts: 'dontInvert',
  });
  assert.equal(whiteBackgroundDecode?.data, payload, 'the white-background reference must decode independently');

  const transparentHash = createHash('sha256').update(transparentBytes).digest('hex');
  const opaqueHash = createHash('sha256').update(opaqueBytes).digest('hex');
  const transparentResult = await detectImageRegions({ bytes: transparentBytes, mimeType: 'image/png', kinds: ['barcode'] });
  const opaqueResult = await detectImageRegions({ bytes: opaqueBytes, mimeType: 'image/png', kinds: ['barcode'] });
  assert.equal(transparentResult.regions.length, 1, 'transparent QR is detected');
  assert.equal(opaqueResult.regions.length, 1, 'opaque QR is detected');
  assert.ok(intersectionOverUnion(transparentResult.regions[0].bounds, opaqueResult.regions[0].bounds) >= 0.95);
  assert.equal(createHash('sha256').update(transparentBytes).digest('hex'), transparentHash, 'transparent source bytes are unchanged');
  assert.equal(createHash('sha256').update(opaqueBytes).digest('hex'), opaqueHash, 'opaque source bytes are unchanged');
});

test('landscape and irregular texture are negative fixtures with no QR, text, or rectangle regions', async () => {
  for (const name of ['negative-landscape.png', 'negative-texture.png']) {
    const result = await detectImageRegions({ bytes: await fixture(name), mimeType: 'image/png' });
    assert.deepEqual(result.regions, [], `${name} false positive`);
  }
});

test('QR replacement preserves every pixel outside the detected box and an independent decoder reads the new code', async () => {
  const source = await fixture('poster-mixed.png');
  const sourceImage = await loadImage(source);
  const sourceCanvas = createCanvas(sourceImage.width, sourceImage.height);
  const sourceContext = sourceCanvas.getContext('2d');
  sourceContext.drawImage(sourceImage, 0, 0);
  const originalPixels = sourceContext.getImageData(0, 0, sourceImage.width, sourceImage.height);
  const before = new Uint8ClampedArray(originalPixels.data);
  const locationResult = await detectImageRegions({ bytes: source, mimeType: 'image/png', kinds: ['barcode'] });
  assert.equal(locationResult.regions.length, 1);
  const target = locationResult.regions[0].bounds;
  assert.ok(intersectionOverUnion(posterTruth.barcode, target) >= 0.9, 'target box is independently checked against QR ground truth');

  const payload = 'replacement-readable-qr-002';
  const code = QrCode.encodeText(payload, Ecc.MEDIUM);
  for (let y = target.y; y < target.y + target.height; y += 1) {
    for (let x = target.x; x < target.x + target.width; x += 1) {
      const moduleX = Math.min(code.size - 1, Math.floor((x - target.x) * code.size / target.width));
      const moduleY = Math.min(code.size - 1, Math.floor((y - target.y) * code.size / target.height));
      const offset = (y * sourceImage.width + x) * 4;
      const black = code.getModule(moduleX, moduleY);
      originalPixels.data[offset] = black ? 0 : 255;
      originalPixels.data[offset + 1] = black ? 0 : 255;
      originalPixels.data[offset + 2] = black ? 0 : 255;
      originalPixels.data[offset + 3] = 255;
    }
  }
  sourceContext.putImageData(originalPixels, 0, 0);
  const replacement = sourceCanvas.toBuffer('image/png');
  const replacedImage = await loadImage(replacement);
  const replacedCanvas = createCanvas(replacedImage.width, replacedImage.height);
  const replacedContext = replacedCanvas.getContext('2d');
  replacedContext.drawImage(replacedImage, 0, 0);
  const after = replacedContext.getImageData(0, 0, replacedImage.width, replacedImage.height).data;
  let outsidePixelsChanged = 0;
  for (let y = 0; y < replacedImage.height; y += 1) {
    for (let x = 0; x < replacedImage.width; x += 1) {
      if (x >= target.x && x < target.x + target.width && y >= target.y && y < target.y + target.height) continue;
      const offset = (y * replacedImage.width + x) * 4;
      if (before[offset] !== after[offset] || before[offset + 1] !== after[offset + 1]
        || before[offset + 2] !== after[offset + 2] || before[offset + 3] !== after[offset + 3]) outsidePixelsChanged += 1;
    }
  }
  assert.equal(outsidePixelsChanged, 0, 'all pixels outside the detection box remain byte-identical');
  const decoded = jsQR(after, replacedImage.width, replacedImage.height, { inversionAttempts: 'dontInvert' });
  assert.equal(decoded?.data, payload, 'the replacement code must decode independently');
});

test('image regions reject unsupported, malformed, oversized, aborted, and invalid-kind inputs', async () => {
  const bytes = await fixture('poster-mixed.png');
  await assert.rejects(detectImageRegions({ bytes, mimeType: 'image/webp' }), (error) => error.code === 'ERR_IMAGE_REGIONS_FORMAT_UNSUPPORTED');
  await assert.rejects(detectImageRegions({ bytes: Buffer.from('not an image'), mimeType: 'image/png' }), (error) => error.code === 'ERR_IMAGE_REGIONS_FORMAT_UNSUPPORTED');
  await assert.rejects(detectImageRegions({ bytes, mimeType: 'image/png', kinds: ['payload'] }), (error) => error.code === 'ERR_IMAGE_REGIONS_INPUT');
  const oversized = Buffer.from(bytes);
  oversized.writeUInt32BE(32_769, 16);
  await assert.rejects(detectImageRegions({ bytes: oversized, mimeType: 'image/png' }), (error) => error.code === 'ERR_IMAGE_REGIONS_IMAGE_SIZE');
  const controller = new AbortController();
  const reason = new Error('fixture cancellation');
  controller.abort(reason);
  await assert.rejects(detectImageRegions({ bytes, mimeType: 'image/png', signal: controller.signal }), reason);
});
