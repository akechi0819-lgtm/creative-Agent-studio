import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

const identityInputs = [
  'package.json',
  'package-lock.json',
  'src',
  'scripts',
  'adapters/dsh',
  'adapters/free-model',
  'web/src',
  'web/public',
  'web/index.html',
  'web/dist',
  'release/launcher.mjs',
  'release/prepare-python.mjs',
  'release/windows-start.ps1',
  'release/windows-start.vbs',
  'release/macos-launcher.applescript',
  'third_party/canvas/VERSION',
  'third_party/canvas/CHANGELOG.md',
  'third_party/canvas/web/package.json',
  'third_party/canvas/web/package-lock.json',
  'third_party/canvas/web/index.html',
  'third_party/canvas/web/vite.config.ts',
  'third_party/canvas/web/tsconfig.json',
  'third_party/canvas/web/postcss.config.mjs',
  'third_party/canvas/web/src',
  'third_party/canvas/web/public',
  'third_party/canvas/web/dist',
  'third_party/canvas/canvas-agent/package.json',
  'third_party/canvas/canvas-agent/package-lock.json',
  'third_party/canvas/canvas-agent/tsconfig.json',
  'third_party/canvas/canvas-agent/src',
  'third_party/canvas/canvas-agent/dist',
  'third_party/our-free-model/src',
  'third_party/our-free-model/workbuddy',
  'third_party/workbench',
];

const ignoredDirectories = new Set(['.git', 'node_modules', '.studio-runtime']);
const ignoredFiles = new Set(['.DS_Store', 'Thumbs.db']);

async function hashPath(root, relative, hash) {
  const fullPath = path.join(root, relative);
  let info;
  try {
    info = await lstat(fullPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    hash.update(`missing\0${relative}\0`);
    return;
  }

  if (info.isSymbolicLink()) {
    hash.update(`link\0${relative}\0${await readlink(fullPath)}\0`);
    return;
  }
  if (info.isDirectory()) {
    hash.update(`directory\0${relative}\0`);
    const entries = await readdir(fullPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      if (ignoredFiles.has(entry.name)) continue;
      await hashPath(root, path.join(relative, entry.name), hash);
    }
    return;
  }
  if (!info.isFile()) {
    hash.update(`other\0${relative}\0`);
    return;
  }
  hash.update(`file\0${relative}\0`).update(await readFile(fullPath)).update('\0');
}

function readGitCommit(sourceDirectory) {
  try {
    return execFileSync('git', ['-C', sourceDirectory, 'rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Identify the checkout and runtime inputs without including user data or credentials. */
export async function runtimeSourceIdentity(sourceDirectory, { releaseBundle = process.env.STUDIO_RELEASE_BUNDLE === '1' } = {}) {
  sourceDirectory = await realpath(path.resolve(sourceDirectory));
  const hash = createHash('sha256');
  for (const relative of identityInputs) await hashPath(sourceDirectory, relative, hash);
  const packageJson = await readFile(path.join(sourceDirectory, 'package.json'), 'utf8').then(JSON.parse);
  const distribution = releaseBundle ? 'release-bundle' : 'source';
  hash.update(`distribution\0${distribution}\0`);
  return {
    sourceDirectory,
    gitCommit: readGitCommit(sourceDirectory),
    version: typeof packageJson.version === 'string' ? packageJson.version : null,
    distribution,
    buildFingerprint: hash.digest('hex'),
  };
}

export function runtimeIdentitiesMatch(expected, actual) {
  return Boolean(expected && actual
    && typeof expected.sourceDirectory === 'string'
    && expected.sourceDirectory === actual.sourceDirectory
    && typeof expected.buildFingerprint === 'string'
    && expected.buildFingerprint === actual.buildFingerprint
    && expected.distribution === actual.distribution);
}

export function describeRuntimeIdentity(identity) {
  if (!identity) return '旧版本实例未上报运行身份';
  const fingerprint = typeof identity.buildFingerprint === 'string'
    ? identity.buildFingerprint.slice(0, 12)
    : '未知构建';
  const commit = identity.gitCommit || '无 Git 提交号';
  return `${identity.sourceDirectory || '未知程序目录'}（${identity.distribution || '未知运行类型'}，提交 ${commit}，构建 ${fingerprint}）`;
}

export function runtimeIdentityMismatchMessage(status, { stopInstruction = '从本项目运行 `node scripts/launcher.mjs stop` 正常停止旧服务' } = {}) {
  const active = describeRuntimeIdentity(status?.sourceIdentity);
  const current = describeRuntimeIdentity(status?.currentIdentity);
  return [
    '检测到同一数据目录中运行着另一份源码目录或不同构建的工作台，当前入口不会打开旧实例。',
    `运行实例：${active}`,
    `当前入口：${current}`,
    `请先确认旧工作台没有在途作业，再${stopInstruction}；完成源码更新和构建后重新启动。不会强制结束进程或删除数据。`,
  ].join('\n');
}

export function runtimeIdentityMismatchError(status, options) {
  const error = new Error(runtimeIdentityMismatchMessage(status, options));
  error.code = 'ERR_RUNTIME_IDENTITY_MISMATCH';
  return error;
}
