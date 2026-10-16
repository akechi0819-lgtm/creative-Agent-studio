import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preparePython } from './python.mjs';
import { checkDependencyGroup } from './dependencies.mjs';
import { buildTargets, captureBuildInputs, inspectBuildOutputs, canAdoptBuild } from './builds.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const npmTargets = ['.', 'third_party/canvas/canvas-agent', 'third_party/canvas/web', 'adapters/dsh'];

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

export async function acquirePrepareLock(root, onProgress = () => {}) {
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

async function dependencyFingerprint(cwd) {
  const hash = createHash('sha256');
  for (const name of ['package.json', 'package-lock.json']) {
    hash.update(name).update('\0').update(await readFile(path.join(cwd, name))).update('\0');
  }
  return hash.digest('hex');
}

const outputManifest = outputs => outputs.files.map(({path, sha256, size}) => ({path, sha256, size}));
const sameOutputs = (saved, current) => JSON.stringify(saved) === JSON.stringify(outputManifest(current));

/** Validate each installed group independently. force rebuilds outputs, never healthy dependencies. */
export async function prepareWorkspace({
  root = projectRoot,
  nodePath = process.execPath,
  npmPath,
  force = false,
  includePython = true,
  onProgress = () => {},
  operations = {},
} = {}) {
  root = path.resolve(root);
  nodePath = path.resolve(nodePath);
  const statePath = path.join(root, '.studio-runtime', 'prepare-state.json');
  const npmCli = npmPath ? path.resolve(npmPath) : resolveNpmCli(nodePath);
  const env = prependPath(nodePath);
  const checkDependencies = operations.checkDependencies || checkDependencyGroup;
  const npm = operations.npm || ((args, cwd) => runNpm(nodePath, npmCli, args, cwd, env));
  const node = operations.node || ((args, cwd) => runNode(nodePath, args, cwd, env));
  const python = operations.python || preparePython;
  const releaseLock = await acquirePrepareLock(root, onProgress);
  let state;
  let activeStep;
  const actions = { dependenciesInstalled: [], dependenciesReused: [], buildsRun: [], buildsReused: [] };
  const ensureOffline = async () => {
    const active = await liveServer(root);
    if (active) throw new Error(`同一源码目录已有工作台进程（PID ${active.pid}）正在运行；停止该实例后再修改依赖或构建产物。`);
  };
  try {
    let saved;
    try { saved = JSON.parse(await readFile(statePath, 'utf8')); } catch { /* No trusted preparation ledger: inspect actual files. */ }
    const record = value => value && typeof value === 'object' && !Array.isArray(value);
    state = saved?.schemaVersion === 2 && record(saved.dependencies) && record(saved.builds)
      ? saved : {schemaVersion: 2, dependencies: {}, builds: {}};
    state.status = 'preparing';
    state.startedAt = new Date().toISOString();
    state.nodeVersion = process.versions.node;
    delete state.error;
    await writeState(statePath, state);

    for (const target of npmTargets) {
      const cwd = path.join(root, target);
      const input = await dependencyFingerprint(cwd);
      const current = await checkDependencies({cwd, nodePath, npmPath: npmCli});
      if (!current.ready) {
        if (current.repairable === false) throw new Error(`${target} 无法完成依赖验证，未尝试重装：${current.reason}`);
        await ensureOffline();
        activeStep = {section: 'dependencies', id: target};
        state.dependencies[target] = {status: 'installing', fingerprint: input, reason: current.reason};
        await writeState(statePath, state);
        onProgress({phase: 'install', target, message: `补齐固定依赖：${target}`});
        await npm(['ci', '--no-audit', '--no-fund'], cwd);
        const verified = await checkDependencies({cwd, nodePath, npmPath: npmCli});
        if (!verified.ready) throw new Error(`${target} 安装后依赖验证未通过：${verified.reason}`);
        if (await dependencyFingerprint(cwd) !== input) throw new Error(`${target} 依赖清单在安装期间变化；保留已完成安装，下次只重新检查本组。`);
        actions.dependenciesInstalled.push(target);
      } else {
        actions.dependenciesReused.push(target);
        onProgress({phase: 'reuse', target, message: `验证并复用固定依赖：${target}`});
      }
      state.dependencies[target] = {status: 'ready', fingerprint: input, verifiedAt: new Date().toISOString()};
      activeStep = null;
      await writeState(statePath, state);
    }

    for (const target of buildTargets) {
      if (await dependencyFingerprint(path.join(root, target.dependency)) !== state.dependencies[target.dependency].fingerprint) {
        throw new Error(`${target.dependency} 依赖清单在准备期间变化；下次只重新检查变更的组件。`);
      }
      const inputs = await captureBuildInputs(root, target);
      let outputs = await inspectBuildOutputs(root, target);
      const savedBuild = state.builds[target.id];
      const reuse = !force && outputs.ready && (savedBuild
        ? savedBuild.status === 'ready' && savedBuild.fingerprint === inputs.fingerprint && sameOutputs(savedBuild.outputs, outputs)
        : canAdoptBuild(inputs, outputs));
      if (!reuse) {
        await ensureOffline();
        activeStep = {section: 'builds', id: target.id};
        state.builds[target.id] = {status: 'building', fingerprint: inputs.fingerprint};
        await writeState(statePath, state);
        onProgress({phase: 'build', target: target.id, message: `构建：${target.id}`});
        if (target.nodeScript) await node([path.join(root, target.nodeScript)], path.join(root, target.cwd));
        else await npm(target.npmArgs, path.join(root, target.cwd));
        const finishedInputs = await captureBuildInputs(root, target);
        outputs = await inspectBuildOutputs(root, target);
        if (!outputs.ready) throw new Error(`${target.id} 构建产物不完整：${outputs.reason}`);
        if (finishedInputs.fingerprint !== inputs.fingerprint) {
          throw new Error(`${target.id} 源码在构建期间变化；未认领不确定的产物，下次仅重建本组件。`);
        }
        actions.buildsRun.push(target.id);
      } else {
        actions.buildsReused.push(target.id);
        onProgress({phase: 'reuse', target: target.id, message: `验证并复用构建：${target.id}`});
      }
      state.builds[target.id] = {status: 'ready', fingerprint: inputs.fingerprint, outputs: outputManifest(outputs), verifiedAt: new Date().toISOString()};
      activeStep = null;
      await writeState(statePath, state);
    }

    let pythonResult = null;
    if (includePython) {
      pythonResult = await python({root, nodePath, onProgress, beforeChange: ensureOffline});
      state.python = {fingerprint: pythonResult.fingerprint, pythonExecutable: pythonResult.pythonExecutable, status: 'ready'};
    } else {
      state.python = {status: 'deferred', reason: 'release-first-start'};
      onProgress({phase: 'deferred', message: 'Python/OCR 将在运行包首次启动时准备。'});
    }
    for (const target of npmTargets) {
      if (await dependencyFingerprint(path.join(root, target)) !== state.dependencies[target].fingerprint) {
        throw new Error(`${target} 依赖清单在准备期间变化；未将过期检查标记为就绪。`);
      }
    }
    for (const target of buildTargets) {
      if ((await captureBuildInputs(root, target)).fingerprint !== state.builds[target.id].fingerprint) {
        throw new Error(`${target.id} 源码在准备期间变化；下次只重建变更的组件。`);
      }
    }
    state.status = 'ready';
    state.completedAt = new Date().toISOString();
    state.fingerprint = createHash('sha256').update(JSON.stringify({
      dependencies: Object.fromEntries(Object.entries(state.dependencies).map(([id, value]) => [id, value.fingerprint])),
      builds: Object.fromEntries(Object.entries(state.builds).map(([id, value]) => [id, value.fingerprint])),
      python: pythonResult?.fingerprint ?? 'deferred',
    })).digest('hex');
    await writeState(statePath, state);
    const skipped = !actions.dependenciesInstalled.length && !actions.buildsRun.length && (!includePython || pythonResult.skipped);
    const message = includePython
      ? (skipped ? '依赖、构建与 OCR 已验证复用，无需安装。' : '必要准备已完成，其余环境保持复用。')
      : 'Node 依赖与构建已完成；Python/OCR 将在首次启动时准备。';
    onProgress({phase: skipped ? 'skip' : 'ready', message});
    return {root, nodePath, npmPath: npmCli, fingerprint: state.fingerprint, skipped, ...actions, python: pythonResult, pythonDeferred: !includePython};
  } catch (error) {
    if (state && activeStep) {
      const entry = state[activeStep.section][activeStep.id];
      state[activeStep.section][activeStep.id] = {...entry, status: 'failed', error: error.message};
    }
    if (state) await writeState(statePath, {...state, status: 'failed', failedAt: new Date().toISOString(), error: error.message});
    throw error;
  } finally {
    await releaseLock();
  }
}

export const preparationInternals = Object.freeze({resolveNpmCli, dependencyFingerprint, liveServer, acquirePrepareLock});
