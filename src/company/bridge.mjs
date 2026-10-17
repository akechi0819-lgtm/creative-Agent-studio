import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataRoot as defaultDataRoot } from '../canvas/client.mjs';
import { readCompanyConfig } from './config.mjs';
import { readConfigRecord } from '../web/config.mjs';
import { createImageProxyHandler, validateImageProxyConfig } from '../web/image-proxy.mjs';

const PROTOCOL_VERSION = 1;
const RUNNING = new Map();
const MAX_BODY_BYTES = 64 * 1024;
const MAX_HEALTH_BYTES = 32 * 1024;
const TICKET_TTL_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[a-f0-9]{64}$/i;

function fail(message, code = 'ERR_COMPANY_BRIDGE') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function checkedTaskId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw fail('公司 Canvas bridge 需要有效的本地任务 ID', 'ERR_COMPANY_BRIDGE_CONFIG');
  return value;
}

function isLoopback(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  const parts = host.split('.');
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function remoteOrigin(webUrl) {
  let value;
  try { value = new URL(webUrl); } catch { throw fail('公司 Canvas Web 地址无效', 'ERR_COMPANY_BRIDGE_CONFIG'); }
  if (value.protocol !== 'https:' || isLoopback(value.hostname) || value.username || value.password || value.search || value.hash) {
    throw fail('公司 Canvas Web 必须是无凭据的远端 HTTPS 地址', 'ERR_COMPANY_BRIDGE_CONFIG');
  }
  return value.origin;
}

function bridgePort(bridgeUrl) {
  if (!bridgeUrl) return null;
  let value;
  try { value = new URL(bridgeUrl); } catch { throw fail('公司 Canvas bridge 地址无效', 'ERR_COMPANY_BRIDGE_CONFIG'); }
  if (value.protocol !== 'http:' || !isLoopback(value.hostname) || !value.port || value.pathname !== '/' || value.username || value.password || value.search || value.hash) {
    throw fail('公司 Canvas bridge 必须使用本机回环 HTTP 地址和显式端口', 'ERR_COMPANY_BRIDGE_CONFIG');
  }
  return Number(value.port);
}

function validateClientId(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 300 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw fail('公司 Canvas clientId 无效', 'ERR_COMPANY_BRIDGE_CONFIG');
  }
  return value.trim();
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address()?.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!Number.isInteger(port) || port < 1) throw fail('无法分配本机 Canvas bridge 端口');
  return port;
}

function taskDirectory(root, taskId) {
  return path.join(path.resolve(root), 'canvas', checkedTaskId(taskId));
}

function taskBridgePaths(root, taskId) {
  const directory = taskDirectory(root, taskId);
  return {
    directory,
    config: path.join(directory, 'company-canvas-bridge.json'),
    lock: path.join(directory, 'company-canvas-bridge.lock'),
    descriptor: path.join(directory, 'company-canvas-bridge-instance.json'),
  };
}

async function ensurePrivateTaskDirectory(root, taskId) {
  const directory = taskDirectory(root, taskId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw fail('公司 Canvas 任务目录必须是普通目录', 'ERR_COMPANY_BRIDGE_PATH');
  const rootReal = await fs.realpath(path.resolve(root));
  const directoryReal = await fs.realpath(directory);
  const relative = path.relative(rootReal, directoryReal);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw fail('公司 Canvas 任务目录超出数据根目录', 'ERR_COMPANY_BRIDGE_PATH');
  }
  await fs.chmod(directory, 0o700);
  return directory;
}

async function existingTaskDirectoryState(root, taskId) {
  const directory = taskDirectory(root, taskId);
  let info;
  try { info = await fs.lstat(directory); }
  catch (error) {
    if (error.code === 'ENOENT') return { present: false, safe: true };
    return { present: true, safe: false };
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return { present: true, safe: false };
  try {
    const rootReal = await fs.realpath(path.resolve(root));
    const directoryReal = await fs.realpath(directory);
    const relative = path.relative(rootReal, directoryReal);
    const inside = !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
    return { present: true, safe: inside };
  } catch { return { present: true, safe: false }; }
}

function normalizeTaskConfig(value, taskId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1
    || value.taskId !== taskId || value.projectId !== taskId) {
    throw fail('公司 Canvas 任务 bridge 配置无效', 'ERR_COMPANY_BRIDGE_CONFIG');
  }
  const webUrl = typeof value.webUrl === 'string' ? value.webUrl.trim() : '';
  remoteOrigin(webUrl);
  const bridgeUrl = typeof value.bridgeUrl === 'string' ? value.bridgeUrl.trim() : '';
  bridgePort(bridgeUrl);
  if (typeof value.token !== 'string' || !TOKEN.test(value.token)) throw fail('公司 Canvas 任务 token 无效', 'ERR_COMPANY_BRIDGE_CONFIG');
  if (typeof value.clientId !== 'string' || value.clientId.length > 300) throw fail('公司 Canvas 任务 clientId 无效', 'ERR_COMPANY_BRIDGE_CONFIG');
  return { schemaVersion: 1, taskId, projectId: taskId, webUrl, bridgeUrl, token: value.token, clientId: value.clientId };
}

