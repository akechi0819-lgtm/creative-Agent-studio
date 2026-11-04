import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dataRoot } from '../canvas/client.mjs';
import { createCanvasRuntime } from '../canvas/runtime.mjs';
import { readMaterialConfig, saveMaterialConfig } from '../materials/config.mjs';
import { verifyMaterials } from '../materials/verify.mjs';
import { publicConfig, readConfigRecord, saveConfig, validateCompanyDefaults } from './config.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const DEFAULTS_ENV = 'COMPANY_LITE_DEFAULTS_FILE';
const REQUIRED_SETUP_DEPENDENCIES = ['@modelcontextprotocol/sdk', 'zod'];

const SETUP_FILES = [
  'package.json',
  'scripts/setup.mjs',
  'scripts/materials.mjs',
  'scripts/materials-mcp.mjs',
  'scripts/studio.mjs',
  'src/lite/setup.mjs',
  'src/lite/material-login.mjs',
  'src/lite/config.mjs',
  'src/materials/client.mjs',
  'src/materials/config.mjs',
  'src/materials/mcp.mjs',
  'src/materials/verify.mjs',
  'src/canvas/runtime.mjs',
  'src/canvas/mcp.mjs',
];

const CANVAS_FILES = [
  'third_party/canvas/web/dist/index.html',
  'third_party/canvas/canvas-agent/dist/index.js',
];

function setupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rootPath(root) {
  const value = root ?? dataRoot();
  if (typeof value !== 'string' || !value.trim()) throw setupError('ERR_SETUP_ROOT', '数据目录无效');
  return path.resolve(value);
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function fileCheck(repoRoot, relative) {
  const file = path.join(repoRoot, relative);
  try {
    const info = await fs.lstat(file);
    return { path: relative, exists: info.isFile() && !info.isSymbolicLink(), size: info.size };
  } catch (error) {
    if (error.code === 'ENOENT') return { path: relative, exists: false, error: '文件不存在' };
    return { path: relative, exists: false, error: error.message };
  }
}

function supportedNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 22 && minor >= 19) || major >= 24;
}

async function checkPackage(repoRoot, nodeVersion) {
  const files = await Promise.all(SETUP_FILES.map((file) => fileCheck(repoRoot, file)));
  const nodeOk = supportedNodeVersion(nodeVersion);
  const missing = files.filter((file) => !file.exists).map((file) => file.path);
  let manifestError = null;
  let dependencyNames = [];
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || !manifest.dependencies || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)) {
      throw new Error('package.json 缺少运行依赖清单');
    }
    dependencyNames = Object.keys(manifest.dependencies);
    const missingRequired = REQUIRED_SETUP_DEPENDENCIES.filter((name) => !dependencyNames.includes(name));
    if (missingRequired.length) throw new Error(`package.json 缺少 Studio CLI 核心依赖：${missingRequired.join('、')}`);
  } catch (error) {
    manifestError = error.code === 'ENOENT' ? 'package.json 不存在' : error instanceof SyntaxError ? 'package.json 格式无效' : error.message || 'package.json 无法读取';
  }
  const requireFromStudio = createRequire(path.join(repoRoot, 'scripts/studio.mjs'));
  const dependencies = dependencyNames.map((name) => {
    try { return { name, exists: Boolean(requireFromStudio.resolve(name === '@modelcontextprotocol/sdk' ? `${name}/server/mcp.js` : name)) }; }
    catch { return { name, exists: false }; }
  });
  const missingDependencies = dependencies.filter((item) => !item.exists).map((item) => item.name);
  const issues = [];
  if (!nodeOk) issues.push(`需要 Node.js 22.19+ 或 24+，当前为 ${nodeVersion}`);
  if (missing.length) issues.push(`源码工作区缺少文件：${missing.join('、')}`);
  if (manifestError) issues.push(`Studio CLI 运行依赖清单无效：${manifestError}`);
  if (missingDependencies.length) issues.push(`Studio CLI 运行依赖缺少：${missingDependencies.join('、')}`);
  const ready = nodeOk && missing.length === 0 && !manifestError && missingDependencies.length === 0;
  return {
    id: 'package',
    title: '检查源码与运行依赖',
    status: ready ? 'ready' : 'needs_action',
    complete: ready,
    actionNeeded: !ready,
    summary: ready ? `Node.js ${nodeVersion}、源码入口和运行依赖已就绪` : issues.join('；'),
    nextAction: ready
      ? '继续检查本地 Canvas 组件。'
      : !nodeOk
        ? '安装或切换到项目要求的 Node.js 版本，再运行 node scripts/prepare.mjs。'
        : '源码文件或运行依赖缺失时运行 node scripts/prepare.mjs，并按输出修复未完成步骤。',
    error: issues.length ? { code: 'ERR_SETUP_PACKAGE', message: issues.join('；') } : null,
    checks: [
      { name: 'Node.js', ok: nodeOk, detail: nodeVersion },
      ...files.map((file) => ({ name: file.path, ok: file.exists, detail: file.exists ? `${file.size} bytes` : file.error })),
      ...(manifestError ? [{ name: 'package.json dependencies', ok: false, detail: manifestError }] : []),
      ...dependencies.map((item) => ({ name: `Studio CLI 依赖 ${item.name}`, ok: item.exists, detail: item.exists ? '已找到' : '未找到' })),
    ],
  };
}

async function checkCanvasComponent(repoRoot) {
  const canvasPackageFile = 'third_party/canvas/canvas-agent/package.json';
  const files = await Promise.all([...CANVAS_FILES, canvasPackageFile].map((file) => fileCheck(repoRoot, file)));
  const entry = path.join(repoRoot, 'third_party/canvas/canvas-agent/dist/index.js');
  const packageRoot = path.join(repoRoot, 'third_party/canvas/canvas-agent');
  const packageJsonPath = path.join(packageRoot, 'package.json');
  let dependencyNames = [];
  let manifestError = null;
  try {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)
      || !packageJson.dependencies || typeof packageJson.dependencies !== 'object' || Array.isArray(packageJson.dependencies)) {
      throw new Error('Canvas Agent package.json 缺少运行依赖清单');
    }
    dependencyNames = Object.keys(packageJson.dependencies).sort();
  } catch (error) {
    manifestError = error.code === 'ENOENT' ? 'Canvas Agent package.json 不存在' : error instanceof SyntaxError ? 'Canvas Agent package.json 格式无效' : error.message || 'Canvas Agent package.json 无法读取';
  }
  const requireFromCanvas = createRequire(entry);
  const dependencies = dependencyNames.map((name) => {
    try { return { name, exists: Boolean(requireFromCanvas.resolve(name)) }; }
    catch { return { name, exists: false }; }
  });
  const missingFiles = files.filter((file) => !file.exists).map((file) => file.path);
  const missingDependencies = dependencies.filter((item) => !item.exists).map((item) => item.name);
  const ready = missingFiles.length === 0 && !manifestError && missingDependencies.length === 0;
  const issues = [];
  if (missingFiles.length) issues.push(`Canvas 预构建文件缺少：${missingFiles.join('、')}`);
  if (manifestError) issues.push(`Canvas Agent 依赖清单无效：${manifestError}`);
  if (missingDependencies.length) issues.push(`Canvas 运行依赖缺少：${missingDependencies.join('、')}`);
  return {
    id: 'canvas',
    title: '准备本地 Canvas',
    status: ready ? 'ready' : 'needs_action',
    complete: ready,
    actionNeeded: !ready,
    summary: ready ? '本地画布组件已就绪，创作时打开共享画布。' : issues.join('；'),
    nextAction: ready
      ? '运行 node scripts/studio.mjs mcp-config 取得 command/args，再按所用宿主实际配置格式添加本机 stdio MCP，并实际调用 canvas_status。'
      : 'Canvas 预构建文件或运行依赖缺失时运行 node scripts/prepare.mjs，并按输出修复未完成步骤。',
    error: issues.length ? { code: 'ERR_SETUP_CANVAS_PACKAGE', message: issues.join('；') } : null,
    checks: [
      ...files.map((file) => ({ name: file.path, ok: file.exists, detail: file.exists ? `${file.size} bytes` : file.error })),
      ...(manifestError ? [{ name: 'Canvas Agent dependencies', ok: false, detail: manifestError }] : []),
      ...dependencies.map((item) => ({ name: `依赖 ${item.name}`, ok: item.exists, detail: item.exists ? '已找到' : '未找到' })),
    ],
  };
}

