#!/usr/bin/env node
import { access, mkdir, open, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataRoot } from '../src/canvas/client.mjs';
import { pathWithin } from '../src/launcher/distribution.mjs';
import { auxiliaryStatus, stopAuxiliary } from '../src/launcher/services.mjs';
import { runtimeStatus, stopRuntime } from '../src/launcher/control.mjs';

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodePath = process.execPath;
const expectedTarget = `${process.platform}-${process.arch}`;
const pythonPrepareScript = path.join(bundleRoot, 'release/prepare-python.mjs');

async function verifyBundle({ requireCompanyServices = true } = {}) {
  const manifest = JSON.parse(await readFile(path.join(bundleRoot, 'release-manifest.json'), 'utf8'));
  const profile = manifest.profile ?? 'general';
  const expectedProduct = profile === 'company' ? 'Creative Agent Studio Company' : 'Creative Agent Studio';
  if (!['general', 'company'].includes(profile) || manifest.product !== expectedProduct || manifest.target !== expectedTarget) {
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
  if (profile === 'company' && requireCompanyServices) {
    const file = path.join(bundleRoot, 'company-services.json');
    if (!manifest.files.some(entry => entry.path === 'company-services.json')) throw new Error('公司版运行包缺少管理员服务预配文件。');
    const { readCompanyDeployment } = await import('../src/company/deployment.mjs');
    const deployment = await readCompanyDeployment({ file });
    if (!deployment.configured) throw new Error('公司版运行包缺少有效服务配置，请联系管理员重新获取运行包。');
  }
  return manifest;
}

function packageEnvironment(pythonRuntime) {
  return {
    ...process.env,
    STUDIO_OCR_PYTHON: pythonRuntime.pythonPath,
    STUDIO_RAPIDOCR_MODEL_DIR: pythonRuntime.modelRoot,
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
  };
}

async function preparePythonRuntime(root) {
  const runtimeRoot = path.join(root, 'runtime');
  const runtimeStateRoot = path.join(runtimeRoot, '.studio-runtime');
  const logPath = path.join(root, 'python-prepare.log');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const log = await open(logPath, 'a', 0o600);
  await log.writeFile(`\n[${new Date().toISOString()}] 首次启动 Python/OCR 准备开始。\n`);
  const child = spawn(nodePath, [pythonPrepareScript], {
    cwd: bundleRoot,
    env: { ...process.env },
    windowsHide: true,
    stdio: ['ignore', log.fd, log.fd],
  });
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
  } catch (error) {
    await log.writeFile(`[${new Date().toISOString()}] Python/OCR 准备进程启动失败：${error.message}\n`);
    throw new Error(`本机 Python/OCR 准备未完成，可重试；安装日志：${logPath}`);
  } finally {
    await log.close();
  }
  if (code !== 0) throw new Error(`本机 Python/OCR 准备未完成，可重试；安装日志：${logPath}`);

  let runtimeState;
  let dependencyState;
  let modelState;
  try {
    [runtimeState, dependencyState, modelState] = await Promise.all([
      readFile(path.join(runtimeStateRoot, 'python-runtime-state.json'), 'utf8').then(JSON.parse),
      readFile(path.join(runtimeStateRoot, 'python-state.json'), 'utf8').then(JSON.parse),
      readFile(path.join(runtimeStateRoot, 'rapidocr-model-state.json'), 'utf8').then(JSON.parse),
    ]);
  } catch {
    throw new Error(`本机 Python/OCR 准备状态不完整，可重试；安装日志：${logPath}`);
  }
  const pythonPath = path.resolve(runtimeState.pythonExecutable || '');
  const modelRoot = path.resolve(modelState.modelRoot || '');
  if (runtimeState.status !== 'ready' || dependencyState.status !== 'ready' || modelState.status !== 'ready'
      || !runtimeState.pythonVersion?.startsWith('3.12.')
      || !pathWithin(runtimeRoot, pythonPath) || !pathWithin(runtimeRoot, modelRoot)) {
    throw new Error(`本机 Python/OCR 检查未通过，可重试；安装日志：${logPath}`);
  }
  await Promise.all([access(pythonPath), stat(modelRoot).then(info => {
    if (!info.isDirectory()) throw new Error('模型缓存路径不是目录。');
  })]);
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
  const manifest = await verifyBundle();
  const companyProfile = manifest.profile === 'company';
  const root = dataRoot();
  const existing = await runtimeStatus(root);
  if (existing.running) {
    await openBrowser(existing.url);
    return { running: true, reused: true, url: existing.url, message: '工作台已在运行，已打开本机页面。' };
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
  if (companyProfile) webArgs.push('--port', '4311');
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
}

async function stop() {
  await verifyBundle({ requireCompanyServices: false });
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
