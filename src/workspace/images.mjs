import { createHash } from 'node:crypto';
import { readWorkspaceFile, safeFileName, writeWorkspaceFile } from './paths.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(fileURLToPath(new URL('../../adapters/dsh/package.json', import.meta.url)));
const sharp = require('sharp');

const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
const MAX_BATCH_IMAGES = 100;
const MAX_BATCH_BYTES = 512 * 1024 * 1024;
const SUPPORTED_FORMATS = new Set(['jpeg', 'png', 'webp']);

function imageFormat(format) {
  if (format === 'jpg') return 'jpeg';
  if (!SUPPORTED_FORMATS.has(format)) throw new Error('图片格式只支持 JPEG、PNG 或 WebP。');
  return format;
}

function mimeType(format) {
  return format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
}

export async function createImagePreview({ workspaceRoot, relativePath, attachments, signal }) {
  if (!attachments || typeof attachments.saveImage !== 'function') throw new Error('当前 DSH 会话没有图片附件服务。');
  const bytes = await readWorkspaceFile(workspaceRoot, relativePath);
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('图片超过 100 MiB 预览上限。');
  signal?.throwIfAborted();
  let image;
  try {
    image = sharp(bytes, { failOn: 'error', limitInputPixels: 64 * 1024 * 1024 });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || !['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif', 'heif'].includes(metadata.format)) {
      throw new Error('unsupported_image');
    }
    const previewBytes = await image.rotate().resize(1800, 1800, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    signal?.throwIfAborted();
    const preview = await attachments.saveImage({ data: new Uint8Array(previewBytes), mediaType: 'image/jpeg', name: safeFileName(relativePath, 'workspace-image') });
    return {
      relativePath,
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      preview,
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    if (error?.message === 'unsupported_image') throw new Error('该文件不是受支持的光栅图片。');
    throw new Error('无法解码该图片。');
  }
}

export async function batchProcessImages({ workspaceRoot, relativePaths, maxLongEdge = 1600, format = 'jpeg', signal }) {
  if (!Array.isArray(relativePaths) || !relativePaths.length || relativePaths.length > MAX_BATCH_IMAGES) {
    throw new Error(`批量图片数量必须在 1 到 ${MAX_BATCH_IMAGES} 张之间。`);
  }
  if (!Number.isInteger(maxLongEdge) || maxLongEdge < 64 || maxLongEdge > 4096) {
    throw new Error('图片最长边必须在 64 到 4096 像素之间。');
  }
  const targetFormat = imageFormat(format);
  const uniquePaths = [...new Set(relativePaths)];
  if (uniquePaths.length !== relativePaths.length) throw new Error('图片路径不能重复。');
  const outputs = [];
  let totalBytes = 0;
  for (const relativePath of uniquePaths) {
    signal?.throwIfAborted();
    const bytes = await readWorkspaceFile(workspaceRoot, relativePath);
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > MAX_IMAGE_BYTES || totalBytes > MAX_BATCH_BYTES) throw new Error('批量图片总输入超过 512 MiB 上限。');
    const digest = createHash('sha256').update(relativePath).digest('hex').slice(0, 8);
    const base = path.posix.basename(relativePath, path.posix.extname(relativePath));
    const outputName = `${safeFileName(base, 'image')}-${digest}-processed.${targetFormat === 'jpeg' ? 'jpg' : targetFormat}`;
    let output;
    try {
      let pipeline = sharp(bytes, { failOn: 'error', limitInputPixels: 64 * 1024 * 1024 })
        .rotate()
        .resize(maxLongEdge, maxLongEdge, { fit: 'inside', withoutEnlargement: true });
      pipeline = targetFormat === 'jpeg' ? pipeline.jpeg({ quality: 90 }) : pipeline.toFormat(targetFormat);
      output = await pipeline.toBuffer();
    } catch {
      throw new Error(`无法处理图片：${safeFileName(relativePath)}`);
    }
    signal?.throwIfAborted();
    const saved = await writeWorkspaceFile(workspaceRoot, `outputs/${outputName}`, output);
    const metadata = await sharp(output).metadata();
    outputs.push({ source: relativePath, path: saved.relativePath, bytes: output.byteLength, width: metadata.width, height: metadata.height, mediaType: mimeType(targetFormat) });
  }
  return { processedCount: outputs.length, outputs };
}