function safeTimestamp(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

async function readJsonFile(file, label) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw setupError('ERR_SETUP_STATE', `${label} 无法读取`);
  }
}

async function readPreparationFile(file, label) {
  let source;
  try { source = await fs.readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { present: false, value: null };
    throw setupError('ERR_SETUP_STATE', `${label} 无法读取`);
  }
  try { return { present: true, value: JSON.parse(source) }; }
  catch { throw setupError('ERR_SETUP_STATE', `${label} 格式无效`); }
}

function preparationPidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function lockStartedAfterState(lock, state) {
  const stateTime = state.status === 'ready' ? Date.parse(state.completedAt)
    : state.status === 'failed' ? Date.parse(state.failedAt)
      : Date.parse(state.startedAt);
  const lockTime = Date.parse(lock.startedAt);
  if (!Number.isFinite(stateTime) || !Number.isFinite(lockTime)) return true;
  return lockTime > stateTime;
}

function preparationStage(state) {
  const dependency = Object.entries(state?.dependencies || {})
    .find(([, entry]) => ['installing', 'failed'].includes(entry?.status));
  if (dependency) return dependency[0] === '.' ? 'package' : 'canvas';
  if (Object.values(state?.builds || {}).some((entry) => ['building', 'failed'].includes(entry?.status))) return 'canvas';
  return state?.dependencies?.['.']?.status === 'ready' ? 'canvas' : 'package';
}

async function readPreparationStatus(repoRoot) {
  const directory = path.join(repoRoot, '.studio-runtime');
  const [stateFile, lockFile] = await Promise.all([
    readPreparationFile(path.join(directory, 'prepare-state.json'), '源码准备状态'),
    readPreparationFile(path.join(directory, 'prepare.lock'), '源码准备锁'),
  ]);
  const state = stateFile.value;
  if (stateFile.present && (!state || typeof state !== 'object' || Array.isArray(state)
    || state.schemaVersion !== 3 || !['preparing', 'ready', 'failed'].includes(state.status)
    || !state.dependencies || typeof state.dependencies !== 'object' || Array.isArray(state.dependencies)
    || !state.builds || typeof state.builds !== 'object' || Array.isArray(state.builds))) {
    throw setupError('ERR_SETUP_STATE', '源码准备状态格式无效');
  }

  const lock = lockFile.value;
  if (lockFile.present && (!lock || typeof lock !== 'object' || Array.isArray(lock)
    || !Number.isInteger(lock.pid) || lock.pid <= 0)) {
    throw setupError('ERR_SETUP_STATE', '源码准备锁格式无效');
  }
  const lockAlive = lockFile.present && preparationPidIsAlive(lock.pid);
  if (state && lockAlive && lockStartedAfterState(lock, state)) {
    return { phase: 'preparing', state: null, pid: lock.pid, lockPresent: true };
  }
  if (state?.status === 'ready') return { phase: 'ready', state, lockAlive, pid: lock?.pid ?? null };
  if (state?.status === 'failed') return { phase: 'failed', state, pid: lock?.pid ?? null };
  if (state?.status === 'preparing') {
    return { phase: lockAlive ? 'preparing' : 'interrupted', state, pid: lock?.pid ?? null, lockPresent: lockFile.present };
  }
  if (lockAlive) return { phase: 'preparing', state: null, pid: lock.pid, lockPresent: true };
  if (lockFile.present) return { phase: 'interrupted', state: null, pid: lock.pid, lockPresent: true };
  return null;
}

function applyPreparationStatus(packageStep, canvasStep, preparation) {
  if (!preparation || preparation.phase === 'ready') return;
  const stage = preparationStage(preparation.state);
  const step = stage === 'package' ? packageStep : canvasStep;
  const active = preparation.phase === 'preparing';
  const failedDependency = Object.values(preparation.state?.dependencies || {}).find((entry) => entry?.status === 'failed');
  const failedBuild = Object.values(preparation.state?.builds || {}).find((entry) => entry?.status === 'failed');
  const failure = failedDependency?.error || failedBuild?.error || preparation.state?.error || '准备过程未完成';
  const detail = typeof failure === 'string' ? failure : '准备过程未完成';
  step.status = active ? 'preparing' : 'needs_action';
  step.complete = false;
  step.actionNeeded = !active;
  step.error = active ? null : {
    code: preparation.phase === 'failed' ? 'ERR_SETUP_PREPARATION_FAILED' : 'ERR_SETUP_PREPARATION_INTERRUPTED',
    message: detail,
  };
  if (active) {
    const installing = Object.entries(preparation.state?.dependencies || {})
      .find(([, entry]) => entry?.status === 'installing');
    const building = Object.entries(preparation.state?.builds || {})
      .find(([, entry]) => entry?.status === 'building');
    if (installing) {
      const component = installing[0] === '.' ? '项目' : installing[0].endsWith('canvas-agent') ? 'Canvas Agent' : 'Canvas Web';
      step.summary = `正在安装 ${component} 依赖。`;
    } else if (building) {
      const component = building[0] === 'CanvasAgent' ? 'Canvas Agent' : 'Canvas Web';
      step.summary = `正在构建 ${component}。`;
    } else if (preparation.state) {
      step.summary = stage === 'package' ? '正在检查项目运行依赖。' : '正在核验 Canvas Agent 与 Canvas Web 构建产物。';
    } else {
      step.summary = `源码准备已启动${preparation.pid ? `（PID ${preparation.pid}）` : ''}，正在写入准备状态。`;
    }
    step.nextAction = '源码准备仍在进行，请稍后重新查看状态。';
  } else if (preparation.phase === 'failed') {
    step.summary = `源码准备失败：${detail}`;
    step.nextAction = '修复准备失败原因后运行 node scripts/prepare.mjs。';
  } else {
    step.summary = '源码准备已中断，未发现活动准备进程；旧构建文件不会作为本次准备成功的证明。';
    step.nextAction = '运行 node scripts/prepare.mjs 重新开始源码准备。';
  }
  step.checks.push({
    name: '源码准备状态',
    ok: active,
    detail: active
      ? step.summary
      : preparation.phase === 'failed' ? detail : step.summary,
  });
}

async function readHostReport(root) {
  const value = await readJsonFile(path.join(root, 'setup', 'host-report.json'), '宿主报告');
  if (value === null) return null;
  // v1 reports described the old single-tool MCP probe and never prove both
  // current-host query and original-file download access.
  if (value.schemaVersion !== 2) return null;
  if (!['connected', 'failed'].includes(value.status)
    || typeof value.checkedAt !== 'string'
    || (value.status === 'connected' && (
      typeof value.credentialId !== 'string' || !value.credentialId
      || typeof value.materialCheckAt !== 'string'
      || typeof value.queryTool !== 'string' || !/^[\w.-]{1,120}$/.test(value.queryTool)
      || typeof value.downloadTool !== 'string' || !/^[\w.-]{1,120}$/.test(value.downloadTool)
    ))) {
    throw setupError('ERR_SETUP_STATE', '宿主报告格式无效');
  }
  return {
    status: value.status,
    checkedAt: safeTimestamp(value.checkedAt),
    credentialId: value.credentialId || null,
    materialCheckAt: safeTimestamp(value.materialCheckAt),
    queryTool: value.queryTool || null,
    downloadTool: value.downloadTool || null,
    source: '宿主报告',
    independentlyVerified: false,
  };
}

async function readMaterialCheck(root) {
  const value = await readJsonFile(path.join(root, 'setup', 'material-check.json'), '素材库验证记录');
  if (value === null) return null;
  if (value.schemaVersion !== 1 || typeof value.credentialId !== 'string' || !value.credentialId
    || typeof value.baseUrl !== 'string' || typeof value.checkedAt !== 'string'
    || !['authenticated', 'queryVerified', 'downloadVerified'].every((key) => typeof value[key] === 'boolean')
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0
    || typeof value.sha256 !== 'string' || (value.sha256 !== '' && !/^[a-f\d]{64}$/i.test(value.sha256))
    || ![null, 'config', 'login', 'query', 'download'].includes(value.failedStage)
    || ![null, 'config_invalid', 'login_failed', 'query_failed', 'download_failed', 'empty_download', 'no_small_image'].includes(value.failureCode)) {
    throw setupError('ERR_SETUP_STATE', '素材库验证记录格式无效');
  }
  return {
    credentialId: value.credentialId,
    baseUrl: value.baseUrl,
    checkedAt: safeTimestamp(value.checkedAt),
    authenticated: value.authenticated,
    queryVerified: value.queryVerified,
    downloadVerified: value.downloadVerified,
    bytes: value.bytes,
    sha256: value.sha256.toLowerCase(),
    failedStage: value.failedStage,
    failureCode: value.failureCode,
    source: '本机实际验证',
    independentlyVerified: true,
  };
}

