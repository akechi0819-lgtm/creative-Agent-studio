import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { FreeModelAdapter, ROUTE_MAIN, ROUTE_REGION } from '../../third_party/our-free-model/src/adapter.js';
import { createForwardCompletion } from '../../third_party/our-free-model/src/core/completion.js';
import { buildCatalog, buildKiloCatalog, parseListing } from '../../third_party/our-free-model/src/catalog.js';
import { getJson } from '../../third_party/our-free-model/src/http.js';
import { fetchKiloListing } from '../../third_party/our-free-model/src/kilo.js';
import { startForwardServer, keyMatches } from '../../third_party/our-free-model/src/forward.js';

export const SOURCES = ['opencode', 'kilo', 'workbuddy-cn', 'workbuddy-intl'];
export function modelMatchesSource(model, source) {
  const prefix = { opencode: 'opencode/', kilo: 'kilo/', 'workbuddy-cn': 'buddy/', 'workbuddy-intl': 'workbuddy/' }[source];
  return Boolean(prefix && typeof model === 'string' && model.startsWith(prefix) && model.length > prefix.length);
}
const quiet = { info() {}, warn() {}, error() {}, log() {} };
const idle = () => ({ accounts: [], login: { status: 'idle' } });
function fail(message, statusCode = 503) { return Object.assign(new Error(message), { statusCode }); }
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 16384) throw fail('请求过大', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw fail('请求格式无效', 400); }
}