export async function readCompanyCanvasBridgeConfig({ root = defaultDataRoot(), taskId } = {}) {
  const checkedId = checkedTaskId(taskId);
  const { directory, config } = taskBridgePaths(root, checkedId);
  let directoryInfo;
  try { directoryInfo = await fs.lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw fail('公司 Canvas 任务目录无效', 'ERR_COMPANY_BRIDGE_PATH');
  const rootReal = await fs.realpath(path.resolve(root));
  const directoryReal = await fs.realpath(directory);
  const relative = path.relative(rootReal, directoryReal);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw fail('公司 Canvas 任务目录超出数据根目录', 'ERR_COMPANY_BRIDGE_PATH');
  }
  try {
    const info = await fs.lstat(config);
    if (!info.isFile() || info.isSymbolicLink()) throw fail('公司 Canvas 私有配置必须是普通文件', 'ERR_COMPANY_BRIDGE_PATH');
    const parsed = JSON.parse(await fs.readFile(config, 'utf8'));
    await fs.chmod(config, 0o600);
    return normalizeTaskConfig(parsed, checkedId);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw fail('公司 Canvas 任务 bridge 配置无效', 'ERR_COMPANY_BRIDGE_CONFIG');
    throw error;
  }
}

async function writePrivateJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export async function bindCompanyCanvasClient({ root = defaultDataRoot(), taskId, clientId } = {}) {
  const checkedId = checkedTaskId(taskId);
  const config = await readCompanyCanvasBridgeConfig({ root, taskId: checkedId });
  if (!config) throw fail('公司 Canvas 任务 bridge 尚未初始化', 'ERR_COMPANY_BRIDGE_CONFIG');
  const next = { ...config, clientId: validateClientId(clientId) };
  const { config: file } = taskBridgePaths(root, checkedId);
  await writePrivateJson(file, next);
  return next;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw fail('请求体超出限制', 'ERR_COMPANY_BRIDGE_INPUT');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw fail('请求 JSON 无效', 'ERR_COMPANY_BRIDGE_INPUT'); }
}

function reply(res, status, value, origin) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'false');
    res.setHeader('vary', 'Origin');
  }
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', String(bytes.length));
  res.writeHead(status);
  res.end(bytes);
}

async function readLimitedResponse(response, maxBytes = MAX_HEALTH_BYTES) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw fail('公司 Canvas bridge 响应超出限制');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw fail('公司 Canvas bridge 响应超出限制');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