async function readImageCheck(root) {
  const value = await readJsonFile(path.join(root, 'setup', 'image-check.json'), '图片 API 检查记录');
  if (value === null) return null;
  if (value.schemaVersion !== 1 || !Number.isInteger(value.configRevision) || value.configRevision < 1
    || typeof value.ok !== 'boolean' || typeof value.checkedAt !== 'string') {
    throw setupError('ERR_SETUP_STATE', '图片 API 检查记录格式无效');
  }
  return {
    configRevision: value.configRevision,
    ok: value.ok,
    statusCode: Number.isInteger(value.statusCode) ? value.statusCode : null,
    checkedAt: safeTimestamp(value.checkedAt),
    message: typeof value.message === 'string' ? value.message.slice(0, 300) : '',
  };
}

async function readImageGenerationEvidence(root) {
  const value = await readJsonFile(path.join(root, 'setup', 'image-generation.json'), '图片生成验收记录');
  if (value === null) return null;
  if (value.schemaVersion !== 1 || !Number.isInteger(value.configRevision) || value.configRevision < 1
    || typeof value.model !== 'string' || !value.model
    || !validCanvasId(value.projectId) || !validCanvasId(value.sourceNodeId)
    || !Array.isArray(value.priorImageNodeIds) || value.priorImageNodeIds.some((id) => !validCanvasId(id))
    || typeof value.submittedAt !== 'string') {
    throw setupError('ERR_SETUP_STATE', '图片生成验收记录格式无效');
  }
  let mcpRead = null;
  if (value.mcpRead !== undefined && value.mcpRead !== null) {
    const read = value.mcpRead;
    if (!read || typeof read !== 'object' || !validCanvasId(read.imageNodeId)
      || !/^[a-f\d]{64}$/i.test(read.sha256 || '') || !Number.isSafeInteger(read.bytes) || read.bytes < 1
      || !Number.isInteger(read.width) || read.width < 1 || !Number.isInteger(read.height) || read.height < 1
      || typeof read.readAt !== 'string') {
      throw setupError('ERR_SETUP_STATE', 'MCP 图片读取记录格式无效');
    }
    mcpRead = { imageNodeId: read.imageNodeId, sha256: read.sha256.toLowerCase(), bytes: read.bytes,
      width: read.width, height: read.height, readAt: safeTimestamp(read.readAt) };
  }
  return {
    configRevision: value.configRevision,
    model: value.model,
    projectId: value.projectId,
    sourceNodeId: value.sourceNodeId,
    priorImageNodeIds: [...new Set(value.priorImageNodeIds)],
    submittedAt: safeTimestamp(value.submittedAt),
    mcpRead,
  };
}

async function readImageAcceptance(root) {
  const value = await readJsonFile(path.join(root, 'setup', 'image-acceptance.json'), '图片安装验收记录');
  if (value === null) return null;
  if (value.schemaVersion !== 1 || !Number.isInteger(value.configRevision) || value.configRevision < 1
    || !validCanvasId(value.projectId) || !validCanvasId(value.sourceNodeId) || !validCanvasId(value.imageNodeId)
    || !/^[a-f\d]{64}$/i.test(value.sha256 || '') || !Number.isSafeInteger(value.bytes) || value.bytes < 1
    || !Number.isInteger(value.width) || value.width < 1 || !Number.isInteger(value.height) || value.height < 1
    || typeof value.submittedAt !== 'string' || typeof value.readAt !== 'string' || typeof value.verifiedAt !== 'string') {
    throw setupError('ERR_SETUP_STATE', '图片安装验收记录格式无效');
  }
  return {
    configRevision: value.configRevision,
    projectId: value.projectId,
    sourceNodeId: value.sourceNodeId,
    imageNodeId: value.imageNodeId,
    sha256: value.sha256.toLowerCase(),
    bytes: value.bytes,
    width: value.width,
    height: value.height,
    submittedAt: safeTimestamp(value.submittedAt),
    readAt: safeTimestamp(value.readAt),
    verifiedAt: safeTimestamp(value.verifiedAt),
  };
}

function validCanvasId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

function imageAcceptanceMatches(record, evidence, acceptance) {
  return Boolean(record.image.baseUrl && record.image.model && record.image.apiKey
    && evidence && acceptance && evidence.configRevision === record.revision
    && evidence.model === record.image.model && evidence.projectId === acceptance.projectId
    && evidence.sourceNodeId === acceptance.sourceNodeId && evidence.mcpRead
    && evidence.mcpRead.imageNodeId === acceptance.imageNodeId
    && evidence.mcpRead.sha256 === acceptance.sha256 && evidence.mcpRead.bytes === acceptance.bytes
    && evidence.mcpRead.width === acceptance.width && evidence.mcpRead.height === acceptance.height
    && evidence.submittedAt === acceptance.submittedAt && evidence.mcpRead.readAt === acceptance.readAt
    && acceptance.configRevision === record.revision);
}

async function loadDefaults(repoRoot, env) {
  const override = env[DEFAULTS_ENV];
  const file = override || path.join(repoRoot, 'company-defaults.json');
  try {
    const resolved = path.resolve(file);
    const [repoReal, defaultsReal] = await Promise.all([fs.realpath(repoRoot), fs.realpath(resolved)]);
    if (override && isInside(repoReal, defaultsReal)) throw new Error('外部默认配置必须放在仓库目录之外');
    const value = JSON.parse(await fs.readFile(defaultsReal, 'utf8'));
    return { ...validateCompanyDefaults(value), error: null, configured: true };
  } catch (error) {
    if (error.code === 'ENOENT' && !override) return { image: {}, materials: {}, error: null, configured: false };
    return { image: {}, materials: {}, error: error.message || '外部默认配置读取失败', configured: true };
  }
}

export async function resolveMaterialBaseUrl({ baseUrl = '', root, repoRoot = REPO_ROOT, env = process.env } = {}) {
  const supplied = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  if (supplied) return validateCompanyDefaults({ materials: { baseUrl: supplied } }).materials.baseUrl;
  const defaults = await loadDefaults(path.resolve(repoRoot), env);
  if (defaults.error) throw setupError('ERR_MATERIAL_DEFAULTS', '外部素材库默认地址无效；请检查默认配置，或显式提供 HTTPS 地址。');
  if (defaults.materials?.baseUrl) return defaults.materials.baseUrl;
  const saved = await readMaterialConfig({ root });
  if (saved?.baseUrl) return saved.baseUrl;
  throw setupError('ERR_MATERIAL_URL', '请提供素材库 HTTPS 地址，或在外部默认配置 materials.baseUrl 中填写地址。');
}

function stageLogs(steps, hostReport, materialCheck, imageCheck, defaultsError) {
  const logs = [];
  for (const step of steps) {
    for (const check of step.checks || []) {
      logs.push({ level: check.ok ? 'info' : 'error', stage: step.id, message: `${check.name}：${check.detail}` });
    }
  }
  if (materialCheck) {
    const verified = materialCheck.authenticated && materialCheck.queryVerified && materialCheck.downloadVerified
      && materialCheck.bytes > 0 && /^[a-f\d]{64}$/i.test(materialCheck.sha256) && materialCheck.failedStage === null;
    logs.push({
      level: verified ? 'info' : 'error',
      stage: 'materials',
      at: materialCheck.checkedAt,
      source: materialCheck.source,
      message: verified
        ? `本机已验证 Teedy 登录、素材查询及原件下载（${materialCheck.bytes} bytes；SHA-256 ${materialCheck.sha256}）。`
        : `本机素材验证未通过（失败阶段：${materialCheck.failedStage || 'unknown'}）。`,
    });
  }
  if (hostReport) {
    logs.push({
      level: hostReport.status === 'connected' ? 'info' : 'error',
      stage: 'materials',
      at: hostReport.checkedAt,
      source: hostReport.source,
      message: hostReport.status === 'connected'
        ? `当前宿主已报告实际调用素材查询工具 ${hostReport.queryTool} 和原件下载工具 ${hostReport.downloadTool}（independentlyVerified=false）。`
        : '当前宿主报告素材查询或原件下载未通过（independentlyVerified=false）。',
    });
  }
  if (imageCheck) logs.push({ level: imageCheck.ok ? 'info' : 'error', stage: 'image', at: imageCheck.checkedAt, message: imageCheck.message });
  if (defaultsError) logs.push({ level: 'warning', stage: 'materials', message: `公司默认配置：${defaultsError}` });
  return logs;
}

