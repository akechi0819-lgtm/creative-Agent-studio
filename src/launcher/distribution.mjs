import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const RELEASE_TARGETS = Object.freeze({
  'darwin-arm64': Object.freeze({
    id: 'darwin-arm64', platform: 'darwin', arch: 'arm64', runner: 'macos-15',
    nodeArchive: 'node-v22.23.3-darwin-arm64.tar.xz',
    nodeSha256: '72d5d8832b41c9d9646197af614ffd751406ea4d215060eb91b98864e1919a3e',
    nodeRelative: '.studio-runtime/node/node-v22.23.3-darwin-arm64/bin/node',
  }),
  'win32-x64': Object.freeze({
    id: 'win32-x64', platform: 'win32', arch: 'x64', runner: 'windows-2025',
    nodeArchive: 'node-v22.23.3-win-x64.zip',
    nodeSha256: '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71',
    nodeRelative: '.studio-runtime/node/node-v22.23.3-win-x64/node.exe',
  }),
});

const ALLOWED_FILES = new Set([
  'AGENTS.md', 'README.md', 'Creative_Agent_Studio_PRD.md', '开发与施工计划.md',
  'package.json', 'package-lock.json',
  'Start.command', 'Start.cmd', 'Studio.command', 'Studio.cmd',
  'scripts/studio.mjs', 'scripts/setup.mjs', 'scripts/canvas-supervisor.mjs',
  'scripts/canvas-mcp.mjs',
  'docs/README.md', 'docs/代理宿主使用.md', 'docs/工程进度.md',
  'third_party/canvas/LICENSE', 'third_party/canvas/VERSION',
  'third_party/canvas/canvas-agent/package.json',
  'third_party/canvas/canvas-agent/package-lock.json',
  'third_party/canvas/canvas-agent/tsconfig.json',
  'third_party/canvas/canvas-agent/README.md',
  'release/NOTICE-third-party.md',
]);

const ALLOWED_PREFIXES = Object.freeze([
  '.agents/skills/creative-studio/',
  'src/canvas/', 'src/lite/',
  'licenses/',
  'third_party/canvas/canvas-agent/dist/',
  'third_party/canvas/web/dist/',
]);

const FORBIDDEN_SOURCE_PATH = /(?:^|\/)(?:\.git|\.p0-state|\.studio-runtime|\.venv-ocr|node_modules|config|tasks|company|browser-profile|evidence|user-data|employee-data)(?:\/|$)/i;
const FORBIDDEN_BUNDLE_PATH = /(?:^|\/)(?:\.git|\.p0-state|\.venv-ocr|rapidocr-models|python-venv-stage|python-venv-backups|python-runtime-state\.json|employee-data|browser-profile|evidence)(?:\/|$)/i;
const FORBIDDEN_BUNDLE_ROOTS = new Set([
  'config', 'tasks', 'materials', 'exports', 'history', 'logs', 'data', 'user-data',
]);
const NODE_VERSION = '22.23.3';

const toPosix = value => value.split(path.sep).join('/');

export function normalizeTargetId(value) {
  if (typeof value !== 'string' || !Object.hasOwn(RELEASE_TARGETS, value)) {
    throw new Error(`不支持的 Release 平台：${String(value)}；仅支持 ${Object.keys(RELEASE_TARGETS).join('、')}。`);
  }
  return value;
}

export function hostTarget({ platform = process.platform, arch = process.arch } = {}) {
  const id = `${platform}-${arch}`;
  return Object.hasOwn(RELEASE_TARGETS, id) ? RELEASE_TARGETS[id] : null;
}

export function assertNativeTarget(targetId, host = {}) {
  const target = RELEASE_TARGETS[normalizeTargetId(targetId)];
  const current = hostTarget(host);
  if (!current || current.id !== target.id) {
    throw new Error(`禁止跨平台打包：目标 ${target.id} 必须由 ${target.runner} 原生 runner 构建；当前为 ${host.platform ?? process.platform}-${host.arch ?? process.arch}。`);
  }
  return target;
}

export function isReleasePathAllowed(relativePath) {
  const value = toPosix(String(relativePath));
  if (!value || value.startsWith('/') || value.split('/').includes('..') || FORBIDDEN_SOURCE_PATH.test(value)) return false;
  return ALLOWED_FILES.has(value) || ALLOWED_PREFIXES.some(prefix => value.startsWith(prefix));
}

export function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean).map(toPosix).filter(relative => existsSync(path.join(root, relative)));
}

async function regularFile(source, relativePath) {
  const absolute = path.join(source, relativePath);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`打包输入必须是普通文件：${relativePath}`);
  return absolute;
}

