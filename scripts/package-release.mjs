#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertNativeTarget, copyAllowlistedFiles, hashFile, materializeBundleSymlinks,
  normalizeTargetId, pathWithin, pruneBuildState, trackedFiles, writeBundleManifest,
} from '../src/launcher/distribution.mjs';
import { createSkillArchive } from '../src/launcher/skill-archive.mjs';
import { validateCompanyDefaults } from '../src/lite/config.mjs';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_VERSION = '22.23.3';
const REQUIRED_NODE_VERSION = `v${NODE_VERSION}`;
const WINDOWS_SYSTEM_PATH = ['System32', 'System32/WindowsPowerShell/v1.0'];

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!['--target', '--version', '--output', '--company-defaults'].includes(name)) throw new Error(`未知参数：${name}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} 需要一个值。`);
    options[name.slice(2)] = value;
  }
  if (!options.target) throw new Error('必须指定 --target darwin-arm64|win32-x64。');
  if (!options.version || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,79}$/.test(options.version)) throw new Error('版本号格式无效。');
  if (!options.output) throw new Error('必须指定源码树外的 --output 目录。');
  if (options['company-defaults']) options.companyDefaults = options['company-defaults'];
  return options;
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  } catch (error) {
    throw new Error(`命令失败：${command}（退出码 ${error.status ?? 'unknown'}）`, { cause: error });
  }
}

function hostEnvironment(stage, nodePath) {
  const entries = [path.dirname(nodePath)];
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    entries.push(...WINDOWS_SYSTEM_PATH.map(item => path.join(systemRoot, item)), systemRoot);
  } else {
    entries.push('/usr/bin', '/bin', '/usr/sbin', '/sbin');
  }
  return {
    ...process.env,
    PATH: [...entries, process.env.PATH].filter(Boolean).join(path.delimiter),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_cache: path.join(stage, '.studio-runtime', 'npm-cache'),
  };
}

async function readCompanyDefaults(sourcePath, outputRoot) {
  if (!sourcePath) return null;
  const requested = path.resolve(SOURCE_ROOT, sourcePath);
  const actual = await realpath(requested).catch(() => { throw new Error('--company-defaults 指定的文件不存在或无法访问。'); });
  const info = await lstat(requested);
  if (!info.isFile() || info.isSymbolicLink() || pathWithin(SOURCE_ROOT, actual) || pathWithin(outputRoot, actual)) {
    throw new Error('--company-defaults 必须是工作树与输出目录之外的普通 JSON 文件。');
  }
  let value;
  try { value = JSON.parse(await readFile(actual, 'utf8')); }
  catch { throw new Error('--company-defaults 不是有效 JSON。'); }
  let normalized;
  try { normalized = validateCompanyDefaults(value); }
  catch (error) { throw new Error(`--company-defaults 配置无效：${error.message || '字段或地址格式不符合要求。'}`); }
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

async function downloadPinnedNode(target, stage) {
  const runtimeRoot = path.join(stage, '.studio-runtime', 'node');
  const archiveRoot = path.join(stage, '.studio-runtime', 'downloads');
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(archiveRoot, { recursive: true });
  const archivePath = path.join(archiveRoot, target.nodeArchive);
  const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${target.nodeArchive}`, {
    redirect: 'error', signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  if (!response.ok || !response.body) throw new Error(`Node.js ${NODE_VERSION} 下载失败：HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archivePath, { flags: 'wx' }));
  if (await hashFile(archivePath) !== target.nodeSha256) throw new Error(`Node.js 官方运行时哈希不匹配：${target.id}`);

  if (target.platform === 'darwin') {
    run('tar', ['-xf', archivePath, '-C', runtimeRoot]);
  } else {
    const script = [
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      '[System.IO.Compression.ZipFile]::ExtractToDirectory($env:CAS_NODE_ARCHIVE, $env:CAS_NODE_DESTINATION)',
    ].join('; ');
    run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, CAS_NODE_ARCHIVE: archivePath, CAS_NODE_DESTINATION: runtimeRoot },
    });
  }
  await rm(archiveRoot, { recursive: true, force: true });
  const nodePath = path.join(stage, target.nodeRelative);
  const version = execFileSync(nodePath, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  if (version !== REQUIRED_NODE_VERSION) throw new Error(`随包 Node.js 版本不符：${version}`);
  return nodePath;
}