async function readResponseJson(response, maxBytes = MAX_HEALTH_BYTES) {
  const bytes = await readLimitedResponse(response, maxBytes);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw fail('公司 Canvas bridge 响应无效'); }
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function companyBridgeServer(config, stop) {
  // Keep this import inside bridge startup so cold dependency preparation can
  // load status/stop without the optional Canvas distribution being installed.
  const { createHttpApp } = await import('../../third_party/canvas/canvas-agent/dist/server/http.js');
  const baseApp = createHttpApp(config);
  const tickets = new Map();
  const reservedClients = new Map();
  const imageResultUrls = new Map();
  const imageProxyPrefix = `/__company/image-proxy/${config.projectId}/`;
  const imageProxy = createImageProxyHandler({
    prefix: imageProxyPrefix,
    authorize: (req) => req.headers.origin === config.origin
      && constantTimeEqual(req.headers['x-canvas-agent-token'], config.token),
    getSession: async () => {
      const record = await readConfigRecord({ root: config.root });
      return {
        imageConfig: validateImageProxyConfig({ ...record.image, apiFormat: 'openai' }),
        expiresAt: Number.MAX_SAFE_INTEGER,
        imageResultUrls,
      };
    },
  });
  const publicImageConfig = async () => {
    const record = await readConfigRecord({ root: config.root });
    const image = validateImageProxyConfig({ ...record.image, apiFormat: 'openai' });
    return {
      configRevision: record.revision,
      imageConfig: {
        baseUrl: image.baseUrl,
        model: image.model,
        apiFormat: image.apiFormat,
        configured: Boolean(image.baseUrl && image.model && image.apiKey),
      },
    };
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', config.url);
    if (!url.pathname.startsWith('/__company/')) return void baseApp(req, res);
    const origin = req.headers.origin;
    if (origin && origin !== config.origin) return void reply(res, 403, { ok: false, error: 'origin not allowed' });

    if (req.method === 'OPTIONS') {
      if (origin !== config.origin) return void reply(res, 403, { ok: false, error: 'origin not allowed' });
      res.setHeader('access-control-allow-origin', config.origin);
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type,x-canvas-agent-token');
      res.setHeader('access-control-allow-private-network', 'true');
      res.setHeader('access-control-max-age', '600');
      res.setHeader('vary', 'Origin');
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === '/__company/health' && req.method === 'GET') {
      if (!constantTimeEqual(req.headers['x-canvas-agent-token'], config.token)) {
        return void reply(res, 401, { ok: false, error: 'invalid token' });
      }
      return void reply(res, 200, { ok: true, service: 'company-canvas-bridge', protocolVersion: PROTOCOL_VERSION, projectId: config.projectId, instanceId: config.instanceId });
    }
    if (origin === config.origin) {
      res.setHeader('access-control-allow-origin', config.origin);
      res.setHeader('access-control-allow-credentials', 'false');
      res.setHeader('vary', 'Origin');
      res.setHeader('referrer-policy', 'no-referrer');
    }
    if (url.pathname === '/__company/stop' && req.method === 'POST') {
      if (origin || !constantTimeEqual(req.headers['x-canvas-agent-token'], config.token)) {
        return void reply(res, 403, { ok: false, error: 'request not allowed' });
      }
      try {
        const body = await readJsonBody(req);
        if (!constantTimeEqual(body.instanceId, config.instanceId)) {
          return void reply(res, 409, { ok: false, error: 'instance mismatch' });
        }
        reply(res, 200, { ok: true, stopping: true, instanceId: config.instanceId });
        setImmediate(() => { void stop().catch(() => {}); });
        return;
      } catch {
        return void reply(res, 400, { ok: false, error: 'request invalid' });
      }
    }
    if (url.pathname === '/__company/open-ticket' && req.method === 'POST') {
      if (!constantTimeEqual(req.headers['x-canvas-agent-token'], config.token)) {
        return void reply(res, 401, { ok: false, error: 'invalid token' });
      }
      try {
        const body = await readJsonBody(req);
        if (body.projectId !== config.projectId) return void reply(res, 403, { ok: false, error: 'project mismatch' });
        let clientId;
        if (body.clientId !== undefined) clientId = validateClientId(body.clientId);
        for (const [key, ticket] of tickets) {
          if (ticket.expiresAt > Date.now()) continue;
          tickets.delete(key);
          if (ticket.clientId && reservedClients.get(ticket.clientId) === key) reservedClients.delete(ticket.clientId);
        }
        if (clientId) {
          if (reservedClients.has(clientId)) return void reply(res, 409, { ok: false, error: 'client already has a pending ticket' });
          const healthResponse = await fetch(`${config.url}/health`, {
            headers: { 'x-canvas-agent-token': config.token }, signal: AbortSignal.timeout(1000), redirect: 'error',
          });
          const health = await readResponseJson(healthResponse);
          if (!healthResponse.ok || health?.ok !== true || health.instanceId !== config.instanceId
            || health.projectId !== config.projectId || !Array.isArray(health.targets)) {
            return void reply(res, 503, { ok: false, error: 'canvas health unavailable' });
          }
          if (health.targets.some((target) => target?.clientId === clientId)) {
            return void reply(res, 409, { ok: false, error: 'client already connected' });
          }
        }
        const ticket = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + TICKET_TTL_MS;
        tickets.set(ticket, { projectId: config.projectId, ...(clientId ? { clientId } : {}), expiresAt });
        if (clientId) reservedClients.set(clientId, ticket);
        return void reply(res, 200, { ok: true, ticket, expiresAt });
      } catch (error) {
        return void reply(res, 400, { ok: false, error: error?.message || 'request invalid' });
      }
    }
    if (url.pathname.startsWith('/__company/image-proxy/')) {
      if (!url.pathname.startsWith(imageProxyPrefix)) return void reply(res, 403, { ok: false, error: 'project mismatch' }, origin === config.origin ? config.origin : undefined);
      if (await imageProxy(req, res)) return;
    }
    if (url.pathname === `/__company/config/${config.projectId}` && req.method === 'GET') {
      if (origin !== config.origin || !constantTimeEqual(req.headers['x-canvas-agent-token'], config.token) || url.search) {
        return void reply(res, 403, { ok: false, error: 'request not allowed' }, origin === config.origin ? config.origin : undefined);
      }
      try {
        return void reply(res, 200, { ok: true, projectId: config.projectId, ...(await publicImageConfig()) }, config.origin);
      } catch {
        return void reply(res, 503, { ok: false, error: 'image config unavailable' }, config.origin);
      }
    }
    if (url.pathname === '/__company/bootstrap' && req.method === 'POST') {
      if (origin !== config.origin) return void reply(res, 403, { ok: false, error: 'origin not allowed' });
      try {
        const body = await readJsonBody(req);
        const ticketKey = body.ticket;
        if (typeof ticketKey !== 'string' || !/^[a-f0-9]{64}$/u.test(ticketKey)) {
          return void reply(res, 400, { ok: false, error: 'ticket invalid' }, config.origin);
        }
        const ticket = tickets.get(ticketKey);
        tickets.delete(ticketKey);
        if (ticket?.clientId && reservedClients.get(ticket.clientId) === ticketKey) reservedClients.delete(ticket.clientId);
        if (!ticket || ticket.expiresAt <= Date.now()) return void reply(res, 410, { ok: false, error: 'ticket expired' }, config.origin);
        const image = await publicImageConfig();
        return void reply(res, 200, {
          ok: true,
          bridgeUrl: config.url,
          token: config.token,
          projectId: ticket.projectId,
          ...image,
          ...(ticket.clientId ? { clientId: ticket.clientId } : {}),
        }, config.origin);
      } catch (error) {
        return void reply(res, 400, { ok: false, error: error?.message || 'request invalid' }, config.origin);
      }
    }
    return void reply(res, 404, { ok: false, error: 'not found' }, origin === config.origin ? config.origin : undefined);
  });
  return server;
}

