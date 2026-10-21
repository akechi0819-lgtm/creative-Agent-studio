#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataRoot } from '../src/canvas/client.mjs';
import { pathWithin } from '../src/launcher/distribution.mjs';
import { auxiliaryStatus, stopAuxiliary } from '../src/launcher/services.mjs';
import { alive, readJson, runtimeStatus, stopRuntime } from '../src/launcher/control.mjs';

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodePath = process.execPath;
const expectedTarget = `${process.platform}-${process.arch}`;
const pythonPrepareScript = path.join(bundleRoot, 'release/prepare-python.mjs');
const startLockPath = root => path.join(root, 'runtime/.studio-runtime/release-start.lock');
const startBusyMessage = '本机已有启动或 Python/OCR 准备正在进行，请稍后再试。';

async function verifyBundle() {
  const manifest = JSON.parse(await readFile(path.join(bundleRoot, 'release-manifest.json'), 'utf8'));
  if (manifest.product !== 'Creative Agent Studio' || manifest.target !== expectedTarget) {
    throw new Error(`此运行包为 ${manifest.target ?? '未知平台'} 构建，当前设备是 ${expectedTarget}。请下载对应平台版本。`);
  }
  if (manifest.pythonRuntime?.bundled !== false || manifest.pythonRuntime?.preparedOnFirstStart !== true) {
    throw new Error('运行包缺少首次启动 Python/OCR 准备信息，请重新下载完整 Release 包。');
  }
  const bundledPython = manifest.files.some(file => file.path.startsWith('.venv-ocr/')
    || file.path.startsWith('.studio-runtime/python/')
    || file.path.startsWith('.studio-runtime/rapidocr-models/'));
  if (bundledPython) throw new Error('主运行包意外包含 Python/OCR 环境；请重新下载完整 Release 包。');
  await Promise.all([
    access(nodePath), access(pythonPrepareScript), access(path.join(bundleRoot, 'web/dist/index.html')),
    access(path.join(bundleRoot, 'third_party/canvas/web/dist/index.html')),
    access(path.join(bundleRoot, 'third_party/canvas/canvas-agent/dist/index.js')),
    access(path.join(bundleRoot, 'adapters/dsh/lib/client.js')),
    access(path.join(bundleRoot, 'scripts/requirements-cleaner-ocr.lock.txt')),
    access(path.join(bundleRoot, 'scripts/requirements-workspace.lock.txt')),
  ]);
  return manifest;
}

function packageEnvironment(pythonRuntime) {
  return {
    ...process.env,
    STUDIO_RELEASE_BUNDLE: '1',
    STUDIO_OCR_PYTHON: pythonRuntime.pythonPath,
    STUDIO_RAPIDOCR_MODEL_DIR: pythonRuntime.modelRoot,
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
  };
}

async function acquireStartLock(root) {
  const lockPath = startLockPath(root);
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const owner = { pid: process.pid, token: randomUUID() };

  const create = async () => {
    const handle = await open(lockPath, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(owner));
      await handle.sync();
      return handle;
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(lockPath, { force: true }).catch(() => {});
      throw error;
    }
  };

  let handle;
  try {
    handle = await create();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let before;
    let previous;
    try {
      before = await readFile(lockPath, 'utf8');
      previous = JSON.parse(before);
      if (!Number.isSafeInteger(previous.pid) || previous.pid < 1 || typeof previous.token !== 'string') {
        throw new Error(startBusyMessage);
      }
      if (alive(previous.pid)) throw new Error(startBusyMessage);
      if (await readFile(lockPath, 'utf8') !== before) throw new Error(startBusyMessage);
      await rm(lockPath);
    } catch (readError) {
      if (readError.message === startBusyMessage) throw readError;
      if (readError.code !== 'ENOENT') throw new Error(startBusyMessage);
    }
    try {
      handle = await create();
    } catch (retryError) {
      if (retryError.code === 'EEXIST') throw new Error(startBusyMessage);
      throw retryError;
    }
  }

  return async () => {
    await handle.close();
    const current = await readJson(lockPath);
    if (current?.pid === owner.pid && current?.token === owner.token) await rm(lockPath, { force: true });
  };
}

async function readRunLogTail(logPath, offset, maximumBytes = 6000) {
  const info = await stat(logPath).catch(() => null);
  if (!info || info.size <= offset) return '';
  const length = Math.min(info.size - offset, maximumBytes);
  const handle = await open(logPath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, info.size - length);
    return buffer.subarray(0, bytesRead).toString('utf8').trim();
  } finally {
    await handle.close();
  }
}

async function preparationError(logPath, runStart, reason) {
  const tail = await readRunLogTail(logPath, runStart).catch(() => '');
  return new Error([
    '本机 Python/OCR 准备未完成，可重试。',
    reason ? `原因：${reason}` : '',
    tail ? `本次日志尾部：\n${tail}` : '本次未生成可读取的准备输出。',
    `完整日志：${logPath}`,
  ].filter(Boolean).join('\n'));
}