async function findNpmCli(nodePath, target) {
  const candidates = target.platform === 'win32'
    ? [path.join(path.dirname(nodePath), 'node_modules/npm/bin/npm-cli.js')]
    : [path.resolve(path.dirname(nodePath), '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  throw new Error('随包 Node.js 缺少 npm CLI，无法安装精简运行依赖。');
}

async function installProductionDependencies(nodePath, target, stage, env) {
  const npmCli = await findNpmCli(nodePath, target);
  for (const relative of ['.', 'third_party/canvas/canvas-agent']) {
    process.stdout.write(`安装运行依赖：${relative}\n`);
    run(nodePath, [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: path.join(stage, relative), env,
    });
  }
}

async function removeBinDirectories(root) {
  const info = await lstat(root).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info?.isDirectory() || info.isSymbolicLink()) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.name === '.bin' && entry.isDirectory()) await rm(child, { recursive: true, force: true });
    else if (entry.isDirectory() && !entry.isSymbolicLink()) await removeBinDirectories(child);
  }
}

async function pruneRuntimeNpm(nodePath, stage) {
  const nodeDirectory = process.platform === 'win32' ? path.dirname(nodePath) : path.resolve(path.dirname(nodePath), '..');
  await rm(path.join(nodeDirectory, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules'), { recursive: true, force: true });
  for (const name of process.platform === 'win32'
    ? ['npm', 'npm.cmd', 'npx', 'npx.cmd', 'corepack', 'corepack.cmd', 'corepack.ps1']
    : ['npm', 'npx', 'corepack']) {
    await rm(path.join(path.dirname(nodePath), name), { force: true });
  }
  for (const relative of ['node_modules', 'third_party/canvas/canvas-agent/node_modules']) {
    await removeBinDirectories(path.join(stage, relative));
  }
}

async function licenseFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && /^(?:licen[cs]e|copying|notice|copyright)(?:\..*)?$/i.test(entry.name)) files.push(entry.name);
  }
  for (const name of ['licenses', 'license']) {
    const licenseRoot = path.join(directory, name);
    for (const entry of await readdir(licenseRoot, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile()) files.push(`${name}/${entry.name}`);
    }
  }
  return files.sort();
}

async function npmPackageRecords(root, relativeRoot, output = []) {
  const info = await lstat(root).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info?.isDirectory() || info.isSymbolicLink()) return output;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    if (entry.name.startsWith('@')) {
      await npmPackageRecords(path.join(root, entry.name), relativeRoot, output);
      continue;
    }
    const directory = path.join(root, entry.name);
    const manifestPath = path.join(directory, 'package.json');
    if (await access(manifestPath).then(() => true, () => false)) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const license = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type ?? null;
      output.push({
        name: manifest.name ?? entry.name,
        version: manifest.version ?? 'unknown',
        license,
        path: path.relative(relativeRoot, directory).split(path.sep).join('/'),
        licenseFiles: await licenseFiles(directory),
      });
    }
    await npmPackageRecords(path.join(directory, 'node_modules'), relativeRoot, output);
  }
  return output;
}

