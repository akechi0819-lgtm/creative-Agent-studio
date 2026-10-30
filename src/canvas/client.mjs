import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

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
  if (!response.ok || body.instanceId !== config.instanceId) throw new Error('Canvas 实例身份不匹配');
  return body;
}
export async function callCanvasTool(name, input = {}, config, { signal } = {}) {
  signal?.throwIfAborted();
  config ||= await connection();
  const current = await health(config, { signal });
  const siteTool = ['site_navigate','canvas_list_projects'].includes(name);
  const targets=(current.targets || []).filter(t => (siteTool || t.hasCanvas) && (!config.projectId || t.projectId === config.projectId));
  if (!config.clientId && targets.length > 1) throw new Error('多个画布页已连接，请指定本对话使用的 projectId 和 clientId');
  const target = config.clientId ? targets.find(t => t.clientId === config.clientId) : targets[0];
  if (!target) throw new Error('目标 Canvas 页面尚未连接；请先打开画布并查看连接状态');
  const {clientId,projectId} = target;
  const response = await fetch(`${config.bridgeUrl}/api/tools`, {
    method:'POST', headers:{'content-type':'application/json','x-canvas-agent-token':config.token},
    body:JSON.stringify({name,input,projectId,clientId}),
    signal,
  });
  const body = await response.json();
  if (!response.ok || !body.ok) {
    const requestId = /^[0-9a-f-]{36}$/i.test(body.requestId || '') ? body.requestId : null;
    const actionableCode = response.status === 409 && actionableErrors.get(body.error);
    if (actionableCode) {
      throw Object.assign(new Error(body.error), {
        code: actionableCode, requestId, status: response.status, safeMessage: body.error,
      });
    }
    if (response.status === 409 && ['clientId 未连接到此服务实例', '当前网页尚未上报画布状态'].includes(body.error)) {
      throw Object.assign(new Error(`Canvas 未连接或状态尚未同步${requestId ? `（诊断编号 ${requestId}）` : ''}`), {
        code: 'ERR_CANVAS_DISCONNECTED', requestId, status: response.status,
        safeMessage: 'Canvas 未连接或状态尚未同步，请打开当前任务画布。',
      });
    }
    throw Object.assign(new Error(requestId
      ? `Canvas 工具请求失败（HTTP ${response.status}，诊断编号 ${requestId}）`
      : `${name}: Canvas 工具请求失败（HTTP ${response.status}）`), {
      code: 'ERR_CANVAS_TOOL_FAILED', requestId, status: response.status,
      safeMessage: requestId ? `Canvas 工具请求失败，请核对画布日志（诊断编号 ${requestId}）` : 'Canvas 工具请求失败，请核对画布状态。',
    });
  }
  return body.result;
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