/** Derive setup progress from installed files, runtime checks, saved config, and explicit host reports. */
export async function getSetupStatus({ root, repoRoot = REPO_ROOT, nodeVersion = process.version, env = process.env } = {}) {
  const resolvedRoot = rootPath(root);
  const resolvedRepo = path.resolve(repoRoot);
  const [packageStep, canvasStep, record, materialConfig, hostReport, materialCheck, imageCheck, imageGeneration, imageAcceptance, defaults, canvasMcpCheck, preparation] = await Promise.all([
    checkPackage(resolvedRepo, nodeVersion),
    checkCanvasComponent(resolvedRepo),
    readConfigRecord({ root: resolvedRoot }),
    readMaterialConfig({ root: resolvedRoot }),
    readHostReport(resolvedRoot),
    readMaterialCheck(resolvedRoot),
    readImageCheck(resolvedRoot),
    readImageGenerationEvidence(resolvedRoot),
    readImageAcceptance(resolvedRoot),
    loadDefaults(resolvedRepo, env),
    readJsonFile(path.join(resolvedRoot, 'setup', 'canvas-mcp-check.json'), '本地 Canvas MCP 检查'),
    readPreparationStatus(resolvedRepo),
  ]);
  const componentsReady = canvasStep.complete;
  const mcpReady = canvasMcpCheck?.service === 'company-lite-canvas' && Boolean(safeTimestamp(canvasMcpCheck.checkedAt));
  canvasStep.componentsReady = componentsReady;
  canvasStep.mcpConnected = mcpReady;
  canvasStep.checks.push({
    name: '宿主调用本地 Canvas MCP',
    ok: mcpReady,
    detail: mcpReady
      ? `上次探测：${canvasMcpCheck.checkedAt}；新宿主或新会话请实际调用 canvas_status。`
      : '等待宿主实际调用 canvas_status',
  });
  if (componentsReady && !mcpReady) {
    Object.assign(canvasStep, {complete:false,status:'waiting',actionNeeded:true,
      summary:'画布组件已就绪，等待宿主智能体连接本地 Canvas MCP。',
      nextAction:'运行 node scripts/studio.mjs mcp-config 取得 command/args，再按所用宿主实际配置格式添加本机 stdio MCP，并实际调用 canvas_status。无需打开画布或生成图片。'});
  }
  applyPreparationStatus(packageStep, canvasStep, preparation);

  const defaultBaseMismatch = Boolean(materialConfig && defaults.materials?.baseUrl
    && defaults.materials.baseUrl !== materialConfig.baseUrl);
  const materialCheckCurrent = Boolean(!defaultBaseMismatch && materialConfig && materialCheck
    && materialCheck.credentialId === materialConfig.credentialId
    && materialCheck.baseUrl === materialConfig.baseUrl
    && materialCheck.checkedAt);
  const currentMaterialCheck = materialCheckCurrent ? materialCheck : null;
  const localVerified = Boolean(currentMaterialCheck?.authenticated && currentMaterialCheck?.queryVerified
    && currentMaterialCheck?.downloadVerified && currentMaterialCheck.bytes > 0
    && /^[a-f\d]{64}$/i.test(currentMaterialCheck.sha256) && currentMaterialCheck.failedStage === null);
  const linkedHostReport = Boolean(currentMaterialCheck && hostReport
    && hostReport.credentialId === materialConfig?.credentialId
    && hostReport.materialCheckAt === currentMaterialCheck.checkedAt) ? hostReport : null;
  const hostReportCurrent = Boolean(localVerified && linkedHostReport?.status === 'connected');
  const materialReady = localVerified && hostReportCurrent;
  const materialBaseUrl = defaults.materials?.baseUrl || materialConfig?.baseUrl || '';
  const loginAction = materialBaseUrl
    ? '在当前宿主中运行 `node scripts/setup.mjs login-materials`，然后请员工本人在打开的本机网页填写 Teedy 账号。'
    : '先向管理员取得素材库 HTTPS 地址；运行 `node scripts/setup.mjs login-materials <HTTPS地址>`，再请员工本人在打开的本机网页填写 Teedy 账号。';
  const hostInstruction = [
    loginAction,
    '登录网页仅监听 127.0.0.1，员工本人在网页中输入账号；CLI 不接收口令，也不会把账号口令写入验证记录。登录通过后会自动查询素材并下载一份原件进行本机验证。',
    '本机验证通过后，先运行 `node scripts/materials.mjs mcp-config`，按宿主实际格式添加本机 stdio MCP 素材服务。由当前宿主实际调用公司 Teedy 查询工具和原件下载工具，再在源码目录运行 `node scripts/setup.mjs report-host connected <查询工具名> <下载工具名>`。',
    'setup 就绪还要求当前宿主这两项真实调用均成功；旧版单工具报告不再作为证据。',
  ].join('\n\n');
  const materialsStep = {
    id: 'materials',
    title: '连接公司素材库',
    status: materialReady ? 'ready' : !materialConfig ? 'waiting' : localVerified ? 'host_action_needed' : 'needs_action',
    complete: materialReady,
    actionNeeded: !materialReady,
    summary: materialReady
      ? `本机验证与当前宿主素材调用报告均已通过（${linkedHostReport.queryTool}、${linkedHostReport.downloadTool}）`
      : !materialConfig
        ? materialBaseUrl ? '等待员工本人完成 Teedy 登录及本机查询、原件下载验证。' : '等待公司提供素材库 HTTPS 地址。'
        : defaultBaseMismatch
          ? '公司默认素材库地址已变更，需在新地址重新登录并完成本机验证。'
        : localVerified
        ? linkedHostReport?.status === 'failed' ? '本机素材验证通过；当前宿主查询或原件下载报告未通过。' : '本机素材验证通过；等待当前宿主实际调用查询和原件下载工具。'
          : currentMaterialCheck?.failedStage
            ? `当前保存的 Teedy 账号本机验证未通过（${currentMaterialCheck.failedStage}）。`
            : '当前保存的 Teedy 账号尚无有效的登录、查询及原件下载验证。',
    nextAction: materialReady
      ? '继续配置图片服务。'
      : localVerified
        ? '运行 node scripts/materials.mjs mcp-config，按宿主实际格式接入本机 stdio MCP 素材服务；实际调用查询和原件下载工具后，运行 report-host connected <查询工具名> <下载工具名>。'
        : loginAction,
    error: linkedHostReport?.status === 'failed' ? { code: 'ERR_HOST_PROBE', message: '当前宿主报告的素材查询或原件下载未通过' } : defaultBaseMismatch ? { code: 'ERR_MATERIAL_DEFAULT_CHANGED', message: '公司默认素材库地址与已保存账号不一致，需在新地址重新验证' } : currentMaterialCheck && !localVerified ? { code: 'ERR_MATERIAL_CHECK', message: '本机素材库登录、查询或原件下载验证未通过' } : null,
    checkedAt: currentMaterialCheck?.checkedAt || linkedHostReport?.checkedAt || null,
    source: materialReady ? '本机验证与当前宿主报告' : currentMaterialCheck?.source || null,
    independentlyVerified: Boolean(currentMaterialCheck),
    baseUrl: materialBaseUrl || materialConfig?.baseUrl || null,
    hostInstruction,
    checks: [{
      name: '本机 Teedy 登录', ok: Boolean(currentMaterialCheck?.authenticated),
      detail: currentMaterialCheck?.authenticated ? `已验证（${currentMaterialCheck.checkedAt}）` : '等待员工本人在本机网页登录并验证',
    }, {
      name: '本机素材查询', ok: Boolean(currentMaterialCheck?.queryVerified),
      detail: currentMaterialCheck?.queryVerified ? '已实际查询素材记录' : '等待本机查询验证',
    }, {
      name: '本机原件下载', ok: Boolean(currentMaterialCheck?.downloadVerified),
      detail: currentMaterialCheck?.downloadVerified ? `${currentMaterialCheck.bytes} bytes 已下载并计算 SHA-256` : '等待本机下载一份原件验证',
    }, {
      name: '当前宿主查询和原件下载', ok: Boolean(hostReportCurrent),
      detail: hostReportCurrent
        ? `查询：${linkedHostReport.queryTool}；下载：${linkedHostReport.downloadTool}（${linkedHostReport.checkedAt}）`
        : linkedHostReport?.status === 'failed' ? '当前宿主报告的查询或下载调用未通过' : '等待当前宿主分别实际调用查询和下载工具',
    }],
  };

  const imageConfigured = Boolean(record.image.baseUrl && record.image.model && record.image.apiKey);
  const imageVerified = imageConfigured && imageCheck?.configRevision === record.revision && imageCheck.ok;
  const imageGenerationCurrent = Boolean(imageVerified && imageGeneration
    && imageGeneration.configRevision === record.revision && imageGeneration.model === record.image.model);
  const imageReadCurrent = Boolean(imageGenerationCurrent && imageGeneration.mcpRead);
  const imageAcceptanceReady = imageReadCurrent && imageAcceptanceMatches(record, imageGeneration, imageAcceptance);
  const imageNeedsAction = !imageAcceptanceReady;
  if (imageCheck && record.image.apiKey) imageCheck.message = imageCheck.message.replaceAll(record.image.apiKey, '[已隐藏]');
  const safeImageSummary = imageConfigured && imageCheck?.configRevision === record.revision && imageCheck.ok
    ? imageAcceptanceReady ? '图片服务连接、真实生成、宿主 MCP 读图与历史重开验收均通过。'
      : '图片服务连接检查通过，等待当前宿主完成真实生成、MCP 读图和历史重开验收。'
    : !imageConfigured
      ? '填写图片服务地址、模型和密钥后检查连接。'
      : imageCheck?.configRevision === record.revision && !imageCheck.ok
        ? '图片服务连接检查未通过。'
        : '图片服务已保存，请检查连接。';
  let imageNextAction = '填写或确认图片服务地址、模型和密钥，然后保存并检查连接。';
  if (imageVerified) imageNextAction = '在当前宿主打开本地画布，创建单张图片配置节点，并通过 canvas_run_generation 提交一次测试图。';
  if (imageGenerationCurrent) imageNextAction = `在项目 ${imageGeneration.projectId} 查询生成节点 ${imageGeneration.sourceNodeId} 的状态。成功后用 canvas_read_image 读取成图，状态未知时不要重发。`;
  if (imageReadCurrent) imageNextAction = `宿主核验历史图片：node scripts/setup.mjs verify-image ${imageGeneration.projectId} ${imageGeneration.mcpRead.imageNodeId}`;
  if (imageAcceptanceReady) imageNextAction = '继续查看最终检查。';
  const imageStep = {
    id: 'image',
    title: '图片 API 与生图验收',
    status: imageAcceptanceReady ? 'ready' : imageVerified ? 'waiting' : 'needs_action',
    complete: imageAcceptanceReady,
    actionNeeded: imageNeedsAction,
    connectionVerified: imageVerified,
    summary: safeImageSummary,
    nextAction: imageNextAction,
    error: imageCheck?.configRevision === record.revision && !imageCheck.ok
      ? { code: 'ERR_IMAGE_API_CHECK', message: imageCheck.message }
      : null,
    config: publicConfig(record).image,
    defaults: {
      baseUrl: record.image.baseUrl || defaults.image.baseUrl || '',
      model: record.image.model || defaults.image.model || '',
    },
    defaultsError: defaults.error,
    checkedAt: imageCheck?.configRevision === record.revision ? imageCheck.checkedAt : null,
    checks: [{
      name: '图片服务连接',
      ok: imageVerified,
      detail: imageVerified ? 'GET /models 已确认当前配置可连接；此项不调用生成接口。' : imageCheck?.configRevision === record.revision ? '连接检查未通过；请查看检查记录' : '当前配置尚未检查',
    }, {
      name: '本次配置真实生成与宿主 MCP 读图',
      ok: imageReadCurrent,
      detail: imageReadCurrent ? `已读取新生成图片 ${imageGeneration.mcpRead.imageNodeId}（SHA-256 ${imageGeneration.mcpRead.sha256}）` : '等待通过当前配置生成图片并由宿主 MCP 实际读取',
    }, {
      name: '从历史重开并核对本机像素',
      ok: imageAcceptanceReady,
      detail: imageAcceptanceReady ? `历史项目与本机图片像素已核对（${imageAcceptance.bytes} bytes）` : '等待运行 verify-image 重开历史并核对持久化图片',
    }],
  };

  const steps = [packageStep, canvasStep, materialsStep, imageStep];
  const unfinished = steps.find(step => !step.complete);
  const allReady = !unfinished;
  const finishStep = {
    id: 'finish',
    title: '检查完成',
    status: allReady ? 'complete' : 'blocked',
    complete: allReady,
    actionNeeded: !allReady,
    summary: allReady
      ? '本机真实生图、宿主 MCP 读图与历史重开验收均通过；创作时复用共享画布和已保存配置。'
      : `等待完成${unfinished.title}。`,
    nextAction: allReady ? '可在当前宿主智能体中开始创作。' : unfinished.nextAction,
    error: null,
    checks: [{ name: '图片真实生成、宿主 MCP 读图与历史重开', ok: imageAcceptanceReady,
      detail: imageAcceptanceReady
        ? `配置版本 ${imageAcceptance.configRevision}；项目 ${imageAcceptance.projectId}；成图 ${imageAcceptance.imageNodeId}；SHA-256 ${imageAcceptance.sha256}`
        : imageReadCurrent ? '宿主 MCP 已读到本次新生成图片；等待从历史重开项目并运行 verify-image。'
          : imageGenerationCurrent ? '已记录本次图片生成；等待宿主 MCP 实际读取生成结果并从历史重开。'
            : '等待本次配置下的真实生成与宿主 MCP 读图' }],
  };
  steps.push(finishStep);
  const currentStep = steps.find((step) => !step.complete) || finishStep;
  const logs = stageLogs(steps, linkedHostReport, currentMaterialCheck, imageCheck?.configRevision === record.revision ? imageCheck : null, defaults.error);
  return {
    current: currentStep.id,
    actionNeeded: currentStep.actionNeeded,
    nextAction: currentStep.nextAction,
    complete: allReady,
    summary: allReady ? '本机准备已完成' : currentStep.summary,
    steps,
    logs,
    config: publicConfig(record),
  };
}

