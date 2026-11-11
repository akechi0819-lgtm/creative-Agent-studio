import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createVideoProxyHandler, videoBrowserConfig, videoTargetAllowed } from '../src/canvas/video-proxy.mjs';

const createPayload = (extra = {}) => ({
  version: 'video.v1',
  model: 'minimax_h3',
  operation: 'text_to_video',
  prompt: 'A short synthetic provider fixture.',
  duration_seconds: 4,
  resolution: '768',
  aspect_ratio: '16:9',
  ...extra,
});

test('H3 proxy permits only same-origin session traffic to the exact create/status/content contract', async (t) => {
  const providerRequests = [];
  const mp4 = Buffer.from('synthetic-mp4-content');
  let proxy;
  const server = createServer((req, res) => { void proxy(req, res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const webUrl = `http://127.0.0.1:${address.port}`;
  proxy = createVideoProxyHandler({
    webUrl,
    getSession: (req) => req.headers.cookie === 'studio=valid'
      ? { videoConfig: { apiKey: 'fixture-video-secret' } }
      : null,
    fetchImpl: async (url, options) => {
      providerRequests.push({ url, options });
      if (url === 'https://api.osodm.com/v1/videos') {
        return new Response(JSON.stringify({ id: 'video-task-1', status: 'pending' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://api.osodm.com/v1/videos/video-task-1') {
        return new Response(JSON.stringify({ id: 'video-task-1', status: 'completed' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://api.osodm.com/v1/videos/video-task-1/content') {
        return new Response(mp4, { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      throw new Error(`unexpected upstream target: ${url}`);
    },
  });

  const targetUrl = (target) => `${webUrl}/__studio/video-proxy/${encodeURIComponent(target)}`;
  const originHeaders = { origin: webUrl, cookie: 'studio=valid' };
  const create = await fetch(targetUrl('https://api.osodm.com/v1/videos'), {
    method: 'POST',
    headers: { ...originHeaders, 'content-type': 'application/json', authorization: 'Bearer browser-sentinel' },
    body: JSON.stringify(createPayload()),
  });
  assert.equal(create.status, 200);
  assert.deepEqual(await create.json(), { id: 'video-task-1', status: 'pending' });
  assert.equal(providerRequests[0].url, 'https://api.osodm.com/v1/videos');
  assert.equal(providerRequests[0].options.method, 'POST');
  assert.equal(providerRequests[0].options.headers.get('authorization'), 'Bearer fixture-video-secret');
  assert.deepEqual(JSON.parse(providerRequests[0].options.body), createPayload());
  assert.doesNotMatch(providerRequests[0].options.body, /generate_audio|watermark|quality|media_inputs/);

  const status = await fetch(targetUrl('https://api.osodm.com/v1/videos/video-task-1'), { headers: originHeaders });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { id: 'video-task-1', status: 'completed' });
  const content = await fetch(targetUrl('https://api.osodm.com/v1/videos/video-task-1/content'), { headers: originHeaders });
  assert.equal(content.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), mp4);
  assert.equal(providerRequests.length, 3);

  const safe = videoBrowserConfig({ apiKey: 'fixture-video-secret' }, webUrl);
  assert.equal(safe.apiKey, 'local-session');
  assert.equal(safe.apiKeyConfigured, true);
  assert.equal(safe.proxyEnabled, true);
  assert.equal(safe.proxyUrl, `${webUrl}/__studio/image-proxy`);
  assert.equal(JSON.stringify(safe).includes('fixture-video-secret'), false);
});

test('H3 proxy rejects absent sessions, other origins/providers, non-contract methods, and unsupported video inputs', async (t) => {
  let calls = 0;
  let proxy;
  const server = createServer((req, res) => { void proxy(req, res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const webUrl = `http://127.0.0.1:${server.address().port}`;
  proxy = createVideoProxyHandler({
    webUrl,
    getSession: (req) => req.headers.cookie === 'studio=valid'
      ? { videoConfig: { apiKey: 'fixture-video-secret' } }
      : null,
    fetchImpl: async () => { calls += 1; return new Response('{}', { status: 200 }); },
  });
  const targetUrl = (target) => `${webUrl}/__studio/video-proxy/${encodeURIComponent(target)}`;
  const valid = { origin: webUrl, cookie: 'studio=valid', 'content-type': 'application/json' };

  assert.equal((await fetch(targetUrl('https://api.osodm.com/v1/videos'), { method: 'POST', headers: { origin: webUrl, 'content-type': 'application/json' }, body: JSON.stringify(createPayload()) })).status, 401);
  assert.equal((await fetch(targetUrl('https://api.osodm.com/v1/videos'), { method: 'POST', headers: { ...valid, origin: 'https://evil.example' }, body: JSON.stringify(createPayload()) })).status, 403);
  assert.equal((await fetch(targetUrl('https://evil.example/v1/videos'), { method: 'POST', headers: valid, body: JSON.stringify(createPayload()) })).status, 403);
  assert.equal((await fetch(targetUrl('https://api.osodm.com/v1/models'), { headers: valid })).status, 403);
  assert.equal((await fetch(targetUrl('https://api.osodm.com/v1/videos/video-task-1'), { method: 'DELETE', headers: valid })).status, 403);
  assert.equal((await fetch(targetUrl('https://api.osodm.com/v1/videos'), { method: 'POST', headers: valid, body: JSON.stringify(createPayload({ generate_audio: true })) })).status, 400);
  assert.equal((await fetch(targetUrl('https://api.osodm.com/v1/videos'), { method: 'POST', headers: valid, body: JSON.stringify(createPayload({ duration_seconds: 16 })) })).status, 400);
  assert.equal(calls, 0);
});

test('video target allowlist matches only the configured H3 route set', () => {
  const videoConfig = { apiKey: 'fixture-video-secret' };
  assert.equal(videoTargetAllowed(videoConfig, new URL('https://api.osodm.com/v1/videos'), 'POST'), true);
  assert.equal(videoTargetAllowed(videoConfig, new URL('https://api.osodm.com/v1/videos/video-task-1'), 'GET'), true);
  assert.equal(videoTargetAllowed(videoConfig, new URL('https://api.osodm.com/v1/videos/video-task-1/content'), 'GET'), true);
  assert.equal(videoTargetAllowed(videoConfig, new URL('https://api.osodm.com/v1/models'), 'GET'), false);
  assert.equal(videoTargetAllowed(videoConfig, new URL('https://evil.example/v1/videos'), 'POST'), false);
  assert.equal(videoTargetAllowed({ apiKey: '' }, new URL('https://api.osodm.com/v1/videos'), 'POST'), false);
});
