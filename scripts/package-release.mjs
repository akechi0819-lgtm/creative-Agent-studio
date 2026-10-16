#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  RELEASE_TARGETS, assertCleanWorkingTree, assertNativeTarget, copyAllowlistedFiles,
  hashFile, materializeBundleSymlinks, normalizeTargetId, pathWithin, pruneBuildState,
  trackedFiles, validatePortablePython, writeBundleManifest,
} from '../src/launcher/distribution.mjs';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_VERSION = '22.23.3';
const REQUIRED_NODE_VERSION = `v${NODE_VERSION}`;

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!['--target', '--version', '--output'].includes(name)) throw new Error(`未知参数：${name}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} 需要一个值。`);
    options[name.slice(2)] = value;
  }
  if (!options.target) throw new Error('必须指定 --target darwin-arm64|darwin-x64|win32-x64。');
  if (!options.version) throw new Error('必须指定 --version。');
  if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,79}$/.test(options.version)) throw new Error('版本号格式无效。');
  if (!options.output) throw new Error('必须指定源码树外的 --output 目录。');
  return options;
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  } catch (error) {
    throw new Error(`命令失败：${command} ${args.join(' ')}（退出码 ${error.status ?? 'unknown'}）`, { cause: error });
  }
}

function environmentWithoutSystemPython(stage, nodePath) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const pathEntries = process.platform === 'win32'
    ? [path.dirname(nodePath), path.join(systemRoot, 'System32'), systemRoot]
    : [path.dirname(nodePath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return {
    ...process.env,
    PATH: pathEntries.join(path.delimiter),
    UV_NO_CONFIG: '1',
    UV_NO_PROGRESS: '1',
    UV_CACHE_DIR: path.join(stage, '.studio-runtime', 'uv-cache'),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
}

async function downloadPinnedNode(target, stage) {
  const runtimeRoot = path.join(stage, '.studio-runtime', 'node');
  const downloadRoot = path.join(stage, '.studio-runtime', 'downloads');
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(downloadRoot, { recursive: true });
  const archivePath = path.join(downloadRoot, target.nodeArchive);
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${target.nodeArchive}`;
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Node.js ${NODE_VERSION} 下载失败：HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archivePath, { flags: 'wx' }));
  const digest = await hashFile(archivePath);
  if (digest !== target.nodeSha256) throw new Error(`Node.js 官方运行时哈希不匹配：${target.id}`);
  run('tar', ['-xf', archivePath, '-C', runtimeRoot]);
  await rm(archivePath, { force: true });
  const nodePath = path.join(stage, target.nodeRelative);
  const output = execFileSync(nodePath, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  if (output !== REQUIRED_NODE_VERSION) throw new Error(`随包 Node.js 版本不符：${output}`);
  return nodePath;
}

async function verifyBundledPython(stage, env) {
  const uv = path.join(stage, '.studio-runtime', 'uv', process.platform === 'win32' ? 'uv.exe' : 'uv');
  const python = path.join(stage, '.venv-ocr', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  await access(uv);
  await access(python);
  run(uv, ['pip', 'check', '--python', python], { cwd: stage, env });
  run(python, ['-I', '-c', 'import cv2, docx, numpy, openpyxl, rapidocr; print("OCR/Office imports: ready")'], { cwd: stage, env });
  return python;
}

async function packageNodeRuntime(nodePath, stage) {
  const nodeRoot = path.resolve(path.dirname(nodePath), process.platform === 'win32' ? '.' : '..');
  const nodeModules = path.join(nodeRoot, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules');
  await rm(nodeModules, { recursive: true, force: true });
  const wrappers = process.platform === 'win32'
    ? ['npm', 'npm.cmd', 'npx', 'npx.cmd', 'corepack', 'corepack.cmd', 'corepack.ps1']
    : ['npm', 'npx', 'corepack'];
  for (const name of wrappers) await rm(path.join(path.dirname(nodePath), name), { force: true });
  for (const base of [stage, path.join(stage, 'adapters/dsh'), path.join(stage, 'third_party/canvas/web'), path.join(stage, 'third_party/canvas/canvas-agent')]) {
    await removeNpmBinLinks(path.join(base, 'node_modules'));
  }
}

async function removeNpmBinLinks(nodeModules) {
  const info = await lstat(nodeModules).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info?.isDirectory() || info.isSymbolicLink()) return;
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    const child = path.join(nodeModules, entry.name);
    if (entry.name === '.bin') {
      await rm(child, { recursive: true, force: true });
    } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
      if (entry.name.startsWith('@')) await removeNpmBinLinks(child);
      else await removeNpmBinLinks(path.join(child, 'node_modules'));
    }
  }
}

async function licenseFileCandidates(directory) {
  const names = [];
  const rootEntries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  names.push(...rootEntries.filter(entry => entry.isFile() && /^(?:licen[cs]e|copying|notice|copyright)(?:\..*)?$/i.test(entry.name)).map(entry => entry.name));
  for (const licenseDirectory of ['licenses', 'license']) {
    const licenseRoot = path.join(directory, licenseDirectory);
    for (const entry of await readdir(licenseRoot, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile()) names.push(`${licenseDirectory}/${entry.name}`);
    }
  }
  return names.sort();
}

async function npmPackageRecords(nodeModules, relativeRoot, output = []) {
  const info = await lstat(nodeModules).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info?.isDirectory() || info.isSymbolicLink()) return output;
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    if (entry.name.startsWith('@')) {
      await npmPackageRecords(path.join(nodeModules, entry.name), relativeRoot, output);
      continue;
    }
    const directory = path.join(nodeModules, entry.name);
    const packagePath = path.join(directory, 'package.json');
    try {
      const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
      output.push({ name: pkg.name ?? entry.name, version: pkg.version ?? 'unknown', license: pkg.license ?? null,
        path: path.relative(relativeRoot, directory).split(path.sep).join('/'), licenseFiles: await licenseFileCandidates(directory) });
    } catch { /* Non-package directories inside node_modules are not inventory entries. */ }
    await npmPackageRecords(path.join(directory, 'node_modules'), relativeRoot, output);
  }
  return output;
}

async function pythonPackageRecords(sitePackages, relativeRoot) {
  const result = [];
  const info = await readdir(sitePackages, { withFileTypes: true });
  for (const entry of info.filter(value => value.isDirectory() && value.name.endsWith('.dist-info'))) {
    const directory = path.join(sitePackages, entry.name);
    const metadata = await readFile(path.join(directory, 'METADATA'), 'utf8').catch(() => '');
    const field = name => metadata.match(new RegExp(`^${name}: (.+)$`, 'mi'))?.[1] ?? null;
    const licenseDir = path.join(directory, 'licenses');
    const licenseFiles = await readdir(licenseDir, { withFileTypes: true }).then(entries => entries.filter(item => item.isFile()).map(item => `licenses/${item.name}`)).catch(() => []);
    result.push({ name: field('Name') ?? entry.name.replace(/\.dist-info$/, ''), version: field('Version') ?? 'unknown', license: field('License-Expression') ?? field('License'),
      path: path.relative(relativeRoot, directory).split(path.sep).join('/'), licenseFiles });
  }
  return result;
}

async function findPythonRuntimeLicenses(runtimeRoot, stage) {
  const known = [
    'LICENSE.txt', 'LICENSE', 'install/LICENSE.txt', 'install/LICENSE',
    'install/share/doc/python3.12/LICENSE.txt', 'install/share/licenses/python3.12/LICENSE.txt',
    'install/lib/python3.12/LICENSE.txt',
  ];
  const found = [];
  for (const relative of known) {
    if (await access(path.join(runtimeRoot, relative)).then(() => true, () => false)) {
      found.push(path.relative(stage, path.join(runtimeRoot, relative)).split(path.sep).join('/'));
    }
  }
  async function walk(directory, depth) {
    if (depth > 6) return;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const absolute = path.join(directory, entry.name);
      if (entry.isFile() && /^(?:LICENSE|COPYING)(?:\..*)?$/i.test(entry.name)) {
        found.push(path.relative(stage, absolute).split(path.sep).join('/'));
      } else if (entry.isDirectory() && !['site-packages', '__pycache__'].includes(entry.name)) {
        await walk(absolute, depth + 1);
      }
    }
  }
  if (!found.length) await walk(runtimeRoot, 0);
  return found;
}

async function writeLicenseInventory(stage, target, nodePath) {
  const roots = [stage, path.join(stage, 'adapters/dsh'), path.join(stage, 'third_party/canvas/web'), path.join(stage, 'third_party/canvas/canvas-agent')];
  const npm = [];
  for (const root of roots) npm.push(...await npmPackageRecords(path.join(root, 'node_modules'), stage));
  const sitePackages = [
    path.join(stage, '.venv-ocr', 'lib', 'python3.12', 'site-packages'),
    path.join(stage, '.venv-ocr', 'Lib', 'site-packages'),
  ];
  let python = [];
  for (const candidate of sitePackages) {
    python = await pythonPackageRecords(candidate, stage).catch(() => []);
    if (python.length) break;
  }
  const missing = [...npm.filter(item => !item.license).map(item => `npm:${item.name}@${item.version}`),
    ...python.filter(item => !item.license).map(item => `python:${item.name}==${item.version}`)];
  if (missing.length) throw new Error(`依赖元数据缺少许可证字段，请先人工核对：${missing.slice(0, 12).join('、')}`);
  const targetRoot = path.dirname(nodePath);
  const nodeRuntimeRoot = process.platform === 'win32' ? targetRoot : path.resolve(targetRoot, '..');
  const nodeLicense = path.join(nodeRuntimeRoot, 'LICENSE');
  const nodeLicensePresent = await access(nodeLicense).then(() => true, () => false);
  const pythonRuntimeLicenses = await findPythonRuntimeLicenses(path.join(stage, '.studio-runtime/python'), stage);
  const mplPackages = npm.filter(item => String(item.license).includes('MPL-2.0'));
  const lgplPackages = npm.filter(item => String(item.license).includes('LGPL-3.0'));
  const ccByPackages = npm.filter(item => String(item.license).includes('CC-BY-4.0'));
  const sharpLibvips = npm.filter(item => item.name.startsWith('@img/sharp-libvips-'));
  const libreOfficePackages = npm.filter(item => item.name.startsWith('@deepseek-ai/libreoffice-kit'));
  const tesseractDataPackages = npm.filter(item => item.name.startsWith('@tesseract.js-data/'));
  const expectedStaticNotices = [
    'release/licenses/Apache-2.0.txt', 'release/licenses/CC-BY-4.0.txt',
    'release/licenses/LGPL-3.0.txt',
    'release/licenses/MPL-2.0.txt', 'release/NOTICE-third-party.md',
    'release/NOTICE-rapidocr-models.md',
  ];
  const evidenceFailures = [];
  for (const relative of expectedStaticNotices) {
    if (!await access(path.join(stage, relative)).then(() => true, () => false)) evidenceFailures.push(`缺少随包许可材料 ${relative}`);
  }
  if (!nodeLicensePresent) evidenceFailures.push('Node.js 官方运行时未保留 LICENSE 文件');
  if (!pythonRuntimeLicenses.length) evidenceFailures.push('Python 3.12 官方运行时未找到 LICENSE.txt');
  if (mplPackages.length && !libreOfficePackages.some(item => item.licenseFiles.some(file => /(^|\/)LICENSE$/i.test(file)))) {
    evidenceFailures.push('MPL-2.0 组件没有随包可定位的 LICENSE');
  }
  if (ccByPackages.length && !await access(path.join(stage, 'release/licenses/CC-BY-4.0.txt')).then(() => true, () => false)) {
    evidenceFailures.push('CC-BY-4.0 组件缺少许可证文本');
  }
  for (const pkg of sharpLibvips) {
    const packageRoot = path.join(stage, pkg.path);
    const hasReadme = await access(path.join(packageRoot, 'README.md')).then(() => true, () => false);
    const hasVersions = await access(path.join(packageRoot, 'versions.json')).then(() => true, () => false);
    const nativeFiles = await readdir(path.join(packageRoot, 'lib'), { withFileTypes: true }).catch(() => []);
    if (!hasReadme || !hasVersions || !nativeFiles.some(item => /\.(?:dll|dylib|so(?:\.\d+)*)$/i.test(item.name))) {
      evidenceFailures.push(`sharp-libvips LGPL 动态库或版本来源材料不完整：${pkg.path}`);
    }
  }
  const inventory = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    note: '上游许可证与 NOTICE 文件随包保留。此清单及自动检查记录可核验的包内材料，不构成法律意见。',
    runtime: {
      target: target.id,
      node: { version: REQUIRED_NODE_VERSION, path: path.relative(stage, nodeLicense).split(path.sep).join('/'), licensePresent: nodeLicensePresent },
      python: { version: '3.12.15', licenseFiles: pythonRuntimeLicenses },
    },
    identifiedObligations: {
      mpl2: { packages: mplPackages, notice: 'release/NOTICE-third-party.md', sourceChanges: '本项目不修改这些上游包；若未来修改 MPL 覆盖代码，发布必须提供对应修改源码。' },
      lgpl3: { packages: lgplPackages, sharpLibvips, notice: 'release/NOTICE-third-party.md', replaceableDynamicLibraries: true },
      ccBy4: { packages: ccByPackages, notice: 'release/NOTICE-third-party.md', attribution: 'Can I Use / caniuse.com' },
      tesseractModels: {
        packages: tesseractDataPackages,
        upstreamDataLicense: 'Apache-2.0',
        packageDeclaredLicense: 'MIT',
        licenseText: 'release/licenses/Apache-2.0.txt',
        note: '保留每个 npm 包原始 package.json 的 MIT 声明；训练数据由上游 Apache-2.0 仓库提供。包不包含单独 MIT 许可文本文件。',
      },
      libreOffice: { packages: libreOfficePackages, licenseFiles: libreOfficePackages.map(item => ({ package: item.path, files: item.licenseFiles })) },
    },
    packageLocations: {
      nodeLicense: nodeLicensePresent ? path.relative(stage, nodeLicense).split(path.sep).join('/') : null,
      pythonRuntimeLicenses,
      pythonPackageLicenses: python.map(item => ({ name: item.name, version: item.version, path: item.path, license: item.license, licenseFiles: item.licenseFiles })),
      tesseractModels: npm.filter(item => item.name.startsWith('@tesseract.js-data/')).map(item => ({ name: item.name, version: item.version, path: item.path, declaredLicense: item.license })),
    },
    releaseLicenseGate: { status: evidenceFailures.length ? 'blocked' : 'evidence-complete', blockers: evidenceFailures },
    npm,
    python,
  };
  await writeFile(path.join(stage, 'THIRD-PARTY-LICENSES.json'), `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
  if (evidenceFailures.length) process.stderr.write(`许可材料检查：该包可用于 build-only 审查，但正式 tag 发布被阻止：${evidenceFailures.join('；')}\n`);
  return inventory;
}

async function makeMacApp(stage, target) {
  const bundle = path.join(stage, 'Creative Agent Studio.app');
  const sourcePath = path.join(stage, 'release/macos-launcher.applescript');
  const source = await readFile(sourcePath, 'utf8');
  const marker = '__NODE_DIRECTORY__';
  if (!source.includes(marker)) throw new Error('macOS 启动脚本缺少 Node 目录占位符。');
  const nodeDirectoryName = path.posix.basename(path.posix.dirname(path.posix.dirname(target.nodeRelative)));
  const compiledSource = path.join(stage, '.studio-runtime', 'macos-launcher.applescript');
  await writeFile(compiledSource, source.replaceAll(marker, nodeDirectoryName), { flag: 'wx' });
  run('osacompile', ['-o', bundle, compiledSource]);
  const compiledScript = path.join(bundle, 'Contents/Resources/Scripts/main.scpt');
  const decompiled = execFileSync('osadecompile', [compiledScript], { encoding: 'utf8' });
  if (!decompiled.includes(nodeDirectoryName) || decompiled.includes(marker)) {
    throw new Error('编译后的 macOS 图形启动器没有指向本平台随包 Node。');
  }
  await rm(compiledSource, { force: true });
}

async function makeWindowsEntry(stage) {
  await copyFile(path.join(stage, 'release/windows-start.vbs'), path.join(stage, 'Start.vbs'));
  const scriptPath = path.join(stage, 'release/windows-start.ps1');
  const powershell = (await readFile(scriptPath, 'utf8')).replace(/^\uFEFF/u, '');
  if (!powershell.includes('node-v22.23.3-win-x64\\node.exe')) throw new Error('Windows 图形启动器未指向随包 Node。');
  // Windows PowerShell 5.1 needs a BOM to decode Chinese source as UTF-8.
  await writeFile(scriptPath, `\uFEFF${powershell}`, 'utf8');
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:CAS_LAUNCHER_SCRIPT,[ref]$tokens,[ref]$errors); if($errors.Count){throw ($errors | Out-String)}'], {
    env: {...process.env, CAS_LAUNCHER_SCRIPT:scriptPath},
  });
}