/** Called only by the Canvas MCP status tool after an actual protocol invocation. */
export async function recordCanvasMcpCheck({ root } = {}) {
  await writePrivateJson(root, 'canvas-mcp-check.json', {service:'company-lite-canvas',checkedAt:new Date().toISOString()});
}

/** Whether a successful Canvas MCP image call should leave installation evidence. */
export async function imageAcceptanceTrackingPending({ root } = {}) {
  const resolvedRoot = rootPath(root);
  const [record, check, evidence, acceptance] = await Promise.all([
    readConfigRecord({ root: resolvedRoot }), readImageCheck(resolvedRoot),
    readImageGenerationEvidence(resolvedRoot), readImageAcceptance(resolvedRoot),
  ]);
  if (!record.image.baseUrl || !record.image.model || !record.image.apiKey
    || !check?.ok || check.configRevision !== record.revision
    || imageAcceptanceMatches(record, evidence, acceptance)) return false;
  return !(evidence?.configRevision === record.revision && evidence.mcpRead);
}

/** Record one submitted MCP generation only while the current setup still needs its test image. */
export async function recordImageGenerationSubmission({ projectId, sourceNodeId, canvasState } = {}, { root, now = () => new Date() } = {}) {
  if (!validCanvasId(projectId) || !validCanvasId(sourceNodeId)
    || !canvasState || canvasState.projectId !== projectId
    || !Array.isArray(canvasState.nodes) || !Array.isArray(canvasState.connections)) return { recorded: false };
  const resolvedRoot = rootPath(root);
  const [record, check, evidence, acceptance] = await Promise.all([
    readConfigRecord({ root: resolvedRoot }), readImageCheck(resolvedRoot),
    readImageGenerationEvidence(resolvedRoot), readImageAcceptance(resolvedRoot),
  ]);
  if (!record.image.baseUrl || !record.image.model || !record.image.apiKey
    || !check?.ok || check.configRevision !== record.revision
    || imageAcceptanceMatches(record, evidence, acceptance)) return { recorded: false };
  const source = canvasState.nodes.find((node) => node.id === sourceNodeId);
  if (source?.type !== 'config' || source.metadata?.generationMode !== 'image'
    || String(source.metadata?.count ?? '') !== '1'
    || source.metadata?.model && source.metadata.model !== record.image.model) return { recorded: false };
  const previousSource = evidence?.configRevision === record.revision
    ? canvasState.nodes.find((node) => node.id === evidence.sourceNodeId)
    : null;
  if (evidence?.configRevision === record.revision && (evidence.mcpRead || previousSource?.metadata?.status !== 'error')) {
    return { recorded: false };
  }
  const priorImageNodeIds = canvasState.nodes.filter((node) => node.type === 'image').map((node) => node.id);
  await writePrivateJson(resolvedRoot, 'image-generation.json', {
    schemaVersion: 1,
    configRevision: record.revision,
    model: record.image.model,
    projectId,
    sourceNodeId,
    priorImageNodeIds,
    submittedAt: now().toISOString(),
    mcpRead: null,
  });
  return { recorded: true };
}

