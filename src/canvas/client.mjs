import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const root = path.resolve(import.meta.dirname, '../..');
export function dataRoot() {
  if (process.env.STUDIO_DATA_DIR) return path.resolve(process.env.STUDIO_DATA_DIR);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library/Application Support/Creative Agent Studio');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'Creative Agent Studio');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'creative-agent-studio');
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
  const targets=(current.targets || []).filter(t => t.hasCanvas && t.projectId === config.projectId);
  if (!config.clientId && targets.length > 1) throw new Error("多个目标编辑页已连接，请显式选择 clientId");
  const clientId = config.clientId || targets[0]?.clientId;
  if (!clientId) throw new Error('目标 Canvas 编辑页尚未连接');
  const response = await fetch(`${config.bridgeUrl}/api/tools`, {
    method:'POST', headers:{'content-type':'application/json','x-canvas-agent-token':config.token},
    body:JSON.stringify({name,input,projectId:config.projectId,clientId}),
    signal,
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(`${name}: ${body.error || response.status}`);
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
