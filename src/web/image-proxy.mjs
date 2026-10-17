import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const IMAGE_RESULT_URL_TTL_MS = 60 * 60_000;
const MAX_IMAGE_RESULT_URLS_PER_SESSION = 64;
const MAX_IMAGE_RESULT_URL_LENGTH = 8192;
const MAX_IMAGE_JSON_CAPTURE_BYTES = 1024 * 1024;

export function validateImageProxyConfig(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid image config');
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey : '';
  const apiFormat = value.apiFormat === 'gemini' ? 'gemini' : 'openai';
  if (baseUrl.length > 2000 || model.length > 300 || apiKey.length > 5000) throw new Error('invalid image config');
  if (baseUrl) {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('invalid image config');
    }
  }
  return { baseUrl, model, apiKey, apiFormat };
}

function safeJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end(JSON.stringify(value));
}

function allowedImageTarget(session, target, method) {
  const image = session.imageConfig;
  if (!image?.baseUrl || !image.model || !image.apiKey) return false;
  let base;
  try { base = new URL(image.baseUrl); } catch { return false; }
  if (target.protocol !== base.protocol || target.origin !== base.origin || target.username || target.password || target.search || target.hash) return false;
  const basePath = base.pathname.replace(/\/+$/u, '');
  const apiPath = /\/v1$/iu.test(basePath) ? basePath : `${basePath}/v1`;
  return (method === 'GET' && target.pathname === `${apiPath}/models`)
    || (method === 'POST' && (target.pathname === `${apiPath}/images/generations` || target.pathname === `${apiPath}/images/edits`));
}

function isImageCreationTarget(session, target, method) {
  if (method !== 'POST') return false;
  const image = session.imageConfig;
  if (!image?.baseUrl) return false;
  let base;
  try { base = new URL(image.baseUrl); } catch { return false; }
  if (target.protocol !== base.protocol || target.origin !== base.origin || target.username || target.password || target.search || target.hash) return false;
  const basePath = base.pathname.replace(/\/+$/u, '');
  const apiPath = /\/v1$/iu.test(basePath) ? basePath : `${basePath}/v1`;
  return target.pathname === `${apiPath}/images/generations` || target.pathname === `${apiPath}/images/edits`;
}

function cleanImageResultUrls(session, now = Date.now()) {
  const urls = session.imageResultUrls;
  if (!(urls instanceof Map)) return;
  for (const [value, expiresAt] of urls) if (expiresAt <= now) urls.delete(value);
  while (urls.size > MAX_IMAGE_RESULT_URLS_PER_SESSION) urls.delete(urls.keys().next().value);
}

function rememberImageResultUrls(session, body) {
  let parsed;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return; }
  if (!Array.isArray(parsed?.data)) return;
  if (!(session.imageResultUrls instanceof Map)) session.imageResultUrls = new Map();
  const expiresAt = Math.min(session.expiresAt, Date.now() + IMAGE_RESULT_URL_TTL_MS);
  for (const item of parsed.data) {
    const value = item?.url;
    if (typeof value !== 'string' || !value || value.length > MAX_IMAGE_RESULT_URL_LENGTH) continue;
    let target;
    try { target = new URL(value); } catch { continue; }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) continue;
    session.imageResultUrls.delete(value);
    session.imageResultUrls.set(value, expiresAt);
  }
  cleanImageResultUrls(session);
}

function imageResultUrlAllowed(session, value) {
  cleanImageResultUrls(session);
  return session.imageResultUrls instanceof Map && session.imageResultUrls.has(value);
}

function decodeImageProxyTarget(rawTarget) {
  return /^https?:\/\//iu.test(rawTarget) ? rawTarget : decodeURIComponent(rawTarget);
}