function bridgeDataDirectory(root, taskId) {
  return path.join(taskDirectory(root, taskId), 'company-canvas-agent-data');
}

async function readDescriptorRecord(file) {
  let info;
  try {
    info = await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false, valid: false, value: null };
    return { present: true, valid: false, value: null };
  }
  if (!info.isFile() || info.isSymbolicLink()) return { present: true, valid: false, value: null };
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Number.isInteger(value?.pid) || value.pid < 1 || !Number.isInteger(value.port)
      || typeof value.instanceId !== 'string' || !value.instanceId
      || typeof value.taskId !== 'string' || !UUID.test(value.taskId)) return { present: true, valid: false, value: null };
    return { present: true, valid: true, value };
  } catch { return { present: true, valid: false, value: null }; }
}

async function readLockRecord(file) {
  let info;
  try { info = await fs.lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { present: false, valid: false, value: null };
    return { present: true, valid: false, value: null };
  }
  if (!info.isFile() || info.isSymbolicLink()) return { present: true, valid: false, value: null };
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Number.isInteger(value?.pid) || value.pid < 1 || typeof value.instanceId !== 'string' || !value.instanceId
      || typeof value.taskId !== 'string' || !UUID.test(value.taskId)) return { present: true, valid: false, value: null };
    return { present: true, valid: true, value };
  } catch { return { present: true, valid: false, value: null }; }
}

function processState(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    return null;
  }
}

function combinedOwnerState(...records) {
  const present = records.filter((record) => record?.present);
  if (!present.length) return false;
  const valid = present.filter((record) => record.valid);
  const states = valid.map((record) => processState(record.value.pid));
  if (states.includes(true)) return true;
  if (states.includes(null) || valid.length !== present.length) return null;
  return states.length > 0 && states.every((state) => state === false) ? false : null;
}

async function readDescriptor(file) {
  const record = await readDescriptorRecord(file);
  return record.valid ? record.value : null;
}

async function taskCanvasConfigForStart({ root, taskId, webUrl } = {}) {
  const current = await readCompanyCanvasBridgeConfig({ root, taskId });
  const global = await readCompanyConfig({ root });
  const nextWebUrl = (webUrl == null ? current?.webUrl || global.canvas.webUrl : String(webUrl)).trim();
  if (!nextWebUrl) throw fail('请先配置公司 Canvas Web HTTPS 地址', 'ERR_COMPANY_BRIDGE_CONFIG');
  const origin = remoteOrigin(nextWebUrl);
  if (current && current.webUrl !== nextWebUrl) {
    throw fail('当前任务已绑定到另一 Canvas Web 地址；请继续使用原任务页面', 'ERR_COMPANY_BRIDGE_WEB_CHANGED');
  }
  if (current) return { current, origin };
  const port = await reserveLoopbackPort();
  const value = {
    schemaVersion: 1,
    taskId,
    projectId: taskId,
    webUrl: nextWebUrl,
    bridgeUrl: `http://127.0.0.1:${port}`,
    token: crypto.randomBytes(32).toString('hex'),
    clientId: '',
  };
  const { config: file } = taskBridgePaths(root, taskId);
  await writePrivateJson(file, value);
  return { current: normalizeTaskConfig(value, taskId), origin };
}

