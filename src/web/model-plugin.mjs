import fs from 'node:fs/promises';
import path from 'node:path';
import { fork } from 'node:child_process';
import { dataRoot } from '../canvas/client.mjs';

export const MODEL_SOURCES = ['custom', 'opencode', 'kilo', 'workbuddy-cn', 'workbuddy-intl'];
const starts = new Map();
function pluginError(message) { return Object.assign(new Error(message), { code: 'ERR_MODEL_PLUGIN', statusCode: 503 }); }
export function matchesSource(model, source) {
  const prefix = { opencode: 'opencode/', kilo: 'kilo/', 'workbuddy-cn': 'buddy/', 'workbuddy-intl': 'workbuddy/' }[source];
  return Boolean(prefix && typeof model === 'string' && model.startsWith(prefix) && model.length > prefix.length);
}
async function descriptor(root) {
  try {
    const file = path.join(root, 'model-plugin', 'instance.json');
    if ((await fs.lstat(file)).isSymbolicLink()) return null;
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    const url = new URL(value.baseUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.port || typeof value.apiKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.apiKey)) return null;
    const response = await fetch(`${value.baseUrl}/health`, { headers: { authorization: `Bearer ${value.apiKey}` }, signal: AbortSignal.timeout(1500), redirect: 'error' });
    const health = await response.json();
    return response.ok && health.service === 'studio-model-plugin' && health.instanceId === value.instanceId ? value : null;
  } catch { return null; }
}
export async function ensureModelPlugin({ root = dataRoot() } = {}) {
  root = path.resolve(root);
  if (starts.has(root)) return starts.get(root);
  const pending = (async () => {
    const existing = await descriptor(root); if (existing) return existing;
    return new Promise((resolve, reject) => {
      const child = fork(path.resolve(import.meta.dirname, '../../scripts/model-plugin.mjs'), [root], {
        execArgv: ['--use-env-proxy'], detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      let done = false;
      const finish = async ok => {
        if (done) return; done = true; clearTimeout(timer);
        if (child.connected) child.disconnect(); child.unref();
        const value = await descriptor(root);
        if (value) resolve(value); else reject(pluginError(ok ? '模型插件未能连接' : '模型插件启动未完成，请检查本地运行环境'));
      };
      const timer = setTimeout(() => { child.kill('SIGTERM'); void finish(false); }, 15000);
      child.once('message', () => void finish(true));
      child.once('error', () => void finish(false));
      child.once('exit', () => void finish(false));
    });
  })();
  starts.set(root, pending);
  try { return await pending; } finally { starts.delete(root); }
}
export async function callModelPlugin(action, body, { root = dataRoot(), start = true, signal } = {}) {
  const connection = start ? await ensureModelPlugin({ root }) : await descriptor(root);
  if (!connection) return { running: false, accounts: [], login: { status: 'idle' } };
  const timeout = AbortSignal.timeout(action === 'models' ? 45000 : 30000);
  let response;
  try {
    response = await fetch(`${connection.baseUrl}/studio/${action}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${connection.apiKey}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error();
    return await response.json();
  } catch { throw pluginError('模型来源暂时不可用，请检查网络或重新连接账号'); }
}
export async function stopModelPlugin({ root = dataRoot() } = {}) { return callModelPlugin('stop', {}, { root, start: false }); }
