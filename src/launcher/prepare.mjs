import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preparePython } from './python.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lockInputs = [
  'package.json',
  'package-lock.json',
  'third_party/canvas/canvas-agent/package.json',
  'third_party/canvas/canvas-agent/package-lock.json',
  'third_party/canvas/web/package.json',
  'third_party/canvas/web/package-lock.json',
  'adapters/dsh/package.json',
  'adapters/dsh/package-lock.json',
  'scripts/build-web.mjs',
  'scripts/build-workbuddy-plugin.mjs',
  'scripts/dsh-p0-build-client.mjs',
  'scripts/requirements-cleaner-ocr.txt',
  'scripts/requirements-cleaner-ocr.lock.txt',
  'scripts/ocr_materials.py',
  'third_party/our-free-model/workbuddy/upstream-business.mjs',
];
const sourceRoots = [
  'src',
  'web',
  'third_party/canvas/canvas-agent',
  'third_party/canvas/web',
  'adapters/dsh',
  'third_party/our-free-model/workbuddy',
];
const npmTargets = [
  '.',
  'third_party/canvas/canvas-agent',
  'third_party/canvas/web',
  'adapters/dsh',
];
const buildTargets = [
  { cwd: '.', args: ['run', 'web:build'], label: 'Studio Web' },
  { cwd: 'third_party/canvas/canvas-agent', args: ['run', 'build'], label: 'Canvas Agent' },
  { cwd: 'third_party/canvas/web', args: ['run', 'build'], label: 'Canvas Web' },
  { cwd: 'adapters/dsh', args: ['run', 'p0:client:build'], label: 'DSH client' },
];
const requiredOutputs = [
  'web/dist/index.html',
  'web/dist/assets/app.js',
  'third_party/canvas/canvas-agent/dist/index.js',
  'third_party/canvas/web/dist/index.html',
  'adapters/dsh/lib/client.js',
  'third_party/our-free-model/workbuddy/runtime.mjs',
];

function resolveNpmCli(nodePath) {
  const executableDirs = new Set([path.dirname(nodePath), path.dirname(process.execPath)]);
  for (const dir of executableDirs) {
    const candidates = process.platform === 'win32'
      ? [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
      : [
          path.resolve(dir, '../lib/node_modules/npm/bin/npm-cli.js'),
          path.resolve(dir, '../node_modules/npm/bin/npm-cli.js'),
        ];
    const match = candidates.find((candidate) => existsSync(candidate));
    if (match) return match;
  }
  return null;
}

async function listSourceFiles(root, relativeDirectory) {
  const files = [];
  async function visit(relativePath) {
    const absolutePath = path.join(root, relativePath);
    let entries;
    try {
      entries = await readdir(absolutePath, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childPath = path.posix.join(relativePath.replaceAll(path.sep, '/'), entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', '.git', '.studio-runtime'].includes(entry.name)) continue;
        if (childPath === 'adapters/dsh/lib') continue;
        await visit(childPath.split('/').join(path.sep));
      } else if (entry.isFile()) {
        if (childPath === 'third_party/our-free-model/workbuddy/runtime.mjs') continue;
        files.push(childPath);
      }
    }
  }
  await visit(relativeDirectory);
  return files;
}

async function fingerprint(root) {
  const hash = createHash('sha256');
  let sourceFileCount = 0;
  for (const file of lockInputs) {
    const bytes = await readFile(path.join(root, file));
    hash.update(file).update('\0').update(bytes).update('\0');
  }
  for (const sourceRoot of sourceRoots) {
    const files = await listSourceFiles(root, sourceRoot);
    sourceFileCount += files.length;
    for (const file of files) {
      const bytes = await readFile(path.join(root, file));
      hash.update(file).update('\0').update(bytes).update('\0');
    }
  }
  return { value: hash.digest('hex'), sourceFileCount };
}

function prependPath(nodePath) {
  const directory = path.dirname(nodePath);
  const current = process.env.PATH ?? '';
  return { ...process.env, PATH: [directory, current].filter(Boolean).join(path.delimiter) };
}

function runNode(nodePath, args, cwd, env) {
  const result = spawnSync(nodePath, args, {
    cwd,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const code = result.status ?? 1;
    throw new Error(`命令失败（退出码 ${code}）：${path.relative(projectRoot, cwd) || '.'} / ${args.join(' ')}`);
  }
}

function runNpm(nodePath, npmCli, args, cwd, env) {
  if (npmCli) {
    runNode(nodePath, [npmCli, ...args], cwd, env);
    return;
  }
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCommand, args, {
    cwd,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm 命令失败（退出码 ${result.status ?? 1}）：${args.join(' ')}`);
  }
}

async function writeState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, statePath);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function liveServer(root) {
  const directory = path.join(root, '.studio-runtime', 'servers');
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
    const markerPath = path.join(directory, name);
    let marker;
    try {
      marker = JSON.parse(await readFile(markerPath, 'utf8'));
    } catch {
      throw new Error(`发现无法读取的运行中实例标记 ${path.basename(markerPath)}；请确认工作台已停止后再重试。`);
    }
    if (processIsAlive(marker.pid)) return marker;
    await rm(markerPath, { force: true });
  }
  return null;
}

async function acquirePrepareLock(root, onProgress) {
  const lockPath = path.join(root, '.studio-runtime', 'prepare.lock');
  const owner = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() };
  const startedWaiting = Date.now();
  let handle;
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  while (!handle) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(owner)}\n`);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        if (handle) {
          await handle.close().catch(() => {});
          await rm(lockPath, { force: true });
        }
        throw error;
      }
      let previous;
      try {
        previous = JSON.parse(await readFile(lockPath, 'utf8'));
      } catch {
        previous = null;
      }
      if (previous?.pid && !processIsAlive(previous.pid)) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() - startedWaiting > 15 * 60 * 1000) {
        throw new Error('等待项目依赖准备锁超时；请检查是否有另一个首次启动仍在运行。');
      }
      onProgress({ phase: 'wait', message: '另一个启动正在准备本项目，等待它完成。' });
      await delay(500);
    }
  }
  return async () => {
    await handle.close();
    let current;
    try {
      current = JSON.parse(await readFile(lockPath, 'utf8'));
    } catch {
      current = null;
    }
    if (current?.token === owner.token) await rm(lockPath, { force: true });
  };
}