/** Record image bytes returned by an actual host stdio MCP canvas_read_image call. */
export async function recordImageMcpRead({ projectId, imageNodeId, canvasState, imageResult } = {}, { root, now = () => new Date() } = {}) {
  if (!validCanvasId(projectId) || !validCanvasId(imageNodeId)
    || !canvasState || canvasState.projectId !== projectId
    || !Array.isArray(canvasState.nodes) || !Array.isArray(canvasState.connections)) return { recorded: false };
  const resolvedRoot = rootPath(root);
  const [record, check, evidence, acceptance] = await Promise.all([
    readConfigRecord({ root: resolvedRoot }), readImageCheck(resolvedRoot),
    readImageGenerationEvidence(resolvedRoot), readImageAcceptance(resolvedRoot),
  ]);
  if (!record.image.baseUrl || !record.image.model || !record.image.apiKey
    || !check?.ok || check.configRevision !== record.revision
    || imageAcceptanceMatches(record, evidence, acceptance)
    || !evidence || evidence.configRevision !== record.revision || evidence.model !== record.image.model
    || evidence.projectId !== projectId || evidence.mcpRead) return { recorded: false };
  if (!isFreshGeneratedImage(canvasState, imageNodeId, evidence, record.image.model)) return { recorded: false };
  const image = decodeImageDataUrl(imageResult?.dataUrl);
  if (!image || imageResult?.nodeId !== imageNodeId
    || !Number.isInteger(imageResult.width) || imageResult.width < 1
    || !Number.isInteger(imageResult.height) || imageResult.height < 1) return { recorded: false };
  const node = canvasState.nodes.find((item) => item.id === imageNodeId);
  if (node.metadata.naturalWidth !== imageResult.width || node.metadata.naturalHeight !== imageResult.height) return { recorded: false };
  const mcpRead = {
    imageNodeId,
    sha256: createHash('sha256').update(image.bytes).digest('hex'),
    bytes: image.bytes.length,
    width: imageResult.width,
    height: imageResult.height,
    readAt: now().toISOString(),
  };
  await writePrivateJson(resolvedRoot, 'image-generation.json', {
    schemaVersion: 1,
    configRevision: evidence.configRevision,
    model: evidence.model,
    projectId: evidence.projectId,
    sourceNodeId: evidence.sourceNodeId,
    priorImageNodeIds: evidence.priorImageNodeIds,
    submittedAt: evidence.submittedAt,
    mcpRead,
  });
  return { recorded: true };
}

/** Reopen one witnessed project from Canvas history, compare the returned image to disk bytes, and seal acceptance. */
export async function verifyImageAcceptance({ projectId, imageNodeId } = {}, {
  root, repoRoot = REPO_ROOT, env = process.env, runtime = createCanvasRuntime({ root }), now = () => new Date(),
} = {}) {
  if (!validCanvasId(projectId) || !validCanvasId(imageNodeId)) {
    throw setupError('ERR_IMAGE_ACCEPTANCE_ARGUMENT', 'verify-image 需要有效的 projectId 和生成后图片节点 ID。');
  }
  const resolvedRoot = rootPath(root);
  const [record, check, evidence, previousAcceptance] = await Promise.all([
    readConfigRecord({ root: resolvedRoot }), readImageCheck(resolvedRoot),
    readImageGenerationEvidence(resolvedRoot), readImageAcceptance(resolvedRoot),
  ]);
  if (!record.image.baseUrl || !record.image.model || !record.image.apiKey
    || !check?.ok || check.configRevision !== record.revision) {
    throw setupError('ERR_IMAGE_ACCEPTANCE_CONFIG', '当前图片配置尚未通过连接检查；请先运行 node scripts/setup.mjs check-image。');
  }
  if (!evidence || evidence.configRevision !== record.revision || evidence.model !== record.image.model
    || evidence.projectId !== projectId || evidence.mcpRead?.imageNodeId !== imageNodeId) {
    throw setupError('ERR_IMAGE_ACCEPTANCE_EVIDENCE', '找不到与当前图片配置、项目和节点匹配的宿主 MCP 生成及读图证据。');
  }
  if (imageAcceptanceMatches(record, evidence, previousAcceptance)) {
    return getSetupStatus({ root: resolvedRoot });
  }

  const initial = await runtime.status();
  if (!initial.running) throw setupError('ERR_IMAGE_HISTORY_REOPEN', '本机 Canvas 尚未运行；请由当前宿主连接并打开画布历史后重试验收。');
  const forRequestedProject = initial.targets.filter((target) => target.projectId === projectId && target.hasCanvas);
  const candidates = forRequestedProject.length ? forRequestedProject : initial.targets.filter(target => target.projectId === 'library');
  const active = candidates.find(target => target.active) || (candidates.length === 1 ? candidates[0] : null);
  if (!active?.clientId) throw setupError('ERR_IMAGE_HISTORY_REOPEN', '当前宿主没有唯一的 Canvas 页面；请在目标宿主中打开画布历史后重试。');
  let historyTarget = active.projectId === 'library' && !active.hasCanvas ? active : null;
  if (!historyTarget) {
    await runtime.call('site_navigate', { path: '/canvas?mode=choose' }, { projectId: active.projectId, clientId: active.clientId });
    historyTarget = await waitForCanvasTarget(runtime, active.clientId, (target) => target.projectId === 'library' && !target.hasCanvas);
  }
  const persistedProject = await readPersistedCanvasProject(resolvedRoot, projectId);
  if (!persistedProject) throw setupError('ERR_IMAGE_HISTORY_PROJECT', '指定项目尚未保存到本机画布历史。');
  assertAcceptedProjectImage(persistedProject, projectId, imageNodeId, evidence, record.image.model);

  await runtime.call('site_navigate', { path: `/canvas/${encodeURIComponent(projectId)}` }, {
    projectId: historyTarget.projectId,
    clientId: historyTarget.clientId,
  });
  await waitForCanvasTarget(runtime, historyTarget.clientId,
    (target) => target.projectId === projectId && target.hasCanvas);
  const reopenedState = await runtime.call('canvas_get_state', {}, { projectId, clientId: historyTarget.clientId });
  assertAcceptedProjectImage(reopenedState, projectId, imageNodeId, evidence, record.image.model);
  const reopenedImage = await runtime.call('canvas_read_image', { nodeId: imageNodeId }, { projectId, clientId: historyTarget.clientId });
  const reopenedBytes = decodeImageDataUrl(reopenedImage?.dataUrl);
  if (!reopenedBytes) throw setupError('ERR_IMAGE_HISTORY_READ', '从历史重开的画布未返回有效图片数据。');
  const reopenedHash = createHash('sha256').update(reopenedBytes.bytes).digest('hex');
  const persistedBytes = await readPersistedCanvasImage(resolvedRoot, persistedProject.nodes.find((node) => node.id === imageNodeId).metadata.storageKey);
  const persistedHash = createHash('sha256').update(persistedBytes.bytes).digest('hex');
  if (reopenedHash !== evidence.mcpRead.sha256 || persistedHash !== reopenedHash
    || reopenedBytes.bytes.length !== evidence.mcpRead.bytes
    || persistedBytes.bytes.length !== reopenedBytes.bytes.length
    || reopenedImage.width !== evidence.mcpRead.width || reopenedImage.height !== evidence.mcpRead.height
    || persistedBytes.mimeType !== reopenedBytes.mimeType) {
    throw setupError('ERR_IMAGE_HISTORY_PIXELS', '历史重开后的图片与宿主 MCP 首次读图或本机持久化像素不一致。');
  }

  const acceptance = {
    schemaVersion: 1,
    configRevision: record.revision,
    projectId,
    sourceNodeId: evidence.sourceNodeId,
    imageNodeId,
    sha256: reopenedHash,
    bytes: reopenedBytes.bytes.length,
    width: reopenedImage.width,
    height: reopenedImage.height,
    submittedAt: evidence.submittedAt,
    readAt: evidence.mcpRead.readAt,
    verifiedAt: now().toISOString(),
  };
  await writePrivateJson(resolvedRoot, 'image-acceptance.json', acceptance);
  return getSetupStatus({ root: resolvedRoot, repoRoot, env });
}

