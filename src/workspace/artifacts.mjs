import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { readWorkspaceFile, resolveWorkspaceFile, safeFileName, writeWorkspaceFile, listWorkspaceFiles } from './paths.mjs';
import { runOfficeHelper } from './process.mjs';
import path from 'node:path';

const MAX_TEXT_OUTPUT_BYTES = 1 * 1024 * 1024;
const MAX_ZIP_INPUT_FILES = 1000;
const MAX_ZIP_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_ARTIFACT_READ_BYTES = 512 * 1024 * 1024;

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function writeWorkspaceText(workspaceRoot, fileName, content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_TEXT_OUTPUT_BYTES) {
    throw new Error('文本产物最多为 1 MiB。');
  }
  const name = safeFileName(fileName);
  if (name === 'file' || !path.posix.extname(name)) throw new Error('请提供带扩展名的文件名。');
  const saved = await writeWorkspaceFile(workspaceRoot, `outputs/${name}`, Buffer.from(content, 'utf8'));
  return { path: saved.relativePath, bytes: Buffer.byteLength(content, 'utf8') };
}

export async function writeWorkspaceWorkbook({ workspaceRoot, fileName, sheetsJson, pythonPath, signal }) {
  if (typeof sheetsJson !== 'string' || Buffer.byteLength(sheetsJson, 'utf8') > MAX_TEXT_OUTPUT_BYTES) {
    throw new Error('工作簿数据 JSON 最多为 1 MiB。');
  }
  const name = safeFileName(fileName);
  if (path.posix.extname(name).toLowerCase() !== '.xlsx') throw new Error('工作簿文件名必须以 .xlsx 结尾。');
  let sheets;
  try { sheets = JSON.parse(sheetsJson); } catch { throw new Error('sheetsJson 必须是有效 JSON。'); }
  const relativePath = `outputs/${name}`;
  const result = await runOfficeHelper({
    workspaceRoot,
    pythonPath,
    signal,
    request: { operation: 'write_xlsx', relativePath, sheets },
  });
  const target = await resolveWorkspaceFile(workspaceRoot, relativePath);
  const info = await stat(target.path);
  return { ...result, bytes: info.size };
}

export async function zipWorkspaceFiles({ workspaceRoot, fileName, relativePaths, signal }) {
  if (!Array.isArray(relativePaths) || !relativePaths.length || relativePaths.length > MAX_ZIP_INPUT_FILES) {
    throw new Error(`ZIP 文件列表必须包含 1 到 ${MAX_ZIP_INPUT_FILES} 项。`);
  }
  const name = safeFileName(fileName);
  const zipName = path.posix.extname(name).toLowerCase() === '.zip' ? name : `${name}.zip`;
  const files = {};
  let totalBytes = 0;
  const unique = new Set();
  for (const relativePath of relativePaths) {
    signal?.throwIfAborted();
    if (typeof relativePath !== 'string' || !relativePath.startsWith('outputs/')) {
      throw new Error('ZIP 只能打包 outputs/ 目录中的产物。');
    }
    const target = await resolveWorkspaceFile(workspaceRoot, relativePath);
    if (unique.has(target.relativePath)) throw new Error('ZIP 文件列表不能有重复路径。');
    unique.add(target.relativePath);
    const bytes = await readWorkspaceFile(workspaceRoot, target.relativePath);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_ZIP_INPUT_BYTES) throw new Error('ZIP 输入总大小超过 128 MiB。');
    files[target.relativePath.slice('outputs/'.length)] = new Uint8Array(bytes);
  }
  signal?.throwIfAborted();
  let archive;
  try { archive = zipSync(files, { level: 0 }); } catch { throw new Error('无法创建 ZIP 文件。'); }
  if (archive.byteLength > MAX_ZIP_INPUT_BYTES) throw new Error('ZIP 产物超过 128 MiB 上限。');
  const saved = await writeWorkspaceFile(workspaceRoot, `outputs/${zipName}`, archive);
  return { path: saved.relativePath, fileCount: unique.size, bytes: archive.byteLength, sha256: createHash('sha256').update(archive).digest('hex') };
}

export function createWorkspaceArtifactReader(workspaceRoot) {
  return Object.freeze({
    async listArtifacts() {
      const listing = await listWorkspaceFiles(workspaceRoot, 'outputs', { maxFiles: 1000 });
      const artifacts = [];
      for (const file of listing.files) {
        const target = await resolveWorkspaceFile(workspaceRoot, file.path);
        artifacts.push({
          path: file.path,
          name: path.posix.basename(file.path),
          mimeType: mediaTypeFor(file.path),
          size: file.bytes,
          sha256: await sha256File(target.path),
        });
      }
      return { artifacts, truncated: listing.truncated };
    },
    async readArtifact(relativePath) {
      if (typeof relativePath !== 'string' || !relativePath.startsWith('outputs/')) {
        throw new Error('artifact 路径必须是 workspace 下 outputs/ 开头的相对路径。');
      }
      const target = await resolveWorkspaceFile(workspaceRoot, relativePath);
      const info = await stat(target.path);
      if (info.size > MAX_ARTIFACT_READ_BYTES) throw new Error('artifact 超过 512 MiB 读取上限。');
      const bytes = await readWorkspaceFile(workspaceRoot, target.relativePath);
      return {
        path: target.relativePath,
        name: path.posix.basename(target.relativePath),
        mimeType: mediaTypeFor(target.relativePath),
        bytes,
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    },
  });
}

export function mediaTypeFor(relativePath) {
  const extension = path.posix.extname(relativePath).toLowerCase();
  return ({
    '.csv': 'text/csv', '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain',
    '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.zip': 'application/zip',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  })[extension] || 'application/octet-stream';
}
