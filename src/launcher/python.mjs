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

const MODULE_PATH = fileURLToPath(import.meta.url);
const DOWNLOAD_LIMIT = 80 * 1024 * 1024;
const PYTHON_HEALTH = String.raw`
import importlib
import importlib.metadata as metadata
import json
import pathlib
import sys

expected = json.loads(sys.argv[1])
prefix = pathlib.Path(sys.prefix).resolve()
expected_venv = pathlib.Path(expected["venv"]).resolve()
active_packages = {}
markers_healthy = True
try:
    from packaging.markers import Marker
except Exception:
    Marker = None
    markers_healthy = not any(package.get("marker") for package in expected["packages"].values())

for name, package in expected["packages"].items():
    marker = package.get("marker")
    if marker:
        if Marker is None:
            markers_healthy = False
            continue
        try:
            if not Marker(marker).evaluate():
                continue
        except Exception:
            markers_healthy = False
            continue
    active_packages[name] = package["version"]

versions = {}
for name in active_packages:
    try:
        versions[name] = metadata.version(name)
    except metadata.PackageNotFoundError:
        versions[name] = None

import_errors = {}
for name in expected["imports"]:
    try:
        importlib.import_module(name)
    except Exception as error:
        import_errors[name] = type(error).__name__

runtime_healthy = sys.version_info[:2] == tuple(expected["version"][:2]) and prefix == expected_venv
dependencies_healthy = markers_healthy and versions == active_packages and not import_errors
print(json.dumps({
    "version": list(sys.version_info[:3]),
    "prefix": str(prefix),
    "basePrefix": str(pathlib.Path(sys.base_prefix).resolve()),
    "versions": versions,
    "importErrors": import_errors,
    "runtimeHealthy": runtime_healthy,
    "dependenciesHealthy": dependencies_healthy,
    "ready": runtime_healthy and dependencies_healthy,
}))
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
    pythonHome: path.join(runtime, 'python'),
    modelRoot: path.join(runtime, 'rapidocr-models'),
    modelState: path.join(runtime, 'rapidocr-model-state.json'),
    pythonRuntimeState: path.join(runtime, 'python-runtime-state.json'),
    pythonState: path.join(runtime, 'python-state.json'),
    venv: path.join(root, '.venv-ocr'),
    venvStage: path.join(runtime, 'python-venv-stage'),
    venvBackups: path.join(runtime, 'python-venv-backups'),
    requirements: path.join(root, 'scripts', 'requirements-cleaner-ocr.txt'),
    lock: path.join(root, 'scripts', 'requirements-cleaner-ocr.lock.txt'),
    workspaceRequirements: path.join(root,'scripts','requirements-workspace.txt'),
    workspaceLock: path.join(root,'scripts','requirements-workspace.lock.txt'),
  };
}

function supportedAsset() {
  const key = `${process.platform}-${process.arch}`;
  const asset = UV_ASSETS[key];
  if (!asset) throw new Error(`当前平台暂不支持自动准备 OCR Python：${key}`);
  return asset;
}

function environmentFor(paths, { managedPython = false } = {}) {
  const env = { ...process.env, UV_NO_CONFIG: '1', UV_NO_PROGRESS: '1' };
  if (managedPython) {
    env.UV_PYTHON_INSTALL_DIR = paths.pythonHome;
    env.UV_PYTHON_BIN_DIR = path.join(paths.runtime, 'python-bin');
  }
  return env;
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

async function existingState(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; return null; }
}

function canonicalPackageName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

function parsePinnedPackages(contents, source) {
  const packages = {};
  for (const line of contents.split(/\r?\n/)) {
    const normalizedLine = line.trim().replace(/\s+\\$/, '').trim();
    const match = normalizedLine.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*==\s*([A-Za-z0-9][A-Za-z0-9.!+_-]*)(?:\s*;\s*(.+))?$/);
    if (!match) continue;
    const name = canonicalPackageName(match[1]);
    const packageSpec = { version: match[2], marker: match[3]?.trim() ?? null };
    if (packages[name] && JSON.stringify(packages[name]) !== JSON.stringify(packageSpec)) {
      throw new Error(`${source} 中 ${name} 出现冲突版本或环境标记。`);
    }
    packages[name] = packageSpec;
  }
  return packages;
}

async function dependencySpec(paths) {
  const [ocrRequirements, ocrLock, workspaceRequirements, workspaceLock] = await Promise.all([
    fs.readFile(paths.requirements, 'utf8'), fs.readFile(paths.lock, 'utf8'),
    fs.readFile(paths.workspaceRequirements,'utf8'), fs.readFile(paths.workspaceLock,'utf8'),
  ]);
  const requirementsText=ocrRequirements+'\n'+workspaceRequirements;
  const lockText=ocrLock+'\n'+workspaceLock;
  const requirements = parsePinnedPackages(requirementsText, path.basename(paths.requirements));
  const packages = parsePinnedPackages(lockText, path.basename(paths.lock));
  for (const [name, packageSpec] of Object.entries(requirements)) {
    if (JSON.stringify(packages[name]) !== JSON.stringify(packageSpec)) {
      throw new Error(`OCR 固定依赖锁缺少匹配版本：${name}==${packageSpec.version}。`);
    }
  }
  return { requirements, packages, requirementsText, lockText };
}

async function fingerprint(paths, spec) {
  const dependencies = spec ?? await dependencySpec(paths);
  const hash = createHash('sha256');
  hash.update(dependencies.requirementsText).update('\0').update(dependencies.lockText).update('\0');
  hash.update(JSON.stringify({ python: PYTHON_VERSION, platform: process.platform, arch: process.arch }));
  return hash.digest('hex');
}

function healthArguments(paths, spec) {
  return JSON.stringify({
    version: [3, 12, 0],
    packages: spec.packages,
    imports: spec.imports ?? ['rapidocr', 'onnxruntime', 'cv2', 'numpy', 'pypdfium2', 'openpyxl', 'docx'],
    venv: paths.venv,
  });
}

async function inspectPython(pythonPath, paths, spec) {
  try {
    await fs.access(pythonPath);
    const expected = healthArguments(paths, spec);
    const output = await run(pythonPath, ['-c', PYTHON_HEALTH, expected], {
      cwd: path.dirname(paths.venv), capture: true, timeout: 120_000,
    });
    return JSON.parse(output.stdout.trim().split(/\r?\n/).at(-1));
  } catch {
    return null;
  }
}

async function checkPython(pythonPath, paths, suppliedSpec) {
  const spec = suppliedSpec ?? await dependencySpec(paths);
  return (await inspectPython(pythonPath, paths, spec))?.ready === true;
}

async function modelFilesSnapshot(modelRoot) {
  const files = [];
  for (const file of await listFiles(modelRoot)) {
    if (!/\.(?:onnx|pdmodel)$/i.test(file)) continue;
    const info = await fs.stat(file);
    if (!info.isFile() || info.size === 0) continue;
    files.push({
      path: path.relative(modelRoot, file).split(path.sep).join('/'),
      size: info.size,
      sha256: await sha256File(file),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function verifyModelCache(modelRoot) {
  return (await modelFilesSnapshot(modelRoot)).length >= 2;
}

async function modelFingerprint(dependencyFingerprint) {
  return createHash('sha256')
    .update(OCR_WARMUP)
    .update('\0')
    .update(dependencyFingerprint)
    .digest('hex');
}

async function modelStateReady(paths, fingerprintValue) {
  const state = await existingState(paths.modelState);
  if (state?.status !== 'ready' || state.fingerprint !== fingerprintValue
      || state.modelRoot !== paths.modelRoot || !Array.isArray(state.files) || state.files.length < 2
      || typeof state.warmup?.sampleText !== 'string' || !state.warmup.sampleText.trim()
      || (typeof state.warmup.blankText === 'string' && state.warmup.blankText.trim())) return false;
  const currentFiles = await modelFilesSnapshot(paths.modelRoot);
  return JSON.stringify(currentFiles) === JSON.stringify(state.files);
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

function supportedUvVersion(stdout) {
  const match = stdout.trim().match(/^uv\s+(\d+)\.(\d+)\.(\d+)(?:\s|$)/i);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 0 || minor > 11 || (minor === 11 && patch >= 0);
}

async function resolveUv({ nodePath, paths, onProgress }) {
  for (const command of ['uv', paths.uvExecutable]) {
    try {
      const version = await run(command, ['--version'], { capture: true, timeout: 20_000 });
      if (supportedUvVersion(version.stdout)) {
        return { command, version: version.stdout.trim().replace(/^uv\s+/i, ''), source: command === 'uv' ? 'path' : 'project-private' };
      }
    } catch { /* Try the next available uv or the pinned private fallback. */ }
  }
  const command = await installUv({ nodePath, paths, onProgress });
  return { command, version: UV_VERSION, source: 'downloaded-project-private' };
}

const PYTHON_IDENTITY = String.raw`
import json
import sys
print(json.dumps({"version": list(sys.version_info[:3]), "executable": sys.executable}))
`;

async function findSystemPython312() {
  const candidates = process.platform === 'win32'
    ? [
      { command: 'py', prefix: ['-3.12'] },
      { command: 'python3.12', prefix: [] },
      { command: 'python', prefix: [] },
    ]
    : [
      { command: 'python3.12', prefix: [] },
      { command: 'python3', prefix: [] },
      { command: 'python', prefix: [] },
    ];
  for (const candidate of candidates) {
    try {
      const result = await run(candidate.command, [...candidate.prefix, '-c', PYTHON_IDENTITY], {
        capture: true, timeout: 20_000,
      });
      const identity = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
      if (identity.version?.[0] === 3 && identity.version?.[1] === 12 && identity.executable) {
        return { executable: identity.executable, version: identity.version };
      }
    } catch { /* A missing or unsupported system Python is not a failure. */ }
  }
  return null;
}

async function createVenv(uv, venvPath, systemPython, paths, projectRoot) {
  const env = environmentFor(paths, { managedPython: !systemPython });
  await fs.mkdir(path.dirname(venvPath), { recursive: true });
  if (systemPython) {
    await run(uv, ['venv', '--no-config', '--no-project', '--relocatable', '--python', systemPython.executable, venvPath], {
      cwd: projectRoot, env,
    });
    return;
  }
  await fs.mkdir(paths.pythonHome, { recursive: true });
  await run(uv, ['python', 'install', '--managed-python', '--install-dir', paths.pythonHome, '--no-bin', PYTHON_VERSION], {
    cwd: projectRoot, env,
  });
  await run(uv, ['venv', '--no-config', '--no-project', '--relocatable', '--managed-python', '--python', PYTHON_VERSION, venvPath], {
    cwd: projectRoot, env,
  });
}

async function syncDependencies(uv, pythonPath, paths, projectRoot) {
  const env = environmentFor(paths);
  await run(uv, ['pip', 'sync', '--no-config', '--python', pythonPath, '--require-hashes', paths.lock, paths.workspaceLock], {
    cwd: projectRoot, env,
  });
  await run(uv, ['pip', 'check', '--python', pythonPath], {
    cwd: projectRoot, env, timeout: 5 * 60 * 1000,
  });
}

async function pathExists(candidate) {
  return fs.access(candidate).then(() => true, () => false);
}

async function preserveInvalidStage(paths) {
  if (!(await pathExists(paths.venvStage))) return null;
  const archive = `${paths.venvStage}.incomplete-${Date.now()}-${randomUUID()}`;
  await fs.rename(paths.venvStage, archive);
  return archive;
}

async function assertRelocatableScripts(venvPath, stagePath) {
  const scriptDirectories = [path.join(venvPath, 'bin'), path.join(venvPath, 'Scripts')];
  const stageReferences = new Set([
    path.resolve(stagePath),
    path.resolve(stagePath).replaceAll(path.sep, '/'),
    path.resolve(stagePath).replaceAll('/', '\\'),
  ]);
  let activationScriptFound = false;
  let consoleScriptFound = false;
  for (const directory of scriptDirectories) {
    for (const file of await listFiles(directory)) {
      const name = path.basename(file);
      if (/^activate(?:\..+)?$/i.test(name)) activationScriptFound = true;
      else if (!/^(?:python(?:\d+(?:\.\d+)*)?(?:\.exe)?|pydoc(?:\d+(?:\.\d+)*)?(?:\.bat|\.exe)?)$/i.test(name)) {
        consoleScriptFound = true;
      }
      const contents = await fs.readFile(file);
      if (contents.includes(0)) continue;
      const text = contents.toString('utf8');
      if ([...stageReferences].some((reference) => reference && text.includes(reference))) {
        throw new Error(`OCR 虚拟环境脚本仍引用临时 stage 路径：${path.relative(venvPath, file)}。`);
      }
    }
  }
  if (!activationScriptFound || !consoleScriptFound) {
    throw new Error('OCR 虚拟环境缺少可验证的激活脚本或 console script。');
  }
}

async function promoteStage(paths, spec, operations) {
  const oldVenvExists = await pathExists(paths.venv);
  let backupPath = null;
  if (oldVenvExists) {
    await fs.mkdir(paths.venvBackups, { recursive: true });
    backupPath = path.join(paths.venvBackups, `venv-${Date.now()}-${randomUUID()}`);
    await fs.rename(paths.venv, backupPath);
  }
  try {
    await fs.rename(paths.venvStage, paths.venv);
    await assertRelocatableScripts(paths.venv, paths.venvStage);
    const promoted = await operations.inspectPython(pythonExecutable(paths.venv), paths, spec);
    if (!promoted?.ready) throw new Error('替换后的 OCR Python 虚拟环境未通过路径、版本和锁依赖复核。');
    return { backupPath };
  } catch (error) {
    if (await pathExists(paths.venv)) {
      const failedPath = `${paths.venvStage}.failed-${Date.now()}-${randomUUID()}`;
      await fs.rename(paths.venv, failedPath).catch(() => {});
    }
    if (backupPath && await pathExists(backupPath)) await fs.rename(backupPath, paths.venv);
    throw error;
  }
}

function sourceFromHealth(health, paths) {
  return pathIsWithin(paths.pythonHome, health.basePrefix ?? '')
    ? 'project-managed-python'
    : 'external-python-base';
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function runtimeIsUsable(health, paths, managedOnly) {
  return health?.runtimeHealthy === true
    && (!managedOnly || pathIsWithin(paths.pythonHome, health?.basePrefix ?? ''));
}

async function writeReadyStates(paths, { digest, spec, health, pythonPath, runtimeSource, uvVersion }) {
  const version = health.version.join('.');
  const runtimeState = {
    status: 'ready', pythonExecutable: pythonPath, pythonVersion: version,
    basePrefix: health.basePrefix, runtimeSource,
  };
  const previousRuntimeState = await existingState(paths.pythonRuntimeState);
  if (previousRuntimeState?.status !== 'ready'
      || previousRuntimeState.pythonExecutable !== pythonPath
      || previousRuntimeState.pythonVersion !== version
      || previousRuntimeState.basePrefix !== health.basePrefix
      || previousRuntimeState.runtimeSource !== runtimeSource) {
    await writeJsonAtomically(paths.pythonRuntimeState, { ...runtimeState, verifiedAt: new Date().toISOString() });
  }

  const dependencyState = { status: 'ready', fingerprint: digest, pythonVersion: version, packages: spec.packages };
  const previousDependencyState = await existingState(paths.pythonState);
  if (previousDependencyState?.status !== 'ready'
      || previousDependencyState.fingerprint !== digest
      || previousDependencyState.pythonVersion !== version
      || JSON.stringify(previousDependencyState.packages) !== JSON.stringify(spec.packages)) {
    await writeJsonAtomically(paths.pythonState, {
      ...dependencyState, uvVersion: uvVersion ?? previousDependencyState?.uvVersion ?? null,
      checkedAt: new Date().toISOString(),
    });
  }
}

async function preparePythonCore({ root, onProgress = () => {}, nodePath = process.execPath, beforeChange, managedOnly = false }, injectedOperations = {}) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('Python 准备器需要源码根目录。');
  const projectRoot = path.resolve(root);
  const paths = runtimePaths(projectRoot);
  await fs.access(paths.requirements);
  await fs.access(paths.lock);
  const spec = await dependencySpec(paths);
  const digest = await fingerprint(paths, spec);
  const modelDigest = await modelFingerprint(digest);
  const pythonPath = pythonExecutable(paths.venv);
  const operations = {
    inspectPython,
    resolveUv,
    findSystemPython312,
    createVenv,
    syncDependencies,
    warmOcr,
    ...injectedOperations,
  };

  let health = await operations.inspectPython(pythonPath, paths, spec);
  let runtimeReady = runtimeIsUsable(health, paths, managedOnly);
  let dependenciesReady = runtimeReady && health?.dependenciesHealthy === true;
  const modelsReady = await modelStateReady(paths, modelDigest);
  const needsChanges = !runtimeReady || !dependenciesReady || !modelsReady;

  // The caller checks that changing installed output is safe; a healthy reuse is read-only.
  if (needsChanges && beforeChange) await beforeChange();

  let changed = false;
  let uvInfo = null;
  let promotion = null;
  let runtimeAttempted = false;
  let dependencyAttempted = false;
  let warmupAttempted = false;
  const getUv = async () => {
    if (!uvInfo) uvInfo = await operations.resolveUv({ nodePath, paths, onProgress });
    return uvInfo;
  };

  try {
    await fs.mkdir(paths.runtime, { recursive: true });
    if (runtimeReady && !dependenciesReady) {
      await writeReadyRuntimeStateIfMissing(paths, health, pythonPath, sourceFromHealth(health, paths));
      report(onProgress, 'install', '仅同步不完整或版本不符的 OCR 固定依赖。');
      const uv = await getUv();
      dependencyAttempted = true;
      await operations.syncDependencies(uv.command, pythonPath, paths, projectRoot);
      changed = true;
      health = await operations.inspectPython(pythonPath, paths, spec);
      if (!health?.ready) throw new Error('同步后 OCR Python 未通过锁定包版本、导入和运行检查。');
      dependenciesReady = true;
      dependencyAttempted = false;
    } else if (!runtimeReady) {
      runtimeAttempted = true;
      const uv = await getUv();
      const stagePaths = { ...paths, venv: paths.venvStage };
      const stagePython = pythonExecutable(paths.venvStage);
      let stageHealth = await operations.inspectPython(stagePython, stagePaths, spec);
      if (!runtimeIsUsable(stageHealth, stagePaths, managedOnly)) {
        await preserveInvalidStage(paths);
        const systemPython = managedOnly ? null : await operations.findSystemPython312();
        report(onProgress, 'install', systemPython
          ? `使用本机 Python ${systemPython.version.join('.')} 创建项目私有 OCR 虚拟环境。`
          : `准备项目私有 Python ${PYTHON_VERSION}。`);
        await operations.createVenv(uv.command, paths.venvStage, systemPython, paths, projectRoot);
        changed = true;
        stageHealth = await operations.inspectPython(stagePython, stagePaths, spec);
      }
      if (!runtimeIsUsable(stageHealth, stagePaths, managedOnly)) throw new Error('新建 OCR Python 虚拟环境未通过 3.12 版本与项目路径检查。');
      if (!stageHealth.dependenciesHealthy) {
        report(onProgress, 'install', '同步带 SHA-256 哈希的完整 OCR 固定依赖。');
        dependencyAttempted = true;
        await operations.syncDependencies(uv.command, stagePython, stagePaths, projectRoot);
        changed = true;
        stageHealth = await operations.inspectPython(stagePython, stagePaths, spec);
      }
      if (!stageHealth?.ready) throw new Error('新建 OCR Python 虚拟环境未通过锁定包版本和导入检查。');

      promotion = await promoteStage(paths, spec, operations);
      changed = true;
      health = await operations.inspectPython(pythonPath, paths, spec);
      if (!health?.ready) throw new Error('替换后的 OCR Python 虚拟环境未通过最终复核。');
      runtimeReady = true;
      dependenciesReady = true;
      runtimeAttempted = false;
      dependencyAttempted = false;
    }

    if (!runtimeReady || !dependenciesReady || !health?.ready) {
      throw new Error('OCR Python 运行时或固定依赖尚未就绪。');
    }

    const runtimeSource = sourceFromHealth(health, paths);
    // Keep runtime and dependency readiness if model warmup fails, so a retry only warms models.
    await writeReadyStates(paths, {
      digest, spec, health, pythonPath, runtimeSource, uvVersion: uvInfo?.version,
    });

    let warmResult = null;
    if (!(await modelStateReady(paths, modelDigest))) {
      report(onProgress, 'install', '实际启动 RapidOCR 并核验空白与文字样例，预热模型缓存。');
      warmupAttempted = true;
      warmResult = await operations.warmOcr(pythonPath, paths.modelRoot, projectRoot);
      const modelFiles = await modelFilesSnapshot(paths.modelRoot);
      if (modelFiles.length < 2 || !warmResult?.sampleText?.trim() || warmResult.blankText?.trim()) {
        throw new Error('RapidOCR 实际预热未生成完整模型集，或真实文字样例未通过。');
      }
      await writeJsonAtomically(paths.modelState, {
        status: 'ready', fingerprint: modelDigest, modelRoot: paths.modelRoot,
        files: modelFiles, warmup: warmResult, warmedAt: new Date().toISOString(),
      });
      changed = true;
    }

    if (await fingerprint(paths) !== digest) {
      throw new Error('OCR 依赖清单在准备期间变化；保留已完成环境，下次只重新检查 OCR。');
    }
    report(onProgress, changed ? 'ready' : 'skip', changed
      ? '项目私有 OCR Python、锁定依赖与已验证 RapidOCR 模型缓存就绪。'
      : '项目私有 OCR Python、锁定依赖与已验证 RapidOCR 模型缓存均已就绪。');
    return {
      skipped: !changed,
      fingerprint: digest,
      pythonExecutable: pythonPath,
      pythonVersion: health.version.join('.'),
      uvVersion: uvInfo?.version ?? null,
      runtimeSource,
      basePrefix: health.basePrefix,
    };
  } catch (error) {
    if (runtimeAttempted && !promotion && !runtimeReady) {
      await writeJsonAtomically(paths.pythonRuntimeState, {
        status: 'failed', failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => {});
    }
    if (dependencyAttempted) {
      await writeJsonAtomically(paths.pythonState, {
        status: 'failed', fingerprint: digest, failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => {});
    }
    if (warmupAttempted) {
      await writeJsonAtomically(paths.modelState, {
        status: 'failed', fingerprint: modelDigest, failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => {});
    }
    throw error;
  }
}

async function writeReadyRuntimeStateIfMissing(paths, health, pythonPath, runtimeSource) {
  const state = await existingState(paths.pythonRuntimeState);
  const version = health.version.join('.');
  if (state?.status === 'ready' && state.pythonExecutable === pythonPath
      && state.pythonVersion === version && state.basePrefix === health.basePrefix
      && state.runtimeSource === runtimeSource) return;
  await writeJsonAtomically(paths.pythonRuntimeState, {
    status: 'ready', pythonExecutable: pythonPath, pythonVersion: version,
    basePrefix: health.basePrefix, runtimeSource, verifiedAt: new Date().toISOString(),
  });
}

/** Reuse a healthy project venv, repair locked packages in place, and warm models only when unclaimed. */
export async function preparePython(options = {}) {
  return preparePythonCore(options);
}

export const pythonInternals = Object.freeze({
  runtimePaths, pythonExecutable, supportedAsset, fingerprint, dependencySpec,
  inspectPython, checkPython, verifyModelCache, modelStateReady, prepareWithOperations: preparePythonCore,
});

if (process.argv[2] === '--download-helper') {
  const [, , , url, destination] = process.argv;
  if (!url || !destination) throw new Error('下载 helper 参数缺失。');
  await downloadFile(url, destination);
}
