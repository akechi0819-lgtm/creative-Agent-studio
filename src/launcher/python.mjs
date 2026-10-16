import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const UV_VERSION = '0.12.24';
export const PYTHON_VERSION = '3.12.15';

const UV_ASSETS = Object.freeze({
  'darwin-arm64': { file: 'uv-aarch64-apple-darwin.tar.gz', sha256: '0c4346de7abdb49495b393b9ec809fe387aa43e586be20fecb972216c1e71732' },
  'darwin-x64': { file: 'uv-x86_64-apple-darwin.tar.gz', sha256: '4fa82e37cb94767661f532b001e470b67a186c7260e305bd84ddb78fd545c0b6' },
  'win32-arm64': { file: 'uv-aarch64-pc-windows-msvc.zip', sha256: '4b783bda5cc44bbae0651a837223873a7acee31152381aef5fc86ef6bef25997' },
  'win32-x64': { file: 'uv-x86_64-pc-windows-msvc.zip', sha256: '7c38608c8a18ee137d748a1773053b07ec8f3a30fab49aebaa6f4e4efeceb019' },
  'linux-arm64': { file: 'uv-aarch64-unknown-linux-gnu.tar.gz', sha256: '5231be65f496304623895dacdbf1de8504fec90303684bdf05805aa34414dd21' },
  'linux-x64': { file: 'uv-x86_64-unknown-linux-gnu.tar.gz', sha256: 'b4dfaef47d491a7296981f8374a4595f55dbf84e8937c8ecd2983574d8bb3da6' },
});

const PACKAGE_VERSIONS = Object.freeze({
  rapidocr: '3.10.0',
  onnxruntime: '1.31.0',
  'opencv-python-headless': '5.0.0.93',
  pypdfium2: '5.14.0',
});

const MODULE_PATH = fileURLToPath(import.meta.url);
const DOWNLOAD_LIMIT = 80 * 1024 * 1024;
const PYTHON_HEALTH = String.raw`
import importlib.metadata as metadata
import json
import pathlib
import sys

expected = json.loads(sys.argv[1])
versions = {
    "rapidocr": metadata.version("rapidocr"),
    "onnxruntime": metadata.version("onnxruntime"),
    "opencv-python-headless": metadata.version("opencv-python-headless"),
    "pypdfium2": metadata.version("pypdfium2"),
}
import rapidocr
import onnxruntime
import cv2
import pypdfium2

prefix = pathlib.Path(sys.prefix).resolve()
base = pathlib.Path(sys.base_prefix).resolve()
expected_venv = pathlib.Path(expected["venv"]).resolve()
expected_python = pathlib.Path(expected["pythonHome"]).resolve()
if sys.version_info[:3] != tuple(expected["version"]):
    raise RuntimeError("python_patch_mismatch")
if prefix != expected_venv:
    raise RuntimeError("python_venv_mismatch")
if expected_python not in base.parents and base != expected_python:
    raise RuntimeError("python_base_outside_private_runtime")
if versions != expected["packages"]:
    raise RuntimeError("python_package_versions_mismatch")
print(json.dumps({"version": list(sys.version_info[:3]), "versions": versions}))
`;

const OCR_WARMUP = String.raw`
import json
import pathlib
import sys

import cv2
import numpy as np
from rapidocr import RapidOCR

model_root = pathlib.Path(sys.argv[1]).resolve()
model_root.mkdir(parents=True, exist_ok=True)
engine = RapidOCR(params={"Global.model_root_dir": str(model_root)})

blank = np.full((120, 420, 3), 255, dtype=np.uint8)
blank_result = engine(blank)
blank_text = " ".join(getattr(blank_result, "txts", None) or []).strip()
if blank_text:
    raise RuntimeError("rapidocr_blank_fixture_expected_no_text")

sample = np.full((180, 720, 3), 255, dtype=np.uint8)
cv2.putText(sample, "P4 OCR SAMPLE", (16, 130), cv2.FONT_HERSHEY_SIMPLEX, 2.5, (0, 0, 0), 5, cv2.LINE_AA)
sample_result = engine(sample)
recognized = " ".join(getattr(sample_result, "txts", None) or []).strip()
if not recognized:
    raise RuntimeError("rapidocr_text_fixture_expected_recognition")
print(json.dumps({"blankText": blank_text, "sampleText": recognized}, ensure_ascii=False))
`;