export async function copyAllowlistedFiles(sourceRoot, destinationRoot, sourceFiles) {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  if (destination === source || destination.startsWith(`${source}${path.sep}`)) {
    throw new Error('staging 目录必须位于源码目录之外。');
  }
  const destinationInfo = await lstat(destination).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (destinationInfo) throw new Error('staging 目录必须不存在，避免混入上次构建内容。');
  await mkdir(destination, { recursive: true });

  const selected = [...new Set(sourceFiles.map(toPosix))].filter(isReleasePathAllowed).sort();
  if (!selected.length) throw new Error('allowlist 没有匹配到任何输入文件。');
  for (const relative of selected) {
    const from = await regularFile(source, relative);
    const to = path.join(destination, relative);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  return selected;
}

export async function hashFile(file) {
  const digest = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  const stream = createReadStream(file);
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest('hex');
}

async function walkFiles(root, relative = '', files = []) {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) await walkFiles(root, child, files);
    else if (entry.isFile()) files.push(toPosix(child));
    else if (entry.isSymbolicLink()) throw new Error(`发布包不能包含符号链接：${toPosix(child)}`);
  }
  return files;
}

function forbiddenBundlePath(relative) {
  const value = toPosix(relative);
  return FORBIDDEN_BUNDLE_PATH.test(value) || FORBIDDEN_BUNDLE_ROOTS.has(value.split('/')[0]);
}

export async function materializeBundleSymlinks(root) {
  const absoluteRoot = await realpath(path.resolve(root));
  async function copyTree(source, destination, activeDirectories = new Set()) {
    const sourceInfo = await stat(source);
    if (sourceInfo.isFile()) {
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
      await chmod(destination, sourceInfo.mode & 0o777);
      return;
    }
    if (!sourceInfo.isDirectory()) throw new Error(`发布包包含不支持的链接目标：${source}`);
    const resolved = await realpath(source);
    if (!pathWithin(absoluteRoot, resolved)) throw new Error(`发布包链接指向 staging 外部：${source}`);
    if (activeDirectories.has(resolved)) throw new Error(`发布包包含循环目录链接：${source}`);
    const nextActive = new Set(activeDirectories).add(resolved);
    await mkdir(destination, { recursive: true, mode: sourceInfo.mode & 0o777 });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      await copyEntry(path.join(source, entry.name), path.join(destination, entry.name), nextActive);
    }
  }
  async function copyEntry(source, destination, activeDirectories = new Set()) {
    const info = await lstat(source);
    if (info.isSymbolicLink()) {
      const resolved = await realpath(source);
      if (!pathWithin(absoluteRoot, resolved)) throw new Error(`发布包链接指向 staging 外部：${source}`);
      await copyTree(resolved, destination, activeDirectories);
    } else if (info.isDirectory()) {
      await copyTree(source, destination, activeDirectories);
    } else if (info.isFile()) {
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
      await chmod(destination, info.mode & 0o777);
    } else {
      throw new Error(`发布包包含不支持的文件类型：${source}`);
    }
  }
  async function visit(relative = '') {
    for (const entry of await readdir(path.join(absoluteRoot, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(absoluteRoot, child);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        const temporary = `${absolute}.materializing-${process.pid}`;
        await copyEntry(absolute, temporary);
        await rm(absolute, { force: true });
        await rename(temporary, absolute);
        if ((await lstat(absolute)).isDirectory()) await visit(child);
      } else if (info.isDirectory()) {
        await visit(child);
      }
    }
  }
  await visit();
}

export async function writeBundleManifest(root, targetId, version) {
  const target = RELEASE_TARGETS[normalizeTargetId(targetId)];
  const entries = [];
  for (const relative of await walkFiles(root)) {
    if (relative === 'release-manifest.json' || relative.endsWith('.zip') || relative.endsWith('.sha256')) continue;
    if (forbiddenBundlePath(relative)) throw new Error(`发现不允许进入 Release 的路径：${relative}`);
    const file = path.join(root, relative);
    const info = await stat(file);
    entries.push({ path: relative, size: info.size, sha256: await hashFile(file) });
  }
  const manifest = {
    schemaVersion: 1,
    product: 'Creative Agent Studio Company Lite',
    version,
    target: target.id,
    platform: target.platform,
    architecture: target.arch,
    nodeVersion: NODE_VERSION,
    files: entries,
  };
  await writeFile(path.join(root, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
  return manifest;
}

export async function pruneBuildState(root) {
  const remove = [
    '.studio-runtime/prepare.lock', '.studio-runtime/prepare-state.json',
    '.studio-runtime/servers', '.studio-runtime/ci-data',
    '.studio-runtime/downloads', '.studio-runtime/uv-cache', '.studio-runtime/npm-cache',
  ];
  await Promise.all(remove.map(relative => rm(path.join(root, relative), { recursive: true, force: true })));
  await mkdir(path.join(root, '.studio-runtime'), { recursive: true });
}

export function pathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export const distributionInternals = Object.freeze({
  ALLOWED_FILES, ALLOWED_PREFIXES, FORBIDDEN_SOURCE_PATH, FORBIDDEN_BUNDLE_PATH,
  FORBIDDEN_BUNDLE_ROOTS, NODE_VERSION,
});
