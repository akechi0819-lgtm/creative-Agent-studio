import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dataRoot } from '../canvas/client.mjs';
import { publicConfig, readConfigRecord, saveConfig, validateCompanyDefaults } from './config.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const DEFAULTS_ENV = 'COMPANY_LITE_DEFAULTS_FILE';

const SETUP_FILES = [
  'package.json',
  'scripts/setup.mjs',
  'scripts/studio.mjs',
  'src/lite/setup.mjs',
  'src/lite/config.mjs',
  'src/canvas/runtime.mjs',
];

const CANVAS_FILES = [
  'third_party/canvas/web/dist/index.html',
  'third_party/canvas/canvas-agent/dist/index.js',
];

const WORKBUDDY_MCP_GUIDE = 'https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide';

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
    if (!dependencyNames.includes('fflate')) throw new Error('package.json 缺少 Studio CLI 核心依赖 fflate');
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
  if (missing.length) issues.push(`安装包缺少文件：${missing.join('、')}`);
  if (manifestError) issues.push(`Studio CLI 运行依赖清单无效：${manifestError}`);
  if (missingDependencies.length) issues.push(`Studio CLI 运行依赖缺少：${missingDependencies.join('、')}`);
  const ready = nodeOk && missing.length === 0 && !manifestError && missingDependencies.length === 0;
  return {
    id: 'package',
    title: '检查安装包',
    status: ready ? 'ready' : 'needs_action',
    complete: ready,
    actionNeeded: !ready,
    summary: ready ? `Node.js ${nodeVersion}、Studio CLI 和运行依赖已就绪` : issues.join('；'),
    nextAction: ready ? '继续检查本地 Canvas 组件。' : '请使用完整公司 Lite 安装包；源码目录先运行 prepare:dev。',
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
    nextAction: ready ? '继续在 WorkBuddy 确认公司只读素材 MCP。' : '请使用包含 Canvas 预构建文件和运行依赖的完整安装包；源码目录先运行 prepare:dev。',
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

async function readWorkBuddyReport(root) {
  const value = await readJsonFile(path.join(root, 'setup', 'workbuddy-report.json'), 'WorkBuddy 宿主报告');
  if (value === null) return null;
  if (value.schemaVersion !== 1 || !['connected', 'failed'].includes(value.status)
    || typeof value.checkedAt !== 'string'
    || (value.toolName !== null && (typeof value.toolName !== 'string' || !/^[\w.-]{1,120}$/.test(value.toolName)))
    || (value.status === 'connected' && !value.toolName)) {
    throw setupError('ERR_SETUP_STATE', 'WorkBuddy 宿主报告格式无效');
  }
  return {
    status: value.status,
    checkedAt: safeTimestamp(value.checkedAt),
    toolName: value.toolName,
    source: 'WorkBuddy 宿主报告',
    independentlyVerified: false,
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

function stageLogs(steps, hostReport, imageCheck, defaultsError) {
  const logs = [];
  for (const step of steps) {
    for (const check of step.checks || []) {
      logs.push({ level: check.ok ? 'info' : 'error', stage: step.id, message: `${check.name}：${check.detail}` });
    }
  }
  if (hostReport) {
    logs.push({
      level: hostReport.status === 'connected' ? 'info' : 'error',
      stage: 'materials',
      at: hostReport.checkedAt,
      source: hostReport.source,
      message: hostReport.status === 'connected'
        ? `WorkBuddy 宿主报告：连接可用（只读工具：${hostReport.toolName}；independentlyVerified=false）。`
        : `WorkBuddy 宿主报告：连接检查未通过（${hostReport.toolName || '未提供工具名'}；independentlyVerified=false）。`,
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
  const [packageStep, canvasStep, record, hostReport, imageCheck, defaults, canvasMcpCheck] = await Promise.all([
    checkPackage(resolvedRepo, nodeVersion),
    checkCanvasComponent(resolvedRepo),
    readConfigRecord({ root: resolvedRoot }),
    readWorkBuddyReport(resolvedRoot),
    readImageCheck(resolvedRoot),
    loadDefaults(resolvedRepo, env),
    readJsonFile(path.join(resolvedRoot, 'setup', 'canvas-mcp-check.json'), '本地 Canvas MCP 检查'),
  ]);
  const componentsReady = canvasStep.complete;
  const mcpReady = canvasMcpCheck?.service === 'company-lite-canvas' && Boolean(safeTimestamp(canvasMcpCheck.checkedAt));
  canvasStep.componentsReady = componentsReady;
  canvasStep.mcpConnected = mcpReady;
  canvasStep.checks.push({name:'宿主调用本地 Canvas MCP',ok:mcpReady,detail:mcpReady ? canvasMcpCheck.checkedAt : '等待宿主实际调用 canvas_status'});
  if (componentsReady && !mcpReady) {
    Object.assign(canvasStep, {complete:false,status:'waiting',actionNeeded:true,
      summary:'画布组件已就绪，等待 WorkBuddy 接通本地 Canvas MCP。',
      nextAction:'运行 Studio mcp-config，把返回的本机命令配置为 WorkBuddy MCP 服务，再实际调用 canvas_status。无需打开画布或生成图片。'});
  }

  const materialReady = hostReport?.status === 'connected';
  const materialMcpUrl = defaults.materials?.mcpUrl || '';
  const materialLoginUrl = defaults.materials?.loginUrl || '';
  const hostInstruction = [
    '请在当前电脑的 WorkBuddy 中，使用本人公司账号完成以下操作。',
    materialMcpUrl
      ? `公司提供的只读 MCP 地址：${materialMcpUrl}。请先检查 WorkBuddy 中是否已有该服务；没有时按 WorkBuddy 官方 MCP 界面合同添加这个服务。不要猜测传输类型、认证字段或额外权限；如果缺少服务方要求的信息，先联系管理员补齐。`
      : '公司尚未提供素材 MCP 地址。请检查 WorkBuddy 中是否已有公司只读素材 MCP；如果没有，请暂停并等待管理员提供连接信息，不要猜测地址或配置协议。',
    materialLoginUrl ? `本人登录入口：${materialLoginUrl}。请由员工本人完成 WorkBuddy/公司登录。` : '请由员工本人在 WorkBuddy 完成登录；本能力包不读取或复制 WorkBuddy 凭据。',
    '在 WorkBuddy 的「插件」→「MCP 服务器」确认该服务显示连接成功，并实际调用一个只读素材工具确认返回成功。只记录工具名和成功/失败，不保存素材内容或凭据到安装记录。',
    '探测成功后，在 Company Lite 安装目录按系统调用包装入口：macOS `./Start.command report-workbuddy connected 实际工具名`；Windows `Start.cmd report-workbuddy connected 实际工具名`。若失败，把 connected 改成 failed。不要用系统 Node。',
    `WorkBuddy 官方 MCP 指引：${WORKBUDDY_MCP_GUIDE}`,
  ].join('\n\n');
  const materialsStep = {
    id: 'materials',
    title: '连接公司素材库',
    status: materialReady ? 'host_reported' : hostReport?.status === 'failed' ? 'needs_action' : 'waiting',
    complete: materialReady,
    actionNeeded: !materialReady,
    summary: materialReady
      ? `WorkBuddy 已报告连接可用（${hostReport.toolName}）`
      : hostReport?.status === 'failed'
        ? 'WorkBuddy 尚未报告连接成功，请重新完成检查。'
        : materialMcpUrl
          ? '等待 WorkBuddy 完成连接检查。'
          : '等待公司提供素材库连接。',
    nextAction: materialReady
      ? '继续配置图片服务。'
      : '在 WorkBuddy 中完成本人登录并执行只读素材检查，然后报告检查结果。',
    error: hostReport?.status === 'failed' ? { code: 'ERR_WORKBUDDY_HOST_PROBE', message: 'WorkBuddy 宿主报告的只读 MCP 探测未通过' } : null,
    checkedAt: hostReport?.checkedAt || null,
    source: hostReport?.source || null,
    independentlyVerified: false,
    mcpUrl: materialMcpUrl || null,
    loginUrl: materialLoginUrl || null,
    hostInstruction,
    checks: [{
      name: 'WorkBuddy 连接状态',
      ok: materialReady,
      detail: materialReady
        ? `WorkBuddy 已报告连接可用：${hostReport.toolName}（${hostReport.checkedAt || '时间未知'}）`
        : hostReport?.status === 'failed' ? 'WorkBuddy 尚未报告连接成功' : '等待 WorkBuddy 完成检查',
    }],
  };

  const imageConfigured = Boolean(record.image.baseUrl && record.image.model && record.image.apiKey);
  const imageVerified = imageConfigured && imageCheck?.configRevision === record.revision && imageCheck.ok;
  const imageNeedsAction = !imageVerified;
  if (imageCheck && record.image.apiKey) imageCheck.message = imageCheck.message.replaceAll(record.image.apiKey, '[已隐藏]');
  const safeImageSummary = imageConfigured && imageCheck?.configRevision === record.revision && imageCheck.ok
    ? '图片服务连接检查通过。'
    : !imageConfigured
      ? '填写图片服务地址、模型和密钥后检查连接。'
      : imageCheck?.configRevision === record.revision && !imageCheck.ok
        ? '图片服务连接检查未通过。'
        : '图片服务已保存，请检查连接。';
  const imageStep = {
    id: 'image',
    title: '图片服务连接',
    status: imageVerified ? 'ready' : 'needs_action',
    complete: imageVerified,
    actionNeeded: imageNeedsAction,
    summary: imageVerified ? '连接检查通过，尚未进行真实出图。' : safeImageSummary,
    nextAction: imageVerified
      ? '继续查看最终检查。'
      : '填写或确认图片服务地址、模型和密钥，然后保存并检查连接。',
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
      detail: imageVerified ? '连接检查通过；尚未进行真实出图。' : imageCheck?.configRevision === record.revision ? '连接检查未通过；请查看检查记录' : '当前配置尚未检查',
    }],
  };

  const steps = [packageStep, canvasStep, materialsStep, imageStep];
  const allReady = steps.every((step) => step.complete);
  const finishStep = {
    id: 'finish',
    title: '检查完成',
    status: allReady ? 'complete' : 'blocked',
    complete: allReady,
    actionNeeded: !allReady,
    summary: allReady ? '本地安装配置检查完成；创作时由 WorkBuddy 打开共享画布，历史作品持续保留。' : '仍有步骤未完成，检查结果不会提前标为成功。',
    nextAction: allReady ? '可在 WorkBuddy 开始创作；以后复用已保存的连接和图片配置。' : '由宿主继续处理当前未完成的一步。',
    error: null,
    checks: [{ name: '全部必需步骤', ok: allReady, detail: allReady ? '4 / 4 已就绪' : '需完成安装包、Canvas、WorkBuddy 宿主报告和图片 API 检查' }],
  };
  steps.push(finishStep);
  const currentStep = steps.find((step) => !step.complete) || finishStep;
  const logs = stageLogs(steps, hostReport, imageCheck?.configRevision === record.revision ? imageCheck : null, defaults.error);
  return {
    current: currentStep.id,
    actionNeeded: currentStep.actionNeeded,
    nextAction: currentStep.nextAction,
    complete: allReady,
    summary: allReady ? '本机准备已完成' : currentStep.summary,
    steps,
    logs,
    config: publicConfig(record),
    guide: {
      provider: 'WorkBuddy',
      url: WORKBUDDY_MCP_GUIDE,
      path: 'WorkBuddy「插件」→右上角「MCP 服务器」',
      account: '请在 WorkBuddy 本人账号中完成登录；Company Lite 只记录检查结果，不读取或复制 WorkBuddy 凭据。',
      note: '公司只读素材库继续使用现有 WorkBuddy MCP；Company Lite 不连接或替代 Teedy。如果公司服务未出现，请联系管理员确认应有的服务名称和只读权限；不要从其他应用复制凭据。没有实际宿主探测报告时，状态保持“等待 WorkBuddy 验证”。',
    },
  };
}

/** Called only by the Canvas MCP status tool after an actual protocol invocation. */
export async function recordCanvasMcpCheck({ root } = {}) {
  await writePrivateJson(root, 'canvas-mcp-check.json', {service:'company-lite-canvas',checkedAt:new Date().toISOString()});
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

function cryptoRandom() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function modelsEndpoint(baseUrl) {
  const parsed = new URL(baseUrl);
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/models`;
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

/** Record a sanitized result supplied by the WorkBuddy host after a real read-only MCP call. */
export async function reportWorkBuddyProbe({ status, toolName = '' } = {}, { root, now = () => new Date() } = {}) {
  if (!['connected', 'failed'].includes(status)) throw setupError('ERR_WORKBUDDY_REPORT', 'WorkBuddy 报告状态只能是 connected 或 failed');
  const normalizedTool = typeof toolName === 'string' ? toolName.trim() : '';
  if (status === 'connected' && !normalizedTool) throw setupError('ERR_WORKBUDDY_REPORT', '成功的 WorkBuddy 宿主报告必须提供实际只读工具名');
  if (normalizedTool && !/^[\w.-]{1,120}$/.test(normalizedTool)) throw setupError('ERR_WORKBUDDY_REPORT', 'WorkBuddy 工具名只能包含字母、数字、点、下划线或连字符');
  const report = {
    schemaVersion: 1,
    status,
    toolName: normalizedTool || null,
    checkedAt: now().toISOString(),
    source: 'WorkBuddy 宿主报告',
    independentlyVerified: false,
  };
  await writePrivateJson(root, 'workbuddy-report.json', report);
  return {
    source: report.source,
    status: report.status,
    toolName: report.toolName,
    checkedAt: report.checkedAt,
    independentlyVerified: false,
  };
}

export const setupDefaultsEnvironmentVariable = DEFAULTS_ENV;