function report(onProgress, phase, message) {
  onProgress({ phase, target: 'OCR Python', message });
}

function pythonExecutable(venvPath) {
  return path.join(venvPath, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}

function runtimePaths(root) {
  const runtime = path.join(root, '.studio-runtime');
  const uvDirectory = path.join(runtime, 'uv');
  return {
    runtime,
    uvDirectory,
    uvExecutable: path.join(uvDirectory, process.platform === 'win32' ? 'uv.exe' : 'uv'),
    uvCache: path.join(uvDirectory, 'cache'),
    pythonHome: path.join(runtime, 'python'),
    modelRoot: path.join(runtime, 'rapidocr-models'),
    pythonState: path.join(runtime, 'python-state.json'),
    venv: path.join(root, '.venv-ocr'),
    requirements: path.join(root, 'scripts', 'requirements-cleaner-ocr.txt'),
    lock: path.join(root, 'scripts', 'requirements-cleaner-ocr.lock.txt'),
  };
}

function supportedAsset() {
  const key = `${process.platform}-${process.arch}`;
  const asset = UV_ASSETS[key];
  if (!asset) throw new Error(`当前平台暂不支持自动准备 OCR Python：${key}`);
  return asset;
}

function environmentFor(paths) {
  return {
    ...process.env,
    UV_CACHE_DIR: paths.uvCache,
    UV_PYTHON_INSTALL_DIR: paths.pythonHome,
    UV_PYTHON_BIN_DIR: path.join(paths.runtime, 'python-bin'),
    UV_PYTHON_PREFERENCE: 'only-managed',
    UV_NO_CONFIG: '1',
    UV_NO_PROGRESS: '1',
  };
}

function run(command, args, { cwd, env = process.env, capture = false, timeout = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      killTimer.unref?.();
    }, timeout);
    timer.unref?.();
    if (capture) {
      child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    }
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`命令超时：${path.basename(command)}`));
      if (code !== 0) {
        const detail = capture ? Buffer.concat(stderr).toString('utf8').trim().slice(-3000) : '';
        return reject(new Error(`${path.basename(command)} 退出码 ${code ?? signal ?? 'unknown'}${detail ? `：${detail}` : ''}`));
      }
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

async function sha256File(file) {
  const hash = createHash('sha256');
  const content = await fs.readFile(file);
  hash.update(content);
  return hash.digest('hex');
}

async function downloadFile(url, destination) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('只允许通过 HTTPS 下载官方运行时文件。');
  const response = await fetch(parsed, { signal: AbortSignal.timeout(180_000), redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`下载返回 HTTP ${response.status}。`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > DOWNLOAD_LIMIT) throw new Error('官方 uv 安装包超过下载大小限制。');
    chunks.push(bytes);
  }
  await fs.writeFile(destination, Buffer.concat(chunks, size), { flag: 'wx', mode: 0o600 });
}

function hasProxyEnvironment() {
  return ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
    .some((key) => Boolean(process.env[key]));
}

async function downloadWithSupportedProxy(nodePath, url, destination) {
  const supportsProxyFlag = process.allowedNodeEnvironmentFlags?.has('--use-env-proxy') === true;
  const isFlagEnabled = process.execArgv.includes('--use-env-proxy');
  if (!supportsProxyFlag || !hasProxyEnvironment() || isFlagEnabled) {
    await downloadFile(url, destination);
    return;
  }
  await run(nodePath, ['--use-env-proxy', MODULE_PATH, '--download-helper', url, destination], {
    cwd: path.dirname(MODULE_PATH), env: process.env, timeout: 4 * 60 * 1000,
  });
}