async function outputsExist(root) {
  for (const relativePath of requiredOutputs) {
    try {
      const info = await stat(path.join(root, relativePath));
      if (!info.isFile() || info.size === 0) return false;
    } catch {
      return false;
    }
  }
  for (const target of npmTargets) {
    if (!existsSync(path.join(root, target, 'node_modules'))) return false;
  }
  const pythonRelative = process.platform === 'win32' ? '.venv-ocr/Scripts/python.exe' : '.venv-ocr/bin/python';
  try {
    const pythonInfo = await stat(path.join(root, pythonRelative));
    const pythonState = JSON.parse(await readFile(path.join(root, '.studio-runtime', 'python-state.json'), 'utf8'));
    if (!pythonInfo.isFile() || pythonState.status !== 'ready') return false;
  } catch {
    return false;
  }
  return true;
}

/** Prepare locked dependencies and build outputs. Launcher `update` passes force=true. */
export async function prepareWorkspace({
  root = projectRoot,
  nodePath = process.execPath,
  npmPath,
  force = false,
  onProgress = () => {},
} = {}) {
  root = path.resolve(root);
  nodePath = path.resolve(nodePath);
  const statePath = path.join(root, '.studio-runtime', 'prepare-state.json');
  const { value: lockFingerprint, sourceFileCount } = await fingerprint(root);
  const runtimeVersion = process.versions.node;
  const activeNpmCli = npmPath ? path.resolve(npmPath) : resolveNpmCli(nodePath);
  let previousState;

  try {
    previousState = JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    previousState = null;
  }

  const releaseLock = await acquirePrepareLock(root, onProgress);
  try {
    // Another launcher may have finished while this process waited for the project lock.
    try {
      previousState = JSON.parse(await readFile(statePath, 'utf8'));
    } catch {
      previousState = null;
    }
    if (!force && previousState?.status === 'ready'
        && previousState.lockFingerprint === lockFingerprint
        && previousState.nodeVersion === runtimeVersion
        && await outputsExist(root)) {
      const python = await preparePython({ root, force: false, onProgress, nodePath });
      onProgress({ phase: 'skip', message: '固定依赖与构建产物已就绪，跳过准备。' });
      return {
        root,
        nodePath,
        npmPath: activeNpmCli,
        fingerprint: lockFingerprint,
        skipped: python.skipped,
      };
    }

    const activeServer = await liveServer(root);
    if (activeServer) {
      throw new Error(`同一源码目录已有工作台进程（PID ${activeServer.pid}）正在运行；停止该实例后再重建依赖或前端产物。`);
    }

    const state = {
      status: 'preparing',
      lockFingerprint,
      sourceFileCount,
      nodeVersion: runtimeVersion,
      startedAt: new Date().toISOString(),
    };
    await writeState(statePath, state);
    const env = prependPath(nodePath);
    const npmCli = activeNpmCli;

    try {
      for (const relativePath of npmTargets) {
        const cwd = path.join(root, relativePath);
        onProgress({ phase: 'install', target: relativePath || '.', message: `准备固定依赖：${relativePath || '项目根目录'}` });
        runNpm(nodePath, npmCli, ['ci', '--no-audit', '--no-fund'], cwd, env);
      }

      for (const target of buildTargets) {
        onProgress({ phase: 'build', target: target.label, message: `构建：${target.label}` });
        runNpm(nodePath, npmCli, target.args, path.join(root, target.cwd), env);
      }

      onProgress({ phase: 'build', target: 'WorkBuddy plugin', message: '构建：模型来源插件' });
      runNode(nodePath, [path.join(root, 'scripts/build-workbuddy-plugin.mjs')], root, env);

      await preparePython({ root, force, onProgress, nodePath });

      if (!(await outputsExist(root))) {
        throw new Error('准备命令结束，但一个或多个必要构建产物缺失。');
      }

      const readyState = {
        ...state,
        status: 'ready',
        completedAt: new Date().toISOString(),
      };
      await writeState(statePath, readyState);
      onProgress({ phase: 'ready', message: '首次准备完成。' });
      return {
        root,
        nodePath,
        npmPath: npmCli,
        fingerprint: lockFingerprint,
        skipped: false,
      };
    } catch (error) {
      await writeState(statePath, {
        ...state,
        status: 'failed',
        failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  } finally {
    await releaseLock();
  }
}

export const preparationInternals = Object.freeze({ fingerprint, listSourceFiles, resolveNpmCli, outputsExist, liveServer });