async function verifyRunning(config, descriptor) {
  if (!descriptor || descriptor.port !== config.port || descriptor.taskId !== config.taskId) return false;
  try {
    const response = await fetch(`${config.url}/__company/health`, {
      headers: { 'x-canvas-agent-token': config.token }, signal: AbortSignal.timeout(900), redirect: 'error',
    });
    const value = await readResponseJson(response);
    return response.ok && value?.service === 'company-canvas-bridge'
      && value.protocolVersion === PROTOCOL_VERSION && value.instanceId === descriptor.instanceId
      && value.projectId === descriptor.taskId;
  } catch { return false; }
}

function runningKey(root, taskId) {
  return `${path.resolve(root)}\0${checkedTaskId(taskId)}`;
}

export async function startCompanyBridge({ root = defaultDataRoot(), taskId, webUrl } = {}) {
  if (typeof root !== 'string' || !root.trim()) throw fail('公司 Canvas bridge 数据目录无效');
  const dataRoot = path.resolve(root);
  const checkedId = checkedTaskId(taskId);
  const key = runningKey(dataRoot, checkedId);
  const active = RUNNING.get(key);
  const directory = await ensurePrivateTaskDirectory(dataRoot, checkedId);
  const { lock, descriptor } = taskBridgePaths(dataRoot, checkedId);
  const configuredTask = await readCompanyCanvasBridgeConfig({ root: dataRoot, taskId: checkedId });
  if (configuredTask && webUrl != null && configuredTask.webUrl !== String(webUrl).trim()) {
    throw fail('当前任务已绑定到另一 Canvas Web 地址；请继续使用原任务页面', 'ERR_COMPANY_BRIDGE_WEB_CHANGED');
  }
  if (active?.server.listening) return publicBridgeHandle({ taskId: checkedId, reused: true, stop: active.stop, stopped: active.stopped });
  const currentStatus = await companyBridgeStatus({ root: dataRoot, taskId: checkedId });
  if (currentStatus.state === 'healthy') {
    return publicBridgeHandle({
      taskId: checkedId,
      reused: true,
      stop: () => stopCompanyBridge({ root: dataRoot, taskId: checkedId }),
    });
  }
  if (currentStatus.state === 'unverified') {
    throw fail('公司 Canvas bridge 仍可能运行但无法验证；请先检查状态', 'ERR_COMPANY_BRIDGE_UNVERIFIED');
  }
  let descriptorRecord = await readDescriptorRecord(descriptor);
  let existingDescriptor = descriptorRecord.valid ? descriptorRecord.value : null;
  let existingConfig = await readCompanyCanvasBridgeConfig({ root: dataRoot, taskId: checkedId });
  let lockHandle;
  try { lockHandle = await fs.open(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const lockBefore = await readLockRecord(lock);
    const ownerState = lockBefore.valid ? processState(lockBefore.value.pid) : null;
    if (ownerState !== false) throw fail('公司 Canvas bridge 正在启动或无法验证；稍后检查状态', 'ERR_COMPANY_BRIDGE_BUSY');
    const before = await fs.readFile(lock, 'utf8').catch(() => null);
    if (before === null || await fs.readFile(lock, 'utf8').catch(() => null) !== before) {
      throw fail('公司 Canvas bridge 正在启动；稍后检查状态', 'ERR_COMPANY_BRIDGE_BUSY');
    }
    await fs.rm(lock, { force: true });
    try { lockHandle = await fs.open(lock, 'wx', 0o600); }
    catch { throw fail('公司 Canvas bridge 正在启动；稍后检查状态', 'ERR_COMPANY_BRIDGE_BUSY'); }
  }
  const lockValue = { pid: process.pid, instanceId: crypto.randomUUID(), taskId: checkedId };
  try { await lockHandle.writeFile(JSON.stringify(lockValue)); await lockHandle.sync(); }
  finally { await lockHandle.close(); }

  try {
    const { current, origin } = await taskCanvasConfigForStart({ root: dataRoot, taskId: checkedId, webUrl });
    existingConfig = current;
    const config = {
      port: bridgePort(current.bridgeUrl),
      url: current.bridgeUrl.replace(/\/$/u, ''),
      token: current.token,
      root: dataRoot,
      projectId: checkedId,
      taskId: checkedId,
      instanceId: lockValue.instanceId,
      dataDir: bridgeDataDirectory(dataRoot, checkedId),
      origin,
    };
    await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    await fs.chmod(config.dataDir, 0o700);
    descriptorRecord = await readDescriptorRecord(descriptor);
    existingDescriptor = descriptorRecord.valid ? descriptorRecord.value : null;
    const descriptorOwner = existingDescriptor ? processState(existingDescriptor.pid) : null;
    if (existingDescriptor && descriptorOwner !== false) {
      throw fail('该任务的公司 Canvas bridge 仍可能运行但无法验证；不会启动重复实例', 'ERR_COMPANY_BRIDGE_UNVERIFIED');
    }
    let stop;
    const server = await companyBridgeServer(config, () => stop?.());
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(config.port, '127.0.0.1');
      });
      await writePrivateJson(descriptor, {
        pid: process.pid,
        port: config.port,
        instanceId: config.instanceId,
        taskId: checkedId,
        dataDir: config.dataDir,
      });
    } catch (error) {
      await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
      if (error?.code === 'EADDRINUSE') throw fail('公司 Canvas 本机端口已被占用；请检查配置后重试', 'ERR_COMPANY_BRIDGE_PORT_IN_USE');
      throw fail('公司 Canvas bridge 启动失败', 'ERR_COMPANY_BRIDGE_START');
    }

    let stopping;
    let resolveStopped;
    const stopped = new Promise((resolve) => { resolveStopped = resolve; });
    stop = async () => {
      if (stopping) return stopping;
      stopping = (async () => {
        try {
          await new Promise((resolve) => {
            if (!server.listening) return resolve();
            server.close(() => resolve());
            const forceClose = setTimeout(() => server.closeAllConnections?.(), 100);
            forceClose.unref?.();
          });
          const saved = await readDescriptor(descriptor);
          if (saved?.pid === process.pid && saved.instanceId === config.instanceId) await fs.rm(descriptor, { force: true });
          const lockText = await fs.readFile(lock, 'utf8').catch(() => '');
          if (lockText === JSON.stringify(lockValue)) await fs.rm(lock, { force: true });
          RUNNING.delete(key);
        } finally { resolveStopped(); }
      })();
      return stopping;
    };
    const publicHandle = publicBridgeHandle({ taskId: checkedId, reused: false, stop, stopped, tokenConfigured: Boolean(existingConfig.token) });
    RUNNING.set(key, { server, config, publicHandle, stop, stopped });
    return publicHandle;
  } catch (error) {
    const lockText = await fs.readFile(lock, 'utf8').catch(() => '');
    if (lockText === JSON.stringify(lockValue)) await fs.rm(lock, { force: true });
    throw error;
  }
}

