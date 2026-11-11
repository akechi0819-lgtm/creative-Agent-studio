import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { VIDEO_PROVIDER } from '../lite/config.mjs';

const prefix = '/__studio/video-proxy/';
const resolutions = new Set(['768', '1080p', '2K', '4K']);
const aspectRatios = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
const createBodyKeys = ['aspect_ratio', 'duration_seconds', 'model', 'operation', 'prompt', 'resolution', 'version'];
const maximumCreateBytes = 64 * 1024;

function safeJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end(JSON.stringify(value));
}

function validVideoCreatePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(createBodyKeys)
    || value.version !== 'video.v1' || value.model !== VIDEO_PROVIDER.model
    || value.operation !== 'text_to_video' || typeof value.prompt !== 'string'
    || !value.prompt.trim() || value.prompt.length > 20_000
    || !Number.isInteger(value.duration_seconds) || value.duration_seconds < 4 || value.duration_seconds > 15
    || !resolutions.has(value.resolution) || !aspectRatios.has(value.aspect_ratio)) return false;
  return true;
}

async function readCreateBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximumCreateBytes) throw new Error('request too large');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  const payload = JSON.parse(body || '');
  if (!validVideoCreatePayload(payload)) throw new Error('invalid H3 request');
  return JSON.stringify(payload);
}

export function videoBrowserConfig(videoConfig, webUrl) {
  const configured = Boolean(videoConfig?.apiKey);
  return {
    ...VIDEO_PROVIDER,
    apiKey: configured ? 'local-session' : '',
    apiKeyConfigured: configured,
    proxyEnabled: true,
    proxyUrl: `${webUrl}/__studio/image-proxy`,
  };
}

export function videoTargetAllowed(videoConfig, target, method) {
  if (!videoConfig?.apiKey || target.origin !== VIDEO_PROVIDER.baseUrl
    || target.protocol !== 'https:' || target.username || target.password || target.search || target.hash) return false;
  if (method === 'POST') return target.pathname === '/v1/videos';
  if (method !== 'GET') return false;
  return /^\/v1\/videos\/[A-Za-z0-9_-]+(?:\/content)?$/.test(target.pathname);
}

/** Same-origin, session-authenticated H3 proxy with a fixed provider and operation allowlist. */
export function createVideoProxyHandler({ webUrl, getSession, fetchImpl = fetch } = {}) {
  return async function proxyVideoRequest(req, res) {
    const raw = String(req.url || '');
    if (!raw.startsWith(prefix)) return false;
    if (req.headers.origin && req.headers.origin !== webUrl) {
      res.writeHead(403, { 'cache-control': 'no-store' }).end();
      return true;
    }
    const session = getSession(req);
    if (!session) {
      safeJson(res, 401, { error: 'Studio session required' });
      return true;
    }
    let target;
    try { target = new URL(decodeURIComponent(raw.slice(prefix.length))); }
    catch {
      res.writeHead(400, { 'cache-control': 'no-store' }).end();
      return true;
    }
    const method = req.method || 'GET';
    if (!videoTargetAllowed(session.videoConfig, target, method)) {
      res.writeHead(403, { 'cache-control': 'no-store' }).end();
      return true;
    }

    let body;
    if (method === 'POST') {
      try { body = await readCreateBody(req); }
      catch {
        safeJson(res, 400, { error: 'Invalid H3 video request' });
        return true;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), method === 'POST' ? 10 * 60_000 : 15_000);
    req.once('aborted', () => controller.abort());
    res.once('finish', () => clearTimeout(timeout));
    res.once('close', () => { clearTimeout(timeout); if (!res.writableEnded) controller.abort(); });
    const headers = new Headers({ authorization: `Bearer ${session.videoConfig.apiKey}` });
    for (const name of ['accept', 'content-type']) {
      const value = req.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    const init = { method, headers, signal: controller.signal, redirect: 'manual' };
    if (body !== undefined) {
      init.body = body;
      headers.set('content-type', 'application/json');
    }
    try {
      const upstream = await fetchImpl(target.toString(), init);
      if (upstream.status >= 300 && upstream.status < 400) {
        res.writeHead(502, { 'cache-control': 'no-store' }).end();
        return true;
      }
      const forwarded = {};
      for (const name of ['content-type', 'etag', 'last-modified', 'retry-after']) {
        const value = upstream.headers.get(name);
        if (value) forwarded[name] = value;
      }
      forwarded['cache-control'] = 'no-store';
      forwarded['referrer-policy'] = 'no-referrer';
      res.writeHead(upstream.status, forwarded);
      if (!upstream.body) res.end();
      else {
        try { await pipeline(Readable.fromWeb(upstream.body), res); }
        catch { if (!res.destroyed) res.destroy(); }
      }
    } catch {
      if (!res.destroyed && !res.headersSent) safeJson(res, 502, { error: '视频服务转发失败' });
      else if (!res.destroyed) res.destroy();
    }
    return true;
  };
}
