#!/usr/bin/env node
import { access, mkdir, open, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataRoot } from '../src/canvas/client.mjs';
import { auxiliaryStatus, stopAuxiliary } from '../src/launcher/services.mjs';
import { runtimeStatus, stopRuntime } from '../src/launcher/control.mjs';

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodePath = process.execPath;
const pythonPath = path.join(bundleRoot, '.venv-ocr', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const expectedTarget = `${process.platform}-${process.arch}`;

async function verifyBundle() {
  const manifest = JSON.parse(await readFile(path.join(bundleRoot, 'release-manifest.json'), 'utf8'));
  if (manifest.product !== 'Creative Agent Studio' || manifest.target !== expectedTarget) {
    throw new Error(`此运行包为 ${manifest.target ?? '未知平台'} 构建，当前设备是 ${expectedTarget}。请下载对应平台版本。`);
  }
  await Promise.all([
    access(nodePath), access(pythonPath), access(path.join(bundleRoot, 'web/dist/index.html')),
    access(path.join(bundleRoot, 'third_party/canvas/web/dist/index.html')),
    access(path.join(bundleRoot, 'third_party/canvas/canvas-agent/dist/index.js')),
    access(path.join(bundleRoot, 'adapters/dsh/lib/client.js')),
  ]);
  if (!manifest.files.some(file => file.path.startsWith('.studio-runtime/rapidocr-models/') && file.path.endsWith('.onnx'))) {
    throw new Error('运行包缺少 OCR 模型，请重新下载完整 Release 包。');
  }
  const pythonIdentity = await runCapture(pythonPath, ['-I', '-c', 'import sys; print(".".join(map(str,sys.version_info[:3])))'], {
    env: packageEnvironment(), timeoutMs: 15_000,
  });
  if (!pythonIdentity.stdout.includes('3.12.')) throw new Error(`包内 Python 版本检查失败：${pythonIdentity.stdout.trim() || '无输出'}`);
  return manifest;
}

function packageEnvironment() {
  return {
    ...process.env,
    STUDIO_OCR_PYTHON: pythonPath,
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
  };
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
  const logs = path.join(root, 'web');
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const log = await open(path.join(logs, 'service.log'), 'a', 0o600);
  const env = packageEnvironment();
  const child = spawn(nodePath, [path.join(bundleRoot, 'scripts/web.mjs'), '--no-open'], {
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
  return {
    package: { target: manifest.target, version: manifest.version, pythonVersion: manifest.pythonVersion, nodeVersion: manifest.nodeVersion },
    workbench: current,
    services: await auxiliaryStatus(root),
    checks: { node: await access(nodePath).then(() => true), python: await access(pythonPath).then(() => true) },
  };
}

function output(value) {
  if (value.message) {
    process.stdout.write(`${value.message}${value.url ? `\n${value.url}` : ''}\n`);
    return;
  }
  if (value.workbench) {
    const current = value.workbench;
    process.stdout.write(current.running ? `工作台正在运行：${current.url}\n` : '工作台当前未运行。\n');
    if (value.auxiliary) process.stdout.write(`模型插件：${value.auxiliary.modelPluginRunning ? '运行中' : '未运行'}；Canvas 实例：${value.auxiliary.canvasInstances}\n`);
    return;
  }
  process.stdout.write(`运行包：${value.package.target} ${value.package.version}\nPython ${value.package.pythonVersion}；Node.js ${value.package.nodeVersion}\n`);
  process.stdout.write(value.workbench.running ? `工作台：运行中 ${value.workbench.url}\n` : '工作台：未运行\n');
  process.stdout.write(`包内 Node/Python 检查：${value.checks.node && value.checks.python ? '通过' : '失败'}\n`);
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
