import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Exercise the production browser compositor; jsQR independently decodes its result.
export async function verifyQrBrowser({ root, canvasInstance, callCanvasTool }) {
  const require = createRequire(path.join(root, 'package.json'));
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const jsQR = require('jsqr');
  const { QrCode, Ecc } = await import(pathToFileURL(path.join(root, 'third_party/canvas/web/node_modules/@rc-component/qrcode/es/libs/qrcodegen.js')).href);
  const { detectImageRegions } = await import(pathToFileURL(path.join(root, 'src/creative/image-regions.mjs')).href);
  const fixture = await fs.readFile(path.join(root, 'tests/fixtures/image-regions/poster-mixed.png'));
  const detected = await detectImageRegions({ bytes: fixture, mimeType: 'image/png', kinds: ['barcode'] });
  assert.equal(detected.regions.length, 1);
  const bounds = detected.regions[0].bounds;
  const payload = 'p4-browser-replacement';
  const qr = QrCode.encodeText(payload, Ecc.MEDIUM);
  const replacement = createCanvas(qr.size + 8, qr.size + 8);
  const qrContext = replacement.getContext('2d');
  qrContext.fillStyle = '#ffffff';
  qrContext.fillRect(0, 0, replacement.width, replacement.height);
  qrContext.fillStyle = '#000000';
  for (let y = 0; y < qr.size; y += 1) for (let x = 0; x < qr.size; x += 1) {
    if (qr.getModule(x, y)) qrContext.fillRect(x + 4, y + 4, 1, 1);
  }
  const importImage = async (bytes, title) => {
    const nodeId = randomUUID();
    await callCanvasTool('canvas_import_image', { nodeId, title, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }, canvasInstance);
    return nodeId;
  };
  const baseId = await importImage(fixture, 'P4 合成海报');
  const qrId = await importImage(replacement.toBuffer('image/png'), 'P4 新二维码');
  const result = await callCanvasTool('canvas_compose_images', {
    nodeId: baseId,
    layers: [{ nodeId: qrId, ...bounds, fit: 'contain', clear: '#ffffff', smoothing: 'nearest' }],
  }, canvasInstance);
  assert.equal(result.operation, 'compose');
  const output = await callCanvasTool('canvas_read_image', { nodeId: result.images[0].nodeId }, canvasInstance);
  async function pixels(bytes) {
    const image = await loadImage(bytes);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, image.width, image.height);
  }
  const original = await pixels(fixture);
  const composed = await pixels(Buffer.from(output.dataUrl.split(',')[1], 'base64'));
  assert.equal(composed.width, original.width);
  assert.equal(composed.height, original.height);
  let checked = 0;
  for (let y = 0; y < original.height; y += 1) for (let x = 0; x < original.width; x += 1) {
    if (x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height) continue;
    const offset = (y * original.width + x) * 4;
    for (let channel = 0; channel < 4; channel += 1) assert.equal(composed.data[offset + channel], original.data[offset + channel], `Outside replacement at ${x},${y}`);
    checked += 1;
  }
  const decoded = jsQR(new Uint8ClampedArray(composed.data), composed.width, composed.height);
  assert.equal(decoded?.data, payload, 'Independent decoder must read the new QR payload from the browser output.');
  const source = await callCanvasTool('canvas_read_image', { nodeId: baseId }, canvasInstance);
  assert.deepEqual(Buffer.from(source.dataUrl.split(',')[1], 'base64'), fixture, 'Composition must preserve the source asset.');
  console.log(JSON.stringify({ check: 'production-browser-qr-compose', outsidePixelsUnchanged: checked, newQrDecoded: true }));
}
