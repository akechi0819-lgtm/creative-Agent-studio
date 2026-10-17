import path from 'node:path';
import { toolNames } from '../../third_party/canvas/canvas-agent/dist/canvas/schemas.js';
import { createCanvasManager } from '../web/canvas.mjs';
import { readCompanyConfig as readCompanyConfigDefault } from './config.mjs';
import {
  bindCompanyCanvasClient,
  ensureDetachedCompanyBridge,
  readCompanyCanvasBridgeConfig,
  startCompanyBridge,
  stopCompanyBridge,
} from './bridge.mjs';

const ADAPTER_IDENTITY = 'company-canvas/protocol-v1/task-scoped';
const PROTOCOL_VERSION = 1;
const SUPPORTED_TOOLS = new Set(toolNames);
const REQUIRED_GENERATION_TOOLS = Object.freeze([
  'canvas_get_state', 'canvas_apply_ops', 'canvas_import_image', 'canvas_read_image',
  'canvas_run_generation', 'generation_get_status', 'workbench_image_get_config',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function companyCanvasError(code, message) {
  const error = new Error(message);
  error.name = 'CompanyCanvasError';
  error.code = code;
  error.safeMessage = message;
  return error;
}

function isLoopback(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  const parts = host.split('.');
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function parseEndpoint(value, { protocol, loopback }) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== protocol || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (loopback ? !isLoopback(parsed.hostname) : isLoopback(parsed.hostname)) return null;
  return parsed;
}

function normalizeTaskConfig(record, taskId) {
  if (!UUID.test(taskId || '') || !record || typeof record !== 'object') {
    throw companyCanvasError('ERR_COMPANY_CANVAS_CONFIG', '公司 Canvas 任务 bridge 配置无效');
  }
  const web = parseEndpoint(record.webUrl, { protocol: 'https:', loopback: false });
  const bridge = parseEndpoint(record.bridgeUrl, { protocol: 'http:', loopback: true });
  const projectId = typeof record.projectId === 'string' ? record.projectId.trim() : '';
  const clientId = typeof record.clientId === 'string' ? record.clientId.trim() : '';
  const token = typeof record.token === 'string' ? record.token : '';
  if (!web || !bridge || !bridge.port || bridge.pathname !== '/' || !token.trim() || token !== token.trim()
    || projectId !== taskId || clientId.length > 300) {
    throw companyCanvasError('ERR_COMPANY_CANVAS_CONFIG', '公司 Canvas 任务必须绑定 HTTPS 网页、回环 bridge 和本地任务 projectId');
  }
  return {
    taskId,
    webUrl: web.toString().replace(/\/$/u, '') || web.toString(),
    bridgeUrl: bridge.toString().replace(/\/$/u, ''),
    token,
    projectId,
    clientId,
  };
}

function safeTargetTitle(value) {
  if (typeof value !== 'string') return undefined;
  const title = value.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/https?:\/\/\S+/gi, '[已隐藏链接]')
    .replace(/\b(?:bearer\s+)?[a-z0-9_-]{32,}\b/gi, '[已隐藏凭据]')
    .trim().slice(0, 100);
  return title || undefined;
}

function normalizedHealth(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const hasTargetList = Array.isArray(source.targets);
  const targets = (hasTargetList ? source.targets : [])
    .filter((target) => target && typeof target === 'object' && !Array.isArray(target))
    .map((target) => ({
      projectId: typeof target.projectId === 'string' ? target.projectId : '',
      clientId: typeof target.clientId === 'string' ? target.clientId : '',
      hasCanvas: target.hasCanvas === true,
      ...(safeTargetTitle(target.title) ? { title: safeTargetTitle(target.title) } : {}),
    }));
  const protocolSupported = source.ok === true && source.protocolVersion === PROTOCOL_VERSION
    && typeof source.projectId === 'string' && Boolean(source.projectId.trim())
    && typeof source.instanceId === 'string' && Boolean(source.instanceId.trim())
    && hasTargetList
    && targets.every((target) => target.projectId === source.projectId && Boolean(target.clientId));
  return {
    ok: source.ok === true,
    protocolVersion: Number.isInteger(source.protocolVersion) ? source.protocolVersion : null,
    protocolSupported,
    projectId: typeof source.projectId === 'string' ? source.projectId : '',
    instanceId: typeof source.instanceId === 'string' ? source.instanceId : '',
    targets,
  };
}

function summarizeCapabilities(config, current, { snapshot, stateStatus, readImageStatus } = {}) {
  const targets = current?.targets || [];
  const report = {
    configured: Boolean(config),
    health: current?.ok ? 'ok' : config ? 'unavailable' : 'not-configured',
    protocolVersion: current?.protocolVersion ?? null,
    protocolSupported: current?.protocolSupported === true,
    targets,
    target: { projectBound: false, clientBound: false, verified: false },
    supportedTools: [],
    missing: [],
    missingTools: [],
    unverified: [],
    page: { state: stateStatus || 'not-checked', imageRead: readImageStatus || 'not-checked', imageImport: 'not-probed', storageKey: 'not-checked' },
    readyForGeneration: false,
    message: '',
  };
  if (!config) {
    report.missing = ['任务级 bridge'];
    report.message = '公司 Canvas 使用任务级 bridge；请从具体任务打开画布以创建独立连接。';
    return report;
  }
  if (!current?.ok) {
    report.missing = ['任务级 bridge health'];
    report.message = '该任务的公司 Canvas bridge 暂不可读；未调用绘图工具。';
    return report;
  }
  if (!report.protocolSupported) {
    report.missing = ['protocol v1（health 中的 protocolVersion/projectId/instanceId/targets，以及逐次工具请求的 projectId/clientId）'];
    report.message = '该任务 bridge 不符合新版公司 Canvas protocol v1；未执行远端工具调用。';
    return report;
  }
  report.supportedTools = REQUIRED_GENERATION_TOOLS.filter((name) => SUPPORTED_TOOLS.has(name));
  report.missingTools = REQUIRED_GENERATION_TOOLS.filter((name) => !SUPPORTED_TOOLS.has(name));
  if (report.missingTools.length) report.missing.push(...report.missingTools);
  report.target.projectBound = current.projectId === config.projectId;
  if (!report.target.projectBound) report.missing.push('任务 projectId 与 bridge projectId 匹配');

  const connected = targets.filter((target) => target.hasCanvas && target.projectId === config.projectId);
  const exact = config.clientId ? connected.filter((target) => target.clientId === config.clientId) : [];
  report.target.clientBound = connected.length === 1 && exact.length === 1;
  report.target.verified = report.target.projectBound && connected.length === 1 && exact.length === 1;
  if (!report.target.verified) report.missing.push(connected.length > 1
    ? '多个 Canvas 页面连接；关闭多余页面后重试'
    : '唯一在线 hasCanvas clientId');
  if (stateStatus !== 'verified') report.missing.push('canvas_get_state 对任务身份的只读核对');
  if (readImageStatus === 'failed' || readImageStatus === 'missing') report.missing.push('canvas_read_image 对现有图片节点的只读核对');
  if (Array.isArray(snapshot?.nodes)) {
    const imageNodes = snapshot.nodes.filter((node) => node?.type === 'image');
    if (!imageNodes.length) report.page.storageKey = 'unverified-empty-canvas';
    else if (imageNodes.every((node) => typeof node.metadata?.storageKey === 'string' && node.metadata.storageKey.startsWith('image:'))) {
      report.page.storageKey = 'verified-existing-images';
    } else {
      report.page.storageKey = 'missing-on-existing-images';
      report.missing.push('现有图片节点 metadata.storageKey=image:…');
    }
  }
  report.unverified.push('canvas_import_image 的远端页面执行结果（诊断不会写入测试图片）');
  if (report.page.storageKey === 'unverified-empty-canvas') report.unverified.push('图片导入后写入 image: storageKey（空画布没有可核验图片）');
  report.readyForGeneration = report.target.verified && stateStatus === 'verified'
    && !report.missingTools.length && !report.missing.length;
  report.message = report.readyForGeneration
    ? '已核对任务级新版 bridge、明确目标和画布读取；图片导入仍未通过诊断写入验证。'
    : '公司 Canvas 目标或只读能力核对未通过；未执行画布写入。';
  return report;
}

function templateReport(webUrl) {
  const configured = Boolean(parseEndpoint(webUrl, { protocol: 'https:', loopback: false }));
  return {
    configured,
    health: 'not-started',
    protocolVersion: null,
    protocolSupported: false,
    targets: [],
    target: { projectBound: false, clientBound: false, verified: false },
    supportedTools: [],
    missing: configured ? ['taskId', '任务级 bridge'] : ['webUrl'],
    missingTools: [],
    unverified: [],
    page: { state: 'not-checked', imageRead: 'not-checked', imageImport: 'not-probed', storageKey: 'not-checked' },
    readyForGeneration: false,
    message: configured
      ? 'HTTPS 网页模板已配置；请从具体任务打开 Canvas，诊断该任务自己的 bridge 和页面能力。'
      : '请先配置公司 Canvas HTTPS 网页地址。',
  };
}

/** Reuse the shared Canvas manager while assigning every task its own v1 bridge and remote project. */
export function createCompanyCanvasManager({
  root,
  readConfig,
  readCompanyConfig = readCompanyConfigDefault,
  request = fetch,
  regionDetector,
  detachedBridge = false,
} = {}) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('公司 Canvas manager 需要数据根目录');
  if (typeof readConfig !== 'function') throw new Error('公司 Canvas manager 需要 readConfig');
  if (typeof readCompanyConfig !== 'function') throw new Error('公司 Canvas manager 需要 readCompanyConfig');
  if (typeof request !== 'function') throw new Error('公司 Canvas manager 需要 HTTP 请求实现');
  if (typeof detachedBridge !== 'boolean') throw new Error('公司 Canvas detachedBridge 必须是布尔值');
  const dataRoot = path.resolve(root);
  const ownedBridgeTasks = new Set();

  async function readValidatedConfig(taskId) {
    if (!UUID.test(taskId || '')) throw companyCanvasError('ERR_COMPANY_CANVAS_TASK', '公司 Canvas 需要有效的本地任务 ID');
    let record;
    try { record = await readCompanyCanvasBridgeConfig({ root: dataRoot, taskId }); }
    catch { throw companyCanvasError('ERR_COMPANY_CANVAS_CONFIG', '公司 Canvas 任务连接配置无法读取'); }
    return record ? normalizeTaskConfig(record, taskId) : null;
  }

  async function bridgeHealth(config, { signal } = {}) {
    let response;
    try {
      response = await request(`${config.bridgeUrl}/health`, {
        headers: { 'x-canvas-agent-token': config.token },
        signal: signal || AbortSignal.timeout(3500),
        redirect: 'error',
      });
    } catch { throw companyCanvasError('ERR_COMPANY_CANVAS_HEALTH', '公司 Canvas bridge health 请求失败'); }
    let body;
    try { body = await response.json(); }
    catch { throw companyCanvasError('ERR_COMPANY_CANVAS_HEALTH', '公司 Canvas bridge health 响应无效'); }
    if (!response.ok || body?.ok !== true) throw companyCanvasError('ERR_COMPANY_CANVAS_HEALTH', '公司 Canvas bridge health 未通过');
    return normalizedHealth(body);
  }

  function assertProtocol(config, current) {
    if (!current?.protocolSupported) {
      throw companyCanvasError('ERR_COMPANY_CANVAS_PROTOCOL', '公司 Canvas 仅支持新版 protocol v1 bridge；未执行远端工具调用');
    }
    if (current.projectId !== config.projectId) {
      throw companyCanvasError('ERR_COMPANY_CANVAS_TARGET', '公司 Canvas bridge projectId 与本地任务 ID 不匹配');
    }
  }

  async function assertProtocolTarget(config, current) {
    assertProtocol(config, current);
    if (!config?.projectId || !config?.clientId) {
      throw companyCanvasError('ERR_COMPANY_CANVAS_TARGET', '公司 Canvas 工具调用缺少本地任务的显式 clientId');
    }
    const exact = current.targets.filter((target) => target.hasCanvas
      && target.projectId === config.projectId && target.clientId === config.clientId);
    if (exact.length !== 1) {
      throw companyCanvasError('ERR_COMPANY_CANVAS_TARGET', '公司 Canvas bridge 未返回唯一匹配的在线客户端；未执行远端工具调用');
    }
  }

  async function canvasTool(name, input = {}, config, { signal } = {}) {
    if (typeof name !== 'string' || !SUPPORTED_TOOLS.has(name)) {
      throw companyCanvasError('ERR_COMPANY_CANVAS_CAPABILITY_MISSING', '新版公司 Canvas bridge 工具表中不包含该工具；未执行远端操作');
    }
    const current = await bridgeHealth(config, { signal });
    if (typeof config.__companyBridgeInstanceId === 'string'
      && current.instanceId !== config.__companyBridgeInstanceId) {
      throw companyCanvasError('ERR_CANVAS_TARGET_CHANGED', '公司 Canvas bridge 实例在本次操作中变化；未发送工具请求');
    }
    await assertProtocolTarget(config, current);
    let response;
    try {
      response = await request(`${config.bridgeUrl}/api/tools`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-canvas-agent-token': config.token },
        body: JSON.stringify({ name, input, projectId: config.projectId, clientId: config.clientId }),
        signal: signal || AbortSignal.timeout(40_000),
        redirect: 'error',
      });
    } catch { throw companyCanvasError('ERR_COMPANY_CANVAS_TOOL', '公司 Canvas 工具请求失败'); }
    let body;
    try { body = await response.json(); }
    catch { throw companyCanvasError('ERR_COMPANY_CANVAS_TOOL', '公司 Canvas 工具响应无效'); }
    if (!response.ok || body?.ok !== true) {
      if (response.status === 400 || response.status === 404 || response.status === 501) {
        throw companyCanvasError('ERR_COMPANY_CANVAS_CAPABILITY_MISSING', `新版公司 Canvas 页面未能提供 ${name}；没有自动降级`);
      }
      throw companyCanvasError('ERR_COMPANY_CANVAS_TOOL', '公司 Canvas 工具调用失败');
    }
    return body.result;
  }

  function assertSnapshot({ config, snapshot }) {
    if (!snapshot || snapshot.projectId !== config.projectId || snapshot.clientId !== config.clientId) {
      throw companyCanvasError('ERR_CANVAS_DISCONNECTED', '当前 Canvas projectId/clientId 与本地任务绑定不一致');
    }
  }

  async function resolveTarget({ config, current }) {
    assertProtocol(config, current);
    const connected = current.targets.filter((target) => target.hasCanvas && target.projectId === config.projectId);
    if (connected.length > 1) {
      throw companyCanvasError('ERR_CANVAS_AMBIGUOUS', '当前任务有多个在线 Canvas 页面；关闭多余标签页后重试');
    }
    const exact = config.clientId ? connected.find((target) => target.clientId === config.clientId) : null;
    if (exact) return { projectId: config.projectId, clientId: exact.clientId };
    if (connected.length === 0) {
      throw companyCanvasError('ERR_CANVAS_DISCONNECTED', '当前任务 Canvas 页面尚未连接，请重新打开任务画布');
    }
    const clientId = connected[0].clientId;
    try { await bindCompanyCanvasClient({ root: dataRoot, taskId: config.taskId, clientId }); }
    catch { throw companyCanvasError('ERR_COMPANY_CANVAS_BINDING', '无法保存当前任务的私有 Canvas 页面绑定'); }
    config.clientId = clientId;
    return { projectId: config.projectId, clientId };
  }

  async function readImageProbe(config, snapshot) {
    const image = Array.isArray(snapshot?.nodes) ? snapshot.nodes.find((node) => node?.type === 'image' && typeof node.id === 'string') : null;
    if (!image) return 'unverified-empty';
    try {
      const result = await canvasTool('canvas_read_image', { nodeId: image.id }, config);
      return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/s.test(result?.dataUrl || '') ? 'verified' : 'failed';
    } catch (error) {
      return error?.code === 'ERR_COMPANY_CANVAS_CAPABILITY_MISSING' ? 'missing' : 'failed';
    }
  }

  async function savedImageConfig() {
    let record;
    try { record = await readConfig({ root: dataRoot }); }
    catch { throw companyCanvasError('ERR_COMPANY_CANVAS_IMAGE_CONFIG', '无法读取本机已保存的图片模型配置'); }
    const source = record?.image;
    const baseUrl = typeof source?.baseUrl === 'string' ? source.baseUrl.trim() : '';
    const model = typeof source?.model === 'string' ? source.model.trim() : '';
    const apiKey = typeof source?.apiKey === 'string' ? source.apiKey : '';
    if (!baseUrl || !model || !apiKey) return null;
    let parsed;
    try { parsed = new URL(baseUrl); } catch { throw companyCanvasError('ERR_COMPANY_CANVAS_IMAGE_CONFIG', '本机图片模型配置无效'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash
      || baseUrl.length > 2000 || model.length > 300 || apiKey.length > 5000) {
      throw companyCanvasError('ERR_COMPANY_CANVAS_IMAGE_CONFIG', '本机图片模型配置无效');
    }
    return { baseUrl, model, apiKey };
  }

  async function issueTicket(config) {
    let response;
    try {
      response = await request(`${config.bridgeUrl}/__company/open-ticket`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-canvas-agent-token': config.token },
        body: JSON.stringify({ projectId: config.projectId }),
        signal: AbortSignal.timeout(3500),
        redirect: 'error',
      });
    } catch { throw companyCanvasError('ERR_COMPANY_CANVAS_BOOTSTRAP', '公司 Canvas 一次性连接票据请求失败'); }
    let result;
    try { result = await response.json(); } catch { result = null; }
    if (!response.ok || result?.ok !== true || !/^[a-f0-9]{64}$/u.test(result.ticket || '')
      || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()) {
      throw companyCanvasError('ERR_COMPANY_CANVAS_BOOTSTRAP', '公司 Canvas bootstrap ticket 能力缺失或响应无效');
    }
    const url = new URL('/canvas', config.webUrl);
    url.searchParams.set('mode', 'recent');
    url.searchParams.set('projectId', config.projectId);
    url.hash = new URLSearchParams({ companyBridge: config.bridgeUrl, companyTicket: result.ticket }).toString();
    return url.toString();
  }

  async function diagnose({ taskId, config: suppliedConfig, health: suppliedHealth, snapshot: suppliedSnapshot } = {}) {
    let config = suppliedConfig;
    if (!config && taskId) {
      try { config = await readValidatedConfig(taskId); }
      catch { return summarizeCapabilities(null, null); }
      if (!config) {
        try {
          const record = await readCompanyConfig({ root: dataRoot });
          const report = templateReport(record.canvas?.webUrl || '');
          report.missing = ['任务级 bridge'];
          report.message = report.configured
            ? 'HTTPS 网页模板已配置；此任务尚未打开 Canvas，因此没有任务级 bridge。'
            : '请先配置公司 Canvas HTTPS 网页地址。';
          return report;
        } catch { return templateReport(''); }
      }
    }
    if (!taskId && !config) {
      try {
        const record = await readCompanyConfig({ root: dataRoot });
        return templateReport(record.canvas?.webUrl || '');
      } catch { return templateReport(''); }
    }
    if (!config) return summarizeCapabilities(null, null);
    let current = suppliedHealth;
    try { current ||= await bridgeHealth(config); }
    catch { return summarizeCapabilities(config, null); }
    if (!current.protocolSupported || current.projectId !== config.projectId) return summarizeCapabilities(config, current);

    let stateStatus = 'not-checked';
    let readImageStatus = 'not-checked';
    let snapshot = suppliedSnapshot;
    let target;
    try {
      target = await resolveTarget({ config, current });
      if (!snapshot) snapshot = await canvasTool('canvas_get_state', {}, config);
      assertSnapshot({ config, snapshot });
      stateStatus = 'verified';
      if (readImageStatus === 'not-checked') readImageStatus = await readImageProbe(config, snapshot);
    } catch (error) {
      if (error?.code === 'ERR_CANVAS_AMBIGUOUS') stateStatus = 'ambiguous';
      else stateStatus = error?.code === 'ERR_CANVAS_DISCONNECTED' ? 'disconnected' : 'failed';
    }
    const report = summarizeCapabilities(config, current, { snapshot, stateStatus, readImageStatus });
    if (target) report.target = { projectBound: true, clientBound: true, verified: true };
    return report;
  }

  const connectionAdapter = {
    identity: ADAPTER_IDENTITY,
    async load({ taskId }) {
      const config = await readValidatedConfig(taskId);
      return config;
    },
    async ensure({ taskId }) {
      let template;
      try { template = await readCompanyConfig({ root: dataRoot }); }
      catch { throw companyCanvasError('ERR_COMPANY_CANVAS_CONFIG', '公司 Canvas 网页模板无法读取'); }
      if (!parseEndpoint(template.canvas?.webUrl, { protocol: 'https:', loopback: false })) {
        throw companyCanvasError('ERR_COMPANY_CANVAS_CONFIG', '请先配置公司 Canvas HTTPS 网页地址');
      }
      let bridgeHandle;
      try {
        bridgeHandle = detachedBridge
          ? await ensureDetachedCompanyBridge({ root: dataRoot, taskId, webUrl: template.canvas.webUrl })
          : await startCompanyBridge({ root: dataRoot, taskId, webUrl: template.canvas.webUrl });
      }
      catch (error) {
        throw error?.code ? error : companyCanvasError('ERR_COMPANY_CANVAS_BRIDGE_START', '该任务的公司 Canvas bridge 启动失败');
      }
      if (!detachedBridge && bridgeHandle.owned !== false) ownedBridgeTasks.add(taskId);
      return await readValidatedConfig(taskId);
    },
    async stop({ taskId }) {
      if (detachedBridge || !ownedBridgeTasks.has(taskId)) return;
      await stopCompanyBridge({ root: dataRoot, taskId });
      ownedBridgeTasks.delete(taskId);
    },
    resolveTarget,
    assertSnapshot,
    openUrl: async ({ config }) => issueTicket(config),
    diagnose,
  };

  const manager = createCanvasManager({
    root: dataRoot,
    readConfig,
    canvasTool,
    bridgeHealth,
    ...(regionDetector ? { regionDetector } : {}),
    connectionAdapter,
  });

  return {
    ...manager,
    diagnose: (input = {}) => diagnose(typeof input === 'string' ? { taskId: input } : input),
    async connect(taskId) {
      if (!taskId) throw companyCanvasError('ERR_COMPANY_CANVAS_TASK', '请从一个具体任务打开公司 Canvas');
      const result = await manager.ensure(taskId);
      return { openUrl: result.openUrl, projectId: taskId, clientConnected: result.clientConnected };
    },
    async checkImageConfig(taskId) {
      let image;
      try { image = await savedImageConfig(); }
      catch { return { configured: false, provider: 'openai-compatible', model: null, connectionTested: false, error: 'local-image-config-unavailable' }; }
      return {
        configured: Boolean(image), provider: 'openai-compatible',
        model: image?.model || null, connectionTested: false,
        ...(taskId ? { taskId } : {}),
      };
    },
    async executionOptions(taskId, options) {
      const report = await diagnose({ taskId });
      if (!report.protocolSupported || !report.target.verified || report.page.state !== 'verified') {
        throw companyCanvasError('ERR_COMPANY_CANVAS_CAPABILITY_MISSING', report.message || '公司 Canvas 尚未通过新版目标和只读能力核对');
      }
      const execution = await manager.executionOptions(taskId, options);
      const image = await savedImageConfig();
      if (!image) throw companyCanvasError('ERR_COMPANY_CANVAS_IMAGE_CONFIG', '请先在本机配置已保存的图片模型地址、模型和密钥');
      const operationHealth = await bridgeHealth(execution.config);
      await assertProtocolTarget(execution.config, operationHealth);
      const operationInstanceId = operationHealth.instanceId;
      const assertOperationInstance = async (candidate, signal) => {
        if (candidate?.projectId !== execution.config.projectId || candidate?.clientId !== execution.config.clientId
          || candidate?.connectionKind !== ADAPTER_IDENTITY) {
          throw companyCanvasError('ERR_CANVAS_TARGET_CHANGED', '公司 Canvas 任务绑定在本次操作中变化；未发送工具请求');
        }
        const current = await bridgeHealth(execution.config, { signal });
        if (current.instanceId !== operationInstanceId) {
          throw companyCanvasError('ERR_CANVAS_TARGET_CHANGED', '公司 Canvas bridge 实例在本次操作中变化；未发送工具请求');
        }
        await assertProtocolTarget(execution.config, current);
        return current;
      };
      const allowedModels = new Set([image.model, `studio-image::${image.model}`]);
      const guardedTool = async (name, input, config, callOptions) => {
        await assertOperationInstance(config, callOptions?.signal);
        if (name === 'canvas_apply_ops' && Array.isArray(input?.ops)) {
          for (const operation of input.ops) {
            const model = operation?.metadata?.model;
            if (typeof model === 'string' && model && !allowedModels.has(model)) {
              throw companyCanvasError('ERR_COMPANY_CANVAS_IMAGE_CONFIG', '所选生图模型与本机已保存图片模型不一致');
            }
          }
        }
        return execution.tool(name, input, { ...config, __companyBridgeInstanceId: operationInstanceId }, callOptions);
      };
      const guardedHealth = async (candidate, callOptions) => {
        await assertOperationInstance(candidate, callOptions?.signal);
        return execution.getHealth(candidate, callOptions);
      };
      return { ...execution, model: image.model, getHealth: guardedHealth, tool: guardedTool };
    },
    async state(taskId) {
      return manager.state(taskId);
    },
  };
}

export const companyCanvasProtocol = Object.freeze({
  identity: ADAPTER_IDENTITY,
  version: PROTOCOL_VERSION,
  requiredGenerationTools: REQUIRED_GENERATION_TOOLS,
});
