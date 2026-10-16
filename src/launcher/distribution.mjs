import { execFileSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
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
  'package.json', 'package-lock.json',
  'scripts/assets.mjs', 'scripts/bootstrap-node.ps1', 'scripts/bootstrap-node.sh',
  'scripts/build-web.mjs', 'scripts/build-workbuddy-plugin.mjs', 'scripts/canvas-supervisor.mjs',
  'scripts/canvas.mjs', 'scripts/dsh-p0-build-client.mjs', 'scripts/launcher.mjs',
  'scripts/model-plugin.mjs', 'scripts/ocr_materials.py', 'scripts/prepare.mjs',
  'scripts/requirements-cleaner-ocr.txt', 'scripts/requirements-cleaner-ocr.lock.txt',
  'scripts/requirements-workspace.txt', 'scripts/requirements-workspace.lock.txt',
  'scripts/studio.mjs', 'scripts/web.mjs',
  'web/index.html',
  'third_party/canvas/LICENSE', 'third_party/canvas/VERSION', 'third_party/canvas/CHANGELOG.md',
  'third_party/canvas/web/package.json', 'third_party/canvas/web/package-lock.json',
  'third_party/canvas/web/index.html', 'third_party/canvas/web/vite.config.ts',
  'third_party/canvas/web/tsconfig.json', 'third_party/canvas/web/postcss.config.mjs',
  'third_party/canvas/canvas-agent/package.json', 'third_party/canvas/canvas-agent/package-lock.json',
  'third_party/canvas/canvas-agent/tsconfig.json',
  'third_party/our-free-model/LICENSE', 'third_party/our-free-model/UPSTREAM.json',
  'third_party/our-free-model/package.json', 'third_party/workbench/LICENSE',
  'web/public/brand/characters/LICENSE', 'web/public/brand/characters/ATTRIBUTION.md',
  'web/public/brand/characters/ASSET_LICENSE.md',
  'docs/上游来源.md', 'docs/清洗脚本来源.md', 'docs/模型来源与裁剪.md', 'docs/固定依赖清单.json',
  'release/NOTICE-rapidocr-models.md',
  'release/NOTICE-third-party.md',
  'release/licenses/Apache-2.0.txt', 'release/licenses/CC-BY-4.0.txt',
  'release/licenses/LGPL-3.0.txt', 'release/licenses/MPL-2.0.txt',
  'release/launcher.mjs', 'release/prepare-python.mjs', 'release/macos-launcher.applescript',
  'release/windows-start.vbs', 'release/windows-start.ps1',
]);

const ALLOWED_PREFIXES = Object.freeze([
  'src/assets/', 'src/canvas/', 'src/creative/', 'src/dna/', 'src/launcher/', 'src/web/',
  'src/workspace/',
  'web/src/', 'web/public/',
  'adapters/dsh/', 'adapters/free-model/',
  'third_party/canvas/web/src/', 'third_party/canvas/web/public/',
  'third_party/canvas/canvas-agent/src/',
  'third_party/our-free-model/src/', 'third_party/our-free-model/workbuddy/',
]);

const FORBIDDEN_SOURCE_PATH = /(?:^|\/)(?:\.git|\.p0-state|\.studio-runtime|\.venv-ocr|node_modules|company|browser-profile|evidence)(?:\/|$)/i;
const FORBIDDEN_BUNDLE_PATH = /(?:^|\/)(?:\.git|\.p0-state|company|browser-profile|evidence|user-data|sessions|\.venv-ocr|rapidocr-models|python-venv-stage|python-venv-backups|python-runtime-state\.json)(?:\/|$)/i;
const FORBIDDEN_BUNDLE_ROOTS = new Set(['config', 'tasks', 'materials', 'exports', 'history', 'logs']);
const NODE_VERSION = '22.23.3';
const PYTHON_VERSION = '3.12.15';

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
  const value = String(relativePath).split(path.sep).join('/');
  if (!value || value.startsWith('/') || value.split('/').includes('..') || FORBIDDEN_SOURCE_PATH.test(value)) return false;
  return ALLOWED_FILES.has(value) || ALLOWED_PREFIXES.some(prefix => value.startsWith(prefix));
}

export function assertCleanStatus(status) {
  if (String(status).trim()) {
    const sample = String(status).trim().split(/\r?\n/).slice(0, 8).join('\n');
    throw new Error(`拒绝从脏工作树打包。请在干净 Git checkout 中构建；检测到的改动：\n${sample}`);
  }
}

export function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean).map(value => value.split(path.sep).join('/'));
}

export function assertCleanWorkingTree(root) {
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules'], {
    cwd: root, encoding: 'utf8',
  });
  assertCleanStatus(status);
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

  const selected = [...new Set(sourceFiles.map(value => value.split(path.sep).join('/')))]
    .filter(isReleasePathAllowed).sort();
  if (!selected.length) throw new Error('allowlist 没有匹配到任何已跟踪输入文件。');
  for (const relative of selected) {
    const from = await regularFile(source, relative);
    const to = path.join(destination, relative);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  const required = ['package.json', 'package-lock.json', 'scripts/web.mjs', 'release/launcher.mjs'];
  const missing = required.filter(relative => !selected.includes(relative));
  if (missing.length) throw new Error(`allowlist 缺少必要输入：${missing.join('、')}`);
  return selected;
}

