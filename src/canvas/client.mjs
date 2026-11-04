import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { canvasImportErrorCodes, createCanvasImportError, isCanvasImportError } from './import-errors.mjs';

export const root = path.resolve(import.meta.dirname, '../..');
const actionableErrors = new Map([
  ['图片服务尚未配置，请回到宿主智能体配置图片 API。', 'ERR_CANVAS_IMAGE_API_UNCONFIGURED'],
  ['该节点正在生成图片，请先查询 generation_get_status，完成后再生成。', 'ERR_CANVAS_NODE_BUSY'],
]);
export function dataRoot() {
  if (process.env.STUDIO_DATA_DIR) return path.resolve(process.env.STUDIO_DATA_DIR);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library/Application Support/Creative Agent Studio CompanyLite');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'Creative Agent Studio CompanyLite');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'creative-agent-studio-company-lite');
}
export async function connection() { return JSON.parse(await readFile(path.join(dataRoot(), 'canvas-instance.json'), 'utf8')); }
export async function health(config, { signal } = {}) {
  signal?.throwIfAborted();
  config ||= await connection();
  signal?.throwIfAborted();
  const response = await fetch(`${config.bridgeUrl}/health`, {headers:{'x-canvas-agent-token':config.token}, signal});
  const body = await response.json();
  if (!response.ok || body.instanceId !== config.instanceId) {
    throw Object.assign(new Error('Canvas 实例身份不匹配'), {
      requestId: canvasRequestId(response.headers.get('x-canvas-request-id')),
      status: response.status,
    });
  }
  return body;
}
export async function callCanvasTool(name, input = {}, config, { signal } = {}) {
  let phase = 'health';
  try {
    signal?.throwIfAborted();
    config ||= await connection();
    const current = await health(config, { signal });
    const siteTool = ['site_navigate','canvas_list_projects'].includes(name);
    const pageTargets=(current.targets || []).filter(t => !config.projectId || t.projectId === config.projectId);
    const targets=pageTargets.filter(t => siteTool || t.hasCanvas);
    if (!config.clientId && targets.length > 1) {
      if (name === 'canvas_import_image') throw createCanvasImportError(canvasImportErrorCodes.selectTarget);
      throw new Error('多个画布页已连接，请指定本对话使用的 projectId 和 clientId');
    }
    const target = config.clientId ? targets.find(t => t.clientId === config.clientId) : targets[0];
    if (!target) {
      if (name === 'canvas_import_image') {
        const pendingPage=pageTargets.find(t => !config.clientId || t.clientId === config.clientId);
        throw createCanvasImportError(pendingPage ? canvasImportErrorCodes.statePending : canvasImportErrorCodes.disconnected);
      }
      throw new Error('目标 Canvas 页面尚未连接；请先打开画布并查看连接状态');
    }
    const {clientId,projectId} = target;
    phase = 'tool';
    const response = await fetch(`${config.bridgeUrl}/api/tools`, {
      method:'POST', headers:{'content-type':'application/json','x-canvas-agent-token':config.token},
      body:JSON.stringify({name,input,projectId,clientId}),
      signal,
    });
    const body = name === 'canvas_import_image'
      ? await response.json().catch(() => null)
      : await response.json();
    if (!response.ok || !body?.ok) {
      const responseId = canvasRequestId(response.headers.get('x-canvas-request-id')) || canvasRequestId(body?.requestId);
      if (name === 'canvas_import_image') throw classifyCanvasImportFailure(response.status, body?.error, responseId);
      const actionableCode = response.status === 409 && actionableErrors.get(body?.error);
      if (actionableCode) {
        throw Object.assign(new Error(body.error), {
          code: actionableCode, requestId: responseId, status: response.status, safeMessage: body.error,
        });
      }
      if (response.status === 409 && ['clientId 未连接到此服务实例', '当前网页尚未上报画布状态'].includes(body?.error)) {
        throw Object.assign(new Error(`Canvas 未连接或状态尚未同步${responseId ? `（诊断编号 ${responseId}）` : ''}`), {
          code: 'ERR_CANVAS_DISCONNECTED', requestId: responseId, status: response.status,
          safeMessage: 'Canvas 未连接或状态尚未同步，请打开当前任务画布。',
        });
      }
      throw Object.assign(new Error(responseId
        ? `Canvas 工具请求失败（HTTP ${response.status}，诊断编号 ${responseId}）`
        : `${name}: Canvas 工具请求失败（HTTP ${response.status}）`), {
        code: 'ERR_CANVAS_TOOL_FAILED', requestId: responseId, status: response.status,
        safeMessage: responseId ? `Canvas 工具请求失败，请核对画布日志（诊断编号 ${responseId}）` : 'Canvas 工具请求失败，请核对画布状态。',
      });
    }
    return body.result;
  } catch (error) {
    if (name !== 'canvas_import_image' || isCanvasImportError(error)) throw error;
    if (signal?.aborted) throw error;
    throw createCanvasImportError(phase === 'health'
      ? canvasImportErrorCodes.bridgeUnavailable
      : canvasImportErrorCodes.resultUnknown, {
        requestId: canvasRequestId(error?.requestId),
        status: error?.status,
      });
  }
}

function classifyCanvasImportFailure(status, message, requestId) {
  if (status === 422 && message === '导入图片无法解码，请确认原件是有效的 PNG、JPEG 或 WebP。') {
    return createCanvasImportError(canvasImportErrorCodes.invalidImage, { requestId, status });
  }
  if (status === 400) return createCanvasImportError(canvasImportErrorCodes.invalidArguments, { requestId, status });
  if (status === 413) return createCanvasImportError(canvasImportErrorCodes.payloadTooLarge, { requestId, status });
  if (status === 401) return createCanvasImportError(canvasImportErrorCodes.invalidConnection, { requestId, status });
  if (status === 409 && ['目标 projectId/clientId 未连接', '目标 Canvas 页面尚未连接；请先打开画布并查看连接状态'].includes(message)) {
    return createCanvasImportError(canvasImportErrorCodes.disconnected, { requestId, status });
  }
  if (status === 409 && ['目标网页尚未上报画布状态', '当前网页尚未上报画布状态'].includes(message)) {
    return createCanvasImportError(canvasImportErrorCodes.statePending, { requestId, status });
  }
  if (status === 504 && message === '画布操作超时') {
    return createCanvasImportError(canvasImportErrorCodes.resultUnknown, { requestId, status });
  }
  if (status === 409 && message === '请求页面已断开') {
    return createCanvasImportError(canvasImportErrorCodes.resultUnknown, { requestId, status });
  }
  return createCanvasImportError(canvasImportErrorCodes.resultUnknown, { requestId, status });
}

function canvasRequestId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}
export async function recoverImage(nodeId, destination, config, { signal } = {}) {
  signal?.throwIfAborted();
  const result = await callCanvasTool('canvas_read_image', {nodeId}, config, { signal });
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s.exec(result.dataUrl || '');
  if (!match) throw new Error('未获得可回收的图片数据');
  await mkdir(path.dirname(destination), {recursive:true});
  signal?.throwIfAborted();
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length) throw new Error('图片为空');
  await writeFile(destination, bytes, { signal });
  return {nodeId, path:destination, bytes:bytes.length, width:result.width, height:result.height};
}