async function waitForCanvasTarget(runtime, clientId, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await runtime.status();
    const target = status.targets.find((item) => item.clientId === clientId && predicate(item));
    if (target) return target;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw setupError('ERR_IMAGE_HISTORY_REOPEN', 'Canvas 页面切换超时；请确认同一宿主窗口仍连接本机 Canvas。');
}

function assertAcceptedProjectImage(project, projectId, imageNodeId, evidence, model) {
  if (!project || (project.projectId || project.id) !== projectId || !Array.isArray(project.nodes) || !Array.isArray(project.connections)) {
    throw setupError('ERR_IMAGE_HISTORY_PROJECT', '历史项目内容无效或项目 ID 不匹配。');
  }
  if (!isFreshGeneratedImage(project, imageNodeId, evidence, model)) {
    throw setupError('ERR_IMAGE_ACCEPTANCE_NODE', '成图节点不是本次配置生成的新图片，或与生成配置节点没有连线。');
  }
}

function isFreshGeneratedImage(project, imageNodeId, evidence, model) {
  if ((project.projectId || project.id) !== evidence.projectId || !Array.isArray(project.nodes) || !Array.isArray(project.connections)
    || evidence.priorImageNodeIds.includes(imageNodeId)) return false;
  const source = project.nodes.find((node) => node.id === evidence.sourceNodeId);
  const image = project.nodes.find((node) => node.id === imageNodeId);
  const successfulImages = image?.metadata?.images?.filter((item) => item.status === 'success' && item.storageKey)?.length;
  return source?.type === 'config' && source.metadata?.generationMode === 'image'
    && String(source.metadata?.count ?? '') === '1'
    && (!source.metadata?.model || configuredCanvasImageModel(source.metadata.model, model))
    && image?.type === 'image' && image.metadata?.status === 'success'
    && image.metadata?.generationType === 'generation' && configuredCanvasImageModel(image.metadata?.model, model)
    && typeof image.metadata?.storageKey === 'string' && image.metadata.storageKey.startsWith('image:')
    && (!Array.isArray(image.metadata.images) || successfulImages === 1)
    && project.connections.some((connection) => connection.fromNodeId === evidence.sourceNodeId && connection.toNodeId === imageNodeId);
}

function configuredCanvasImageModel(value, model) {
  return value === model || value === `studio-image::${model}`;
}

async function readCanvasStoreRecord(root, store, key) {
  if (!validCanvasId(store) || typeof key !== 'string' || !key) throw setupError('ERR_IMAGE_HISTORY_STORAGE', 'Canvas 持久化键无效。');
  const directory = path.join(rootPath(root), 'storage', store);
  let directoryInfo;
  try { directoryInfo = await fs.lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw setupError('ERR_IMAGE_HISTORY_STORAGE', 'Canvas 持久化目录无效。');
  const filename = path.join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  let info;
  try { info = await fs.lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw setupError('ERR_IMAGE_HISTORY_STORAGE', 'Canvas 持久化记录无效。');
  let value;
  try { value = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch { throw setupError('ERR_IMAGE_HISTORY_STORAGE', 'Canvas 持久化记录无法解析。'); }
  if (value.key !== key || typeof value.contentType !== 'string' || typeof value.base64 !== 'string') {
    throw setupError('ERR_IMAGE_HISTORY_STORAGE', 'Canvas 持久化记录格式无效。');
  }
  return { contentType: value.contentType, bytes: Buffer.from(value.base64, 'base64') };
}

async function readPersistedCanvasProject(root, projectId) {
  const stored = await readCanvasStoreRecord(root, 'app_state', 'infinite-canvas:canvas_store');
  if (!stored || stored.contentType !== 'application/vnd.creative-agent-studio.localforage-string') return null;
  let value;
  try { value = JSON.parse(stored.bytes.toString('utf8')); }
  catch { throw setupError('ERR_IMAGE_HISTORY_STORAGE', '本机画布历史无法解析。'); }
  if (!Array.isArray(value?.state?.projects) || !Array.isArray(value?.state?.deletedProjects)) {
    throw setupError('ERR_IMAGE_HISTORY_STORAGE', '本机画布历史结构无效。');
  }
  const project = value.state.projects.find(item => item.id === projectId);
  return project ? { ...project, projectId: project.id } : null;
}

async function readPersistedCanvasImage(root, storageKey) {
  const stored = await readCanvasStoreRecord(root, 'image_files', storageKey);
  if (!stored || !['image/png', 'image/jpeg', 'image/webp'].includes(stored.contentType) || stored.bytes.length < 1) {
    throw setupError('ERR_IMAGE_HISTORY_STORAGE', '本机未找到成图的持久化像素文件。');
  }
  return { mimeType: stored.contentType, bytes: stored.bytes };
}

function decodeImageDataUrl(value) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value || '');
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.toString('base64') !== match[2]) return null;
  return { mimeType: match[1], bytes };
}