export async function hashFile(file) {
  const digest = createHash('sha256');
  const content = await readFile(file);
  digest.update(content);
  return digest.digest('hex');
}

function forbiddenBundlePath(relative) {
  const normalized = relative.split(path.sep).join('/');
  const firstStartRuntime = /^(?:\.venv-ocr(?:\/|$)|\.studio-runtime\/(?:python|rapidocr-models)(?:\/|$))/i.test(normalized);
  return firstStartRuntime || FORBIDDEN_BUNDLE_PATH.test(normalized) || FORBIDDEN_BUNDLE_ROOTS.has(normalized.split('/')[0]);
}

async function walkFiles(root, relative = '', files = []) {
  const absolute = path.join(root, relative);
  const entries = await readdir(absolute, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    const childAbsolute = path.join(root, child);
    const info = await lstat(childAbsolute);
    if (info.isSymbolicLink()) throw new Error(`Release 归档前必须物化内部链接：${child}`);
    if (info.isDirectory()) await walkFiles(root, child, files);
    else if (info.isFile()) files.push(child);
    else throw new Error(`Release 目录包含不支持的文件类型：${child}`);
  }
  return files;
}

async function copyTree(source, destination, root, activeDirectories = new Set()) {
  const sourceInfo = await stat(source);
  if (sourceInfo.isFile()) {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    await chmod(destination, sourceInfo.mode & 0o777);
    return;
  }
  if (!sourceInfo.isDirectory()) throw new Error(`Release 包含不支持的链接目标：${source}`);
  const realSource = await realpath(source);
  if (!pathWithin(root, realSource)) throw new Error(`Release 链接指向 staging 外部：${source}`);
  if (activeDirectories.has(realSource)) throw new Error(`Release 包含循环目录链接：${source}`);
  const nextActive = new Set(activeDirectories).add(realSource);
  await mkdir(destination, { recursive: true, mode: sourceInfo.mode & 0o777 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    await copyEntry(path.join(source, entry.name), path.join(destination, entry.name), root, nextActive);
  }
}

async function copyEntry(source, destination, root, activeDirectories = new Set()) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    const target = await realpath(source);
    if (!pathWithin(root, target)) throw new Error(`Release 链接指向 staging 外部：${source}`);
    await copyTree(target, destination, root, activeDirectories);
    return;
  }
  if (info.isDirectory()) return copyTree(source, destination, root, activeDirectories);
  if (!info.isFile()) throw new Error(`Release 包含不支持的文件类型：${source}`);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, info.mode & 0o777);
}

/** Replace contained links with copies before archiving; source checkout links are never copied. */
export async function materializeBundleSymlinks(root) {
  const absoluteRoot = await realpath(path.resolve(root));
  async function visit(relative = '') {
    for (const entry of await readdir(path.join(absoluteRoot, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(absoluteRoot, child);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        const temporary = `${absolute}.materializing-${process.pid}`;
        await copyEntry(absolute, temporary, absoluteRoot);
        await rm(absolute, { force: true });
        await rename(temporary, absolute);
        if ((await lstat(absolute)).isDirectory()) await visit(child);
      } else if (info.isDirectory()) await visit(child);
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
    product: 'Creative Agent Studio',
    version,
    target: target.id,
    platform: target.platform,
    architecture: target.arch,
    nodeVersion: NODE_VERSION,
    pythonRuntime: {
      version: PYTHON_VERSION,
      bundled: false,
      preparedOnFirstStart: true,
      lockFiles: ['scripts/requirements-cleaner-ocr.lock.txt', 'scripts/requirements-workspace.lock.txt'],
    },
    files: entries,
  };
  await writeFile(path.join(root, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
  return manifest;
}

export async function pruneBuildState(root) {
  const remove = [
    '.studio-runtime/uv', '.studio-runtime/downloads', '.studio-runtime/prepare.lock',
    '.studio-runtime/prepare-state.json', '.studio-runtime/python-state.json',
    '.studio-runtime/python-runtime-state.json', '.studio-runtime/rapidocr-model-state.json',
    '.studio-runtime/python-venv-stage', '.studio-runtime/python-venv-backups',
    '.studio-runtime/servers', '.studio-runtime/ci-data', '.studio-runtime/uv-cache', '.studio-runtime/python-bin',
  ];
  await Promise.all(remove.map(relative => rm(path.join(root, relative), { recursive: true, force: true })));
  const runtime = path.join(root, '.studio-runtime');
  await mkdir(runtime, { recursive: true });
}

export function pathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export const distributionInternals = Object.freeze({ ALLOWED_FILES, ALLOWED_PREFIXES, FORBIDDEN_SOURCE_PATH, FORBIDDEN_BUNDLE_PATH, NODE_VERSION, PYTHON_VERSION });