async function preparePythonRuntime(root) {
  const runtimeRoot = path.join(root, 'runtime');
  const runtimeStateRoot = path.join(runtimeRoot, '.studio-runtime');
  const logPath = path.join(root, 'python-prepare.log');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const previousLogSize = await stat(logPath).then(info => info.size, () => 0);
  const log = await open(logPath, 'a', 0o600);
  const header = `\n[${new Date().toISOString()}] 首次启动 Python/OCR 准备开始。\n`;
  await log.writeFile(header);
  const runStart = previousLogSize + Buffer.byteLength(header);
  process.stderr.write(`安装日志：${logPath}\n`);
  const child = spawn(nodePath, [pythonPrepareScript], {
    cwd: bundleRoot,
    env: { ...process.env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pendingWrites = [];
  let outputError = null;
  const persist = chunk => pendingWrites.push(log.write(chunk).catch(error => { outputError ||= error; }));
  child.stdout.on('data', chunk => {
    persist(chunk);
    process.stderr.write(chunk);
  });
  child.stderr.on('data', chunk => {
    persist(chunk);
    process.stderr.write(chunk);
  });
  let code;
  let spawnError;
  try {
    code = await new Promise(resolve => {
      child.once('error', error => { spawnError = error; });
      child.once('close', resolve);
    });
    await Promise.all(pendingWrites);
    if (spawnError) await log.writeFile(`[${new Date().toISOString()}] Python/OCR 准备进程启动失败：${spawnError.message}\n`);
    if (outputError) await log.writeFile(`[${new Date().toISOString()}] 写入 Python/OCR 准备日志失败：${outputError.message}\n`);
  } finally {
    await log.close();
  }
  if (spawnError) throw await preparationError(logPath, runStart, `准备进程启动失败：${spawnError.message}`);
  if (outputError) throw await preparationError(logPath, runStart, `写入准备日志失败：${outputError.message}`);
  if (code !== 0) throw await preparationError(logPath, runStart, `准备进程退出代码 ${code}`);

  let runtimeState;
  let dependencyState;
  let modelState;
  try {
    [runtimeState, dependencyState, modelState] = await Promise.all([
      readFile(path.join(runtimeStateRoot, 'python-runtime-state.json'), 'utf8').then(JSON.parse),
      readFile(path.join(runtimeStateRoot, 'python-state.json'), 'utf8').then(JSON.parse),
      readFile(path.join(runtimeStateRoot, 'rapidocr-model-state.json'), 'utf8').then(JSON.parse),
    ]);
  } catch (error) {
    throw await preparationError(logPath, runStart, `准备状态读取失败：${error.message}`);
  }
  const pythonPath = path.resolve(runtimeState.pythonExecutable || '');
  const modelRoot = path.resolve(modelState.modelRoot || '');
  if (runtimeState.status !== 'ready' || dependencyState.status !== 'ready' || modelState.status !== 'ready'
      || !runtimeState.pythonVersion?.startsWith('3.12.')
      || !pathWithin(runtimeRoot, pythonPath) || !pathWithin(runtimeRoot, modelRoot)) {
    throw await preparationError(logPath, runStart, '准备状态检查未通过（Python、依赖或 RapidOCR 模型尚未就绪）。');
  }
  try {
    await Promise.all([access(pythonPath), stat(modelRoot).then(info => {
      if (!info.isDirectory()) throw new Error('模型缓存路径不是目录。');
    })]);
  } catch (error) {
    throw await preparationError(logPath, runStart, `准备产物检查失败：${error.message}`);
  }
  return { pythonPath, modelRoot, logPath };
}

function runCapture(command, args, { env = process.env, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: bundleRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', value => stdout.push(value));
    child.stderr.on('data', value => stderr.push(value));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      const result = { code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (code === 0) resolve(result);
      else reject(new Error((result.stderr || result.stdout || `${command} exited with ${code}`).trim()));
    });
  });
}

async function openBrowser(url) {
  if (process.env.STUDIO_RELEASE_NO_OPEN === '1') return;
  const command = process.platform === 'darwin' ? 'open' : 'cmd.exe';
  const args = process.platform === 'darwin' ? [url] : ['/d', '/c', 'start', '', url];
  const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
  child.unref();
}

async function start() {
  await verifyBundle();
  const root = dataRoot();
  const existing = await runtimeStatus(root);
  if (existing.running) {
    await openBrowser(existing.url);
    return { running: true, reused: true, url: existing.url, message: '工作台已在运行，已打开本机页面。' };
  }
  const releaseStartLock = await acquireStartLock(root);
  try {
    const afterLock = await runtimeStatus(root);
    if (afterLock.running) {
      await openBrowser(afterLock.url);
      return { running: true, reused: true, url: afterLock.url, message: '工作台已在运行，已打开本机页面。' };
    }
    const pythonRuntime = await preparePythonRuntime(root);
    const afterPreparation = await runtimeStatus(root);
    if (afterPreparation.running) {
      await openBrowser(afterPreparation.url);
      return { running: true, reused: true, url: afterPreparation.url, message: '本机运行环境已就绪，工作台已在运行并打开页面。' };
    }
    const logs = path.join(root, 'web');
    await mkdir(logs, { recursive: true, mode: 0o700 });
    const log = await open(path.join(logs, 'service.log'), 'a', 0o600);
    const env = packageEnvironment(pythonRuntime);
    const webArgs = [path.join(bundleRoot, 'scripts/web.mjs'), '--no-open'];
    const child = spawn(nodePath, [...(process.allowedNodeEnvironmentFlags.has('--use-env-proxy') ? ['--use-env-proxy'] : []), ...webArgs], {
      cwd: bundleRoot, env, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
    });
    let childError = null;
    let exited = null;
    child.once('error', error => { childError = error; });
    child.once('exit', code => { exited = code; });
    child.unref();
    await log.close();

    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && !childError && exited === null) {
      const current = await runtimeStatus(root).catch(() => ({ running: false }));
      if (current.running) {
        await openBrowser(current.url);
        return { running: true, reused: false, url: current.url, message: '工作台已启动，正在默认浏览器打开。' };
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const detail = childError?.message ?? (exited !== null ? `启动进程已退出（代码 ${exited}）` : '启动超过 45 秒仍未健康就绪');
    throw new Error(`工作台启动失败：${detail}。可在本机应用数据目录的 web/service.log 查看日志。`);
  } finally {
    await releaseStartLock();
  }
}

async function stop() {
  const root = dataRoot();
  const workbench = await stopRuntime(root);
  const auxiliary = await stopAuxiliary(root);
  return { workbench, auxiliary, message: '工作台及已识别的 Canvas／模型服务已停止。' };
}

async function status() {
  await verifyBundle();
  const root = dataRoot();
  return { workbench: await runtimeStatus(root), auxiliary: await auxiliaryStatus(root) };
}

async function doctor() {
  const manifest = await verifyBundle();
  const root = dataRoot();
  const current = await runtimeStatus(root).catch(error => ({ running: false, error: error.message }));
  let pythonPrepared = false;
  try {
    const [pythonState, dependencyState, modelState] = await Promise.all([
      readFile(path.join(root, 'runtime/.studio-runtime/python-runtime-state.json'), 'utf8').then(JSON.parse),
      readFile(path.join(root, 'runtime/.studio-runtime/python-state.json'), 'utf8').then(JSON.parse),
      readFile(path.join(root, 'runtime/.studio-runtime/rapidocr-model-state.json'), 'utf8').then(JSON.parse),
    ]);
    pythonPrepared = pythonState.status === 'ready' && dependencyState.status === 'ready' && modelState.status === 'ready';
  } catch { /* First-start preparation has not completed yet. */ }
  return {
    package: { target: manifest.target, version: manifest.version, pythonRuntime: manifest.pythonRuntime, nodeVersion: manifest.nodeVersion },
    workbench: current,
    services: await auxiliaryStatus(root),
    checks: { node: await access(nodePath).then(() => true), pythonPrepared },
  };
}

function output(value) {
  if (value.message) {
    process.stdout.write(`${value.message}${value.url ? `\n${value.url}` : ''}\n`);
    return;
  }
  if (value.workbench) {
    const current = value.workbench;
    if (value.package && value.checks) {
      process.stdout.write(`运行包：${value.package.target} ${value.package.version}\nNode.js ${value.package.nodeVersion}\n`);
      process.stdout.write(`Python/OCR：${value.checks.pythonPrepared ? '已准备' : '首次启动时准备'}\n`);
      process.stdout.write(current.running ? `工作台：运行中 ${current.url}\n` : '工作台：未运行\n');
      process.stdout.write(`包内 Node 检查：${value.checks.node ? '通过' : '失败'}\n`);
      return;
    }
    process.stdout.write(current.running ? `工作台正在运行：${current.url}\n` : '工作台当前未运行。\n');
    if (value.auxiliary) process.stdout.write(`模型插件：${value.auxiliary.modelPluginRunning ? '运行中' : '未运行'}；Canvas 实例：${value.auxiliary.canvasInstances}\n`);
    return;
  }
}

try {
  const command = process.argv[2] ?? 'start';
  if (command === 'start') output(await start());
  else if (command === 'stop') output(await stop());
  else if (command === 'status') output(await status());
  else if (command === 'doctor') output(await doctor());
  else throw new Error('用法：start | stop | status | doctor');
} catch (error) {
  process.stderr.write(`${error?.message || 'Release 包操作失败'}\n`);
  process.exitCode = 1;
}
