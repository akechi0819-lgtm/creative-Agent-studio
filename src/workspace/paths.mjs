import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

const EXPOSED_ROOTS = new Set(['inputs', 'work', 'outputs']);
const INTERNAL_ROOTS = new Set([...EXPOSED_ROOTS, '.runtime']);

export function normalizeRelativePath(value, { allowInternal = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > 1000 || value.includes('\0') || value.includes('\\')) {
    throw new Error('请提供有效的 workspace 相对路径。');
  }
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/u.test(value)) {
    throw new Error('workspace 路径必须是相对路径。');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('workspace 路径不能包含空段、`.` 或 `..`。');
  }
  const roots = allowInternal ? INTERNAL_ROOTS : EXPOSED_ROOTS;
  if (!roots.has(parts[0])) throw new Error('workspace 路径只能位于 inputs、work 或 outputs 目录。');
  return parts.join('/');
}

export async function prepareWorkspace(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) {
    throw new Error('workspaceRoot 必须由宿主提供绝对路径。');
  }
  await mkdir(workspaceRoot, { recursive: true });
  const rootStat = await lstat(workspaceRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('任务 workspace 必须是普通目录。');
  const root = await realpath(workspaceRoot);
  for (const directory of ['inputs', 'work', 'outputs', '.runtime']) {
    const absolute = path.join(root, directory);
    await mkdir(absolute, { recursive: true });
    const stat = await lstat(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('workspace 子目录必须是普通目录。');
  }
  return root;
}

async function assertNoSymlinkPath(root, relativePath, { allowInternal = false, allowMissingLeaf = false } = {}) {
  const normalized = normalizeRelativePath(relativePath, { allowInternal });
  const parts = normalized.split('/');
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (allowMissingLeaf && index === parts.length - 1) return { path: current, relativePath: normalized, exists: false };
      throw new Error('workspace 文件不存在。');
    }
    if (stat.isSymbolicLink()) throw new Error('workspace 不接受符号链接。');
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('workspace 路径中间部分必须是目录。');
    if (index === parts.length - 1 && !stat.isFile()) throw new Error('workspace 路径必须指向普通文件。');
  }
  const resolved = await realpath(current);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('workspace 文件必须位于当前任务目录内。');
  }
  return { path: resolved, relativePath: normalized, exists: true };
}

export async function resolveWorkspaceFile(workspaceRoot, relativePath, options = {}) {
  const root = await prepareWorkspace(workspaceRoot);
  return assertNoSymlinkPath(root, relativePath, options);
}

export async function resolveWorkspaceDirectory(workspaceRoot, relativePath, { allowInternal = false } = {}) {
  const root = await prepareWorkspace(workspaceRoot);
  const normalized = normalizeRelativePath(relativePath, { allowInternal });
  const parts = normalized.split('/');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('workspace 目录必须是普通目录。');
  }
  const resolved = await realpath(current);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('workspace 目录必须位于当前任务目录内。');
  }
  return { path: resolved, relativePath: normalized };
}

export async function readWorkspaceFile(workspaceRoot, relativePath, options = {}) {
  const target = await resolveWorkspaceFile(workspaceRoot, relativePath, options);
  return readFile(target.path);
}

export async function writeWorkspaceFile(workspaceRoot, relativePath, bytes, { allowInternal = false, mode = 0o600 } = {}) {
  const root = await prepareWorkspace(workspaceRoot);
  const normalized = normalizeRelativePath(relativePath, { allowInternal });
  const parts = normalized.split('/');
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    await mkdir(parent, { recursive: true });
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('workspace 目录必须是普通目录。');
  }
  const target = await assertNoSymlinkPath(root, normalized, { allowInternal, allowMissingLeaf: true });
  await writeFile(target.path, bytes, { flag: 'wx', mode });
  return { path: target.path, relativePath: normalized };
}

export async function listWorkspaceFiles(workspaceRoot, directory = undefined, { maxFiles = 500 } = {}) {
  const root = await prepareWorkspace(workspaceRoot);
  const roots = directory === undefined ? ['inputs', 'work', 'outputs'] : [normalizeRelativePath(directory)];
  const files = [];
  const visit = async (relativeDirectory) => {
    const target = await resolveWorkspaceDirectory(root, relativeDirectory);
    const entries = await readdir(target.path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(relativePath);
      } else if (entry.isFile()) {
        const resolved = await assertNoSymlinkPath(root, relativePath);
        const stat = await lstat(resolved.path);
        files.push({ path: relativePath, bytes: stat.size });
        if (files.length >= maxFiles) return;
      } else if (entry.isSymbolicLink()) {
        throw new Error('workspace 不接受符号链接。');
      }
      if (files.length >= maxFiles) return;
    }
  };
  for (const item of roots) {
    await visit(item);
    if (files.length >= maxFiles) break;
  }
  return { files, truncated: files.length >= maxFiles };
}

export function safeFileName(value, fallback = 'file') {
  const name = path.posix.basename(String(value || '')).normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/gu, '_')
    .replace(/^\.+/u, '')
    .trim()
    .slice(0, 120);
  return name || fallback;
}