/** Studio-owned lifecycle; only the chosen anonymous lane and the Buddy worker can make requests. */
export async function startModelPlugin({ root, port = 0, onStop = () => {} }) {
  const directory = path.join(root, 'model-plugin');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw fail('模型插件目录不能是链接');
  await fs.chmod(directory, 0o700);
  const lockPath = path.join(directory, 'service.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const old = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    let alive = true; try { process.kill(old.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (alive) throw fail('模型插件已在运行');
    await fs.unlink(lockPath); lock = await fs.open(lockPath, 'wx', 0o600);
  }
  const instanceId = crypto.randomUUID();
  await lock.writeFile(JSON.stringify({ pid: process.pid, instanceId }));
  const apiKey = crypto.randomBytes(32).toString('hex');
  const lifetime = new AbortController();
  const catalogs = new Map(); const pending = new Map();
  let buddyPromise; let listener; let closing;
  async function buddy() {
    if (!buddyPromise) buddyPromise = import('./workbuddy.mjs').then(({ createWorkBuddy }) => createWorkBuddy({ dataDir: directory, logger: quiet })).catch(() => { buddyPromise = undefined; throw fail('WorkBuddy 服务未能启动'); });
    return buddyPromise;
  }
  async function refresh(source) {
    if (!SOURCES.includes(source)) throw fail('模型来源无效', 400);
    if (pending.has(source)) return pending.get(source);
    const run = (async () => {
      try {
        let rows;
        if (source === 'opencode') rows = buildCatalog(parseListing(await getJson('/zen/v1/models', { signal: lifetime.signal }))).map(entry => ({ ...entry, upstreamId: entry.id, id: `opencode/${entry.id}` }));
        else if (source === 'kilo') {
          const payload = await fetchKiloListing({ signal: lifetime.signal });
          rows = buildKiloCatalog(Array.isArray(payload) ? payload : payload.data ?? payload.models ?? []).map(entry => ({ ...entry, upstreamId: entry.id, id: `kilo/${entry.id}` }));
        }
        else rows = (await (await buddy()).models()).filter(row => modelMatchesSource(row.id, source));
        catalogs.set(source, rows); return rows;
      } catch { throw fail('暂时无法获取该来源的模型，请稍后重试或选择其他来源'); }
    })();
    pending.set(source, run);
    try { return await run; } finally { pending.delete(source); }
  }
  function rows() { return [...catalogs.values()].flat().map(row => ({ id: row.id, name: row.name || row.id, vision: row.vision === true, object: 'model', owned_by: 'studio-model-plugin' })); }
  async function complete(request, onChunk) {
    const source = SOURCES.find(source => modelMatchesSource(request.model, source));
    if (!source) throw fail('此模型来源未接入', 404);
    if (!catalogs.has(source)) await refresh(source);
    const entry = catalogs.get(source).find(row => row.id === request.model);
    if (!entry) throw fail('模型未列入当前来源清单，请刷新模型列表', 404);
    if (source.startsWith('workbuddy')) return (await buddy()).complete(request, onChunk);
    const original = { ...entry, id: entry.upstreamId };
    const snapshot = { catalog: [original], membership: { [ROUTE_MAIN]: [original.id], [ROUTE_REGION]: [] }, settings: {
      enabled: true, exposeRegionModels: false, defaultMaxTokens: 32768,
      streamRecovery: false, tokenSaver: { enabled: false },
    } };
    const state = () => snapshot;
    const adapter = new FreeModelAdapter({ state, recordUsage() {}, recordTurn() {}, warn() {} });
    const run = createForwardCompletion({ adapter, state, signal: lifetime.signal });
    return run({ ...request, model: original.id, openAi: { ...request.openAi, model: original.id } }, onChunk);
  }
  async function status() {
    const saved = await fs.lstat(path.join(directory, 'workbuddy-state.json')).then(() => true).catch(() => false);
    return { running: true, ...((buddyPromise || saved) ? await (await buddy()).status() : idle()) };
  }
  async function handleRequest(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    if (!keyMatches(String(req.headers.authorization || '').replace(/^Bearer /i, ''), apiKey)) {
      json(res, 401, { error: { message: '需要本机模型插件凭据' } }); return true;
    }
    if (url.pathname === '/v1/models' || url.pathname === '/v1/chat/completions') return false;
    try {
      if (url.pathname === '/health' && req.method === 'GET') json(res, 200, { ok: true, service: 'studio-model-plugin', instanceId });
      else if (url.pathname === '/studio/status' && req.method === 'GET') json(res, 200, await status());
      else if (url.pathname === '/studio/models' && req.method === 'POST') {
        const { source } = await readBody(req); await refresh(source);
        json(res, 200, { models: rows().filter(row => modelMatchesSource(row.id, source)) });
      } else if (url.pathname === '/studio/login' && req.method === 'POST') {
        const { region } = await readBody(req); if (!['cn', 'intl'].includes(region)) throw fail('账号地区无效', 400);
        json(res, 200, { running: true, ...await (await buddy()).login(region) });
      } else if (url.pathname === '/studio/cancel' && req.method === 'POST') json(res, 200, { running: true, ...await (await buddy()).cancel() });
      else if (url.pathname === '/studio/logout' && req.method === 'POST') {
        const body = await readBody(req);
        if (!['cn', 'intl'].includes(body.region) || typeof body.id !== 'string' || body.id.length > 200) throw fail('账号参数无效', 400);
        json(res, 200, { running: true, ...await (await buddy()).logout(body) });
        catalogs.delete(`workbuddy-${body.region}`);
      } else if (url.pathname === '/studio/stop' && req.method === 'POST') { json(res, 200, { ok: true }); setImmediate(() => void close()); }
      else json(res, 404, { error: { message: '此功能未接入工作台' } });
    } catch (error) { json(res, error.statusCode || 503, { error: { message: '模型来源操作未完成，请检查网络或重新连接账号' } }); }
    return true;
  }
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      lifetime.abort();
      await listener?.close();
      await buddyPromise?.then(b => b.close()).catch(() => {});
      const descriptorPath = path.join(directory, 'instance.json');
      const saved = await fs.readFile(descriptorPath, 'utf8').then(JSON.parse).catch(() => null);
      if (saved?.instanceId === instanceId) await fs.rm(descriptorPath, { force: true });
      await lock.close(); await fs.rm(lockPath, { force: true }); onStop();
    })(); return closing;
  }
  try {
    listener = await startForwardServer({ config: () => ({ host: '127.0.0.1', port, enabled: true, key: apiKey }), complete, modelRows: rows, handleRequest, log() {} });
    const descriptor = { pid: process.pid, instanceId, baseUrl: `http://127.0.0.1:${listener.port}`, apiKey };
    const temporary = path.join(directory, `.instance-${instanceId}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, path.join(directory, 'instance.json'));
    return { descriptor, close };
  } catch (error) { await close(); throw error; }
}