async function writePrivateJson(root, relative, value) {
  const directory = path.join(rootPath(root), 'setup');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw setupError('ERR_SETUP_PATH', '安装配置目录必须是普通目录');
  await fs.chmod(directory, 0o700);
  const destination = path.join(directory, relative);
  const temporary = path.join(directory, `.${relative}.${process.pid}.${cryptoRandom()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await fs.rename(temporary, destination);
    await fs.chmod(destination, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function removePrivateSetupFiles(root, names) {
  const resolvedRoot = rootPath(root);
  const directory = path.join(resolvedRoot, 'setup');
  let directoryInfo;
  try { directoryInfo = await fs.lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw setupError('ERR_SETUP_PATH', '安装配置目录必须是普通目录');
  const rootReal = await fs.realpath(resolvedRoot);
  const directoryReal = await fs.realpath(directory);
  if (!isInside(rootReal, directoryReal)) throw setupError('ERR_SETUP_PATH', '安装配置目录超出应用数据目录');
  for (const name of names) {
    const file = path.join(directory, name);
    let info;
    try { info = await fs.lstat(file); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isDirectory() && !info.isSymbolicLink()) throw setupError('ERR_SETUP_PATH', '安装验证记录必须是普通文件');
    await fs.unlink(file);
  }
}

/** Clear evidence before a new login attempt so a rejected replacement account cannot look ready. */
export async function beginMaterialLogin({ root } = {}) {
  await removePrivateSetupFiles(root, ['material-check.json', 'host-report.json']);
}

function cryptoRandom() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function modelsEndpoint(baseUrl) {
  const parsed = new URL(baseUrl);
  const basePath = parsed.pathname.replace(/\/+$/, '');
  const apiPath = /\/v1$/i.test(basePath) ? basePath : `${basePath}/v1`;
  parsed.pathname = `${apiPath}/models`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

/** Send only a non-paid GET /models request and persist a redacted outcome tied to config revision. */
export async function verifyImageApi({ root, fetchImpl = fetch, now = () => new Date() } = {}) {
  const resolvedRoot = rootPath(root);
  const record = await readConfigRecord({ root: resolvedRoot });
  const checkedAt = now().toISOString();
  let result;
  if (!record.image.baseUrl || !record.image.model || !record.image.apiKey) {
    result = { schemaVersion: 1, configRevision: record.revision, ok: false, statusCode: null, checkedAt, message: '图片 API 地址、模型和密钥必须填写后才能检查。' };
  } else {
    const url = modelsEndpoint(record.image.baseUrl);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${record.image.apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      const statusCode = Number.isInteger(response?.status) ? response.status : null;
      let ok = false;
      let message;
      if (!response?.ok) {
        message = `GET /models 检查失败：HTTP ${statusCode || '未知'}；未完成连接检查。`;
      } else {
        let payload;
        try { payload = await response.json(); }
        catch { payload = null; }
        const ids = Array.isArray(payload?.data)
          ? payload.data.map((model) => model?.id).filter((id) => typeof id === 'string')
          : [];
        if (!Array.isArray(payload?.data)) {
          message = 'GET /models 返回非 OpenAI 兼容的模型列表；未完成连接检查。';
        } else if (!ids.length) {
          message = 'GET /models 未返回模型 ID；未完成连接检查。';
        } else if (!ids.includes(record.image.model)) {
          message = `GET /models 未列出所配置模型“${record.image.model}”；未完成连接检查。`;
        } else {
          ok = true;
          message = `GET /models 已列出所配置模型“${record.image.model}”（HTTP ${statusCode}）；未调用图片生成，也未验证实际生图能力。`;
        }
      }
      result = { schemaVersion: 1, configRevision: record.revision, ok, statusCode, checkedAt, message };
    } catch (error) {
      const message = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'GET /models 连接超时（10 秒）。'
        : `GET /models 连接失败：${String(error?.message || '网络错误').replaceAll(record.image.apiKey, '[已隐藏]')}`;
      result = { schemaVersion: 1, configRevision: record.revision, ok: false, statusCode: null, checkedAt, message: message.slice(0, 300) };
    }
  }
  await writePrivateJson(resolvedRoot, 'image-check.json', result);
  return result;
}

/** Save image settings first, then record a non-paid /models connectivity result. */
export async function saveAndVerifyImageConfig(input, { root, repoRoot, env, fetchImpl = fetch, now = () => new Date() } = {}) {
  await saveConfig(input, { root });
  await verifyImageApi({ root, fetchImpl, now });
  return getSetupStatus({ root, repoRoot, env });
}

/** Record a redacted phase result tied to the exact locally saved Teedy credentials. */
export async function recordMaterialCheck(result, { root, credentialId, now = () => new Date() } = {}) {
  const config = await readMaterialConfig({ root });
  if (!config || !credentialId || config.credentialId !== credentialId) {
    throw setupError('ERR_MATERIAL_CHECK_STALE', '素材库账号在验证期间已变化；请重新运行素材检查。');
  }
  const phaseKeys = ['authenticated', 'queryVerified', 'downloadVerified'];
  if (!result || typeof result !== 'object'
    || phaseKeys.some((key) => typeof result[key] !== 'boolean')
    || !Number.isSafeInteger(result.bytes) || result.bytes < 0
    || typeof result.sha256 !== 'string') {
    throw setupError('ERR_MATERIAL_CHECK_RESULT', '素材库检查结果格式无效。');
  }
  const failedStages = ['config', 'login', 'query', 'download'];
  const failureCodes = ['config_invalid', 'login_failed', 'query_failed', 'download_failed', 'empty_download', 'no_small_image'];
  let failedStage = result.failedStage ?? null;
  if (failedStage !== null && !failedStages.includes(failedStage)) failedStage = 'config';
  if (!failedStage) failedStage = result.authenticated ? result.queryVerified ? result.downloadVerified ? null : 'download' : 'query' : 'login';
  const failureCode = result.failureCode ?? null;
  const normalizedFailureCode = failureCode === null || failureCodes.includes(failureCode) ? failureCode : 'config_invalid';
  const sha256 = /^[a-f\d]{64}$/i.test(result.sha256) ? result.sha256.toLowerCase() : '';
  const bytes = result.bytes;
  const checkedAt = now().toISOString();
  const check = {
    schemaVersion: 1,
    checkedAt,
    credentialId,
    baseUrl: config.baseUrl,
    authenticated: result.authenticated,
    queryVerified: result.queryVerified,
    downloadVerified: result.downloadVerified,
    bytes,
    sha256,
    failedStage,
    failureCode: normalizedFailureCode,
  };
  await writePrivateJson(root, 'material-check.json', check);
  return { ...check, source: '本机实际验证', independentlyVerified: true };
}

/** Verify the offered credentials before persisting them, then bind the check to the saved credential revision. */
export async function saveAndVerifyMaterials(input, { root, fetchImpl = fetch, now = () => new Date(), verifyImpl = verifyMaterials, saveImpl = saveMaterialConfig } = {}) {
  let result;
  try { result = await verifyImpl(input, { root, fetchImpl }); }
  catch {
    const error = setupError('ERR_MATERIAL_VERIFY', '素材库登录、查询或原件下载验证未完成。');
    error.stage = 'config';
    throw error;
  }
  const stagesPassed = result?.authenticated === true && result?.queryVerified === true && result?.downloadVerified === true
    && Number.isSafeInteger(result.bytes) && result.bytes > 0
    && typeof result.sha256 === 'string' && /^[a-f\d]{64}$/i.test(result.sha256)
    && (result.failedStage ?? null) === null;
  if (!stagesPassed) {
    const error = setupError('ERR_MATERIAL_VERIFY', '素材库登录、查询或原件下载验证未通过。');
    error.stage = ['config', 'login', 'query', 'download'].includes(result?.failedStage) ? result.failedStage
      : result?.authenticated !== true ? 'login' : result?.queryVerified !== true ? 'query' : 'download';
    error.failureCode = ['config_invalid', 'login_failed', 'query_failed', 'download_failed', 'empty_download', 'no_small_image'].includes(result?.failureCode)
      ? result.failureCode : null;
    throw error;
  }
  let saved;
  try {
    saved = await saveImpl({ baseUrl: input.baseUrl, username: input.username, password: input.password }, { root });
    if (!saved?.credentialId) throw new Error('missing credential id');
    await recordMaterialCheck(result, { root, credentialId: saved.credentialId, now });
  } catch {
    const error = setupError('ERR_MATERIAL_SAVE', '验证结果未能保存到本机；请重新运行素材库登录。');
    error.stage = 'save';
    throw error;
  }
  return { credentialId: saved.credentialId };
}

/** Record the two current-host tools only after a successful local login/query/download check. */
export async function reportHostProbe({ status, queryTool = '', downloadTool = '' } = {}, { root, now = () => new Date() } = {}) {
  if (!['connected', 'failed'].includes(status)) throw setupError('ERR_HOST_REPORT', '宿主报告状态只能是 connected 或 failed');
  const queryName = typeof queryTool === 'string' ? queryTool.trim() : '';
  const downloadName = typeof downloadTool === 'string' ? downloadTool.trim() : '';
  if (status === 'connected' && (!/^[\w.-]{1,120}$/.test(queryName) || !/^[\w.-]{1,120}$/.test(downloadName))) {
    throw setupError('ERR_HOST_REPORT', '成功的宿主报告必须提供查询和原件下载工具名');
  }
  const config = await readMaterialConfig({ root });
  const check = await readMaterialCheck(root);
  const checkPassed = Boolean(config && check && check.credentialId === config.credentialId && check.baseUrl === config.baseUrl
    && check.authenticated && check.queryVerified && check.downloadVerified && check.bytes > 0
    && /^[a-f\d]{64}$/i.test(check.sha256) && check.failedStage === null);
  if (status === 'connected' && !checkPassed) {
    throw setupError('ERR_HOST_REPORT', '请先完成当前账号的本机登录、查询和原件下载验证');
  }
  const report = {
    schemaVersion: 2,
    status,
    credentialId: checkPassed ? config.credentialId : null,
    materialCheckAt: checkPassed ? check.checkedAt : null,
    queryTool: status === 'connected' ? queryName : null,
    downloadTool: status === 'connected' ? downloadName : null,
    checkedAt: now().toISOString(),
  };
  await writePrivateJson(root, 'host-report.json', report);
  return {
    source: '宿主报告', status: report.status, queryTool: report.queryTool,
    downloadTool: report.downloadTool, checkedAt: report.checkedAt, independentlyVerified: false,
  };
}

export const setupDefaultsEnvironmentVariable = DEFAULTS_ENV;