async function writeLicenseInventory(stage, target, nodePath) {
  const roots = [path.join(stage, 'node_modules'), path.join(stage, 'third_party/canvas/canvas-agent/node_modules')];
  const npm = [];
  for (const root of roots) await npmPackageRecords(root, stage, npm);
  const missing = npm.filter(item => !item.license).map(item => `npm:${item.name}@${item.version}`);
  if (missing.length) throw new Error(`依赖元数据缺少许可证字段，请先人工核对：${missing.slice(0, 12).join('、')}`);
  const nodeDirectory = process.platform === 'win32' ? path.dirname(nodePath) : path.resolve(path.dirname(nodePath), '..');
  const nodeLicense = path.join(nodeDirectory, 'LICENSE');
  if (!await access(nodeLicense).then(() => true, () => false)) throw new Error('Node.js 官方运行时未保留 LICENSE 文件。');
  for (const relative of ['third_party/canvas/LICENSE', 'licenses/xhs-ad-workbench-MIT.txt', 'release/NOTICE-third-party.md']) {
    if (!await access(path.join(stage, relative)).then(() => true, () => false)) throw new Error(`缺少随包许可材料：${relative}`);
  }
  const inventory = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    note: '本清单记录成品中可检查的第三方包许可证元数据、定位路径及随包许可材料，不构成法律意见。',
    runtime: {
      product: 'Creative Agent Studio Company Lite',
      target: target.id,
      node: { version: REQUIRED_NODE_VERSION, license: path.relative(stage, nodeLicense).split(path.sep).join('/') },
    },
    identifiedObligations: {
      canvasAgent: { license: 'MIT', source: 'third_party/canvas/LICENSE' },
      xhsSkill: { license: 'MIT', source: 'licenses/xhs-ad-workbench-MIT.txt' },
    },
    npm,
  };
  await writeFile(path.join(stage, 'THIRD-PARTY-LICENSES.json'), `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
  return inventory;
}

async function assertLiteLayout(stage, target, { hasCompanyDefaults }) {
  const required = [
    'AGENTS.md', 'README.md', 'Creative_Agent_Studio_PRD.md', '开发与施工计划.md',
    'docs/README.md', 'docs/代理宿主使用.md',
    '.agents/skills/creative-studio/SKILL.md',
    '.agents/skills/creative-studio/references/workbuddy-entry.md',
    'scripts/setup.mjs', 'scripts/studio.mjs', 'scripts/canvas-supervisor.mjs', 'scripts/canvas-mcp.mjs',
    'third_party/canvas/canvas-agent/dist/index.js',
    'third_party/canvas/web/dist/index.html',
    target.nodeRelative,
  ];
  if (target.platform === 'win32') required.push('Start.cmd', 'Studio.cmd');
  else required.push('Start.command', 'Studio.command');
  if (hasCompanyDefaults) required.push('company-defaults.json');
  for (const relative of required) {
    if (!await access(path.join(stage, relative)).then(() => true, () => false)) throw new Error(`Company Lite 成品缺少必要文件：${relative}`);
  }
  for (const relativeRoot of ['', 'third_party/canvas/canvas-agent']) {
    const packageRoot = path.join(stage, relativeRoot);
    const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    for (const name of Object.keys(packageJson.dependencies ?? {})) {
      const relative = path.join(relativeRoot, 'node_modules', name, 'package.json');
      if (!await access(path.join(stage, relative)).then(() => true, () => false)) {
        throw new Error(`Company Lite 成品缺少生产依赖：${name}（${relativeRoot || 'root'}）`);
      }
    }
  }
  const forbidden = [
    'adapters', 'web', 'src/creative', 'Creative Agent Studio Company Lite.app',
    'third_party/canvas/web/node_modules', 'third_party/canvas/canvas-agent/src',
    '.venv-ocr', '.studio-runtime/python', '.studio-runtime/rapidocr-models',
    'node_modules/@napi-rs/canvas', 'node_modules/@techstark/opencv-js',
    'node_modules/tesseract.js', 'node_modules/@tesseract.js-data',
    'node_modules/playwright', 'node_modules/esbuild',
  ];
  for (const relative of forbidden) {
    if (await access(path.join(stage, relative)).then(() => true, () => false)) throw new Error(`Company Lite 成品包含非目标组件：${relative}`);
  }
  if (await access(path.join(stage, 'node_modules/npm')).then(() => true, () => false)) throw new Error('Company Lite 成品不应包含 npm。');
}

async function smokeRuntime(runtimeRoot, target) {
  const nodePath = path.join(runtimeRoot, target.nodeRelative);
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'company-lite-smoke-data-'));
  const env = {
    ...hostEnvironment(runtimeRoot, nodePath),
    PATH: [
      path.dirname(nodePath),
      ...(process.platform === 'win32'
        ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows']
        : ['/usr/bin', '/bin']),
    ].join(path.delimiter),
    STUDIO_DATA_DIR: dataRoot,
    COMPANY_LITE_DEFAULTS_FILE: '',
  };
  try {
    const version = execFileSync(nodePath, ['--version'], { cwd: runtimeRoot, env, encoding: 'utf8', windowsHide: true }).trim();
    if (version !== REQUIRED_NODE_VERSION) throw new Error(`搬移后 Node 运行检查失败：${version}`);
    execFileSync(nodePath, ['--input-type=module', '-e', "await import('./third_party/canvas/canvas-agent/dist/index.js')"], {
      cwd: runtimeRoot, env, encoding: 'utf8', windowsHide: true, timeout: 120_000,
    });
    const runWrapper = (name, args = []) => target.platform === 'darwin'
      ? execFileSync(path.join(runtimeRoot, name), args, {
          cwd: runtimeRoot, env, encoding: 'utf8', windowsHide: true, timeout: 30_000,
        }).trim()
      : execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `call ${name}${args.length ? ` ${args.join(' ')}` : ''}`], {
          cwd: runtimeRoot, env, encoding: 'utf8', windowsHide: true, timeout: 30_000,
        }).trim();
    const setup = runWrapper(target.platform === 'darwin' ? 'Start.command' : 'Start.cmd');
    const setupStatus = JSON.parse(setup);
    const packageStep = setupStatus.steps?.find(step => step.id === 'package');
    const canvasStep = setupStatus.steps?.find(step => step.id === 'canvas');
    if (packageStep?.complete !== true) throw new Error('搬移后 setup status 未确认包内 Node 与 Studio 依赖。');
    if (canvasStep?.componentsReady !== true) throw new Error('搬移后 setup status 未确认 Canvas 本地组件与生产依赖。');
    if (canvasStep.complete !== false || canvasStep.status !== 'waiting') {
      throw new Error('隔离冒烟环境应等待 WorkBuddy 实际调用 canvas_status，不应提前标记 Canvas MCP 已连接。');
    }
    const status = runWrapper(target.platform === 'darwin' ? 'Studio.command' : 'Studio.cmd', ['status']);
    if (!status) throw new Error('共享 Studio CLI 的隔离状态命令没有输出。');
    const mcpConfig = JSON.parse(runWrapper(target.platform === 'darwin' ? 'Studio.command' : 'Studio.cmd', ['mcp-config']));
    const server = mcpConfig?.mcpServers?.['company-lite-canvas'];
    if (typeof server?.command !== 'string' || server.args?.length !== 1 || typeof server.args[0] !== 'string') {
      throw new Error('MCP 配置没有指向成品内的 Node 与 Canvas MCP 启动脚本。');
    }
    const [actualNode, configuredNode, actualScript, configuredScript] = await Promise.all([
      realpath(nodePath), realpath(server.command),
      realpath(path.join(runtimeRoot, 'scripts/canvas-mcp.mjs')), realpath(server.args[0]),
    ]);
    const normalizeExecutablePath = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalizeExecutablePath(configuredNode) !== normalizeExecutablePath(actualNode)
      || normalizeExecutablePath(configuredScript) !== normalizeExecutablePath(actualScript)) {
      throw new Error('MCP 配置没有指向成品内的 Node 与 Canvas MCP 启动脚本。');
    }
    const hasCredentialField = value => {
      if (!value || typeof value !== 'object') return false;
      return Object.entries(value).some(([key, child]) => /api.?key|token|secret|password|authorization/i.test(key)
        || hasCredentialField(child));
    };
    if (hasCredentialField(mcpConfig)) throw new Error('MCP 配置意外包含凭据字段。');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function archiveName(version, target) {
  const label = target.platform === 'darwin' ? 'macOS-arm64' : 'Windows-x64';
  return `Creative-Agent-Studio-CompanyLite-${version}-${label}.zip`;
}

async function makeArchive(stage, archivePath, target) {
  if (target.platform === 'darwin') {
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', stage, archivePath]);
    return;
  }
  const command = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '[System.IO.Compression.ZipFile]::CreateFromDirectory($env:CAS_RELEASE_SOURCE, $env:CAS_RELEASE_ARCHIVE, [System.IO.Compression.CompressionLevel]::Optimal, $true)',
  ].join('; ');
  run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, CAS_RELEASE_SOURCE: stage, CAS_RELEASE_ARCHIVE: archivePath },
  });
}

async function extractArchive(archivePath, destination, target) {
  if (target.platform === 'darwin') {
    run('ditto', ['-x', '-k', archivePath, destination]);
    return;
  }
  const command = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '[System.IO.Compression.ZipFile]::ExtractToDirectory($env:CAS_RELEASE_ARCHIVE, $env:CAS_RELEASE_DESTINATION)',
  ].join('; ');
  run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, CAS_RELEASE_ARCHIVE: archivePath, CAS_RELEASE_DESTINATION: destination },
  });
}

async function verifyArchiveAfterExtraction(archivePath, extractionRoot, rootName, target) {
  await extractArchive(archivePath, extractionRoot, target);
  const productRoot = path.join(extractionRoot, rootName);
  const wrapperFiles = target.platform === 'darwin' ? ['Start.command', 'Studio.command'] : ['Start.cmd', 'Studio.cmd'];
  for (const relative of [
    'README.md', 'AGENTS.md', 'Creative_Agent_Studio_PRD.md', '开发与施工计划.md', ...wrapperFiles,
    'docs/README.md', 'docs/代理宿主使用.md', '.agents/skills/creative-studio/SKILL.md',
    '.agents/skills/creative-studio/references/workbuddy-entry.md',
    'scripts/setup.mjs', 'scripts/studio.mjs', 'scripts/canvas-supervisor.mjs', 'scripts/canvas-mcp.mjs', target.nodeRelative,
  ]) {
    if (!await access(path.join(productRoot, relative)).then(() => true, () => false)) {
      throw new Error(`Company Lite ZIP 缺少能力包根文件：${relative}`);
    }
  }
  if (await access(path.join(productRoot, 'Creative Agent Studio Company Lite.app')).then(() => true, () => false)) {
    throw new Error('Company Lite ZIP 不应包含独立 .app 包装。');
  }
  const manifest = JSON.parse(await readFile(path.join(productRoot, 'release-manifest.json'), 'utf8'));
  if (manifest.target !== target.id || manifest.nodeVersion !== NODE_VERSION
    || manifest.product !== 'Creative Agent Studio Company Lite') throw new Error('归档 manifest 与产品、Node 版本或平台不符。');
  for (const file of manifest.files) {
    const filePath = path.join(productRoot, file.path);
    if (!pathWithin(productRoot, filePath)) throw new Error(`归档 manifest 路径越界：${file.path}`);
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size || await hashFile(filePath) !== file.sha256) {
      throw new Error(`归档文件与 manifest 的大小或 SHA-256 不符：${file.path}`);
    }
  }
  await smokeRuntime(productRoot, target);
}

async function filesUnder(root, relative) {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, child));
    else if (entry.isFile()) files.push(child.split(path.sep).join('/'));
  }
  return files;
}

async function makeSkillArchive(outputRoot) {
  const { archive, files } = await createSkillArchive(SOURCE_ROOT);
  const fileName = 'creative-studio-skill.zip';
  const destination = path.join(outputRoot, fileName);
  await writeFile(destination, archive, { flag: 'wx' });
  const checksum = createHash('sha256').update(archive).digest('hex');
  await writeFile(`${destination}.sha256`, `${checksum}  ${fileName}\n`, { flag: 'wx' });
  return { archive: destination, sha256: checksum, files };
}

async function build(options) {
  const targetId = normalizeTargetId(options.target);
  const target = assertNativeTarget(targetId);
  const outputRoot = path.resolve(options.output);
  if (pathWithin(SOURCE_ROOT, outputRoot)) throw new Error('Release 输出目录必须位于源码工作树之外。');
  const companyDefaults = await readCompanyDefaults(options.companyDefaults, outputRoot);
  const filename = archiveName(options.version, target);
  const expectedOutputs = [filename, `${filename}.sha256`, 'creative-studio-skill.zip', 'creative-studio-skill.zip.sha256'];
  for (const name of expectedOutputs) {
    if (await access(path.join(outputRoot, name)).then(() => true, () => false)) throw new Error(`输出文件已存在：${path.join(outputRoot, name)}`);
  }

  process.stdout.write('验证根与 Canvas 依赖并构建 Canvas Agent/Web。\n');
  const { prepareWorkspace } = await import(pathToFileURL(path.join(SOURCE_ROOT, 'src/launcher/prepare.mjs')).href);
  const preparation = await prepareWorkspace({
    root: SOURCE_ROOT,
    nodePath: process.execPath,
    onProgress: ({ message }) => process.stdout.write(`${message}\n`),
  });
  process.stdout.write(`源码准备完成：${preparation.fingerprint}\n`);

  const parent = await mkdtemp(path.join(os.tmpdir(), 'company-lite-release-'));
  const relocationRoot = await mkdtemp(path.join(os.tmpdir(), 'company-lite-relocated-'));
  const rootName = `Creative-Agent-Studio-CompanyLite-${options.version}-${targetId}`;
  let stage = path.join(parent, rootName);
  try {
    const sourceFiles = [
      ...trackedFiles(SOURCE_ROOT),
      ...await filesUnder(SOURCE_ROOT, 'third_party/canvas/canvas-agent/dist'),
      ...await filesUnder(SOURCE_ROOT, 'third_party/canvas/web/dist'),
    ].filter(relative => target.platform === 'win32'
      ? !['Start.command', 'Studio.command'].includes(relative)
      : !['Start.cmd', 'Studio.cmd'].includes(relative));
    const copied = await copyAllowlistedFiles(SOURCE_ROOT, stage, sourceFiles);
    process.stdout.write(`按 allowlist 复制 ${copied.length} 个源文件。\n`);
    if (companyDefaults) await writeFile(path.join(stage, 'company-defaults.json'), companyDefaults, { flag: 'wx', mode: 0o644 });

    const nodePath = await downloadPinnedNode(target, stage);
    const env = hostEnvironment(stage, nodePath);
    await installProductionDependencies(nodePath, target, stage, env);
    await pruneRuntimeNpm(nodePath, stage);
    await assertLiteLayout(stage, target, { hasCompanyDefaults: Boolean(companyDefaults) });
    await writeLicenseInventory(stage, target, nodePath);
    await pruneBuildState(stage);
    await materializeBundleSymlinks(stage);

    if (target.platform === 'darwin') {
      await chmod(path.join(stage, 'Start.command'), 0o755);
      await chmod(path.join(stage, 'Studio.command'), 0o755);
    }
    const packageManifest = await writeBundleManifest(stage, targetId, options.version);

    const relocatedProduct = path.join(relocationRoot, rootName);
    await rename(stage, relocatedProduct);
    stage = relocatedProduct;
    await mkdir(outputRoot, { recursive: true });
    const archivePath = path.join(outputRoot, filename);
    await makeArchive(stage, archivePath, target);
    const extractedRoot = await mkdtemp(path.join(relocationRoot, 'archive-smoke-'));
    await verifyArchiveAfterExtraction(archivePath, extractedRoot, rootName, target);
    const checksum = await hashFile(archivePath);
    await writeFile(`${archivePath}.sha256`, `${checksum}  ${filename}\n`, { flag: 'wx' });
    const skill = await makeSkillArchive(outputRoot);
    process.stdout.write(JSON.stringify({
      target: target.id, version: options.version,
      archive: archivePath, sha256: checksum, files: packageManifest.files.length,
      skillArchive: skill.archive, skillSha256: skill.sha256, skillFiles: skill.files,
    }, null, 2) + '\n');
  } finally {
    await rm(relocationRoot, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
}

try {
  await build(parseArguments(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`${error?.message ?? 'Release 打包失败'}\n`);
  process.exitCode = 1;
}