function publicBridgeHandle({ taskId, reused, stop, stopped, tokenConfigured = true }) {
  return Object.freeze({
    running: true,
    state: 'healthy',
    owned: true,
    reused: Boolean(reused),
    protocolVersion: PROTOCOL_VERSION,
    taskId,
    projectId: taskId,
    tokenConfigured: Boolean(tokenConfigured),
    ...(stopped ? { stopped } : {}),
    stop,
  });
}

function publicBridgeStatus(state, taskId, reason, running = null) {
  return {
    state,
    running: state === 'healthy' ? true : state === 'dead' ? false : running,
    owned: state === 'healthy',
    protocolVersion: state === 'healthy' ? PROTOCOL_VERSION : null,
    projectId: taskId,
    taskId,
    ...(reason ? { reason } : {}),
  };
}

export async function companyBridgeStatus({ root = defaultDataRoot(), taskId } = {}) {
  if (typeof root !== 'string' || !root.trim()) throw fail('公司 Canvas bridge 数据目录无效');
  const dataRoot = path.resolve(root);
  const checkedId = checkedTaskId(taskId);
  const directoryState = await existingTaskDirectoryState(dataRoot, checkedId);
  if (!directoryState.present) return publicBridgeStatus('dead', checkedId, 'not-running');
  if (!directoryState.safe) return publicBridgeStatus('unverified', checkedId, 'record-invalid');
  const active = RUNNING.get(runningKey(dataRoot, checkedId));
  if (active?.server.listening) {
    const healthy = await verifyRunning(active.config, await readDescriptor(taskBridgePaths(dataRoot, checkedId).descriptor));
    if (healthy) return publicBridgeStatus('healthy', checkedId);
  }
  const paths = taskBridgePaths(dataRoot, checkedId);
  const [descriptorRecord, lockRecord] = await Promise.all([
    readDescriptorRecord(paths.descriptor), readLockRecord(paths.lock),
  ]);
  if (!descriptorRecord.present && !lockRecord.present) return publicBridgeStatus('dead', checkedId, 'not-running');
  const owner = combinedOwnerState(descriptorRecord, lockRecord);
  if (owner === false) return publicBridgeStatus('dead', checkedId, 'process-exited');
  let config;
  try { config = await readCompanyCanvasBridgeConfig({ root: dataRoot, taskId: checkedId }); }
  catch { return publicBridgeStatus('unverified', checkedId, 'record-invalid', owner === true ? true : null); }
  if (!descriptorRecord.valid || !lockRecord.valid) {
    return publicBridgeStatus('unverified', checkedId, owner === true ? 'owner-alive-health-unverified' : 'record-invalid', owner === true ? true : null);
  }
  const descriptor = descriptorRecord.value;
  const lock = lockRecord.value;
  const sameInstance = descriptor.pid === lock.pid && descriptor.instanceId === lock.instanceId
    && descriptor.taskId === lock.taskId && descriptor.taskId === checkedId;
  if (!sameInstance) return publicBridgeStatus('unverified', checkedId, 'identity-mismatch', owner === true ? true : null);
  if (config && await verifyRunning({
    url: config.bridgeUrl.replace(/\/$/u, ''), port: bridgePort(config.bridgeUrl), token: config.token, taskId: checkedId,
  }, descriptor)) return publicBridgeStatus('healthy', checkedId);
  return publicBridgeStatus('unverified', checkedId, owner === true ? 'health-unavailable' : 'owner-unknown', owner === true ? true : null);
}