async function relocatedRuntimeSmoke(stage, target) {
  const nodePath = path.join(stage, target.nodeRelative);
  const pythonPath = path.join(stage, '.venv-ocr', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'cas-release-smoke-data-'));
  const env = {
    ...environmentWithoutSystemPython(stage, nodePath),
    STUDIO_DATA_DIR: dataRoot,
    STUDIO_OCR_PYTHON: pythonPath,
    STUDIO_RELEASE_NO_OPEN: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
  };
  const launcherPath = path.join(stage, 'release/launcher.mjs');
  const workspace = path.join(dataRoot, 'office-smoke');
  try {
    const nodeVersion = execFileSync(nodePath, ['--version'], { cwd: stage, env, encoding: 'utf8', windowsHide: true }).trim();
    if (nodeVersion !== REQUIRED_NODE_VERSION) throw new Error(`搬移后 Node 运行检查失败：${nodeVersion}`);
    const nodeImports = execFileSync(nodePath, ['--input-type=module', '-e', "await import('sharp'); await import('@deepseek-ai/libreoffice-kit'); console.log('native node imports ready')"], {
      cwd: path.join(stage, 'adapters/dsh'), env, encoding: 'utf8', windowsHide: true,
    }).trim();
    if (!nodeImports.includes('native node imports ready')) throw new Error('搬移后的 Node 原生依赖导入未通过。');
    const pythonCode = [
      'import pathlib, sys, cv2, docx, numpy, openpyxl, rapidocr',
      'root = pathlib.Path(sys.argv[1]).resolve()',
      'assert pathlib.Path(sys.prefix).resolve() == (root / ".venv-ocr").resolve(), sys.prefix',
      'assert pathlib.Path(sys.base_prefix).resolve().is_relative_to((root / ".studio-runtime" / "python").resolve()), sys.base_prefix',
      'print("private OCR/Office imports ready")',
    ].join('; ');
    const pythonResult = execFileSync(pythonPath, ['-I', '-c', pythonCode, stage], { cwd: stage, env, encoding: 'utf8', windowsHide: true }).trim();
    if (!pythonResult.includes('private OCR/Office imports ready')) throw new Error('搬移后的 OCR/Office Python 导入未通过。');

    const ocr = execFileSync(pythonPath, ['-I', path.join(stage, 'scripts/ocr_materials.py'), 'image', path.join(stage, 'adapters/dsh/connection-check.png')], {
      cwd: stage, env, encoding: 'utf8', windowsHide: true, timeout: 120_000,
    }).trim();
    const ocrResult = JSON.parse(ocr);
    if (ocrResult.kind !== 'image' || !Array.isArray(ocrResult.pages) || ocrResult.pages.length !== 1) {
      throw new Error('搬移后的本地 OCR JSON 健康检查失败。');
    }

    await mkdir(path.join(workspace, 'inputs'), { recursive: true });
    await mkdir(path.join(workspace, 'outputs'), { recursive: true });
    const documentPath = path.join(workspace, 'inputs/release-smoke.docx');
    execFileSync(pythonPath, ['-I', '-c', 'import sys; from docx import Document; doc=Document(); doc.add_paragraph("portable runtime smoke"); doc.save(sys.argv[1])', documentPath], {
      cwd: stage, env, windowsHide: true,
    });
    const conversionScript = [
      "import { CONVERSION_FORMATS, createConverter } from '@deepseek-ai/libreoffice-kit';",
      "import { convertWorkspaceDocument } from '../../src/workspace/conversion.mjs';",
      `const workspaceRoot = ${JSON.stringify(workspace)};`,
      "const result = await convertWorkspaceDocument({ workspaceRoot, relativePath: 'inputs/release-smoke.docx', fileName: 'release-smoke.pdf', format: 'pdf', libreOfficeKit: { CONVERSION_FORMATS, createConverter } });",
      "if (result.backend !== 'native') throw new Error(`Expected native LibreOfficeKit backend, received ${result.backend}`);",
      "console.log(JSON.stringify(result));",
    ].join('\n');
    const conversionOutput = execFileSync(nodePath, ['--input-type=module', '-e', conversionScript], {
      cwd: path.join(stage, 'adapters/dsh'), env, encoding: 'utf8', windowsHide: true, timeout: 180_000,
    }).trim();
    const conversionResult = JSON.parse(conversionOutput);
    if (conversionResult.format !== 'pdf' || conversionResult.backend !== 'native' || conversionResult.bytes < 1) {
      throw new Error('搬移后的原生 LibreOfficeKit PDF 转换检查失败。');
    }

    const startOutput = execFileSync(nodePath, [launcherPath, 'start'], { cwd: stage, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 }).trim();
    if (!startOutput.includes('工作台已启动')) throw new Error('搬移后的图形启动器调用未启动本机 Web 工作台。');
    const runtime = JSON.parse(await readFile(path.join(dataRoot, 'web/runtime.json'), 'utf8'));
    const health = await fetch(`${runtime.controlUrl}/health`, {
      headers: { authorization: `Bearer ${runtime.token}` }, signal: AbortSignal.timeout(5_000), redirect: 'error',
    });
    const healthBody = await health.json();
    if (!health.ok || healthBody.instanceId !== runtime.instanceId) throw new Error('搬移后 Web 工作台健康 API 身份检查失败。');
    const statusOutput = execFileSync(nodePath, [launcherPath, 'status'], { cwd: stage, env, encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim();
    if (!statusOutput.includes('正在运行')) throw new Error('搬移后的运行状态检查未识别健康工作台。');
    execFileSync(nodePath, [launcherPath, 'stop'], { cwd: stage, env, encoding: 'utf8', windowsHide: true, timeout: 45_000 });
    const stoppedOutput = execFileSync(nodePath, [launcherPath, 'status'], { cwd: stage, env, encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim();
    if (!stoppedOutput.includes('未运行')) throw new Error('搬移后的停止检查未完成。');
    process.stdout.write(`搬移后端到端检查通过：${target.id} / Node ${nodeVersion} / Python imports / OCR JSON / native LibreOffice PDF / Web health-start-status-stop。\n`);
  } finally {
    try { execFileSync(nodePath, [launcherPath, 'stop'], { cwd: stage, env, encoding: 'utf8', windowsHide: true, timeout: 45_000 }); } catch { /* The normal test path stops cleanly; this is only failure cleanup. */ }
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function archiveName(version, target) {
  const labels = { 'darwin-arm64': 'macOS-arm64', 'darwin-x64': 'macOS-x64', 'win32-x64': 'Windows-x64' };
  return `Creative-Agent-Studio-${version}-${labels[target]}.zip`;
}

async function makeArchive(stage, archivePath) {
  if (process.platform === 'darwin') {
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', stage, archivePath]);
  } else {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$source = [System.IO.Path]::GetFullPath($env:CAS_RELEASE_SOURCE).TrimEnd([char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar))
$destination = [System.IO.Path]::GetFullPath($env:CAS_RELEASE_ARCHIVE)
$rootName = [System.IO.Path]::GetFileName($source)
$zip = [System.IO.Compression.ZipFile]::Open($destination, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $separators = [char[]]@([char]92, [char]47)
  Get-ChildItem -LiteralPath $source -Force -File -Recurse | ForEach-Object {
    $relative = $_.FullName.Substring($source.Length).TrimStart($separators).Replace([char]92, [char]47)
    $entryName = "$rootName/$relative"
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal)
  }
} finally {
  $zip.Dispose()
}

$check = [System.IO.Compression.ZipFile]::OpenRead($destination)
try {
  $entries = @{}
  foreach ($entry in $check.Entries) { $entries[$entry.FullName] = $true }
  $manifestName = "$rootName/release-manifest.json"
  if (-not $entries.ContainsKey($manifestName)) { throw 'Windows ZIP 缺少 release-manifest.json。' }
  $manifestReader = New-Object System.IO.StreamReader($check.GetEntry($manifestName).Open())
  try { $manifest = ConvertFrom-Json -InputObject $manifestReader.ReadToEnd() }
  finally { $manifestReader.Dispose() }
  foreach ($file in $manifest.files) {
    $entryName = "$rootName/$($file.path)"
    if (-not $entries.ContainsKey($entryName)) { throw "Windows ZIP 缺少 manifest 文件：$entryName" }
  }
  $required = @(
    "$rootName/.studio-runtime/node/node-v22.23.3-win-x64/node.exe",
    "$rootName/.venv-ocr/Scripts/python.exe"
  )
  foreach ($entryName in $required) {
    if (-not $entries.ContainsKey($entryName)) { throw "Windows ZIP 缺少随包运行时：$entryName" }
  }
  $pythonRoot = "$rootName/.studio-runtime/python/"
  if (-not ($check.Entries | Where-Object { $_.FullName.StartsWith($pythonRoot, [System.StringComparison]::OrdinalIgnoreCase) -and $_.FullName -match '/python(?:3(?:\.12)?)?\.exe$' })) {
    throw 'Windows ZIP 缺少随包 Python 基础运行时。'
  }
  $modelRoot = "$rootName/.studio-runtime/rapidocr-models/"
  if (-not ($check.Entries | Where-Object { $_.FullName.StartsWith($modelRoot, [System.StringComparison]::OrdinalIgnoreCase) -and $_.FullName.EndsWith('.onnx', [System.StringComparison]::OrdinalIgnoreCase) })) {
    throw 'Windows ZIP 缺少随包 RapidOCR ONNX 模型。'
  }
} finally {
  $check.Dispose()
}
`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      env: { ...process.env, CAS_RELEASE_SOURCE: stage, CAS_RELEASE_ARCHIVE: archivePath },
    });
  }
}

async function build(options) {
  const targetId = normalizeTargetId(options.target);
  const target = assertNativeTarget(targetId);
  const source = path.resolve(SOURCE_ROOT);
  const outputRoot = path.resolve(options.output);
  if (pathWithin(source, outputRoot)) throw new Error('Release 输出目录必须位于源码工作树之外。');
  assertCleanWorkingTree(source);

  const parent = await mkdtemp(path.join(os.tmpdir(), 'cas-release-'));
  const rootName = `Creative-Agent-Studio-${options.version}-${targetId}`;
  let stage = path.join(parent, rootName);
  let relocationRoot;
  try {
    const selected = await copyAllowlistedFiles(source, stage, trackedFiles(source));
    process.stdout.write(`按 allowlist 复制 ${selected.length} 个已跟踪源文件。\n`);
    const nodePath = await downloadPinnedNode(target, stage);
    const env = environmentWithoutSystemPython(stage, nodePath);
    const originalPath = process.env.PATH;
    const originalUvCache = process.env.UV_CACHE_DIR;
    process.env.PATH = env.PATH;
    process.env.UV_CACHE_DIR = env.UV_CACHE_DIR;
    process.env.UV_NO_CONFIG = '1';
    process.env.UV_NO_PROGRESS = '1';
    let preparation;
    try {
      const { prepareWorkspace } = await import(pathToFileURL(path.join(stage, 'src/launcher/prepare.mjs')).href);
      preparation = await prepareWorkspace({ root: stage, nodePath, onProgress: ({ message }) => process.stdout.write(`${message}\n`) });
    } finally {
      process.env.PATH = originalPath;
      if (originalUvCache === undefined) delete process.env.UV_CACHE_DIR;
      else process.env.UV_CACHE_DIR = originalUvCache;
      delete process.env.UV_NO_CONFIG;
      delete process.env.UV_NO_PROGRESS;
    }
    process.stdout.write(`源码依赖、前端、Canvas、DSH 与 OCR 资源完成准备（${preparation.fingerprint}）。\n`);
    const pythonPath = await verifyBundledPython(stage, env);
    await validatePortablePython(stage);
    for (const directory of ['.', 'adapters/dsh', 'third_party/canvas/web', 'third_party/canvas/canvas-agent']) {
      const targetRoot = path.resolve(stage, directory);
      const cliCandidates = [
        path.join(path.dirname(nodePath), 'node_modules/npm/bin/npm-cli.js'),
        path.resolve(path.dirname(nodePath), '../lib/node_modules/npm/bin/npm-cli.js'),
        path.resolve(path.dirname(nodePath), '../node_modules/npm/bin/npm-cli.js'),
      ];
      let npmCli;
      for (const candidate of cliCandidates) {
        if (await access(candidate).then(() => true, () => false)) { npmCli = candidate; break; }
      }
      if (!npmCli) throw new Error('随包 Node.js 的 npm CLI 未找到，无法裁剪开发依赖。');
      run(nodePath, [npmCli, 'prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: targetRoot, env });
    }
    await packageNodeRuntime(nodePath, stage);
    await writeLicenseInventory(stage, target, nodePath);
    if (target.platform === 'darwin') await makeMacApp(stage, target);
    else await makeWindowsEntry(stage);
    await pruneBuildState(stage);
    const pythonCheck = execFileSync(pythonPath, ['-I', '-c', 'import cv2, docx, numpy, openpyxl, rapidocr; print("portable runtime ready")'], { cwd: stage, env, encoding: 'utf8' }).trim();
    if (!pythonCheck.includes('portable runtime ready')) throw new Error('OCR/Office runtime 便携导入校验未通过。');
    await materializeBundleSymlinks(stage);
    relocationRoot = await mkdtemp(path.join(os.tmpdir(), 'cas-release-moved-'));
    const relocatedStage = path.join(relocationRoot, rootName);
    await rename(stage, relocatedStage);
    stage = relocatedStage;
    const manifest = await writeBundleManifest(stage, targetId, options.version);
    if (!manifest.files.some(file => file.path.startsWith('.studio-runtime/rapidocr-models/') && file.path.endsWith('.onnx'))) {
      throw new Error('Release staging 缺少 RapidOCR 模型文件。');
    }
    await relocatedRuntimeSmoke(stage, target);
    await mkdir(outputRoot, { recursive: true });
    const filename = archiveName(options.version, targetId);
    const archivePath = path.join(outputRoot, filename);
    await access(archivePath).then(() => { throw new Error(`输出文件已存在：${archivePath}`); }, error => { if (error.code !== 'ENOENT') throw error; });
    await makeArchive(stage, archivePath);
    const checksum = await hashFile(archivePath);
    await writeFile(`${archivePath}.sha256`, `${checksum}  ${filename}\n`, { flag: 'wx' });
    process.stdout.write(JSON.stringify({ target: targetId, version: options.version, archive: archivePath, sha256: checksum, files: manifest.files.length, licenses: 'THIRD-PARTY-LICENSES.json' }, null, 2) + '\n');
  } finally {
    if (relocationRoot) await rm(relocationRoot, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  await build(options);
} catch (error) {
  process.stderr.write(`${error?.message ?? 'Release 打包失败'}\n`);
  process.exitCode = 1;
}
