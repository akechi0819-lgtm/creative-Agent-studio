import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listenStudioServer } from '../src/web/server.mjs';
import { readConfigRecord } from '../src/web/config.mjs';

const pluginKey = 'a'.repeat(64);

async function fixture(t, { plugin = false, fetchImpl } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-model-plugin-api-'));
  const staticDir = path.join(root, 'web-dist');
  await fs.mkdir(staticDir, { recursive: true });
  await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>fixture</title>');

  let pluginServer;
  let pluginAddress;
  const pluginRequests = [];
  if (plugin) {
    pluginServer = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      pluginRequests.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : null });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/health') {
        response.end(JSON.stringify({ service: 'studio-model-plugin', instanceId: 'fixture-instance' }));
        return;
      }
      if (request.headers.authorization !== `Bearer ${pluginKey}`) {
        response.statusCode = 401;
        response.end('{}');
        return;
      }
      if (request.url === '/studio/status') {
        response.end(JSON.stringify({
          running: true,
          accounts: [{ id: 'fixture-account', region: 'cn', name: '测试账号' }],
          login: { status: 'idle' },
        }));
        return;
      }
      if (request.url === '/studio/models') {
        response.end(JSON.stringify({ models: [{ id: 'kilo/fixture-free', name: 'Fixture Free', vision: true }] }));
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    await new Promise((resolve, reject) => {
      pluginServer.once('error', reject);
      pluginServer.listen(0, '127.0.0.1', resolve);
    });
    pluginAddress = `http://127.0.0.1:${pluginServer.address().port}`;
    const pluginDirectory = path.join(root, 'model-plugin');
    await fs.mkdir(pluginDirectory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(pluginDirectory, 'instance.json'), JSON.stringify({
      instanceId: 'fixture-instance', baseUrl: pluginAddress, apiKey: pluginKey,
    }), { mode: 0o600 });
  }

  const running = await listenStudioServer({ root, staticDir, fetchImpl });
  const origin = `http://127.0.0.1:${running.address.port}`;
  t.after(async () => {
    await running.close();
    if (pluginServer?.listening) await new Promise((resolve, reject) => pluginServer.close((error) => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    origin,
    pluginAddress,
    pluginRequests,
    async request(url, { json, ...options } = {}) {
      const headers = new Headers(options.headers || {});
      if (options.method && options.method !== 'GET' && options.method !== 'HEAD') headers.set('origin', origin);
      let body = options.body;
      if (json !== undefined) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(json);
      }
      const response = await fetch(`${origin}${url}`, { ...options, headers, body });
      return { response, data: await response.json() };
    },
  };
}

test('saves a managed source without exposing hosted connection credentials', async (t) => {
  const f = await fixture(t);
  const saved = await f.request('/api/config', {
    method: 'POST',
    json: { expectedRevision: 1, base: { source: 'kilo', model: 'kilo/fixture-free' } },
  });

  assert.equal(saved.response.status, 200);
  assert.deepEqual(saved.data.config.base, {
    source: 'kilo', baseUrl: '', model: 'kilo/fixture-free', apiKeyConfigured: false,
  });
  assert.deepEqual((await readConfigRecord({ root: f.root })).base, {
    source: 'kilo', baseUrl: '', model: 'kilo/fixture-free', apiKey: '',
  });
  assert.equal(JSON.stringify(saved.data).includes(pluginKey), false);
});

test('managed model list uses the saved source when the request omits source', async (t) => {
  const f = await fixture(t, { plugin: true });
  const saved = await f.request('/api/config', {
    method: 'POST',
    json: { expectedRevision: 1, base: { source: 'kilo', model: 'kilo/fixture-free' } },
  });
  assert.equal(saved.response.status, 200);

  const listed = await f.request('/api/config/models', { method: 'POST', json: { kind: 'base' } });
  assert.equal(listed.response.status, 200);
  assert.deepEqual(listed.data.models, [{ id: 'kilo/fixture-free', name: 'Fixture Free', vision: true }]);
  assert.deepEqual(f.pluginRequests.filter((item) => item.url === '/studio/models').map((item) => item.body), [{ source: 'kilo' }]);
  assert.equal(JSON.stringify(listed.data).includes(pluginKey), false);
});

test('model plugin status returns account state without local descriptor credentials', async (t) => {
  const f = await fixture(t, { plugin: true });
  const status = await f.request('/api/model-plugin');

  assert.equal(status.response.status, 200);
  assert.deepEqual(status.data, {
    running: true,
    accounts: [{ id: 'fixture-account', region: 'cn', name: '测试账号' }],
    login: { status: 'idle' },
  });
  assert.equal(JSON.stringify(status.data).includes(pluginKey), false);
  assert.equal(JSON.stringify(status.data).includes(f.pluginAddress), false);
});

test('rejects an invalid managed source before contacting the plugin', async (t) => {
  const f = await fixture(t, { plugin: true });
  const result = await f.request('/api/config/models', {
    method: 'POST', json: { kind: 'base', source: 'untrusted-provider' },
  });

  assert.equal(result.response.status, 400);
  assert.equal(result.data.error.code, 'ERR_MODEL_LIST_INPUT');
  assert.equal(f.pluginRequests.some((item) => item.url === '/studio/models'), false);
});

test('custom base model list remains available through the saved API URL and key', async (t) => {
  let providerRequest;
  const f = await fixture(t, {
    fetchImpl: async (input, init) => {
      providerRequest = { url: new URL(input).toString(), init };
      return Response.json({ data: [{ id: 'custom-fixture-model', name: 'Custom Fixture' }] });
    },
  });
  const saved = await f.request('/api/config', {
    method: 'POST',
    json: { expectedRevision: 1, base: {
      baseUrl: 'https://provider.invalid/v1', model: '', apiKey: 'custom-api-test-key',
    } },
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.config.base.source, 'custom');

  const listed = await f.request('/api/config/models', { method: 'POST', json: { kind: 'base' } });
  assert.equal(listed.response.status, 200);
  assert.deepEqual(listed.data.models, [{ id: 'custom-fixture-model', name: 'Custom Fixture' }]);
  assert.equal(providerRequest.url, 'https://provider.invalid/v1/models');
  assert.equal(providerRequest.init.headers.authorization, 'Bearer custom-api-test-key');
  assert.equal(JSON.stringify(listed.data).includes('custom-api-test-key'), false);
});