async function relayUpstreamBody(upstream, res, { captureImageUrls = false, session } = {}) {
  if (!upstream.body) { res.end(); return; }
  const canCapture = captureImageUrls && /^application\/json(?:\s*;|$)/iu.test(upstream.headers.get('content-type') || '');
  if (!canCapture) { await pipeline(Readable.fromWeb(upstream.body), res); return; }
  const reader = upstream.body.getReader();
  const captured = [];
  let size = 0;
  let done = false;
  while (size <= MAX_IMAGE_JSON_CAPTURE_BYTES) {
    const chunk = await reader.read();
    if (chunk.done) { done = true; break; }
    const bytes = Buffer.from(chunk.value);
    captured.push(bytes);
    size += bytes.length;
    if (size > MAX_IMAGE_JSON_CAPTURE_BYTES) break;
  }
  const prefix = Buffer.concat(captured);
  if (done) {
    rememberImageResultUrls(session, prefix);
    res.end(prefix);
    return;
  }
  const remaining = Readable.from((async function* () {
    if (prefix.length) yield prefix;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        yield Buffer.from(chunk.value);
      }
    } finally { reader.releaseLock(); }
  })());
  await pipeline(remaining, res);
}

/**
 * Reuse the local Canvas image proxy's target allowlist and issued-result URL
 * handling. Callers retain responsibility for their own origin and session
 * authentication, then provide the authorized per-session image config.
 */
export function createImageProxyHandler({ prefix, authorize, getSession, fetchImpl = globalThis.fetch } = {}) {
  if (typeof prefix !== 'string' || !prefix.startsWith('/') || !prefix.endsWith('/')) throw new TypeError('image proxy prefix must be an absolute route prefix');
  if (typeof authorize !== 'function' || typeof getSession !== 'function') throw new TypeError('image proxy authorization and session readers are required');
  if (typeof fetchImpl !== 'function') throw new TypeError('image proxy fetch implementation is required');

  return async function handleImageProxyRequest(req, res) {
    const raw = String(req.url || '');
    if (!raw.startsWith(prefix)) return false;
    let permitted = false;
    try { permitted = await authorize(req); } catch {}
    if (!permitted) { res.writeHead(403, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end(); return true; }
    let session;
    try { session = await getSession(req); } catch {
      safeJson(res, 503, { error: '图片服务配置暂不可用' });
      return true;
    }
    if (!session) { safeJson(res, 401, { error: 'Canvas image session required' }); return true; }

    const rawTarget = raw.slice(prefix.length);
    let targetValue;
    let target;
    try { targetValue = decodeImageProxyTarget(rawTarget); target = new URL(targetValue); }
    catch { res.writeHead(400, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end(); return true; }
    const method = req.method || 'GET';
    const isApiTarget = allowedImageTarget(session, target, method);
    const isIssuedImageResult = method === 'GET' && imageResultUrlAllowed(session, targetValue);
    if (!isApiTarget && !isIssuedImageResult) { res.writeHead(403, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end(); return true; }

    const controller = new AbortController();
    const timeoutMs = isIssuedImageResult ? 10 * 60_000 : method === 'GET' ? 15_000 : 10 * 60_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    req.once('aborted', () => controller.abort());
    res.once('finish', () => clearTimeout(timeout));
    res.once('close', () => { clearTimeout(timeout); if (!res.writableEnded) controller.abort(); });
    const headers = new Headers();
    if (isApiTarget) headers.set('authorization', `Bearer ${session.imageConfig.apiKey}`);
    for (const name of isApiTarget ? ['accept', 'content-type'] : ['accept']) {
      const value = req.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    const init = { method: req.method, headers, signal: controller.signal, redirect: 'manual' };
    if ((req.method || 'GET') === 'POST') { init.body = Readable.toWeb(req); init.duplex = 'half'; }
    try {
      const upstream = await fetchImpl(targetValue, init);
      if (upstream.status >= 300 && upstream.status < 400) { res.writeHead(502, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end(); return true; }
      const forwarded = {};
      for (const name of ['content-type', 'etag', 'last-modified', 'retry-after']) {
        const value = upstream.headers.get(name);
        if (value) forwarded[name] = value;
      }
      forwarded['cache-control'] = 'no-store';
      res.writeHead(upstream.status, forwarded);
      if (!upstream.body) { res.end(); return true; }
      try {
        await relayUpstreamBody(upstream, res, {
          captureImageUrls: isApiTarget && isImageCreationTarget(session, target, method) && upstream.status >= 200 && upstream.status < 300,
          session,
        });
      } catch { if (!res.destroyed) res.destroy(); }
    } catch {
      if (!res.destroyed && !res.headersSent) safeJson(res, 502, { error: '图片服务转发失败' });
      else if (!res.destroyed) res.destroy();
    }
    return true;
  };
}