async function listFiles(directory) {
  const files = [];
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function writeJsonAtomically(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function fingerprint(paths) {
  const hash = createHash('sha256');
  const files = [MODULE_PATH, paths.requirements, paths.lock, path.join(path.dirname(paths.requirements), 'ocr_materials.py')];
  for (const file of files) {
    hash.update(path.basename(file)).update('\0').update(await fs.readFile(file)).update('\0');
  }
  hash.update(JSON.stringify({ uv: UV_VERSION, python: PYTHON_VERSION, platform: process.platform, arch: process.arch }));
  return hash.digest('hex');
}

async function existingState(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; return null; }
}

async function checkPython(pythonPath, paths) {
  try {
    await fs.access(pythonPath);
    const expected = JSON.stringify({
      version: PYTHON_VERSION.split('.').map(Number),
      packages: PACKAGE_VERSIONS,
      venv: paths.venv,
      pythonHome: paths.pythonHome,
    });
    await run(pythonPath, ['-c', PYTHON_HEALTH, expected], { cwd: path.dirname(paths.venv), capture: true, timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

async function verifyModelCache(modelRoot) {
  const files = await listFiles(modelRoot);
  return files.some((file) => file.endsWith('.onnx') || file.endsWith('.pdmodel'));
}

async function installUv({ nodePath, paths, onProgress }) {
  const asset = supportedAsset();
  const binaryName = process.platform === 'win32' ? 'uv.exe' : 'uv';
  const expectedVersion = new RegExp(`^uv ${UV_VERSION.replaceAll('.', '\\.')}\\b`);
  try {
    const version = await run(paths.uvExecutable, ['--version'], { capture: true, timeout: 20_000 });
    if (expectedVersion.test(version.stdout.trim())) return paths.uvExecutable;
  } catch { /* Missing or stale binary: fetch the pinned official build. */ }

  report(onProgress, 'install', `下载并校验官方 uv ${UV_VERSION}。`);
  await fs.mkdir(paths.uvDirectory, { recursive: true });
  const downloadDirectory = path.join(paths.runtime, 'downloads');
  await fs.mkdir(downloadDirectory, { recursive: true });
  const archive = path.join(downloadDirectory, `uv-${UV_VERSION}-${asset.file}`);
  if (await fs.access(archive).then(() => true, () => false)) {
    if (await sha256File(archive) !== asset.sha256) await fs.rm(archive, { force: true });
  }
  if (!(await fs.access(archive).then(() => true, () => false))) {
    const url = `https://releases.astral.sh/github/uv/releases/download/${UV_VERSION}/${asset.file}`;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const temporary = `${archive}.${process.pid}.${randomUUID()}.partial`;
      try {
        await downloadWithSupportedProxy(nodePath, url, temporary);
        const digest = await sha256File(temporary);
        if (digest !== asset.sha256) throw new Error('官方 uv 安装包 SHA-256 校验失败。');
        await fs.rename(temporary, archive);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await fs.rm(temporary, { force: true });
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      }
    }
    if (lastError) throw new Error(`获取官方 uv 安装包失败，可重试准备：${lastError.message}`);
  }

  const extractDirectory = path.join(paths.runtime, `uv-extract-${process.pid}-${randomUUID()}`);
  await fs.mkdir(extractDirectory, { recursive: true });
  try {
    report(onProgress, 'install', '解压 uv 到项目私有运行时目录。');
    if (process.platform === 'win32') {
      const helper = path.join(extractDirectory, 'expand-archive.ps1');
      await fs.writeFile(helper,
        'param([Parameter(Mandatory=$true)][string]$ArchivePath,[Parameter(Mandatory=$true)][string]$DestinationPath)\n'
        + 'Expand-Archive -LiteralPath $ArchivePath -DestinationPath $DestinationPath -Force\n',
        'utf8');
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
        '-ArchivePath', archive, '-DestinationPath', extractDirectory], { cwd: extractDirectory, timeout: 120_000 });
    } else {
      await run('tar', ['-xzf', archive, '-C', extractDirectory], { cwd: extractDirectory, timeout: 120_000 });
    }
    const extracted = (await listFiles(extractDirectory)).find((file) => path.basename(file) === binaryName);
    if (!extracted) throw new Error(`官方 uv 压缩包中缺少 ${binaryName}。`);
    await fs.copyFile(extracted, paths.uvExecutable);
    if (process.platform !== 'win32') await fs.chmod(paths.uvExecutable, 0o700);
    const version = await run(paths.uvExecutable, ['--version'], { capture: true, timeout: 20_000 });
    if (!expectedVersion.test(version.stdout.trim())) throw new Error(`下载的 uv 版本不匹配：${version.stdout.trim()}`);
  } finally {
    await fs.rm(extractDirectory, { recursive: true, force: true });
  }
  return paths.uvExecutable;
}

async function warmOcr(pythonPath, modelRoot, root) {
  await fs.mkdir(modelRoot, { recursive: true });
  const output = await run(pythonPath, ['-c', OCR_WARMUP, modelRoot], {
    cwd: root,
    env: { ...process.env, OMP_NUM_THREADS: '1' },
    capture: true,
    timeout: 15 * 60 * 1000,
  });
  return JSON.parse(output.stdout.trim().split(/\r?\n/).at(-1));
}

/**
 * Prepare a project-private Python 3.12 OCR runtime and warm RapidOCR models.
 * A qualified existing `.venv-ocr` is reused; no system Python is modified.
 */
export async function preparePython({ root, force = false, onProgress = () => {}, nodePath = process.execPath } = {}) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('Python 准备器需要源码根目录。');
  const projectRoot = path.resolve(root);
  const paths = runtimePaths(projectRoot);
  await fs.access(paths.requirements);
  await fs.access(paths.lock);
  const digest = await fingerprint(paths);
  const pythonPath = pythonExecutable(paths.venv);
  const state = await existingState(paths.pythonState);
  const runtimeHealthy = await checkPython(pythonPath, paths);
  const modelsReady = await verifyModelCache(paths.modelRoot);

  if (!force && state?.status === 'ready' && state.fingerprint === digest && runtimeHealthy && modelsReady) {
    report(onProgress, 'skip', '固定 OCR Python 依赖与模型缓存已就绪，跳过准备。');
    return { skipped: true, fingerprint: digest, pythonExecutable: pythonPath };
  }

  await fs.mkdir(paths.runtime, { recursive: true });
  await writeJsonAtomically(paths.pythonState, { status: 'preparing', fingerprint: digest, startedAt: new Date().toISOString() });
  try {
    const uv = await installUv({ nodePath, paths, onProgress });
    const env = environmentFor(paths);
    await fs.mkdir(paths.uvCache, { recursive: true });
    await fs.mkdir(paths.pythonHome, { recursive: true });
    if (!runtimeHealthy || force) {
      report(onProgress, 'install', `准备项目私有 Python ${PYTHON_VERSION}。`);
      await run(uv, ['python', 'install', '--managed-python', '--install-dir', paths.pythonHome, '--no-bin',
        ...(force ? ['--reinstall'] : []), PYTHON_VERSION], { cwd: projectRoot, env });
      await fs.rm(paths.venv, { recursive: true, force: true });
      await run(uv, ['venv', '--no-config', '--no-project', '--managed-python', '--python', PYTHON_VERSION, paths.venv], {
        cwd: projectRoot, env,
      });
    }
    report(onProgress, 'install', '同步带 SHA-256 哈希的完整 OCR 固定依赖。');
    await run(uv, ['pip', 'sync', '--no-config', '--python', pythonPath, '--require-hashes', paths.lock], {
      cwd: projectRoot, env,
    });
    await run(uv, ['pip', 'check', '--python', pythonPath], { cwd: projectRoot, env, timeout: 5 * 60 * 1000 });
    if (!(await checkPython(pythonPath, paths))) throw new Error('私有 OCR Python 运行时未通过版本与依赖导入检查。');

    report(onProgress, 'install', '启动 RapidOCR 并预热私有模型缓存。');
    const warmResult = await warmOcr(pythonPath, paths.modelRoot, projectRoot);
    if (!(await verifyModelCache(paths.modelRoot))) throw new Error('RapidOCR 预热结束但没有生成本地模型文件。');
    await writeJsonAtomically(paths.pythonState, {
      status: 'ready', fingerprint: digest, pythonVersion: PYTHON_VERSION, uvVersion: UV_VERSION,
      modelRoot: path.relative(projectRoot, paths.modelRoot), warmedAt: new Date().toISOString(),
      warmup: warmResult,
    });
    report(onProgress, 'ready', 'OCR Python、固定依赖与 RapidOCR 模型缓存已就绪。');
    return { skipped: false, fingerprint: digest, pythonExecutable: pythonPath, warmup: warmResult };
  } catch (error) {
    await writeJsonAtomically(paths.pythonState, {
      status: 'failed', fingerprint: digest, failedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export const pythonInternals = Object.freeze({ runtimePaths, pythonExecutable, supportedAsset, fingerprint, checkPython, verifyModelCache });

if (process.argv[2] === '--download-helper') {
  const [, , , url, destination] = process.argv;
  if (!url || !destination) throw new Error('下载 helper 参数缺失。');
  await downloadFile(url, destination);
}