export async function stopCompanyBridge({ root = defaultDataRoot(), taskId } = {}) {
  if (typeof root !== 'string' || !root.trim()) throw fail('公司 Canvas bridge 数据目录无效');
  const dataRoot = path.resolve(root);
  const checkedId = checkedTaskId(taskId);
  const directoryState = await existingTaskDirectoryState(dataRoot, checkedId);
  if (!directoryState.present) return { state: 'dead', stopped: false, owned: false, taskId: checkedId, projectId: checkedId };
  if (!directoryState.safe) return { state: 'unverified', stopped: false, owned: false, taskId: checkedId, projectId: checkedId, reason: 'record-invalid' };
  const key = runningKey(dataRoot, checkedId);
  const active = RUNNING.get(key);
  if (active?.server.listening) {
    await active.stop();
    return { state: 'stopped', stopped: true, owned: true, taskId: checkedId, projectId: checkedId };
  }
  const status = await companyBridgeStatus({ root: dataRoot, taskId: checkedId });
  if (status.state === 'dead') return { state: 'dead', stopped: false, owned: false, taskId: checkedId, projectId: checkedId };
  if (status.state !== 'healthy' || !status.owned) {
    return { state: 'unverified', stopped: false, owned: false, taskId: checkedId, projectId: checkedId, reason: status.reason || 'health-unavailable' };
  }
  const paths = taskBridgePaths(dataRoot, checkedId);
  let config;
  try { config = await readCompanyCanvasBridgeConfig({ root: dataRoot, taskId: checkedId }); }
  catch { return { state: 'unverified', stopped: false, owned: false, taskId: checkedId, projectId: checkedId, reason: 'record-invalid' }; }
  const descriptorRecord = await readDescriptorRecord(paths.descriptor);
  const lockRecord = await readLockRecord(paths.lock);
  if (!descriptorRecord.valid || !lockRecord.valid) {
    return { state: 'unverified', stopped: false, owned: false, taskId: checkedId, projectId: checkedId, reason: 'record-invalid' };
  }
  const existing = descriptorRecord.value;
  const lock = lockRecord.value;
  if (existing.taskId !== checkedId || existing.pid !== lock.pid || existing.instanceId !== lock.instanceId
    || !await verifyRunning({
      url: config.bridgeUrl.replace(/\/$/u, ''), port: bridgePort(config.bridgeUrl), token: config.token, taskId: checkedId,
    }, existing)) {
    return { state: 'unverified', stopped: false, owned: false, taskId: checkedId, projectId: checkedId, reason: 'identity-mismatch' };
  }
  try {
    const response = await fetch(`${config.bridgeUrl.replace(/\/$/u, '')}/__company/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-canvas-agent-token': config.token },
      body: JSON.stringify({ instanceId: existing.instanceId }),
      signal: AbortSignal.timeout(1500),
      redirect: 'error',
    });
    const value = await readResponseJson(response);
    if (!response.ok || value?.ok !== true || value?.stopping !== true || value?.instanceId !== existing.instanceId) {
      return { state: 'unverified', stopped: false, owned: false, taskId: checkedId, projectId: checkedId, reason: 'stop-rejected' };
    }
  } catch {
    return { state: 'unverified', stopped: false, owned: false, taskId: checkedId, projectId: checkedId, reason: 'stop-unreachable' };
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await readDescriptorRecord(paths.descriptor);
    if (!current.present || (current.valid && current.value.instanceId !== existing.instanceId)) {
      return { state: 'stopped', stopped: true, owned: true, taskId: checkedId, projectId: checkedId };
    }
    if (current.valid && current.value.instanceId === existing.instanceId && processState(current.value.pid) === false) {
      await fs.rm(paths.descriptor, { force: true });
      const currentLock = await readLockRecord(paths.lock);
      if (currentLock.valid && currentLock.value.instanceId === existing.instanceId) await fs.rm(paths.lock, { force: true });
      return { state: 'stopped', stopped: true, owned: true, taskId: checkedId, projectId: checkedId };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return { state: 'unverified', stopped: false, owned: true, taskId: checkedId, projectId: checkedId, reason: 'stop-timeout' };
}

/** Start a task-scoped Canvas bridge in its own process for the web adapter. */
export async function ensureDetachedCompanyBridge({ root = defaultDataRoot(), taskId, webUrl } = {}) {
  if (typeof root !== 'string' || !root.trim()) throw fail('公司 Canvas bridge 数据目录无效');
  const dataRoot = path.resolve(root);
  const checkedId = checkedTaskId(taskId);
  const value = typeof webUrl === 'string' ? webUrl.trim() : '';
  if (!value) throw fail('请先配置公司 Canvas Web HTTPS 地址', 'ERR_COMPANY_BRIDGE_CONFIG');
  remoteOrigin(value);
  const configuredTask = await readCompanyCanvasBridgeConfig({ root: dataRoot, taskId: checkedId });
  if (configuredTask && configuredTask.webUrl !== value) {
    throw fail('当前任务已绑定到另一 Canvas Web 地址；请继续使用原任务页面', 'ERR_COMPANY_BRIDGE_WEB_CHANGED');
  }
  const before = await companyBridgeStatus({ root: dataRoot, taskId: checkedId });
  if (before.state === 'healthy') {
    return publicBridgeHandle({
      taskId: checkedId,
      reused: true,
      stop: () => stopCompanyBridge({ root: dataRoot, taskId: checkedId }),
    });
  }
  if (before.state === 'unverified') {
    throw fail('公司 Canvas bridge 仍可能运行但无法验证；不会启动重复实例', 'ERR_COMPANY_BRIDGE_UNVERIFIED');
  }
  const script = fileURLToPath(new URL('../../scripts/company-bridge.mjs', import.meta.url));
  let child;
  let spawnError = null;
  try {
    child = spawn(process.execPath, [script, 'start', '--task-id', checkedId, '--web-url', value], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, STUDIO_DATA_DIR: dataRoot },
    });
    child.once('error', (error) => { spawnError = error; });
    child.unref();
  } catch { throw fail('公司 Canvas bridge 子进程启动失败', 'ERR_COMPANY_BRIDGE_START'); }

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) throw fail('公司 Canvas bridge 子进程启动失败', 'ERR_COMPANY_BRIDGE_START');
    const status = await companyBridgeStatus({ root: dataRoot, taskId: checkedId });
    if (status.state === 'healthy') {
      return publicBridgeHandle({
        taskId: checkedId,
        reused: false,
        stop: () => stopCompanyBridge({ root: dataRoot, taskId: checkedId }),
      });
    }
    if ((child.exitCode !== null || child.signalCode !== null) && status.state === 'dead') {
      throw fail('公司 Canvas bridge 子进程未能启动', 'ERR_COMPANY_BRIDGE_START');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  const final = await companyBridgeStatus({ root: dataRoot, taskId: checkedId });
  if (final.state === 'healthy') {
    return publicBridgeHandle({ taskId: checkedId, reused: true, stop: () => stopCompanyBridge({ root: dataRoot, taskId: checkedId }) });
  }
  throw fail(final.state === 'unverified'
    ? '公司 Canvas bridge 子进程仍可能运行但无法验证；请检查任务连接状态'
    : '公司 Canvas bridge 启动等待超时', 'ERR_COMPANY_BRIDGE_START');
}
