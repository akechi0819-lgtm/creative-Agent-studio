import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listenStudioServer } from '../src/web/server.mjs';
import { createStudioAgent } from '../adapters/dsh/runtime.mjs';
import { readConfig, readConfigRecord } from '../src/web/config.mjs';
import { createJobManager } from '../src/web/jobs.mjs';
import {
  approveFinal,
  confirmInputs,
  confirmSheet,
  createTask,
  readTask,
  recordReview,
  setBrief,
  setSources,
  setSheet,
  taskDirectory,
  withTask,
} from '../src/creative/tasks.mjs';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-studio-web-api-'));
  const staticDir = path.join(root, 'web-dist');
  await fs.mkdir(staticDir, { recursive: true });
  await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>fixture</title>');
  const serverOptions = { ...options };
  if (typeof options.agentFactory === 'function') serverOptions.agent = options.agentFactory(root);
  delete serverOptions.agentFactory;
  if (options.agent && typeof options.readConfig !== 'function') {
    serverOptions.readConfig = async () => ({
      basic: { baseUrl: 'https://fixture.invalid/v1', model: 'fixture-default-model', apiKey: 'fixture-agent-key' },
      image: { baseUrl: '', model: '', apiKey: '' },
    });
  }
  const running = await listenStudioServer({ root, staticDir, ...serverOptions });
  const origin = `http://127.0.0.1:${running.address.port}`;
  t.after(async () => {
    await running.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    origin,
    async request(url, { json, ...optionsValue } = {}) {
      const headers = new Headers(optionsValue.headers || {});
      if (optionsValue.method && optionsValue.method !== 'GET' && optionsValue.method !== 'HEAD') headers.set('origin', origin);
      let body = optionsValue.body;
      if (json !== undefined) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(json);
      }
      const response = await fetch(`${origin}${url}`, { ...optionsValue, headers, body });
      const type = response.headers.get('content-type') || '';
      const data = type.includes('application/json') ? await response.json() : await response.arrayBuffer();
      return { response, data };
    },
  };
}

function sheet() {
  return { title: '隔离 Web 夹具', pages: [{ page: 1, copy: '准确文案', prompt: '测试画面', size: '3:4' }] };
}

async function prepareTask(root) {
  let task = await createTask({ title: '隔离 Web 夹具', brief: { topic: '测试主题' } }, root);
  task = await confirmInputs(task.id, { revision: task.revision, by: '测试用户', note: '测试确认需求' }, { root });
  task = await setSheet(task.id, sheet(), {
    root,
    expectedRevision: task.revision,
    inputRevision: task.inputConfirmation.revision,
  });
  task = await confirmSheet(task.id, { version: task.sheetVersion, by: '测试用户', note: '测试确认制作单' }, { root, expectedRevision: task.revision });
  const imagePath = path.join(taskDirectory(task.id, root), 'generated', 'page-01.png');
  const bytes = Buffer.from('isolated image bytes');
  await fs.mkdir(path.dirname(imagePath), { recursive: true });
  await fs.writeFile(imagePath, bytes);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  task = await withTask(task.id, (draft) => {
    draft.execution = {
      version: draft.sheetVersion,
      status: 'succeeded',
      pages: [{ page: 1, status: 'succeeded', nodeId: 'task-node-1', imageNodeId: 'task-image-1', image: { path: imagePath, sha256 } }],
    };
  }, { root, expectedRevision: task.revision });
  return { task, imagePath, sha256, bytes };
}

async function readJob(f, id) {
  const result = await f.request(`/api/jobs/${id}`);
  assert.equal(result.response.status, 200);
  return result.data.job;
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test('config API masks keys, persists private mode, and explicitly clears an omitted channel', async (t) => {
  const f = await fixture(t);
  const saved = await f.request('/api/config', {
    method: 'POST',
    json: { expectedRevision: 1, base: { baseUrl: 'https://provider.invalid/v1', model: 'fixture-model', apiKey: 'secret-web-test-key' } },
  });
  assert.equal(saved.response.status, 200);
  assert.deepEqual(saved.data.config.base, { source: 'custom', baseUrl: 'https://provider.invalid/v1', model: 'fixture-model', apiKeyConfigured: true });
  assert.equal(JSON.stringify(saved.data).includes('secret-web-test-key'), false);
  const publicRead = await f.request('/api/config');
  assert.equal(publicRead.data.config.base.apiKey, undefined);
  assert.equal(publicRead.data.config.base.apiKeyConfigured, true);
  const configPath = path.join(f.root, 'config', 'studio.json');
  const configInfo = await fs.stat(configPath);
  const configDirectoryInfo = await fs.stat(path.dirname(configPath));
  assert.ok(configInfo.isFile());
  assert.ok(configDirectoryInfo.isDirectory());
  // Windows uses the user's inherited directory ACL; Node mode bits do not represent POSIX 0600/0700 there.
  if (process.platform !== 'win32') {
    assert.equal(configInfo.mode & 0o777, 0o600);
    assert.equal(configDirectoryInfo.mode & 0o777, 0o700);
  }

  const cleared = await f.request('/api/config', { method: 'POST', json: { expectedRevision: 2, clearKeys: ['base'] } });
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.data.config.base.apiKeyConfigured, false);
  assert.equal((await readConfig({ root: f.root })).basic.apiKey, '');
  assert.equal((await readConfigRecord({ root: f.root })).revision, 3);
});

test('config save remains successful while reporting an active Canvas sync failure', async (t) => {
  const fakeKey = 'fake-image-key-for-sync-status';
  let syncCall = null;
  const f = await fixture(t, {
    canvas: {
      syncImageConfig: async (record) => {
        syncCall = { revision: record.revision, keyMatches: record.image.apiKey === fakeKey };
        return { status: 'unsynced', updated: 0, active: 1, message: 'Canvas 尚未确认新配置。' };
      },
    },
  });
  const saved = await f.request('/api/config', {
    method: 'POST',
    json: { expectedRevision: 1, image: { baseUrl: 'https://image.invalid/v1', model: 'fixture-image', apiKey: fakeKey } },
  });

  assert.equal(saved.response.status, 200, 'config persistence does not fail with Canvas sync');
  assert.equal(saved.data.canvasSync.status, 'unsynced');
  assert.equal(saved.data.config.image.apiKeyConfigured, true);
  assert.ok(syncCall?.revision > 1);
  assert.equal(syncCall.keyMatches, true);
  assert.equal(JSON.stringify(saved.data).includes(fakeKey), false, 'the saved credential is absent from the ordinary API response');
  assert.equal((await readConfigRecord({ root: f.root })).image.apiKey, fakeKey, 'the key remains saved so the UI can offer sync retry without re-entry');
});

test('model list uses an explicit id list, deduplicates, and works before a model is selected', async (t) => {
  let requestDetails;
  const f = await fixture(t, {
    fetchImpl: async (input, init) => {
      requestDetails = { url: new URL(input).toString(), init };
      return new Response(JSON.stringify({ data: [
        { id: 'fixture-model', name: 'Fixture Model' },
        { id: 'fixture-model', name: 'Duplicate name' },
        { name: 'Name is not an id' },
        { id: '' },
        { id: 'sk-do-not-return-this-secret12345' },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const saved = await f.request('/api/config', {
    method: 'POST',
    json: { expectedRevision: 1, base: { baseUrl: 'https://provider.invalid/v1', model: '', apiKey: 'fixture-model-list-secret' } },
  });
  assert.equal(saved.response.status, 200);

  const listed = await f.request('/api/config/models', { method: 'POST', json: { kind: 'base' } });
  assert.equal(listed.response.status, 200);
  assert.deepEqual(listed.data.models, [{ id: 'fixture-model', name: 'Fixture Model' }]);
  assert.equal(requestDetails.url, 'https://provider.invalid/v1/models');
  assert.equal(requestDetails.init.method, 'GET');
  assert.equal(requestDetails.init.redirect, 'manual');
  assert.equal(requestDetails.init.headers.authorization, 'Bearer fixture-model-list-secret');
  assert.equal((await readConfigRecord({ root: f.root })).base.model, '');
  assert.equal(JSON.stringify(listed.data).includes('fixture-model-list-secret'), false);
});

test('model list errors never return provider bodies or credentials', async (t) => {
  const secret = 'fixture-auth-secret-never-return';
  const f = await fixture(t, {
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: `${secret} provider internal detail` } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const saved = await f.request('/api/config', {
    method: 'POST',
    json: { expectedRevision: 1, base: { baseUrl: 'https://provider.invalid/v1', model: '', apiKey: secret } },
  });
  assert.equal(saved.response.status, 200);
  const result = await f.request('/api/config/models', { method: 'POST', json: { kind: 'base' } });
  assert.equal(result.response.status, 502);
  assert.equal(result.data.error.code, 'ERR_MODEL_LIST_AUTH');
  assert.equal(JSON.stringify(result.data).includes(secret), false);
  assert.equal(JSON.stringify(result.data).includes('provider internal detail'), false);
});

test('model list never reuses a saved key when the requested provider URL changes', async (t) => {
  let requests = 0;
  const f = await fixture(t, { fetchImpl: async () => { requests += 1; return new Response('{"data":[]}'); } });
  const secret = 'stored-provider-secret-must-stay-local';
  const saved = await f.request('/api/config', {
    method: 'POST',
    json: { expectedRevision: 1, base: { baseUrl: 'https://known.invalid/v1', model: '', apiKey: secret } },
  });
  assert.equal(saved.response.status, 200);
  const result = await f.request('/api/config/models', {
    method: 'POST',
    json: { kind: 'base', baseUrl: 'https://unknown.invalid/v1' },
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.data.error.code, 'ERR_MODEL_KEY_REQUIRED');
  assert.equal(requests, 0);
  assert.equal(JSON.stringify(result.data).includes(secret), false);
});

test('config check reads the image provider model list without starting a generation', async (t) => {
  let agentChecks = 0;
  let imageRequest = null;
  const f = await fixture(t, {
    agent: { check: async () => { agentChecks += 1; return { text: true, tools: true, vision: false, notes: 'text and tools only' }; } },
    fetchImpl: async (input, init) => {
      imageRequest = { url: new URL(input).toString(), init };
      return new Response(JSON.stringify({ data: [{ id: 'image-fixture' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const empty = await f.request('/api/config/check', { method: 'POST', json: { kind: 'all' } });
  assert.equal(empty.response.status, 200);
  assert.equal(agentChecks, 0);
  assert.equal(imageRequest, null);
  assert.equal(empty.data.checks.base.status, 'not_configured');
  assert.equal(empty.data.checks.image.status, 'not_configured');
  assert.deepEqual(empty.data.checks.image.capabilities, {
    provider: 'openai-compatible',
    model: null,
    connectionTested: false,
    modelsEndpointAvailable: false,
    modelListed: null,
  });

  const saved = await f.request('/api/config', {
    method: 'POST',
    json: {
      expectedRevision: 1,
      base: { baseUrl: 'https://basic.invalid/v1', model: 'basic-fixture', apiKey: 'basic-check-secret' },
      image: { baseUrl: 'https://image.invalid/v1', model: 'image-fixture', apiKey: 'image-check-secret' },
    },
  });
  assert.equal(saved.response.status, 200);
  const checked = await f.request('/api/config/check', { method: 'POST', json: { kind: 'all' } });
  assert.equal(checked.response.status, 200);
  assert.equal(agentChecks, 1);
  assert.equal(checked.data.checks.base.status, 'connected');
  assert.equal(checked.data.checks.base.capabilities.vision, false);
  assert.equal(checked.data.checks.image.status, 'connected');
  assert.equal(checked.data.checks.image.capabilities.connectionTested, true);
  assert.equal(checked.data.checks.image.capabilities.modelListed, true);
  assert.match(checked.data.checks.image.message, /未发起生图请求/);
  assert.equal(imageRequest.url, 'https://image.invalid/v1/models');
  assert.equal(imageRequest.init.method, 'GET');
  assert.equal(imageRequest.init.redirect, 'manual');
  assert.equal(imageRequest.init.headers.authorization, 'Bearer image-check-secret');
  assert.equal(imageRequest.init.body, undefined);
  assert.equal(JSON.stringify(checked.data).includes('image-check-secret'), false);
});

test('image config check leaves providers without a standard model list unverified', async (t) => {
  let response = new Response(JSON.stringify({ models: [{ name: 'image-fixture' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const f = await fixture(t, { fetchImpl: async () => response });
  const saved = await f.request('/api/config', {
    method: 'POST',
    json: { expectedRevision: 1, image: { baseUrl: 'https://image.invalid/custom/v1/', model: 'image-fixture', apiKey: 'image-check-secret' } },
  });
  assert.equal(saved.response.status, 200);

  const first = await f.request('/api/config/check', { method: 'POST', json: { kind: 'image' } });
  assert.equal(first.data.checks.image.status, 'unverified');
  assert.equal(first.data.checks.image.capabilities.connectionTested, true);
  assert.equal(first.data.checks.image.capabilities.modelsEndpointAvailable, false);
  assert.equal(JSON.stringify(first.data).includes('image-check-secret'), false);

  response = new Response('', { status: 404 });
  const second = await f.request('/api/config/check', { method: 'POST', json: { kind: 'image' } });
  assert.equal(second.data.checks.image.status, 'unverified');
  assert.match(second.data.checks.image.message, /模型待核/);

  response = new Response(JSON.stringify({ data: [{ id: 'different-model' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const third = await f.request('/api/config/check', { method: 'POST', json: { kind: 'image' } });
  assert.equal(third.data.checks.image.status, 'failed');
  assert.equal(third.data.checks.image.capabilities.modelsEndpointAvailable, true);
  assert.equal(third.data.checks.image.capabilities.modelListed, false);
});

test('asset-clean job fails when a local mock model returns invalid output', async (t) => {
  let authorization = '';
  const mockProvider = http.createServer(async (request, response) => {
    authorization = request.headers.authorization || '';
    for await (const _chunk of request) { /* consume the request body without persisting it */ }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'not a JSON cleaning result' } }] }));
  });
  await new Promise((resolve, reject) => {
    mockProvider.once('error', reject);
    mockProvider.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => new Promise((resolve) => mockProvider.close(resolve)));

  const providerUrl = `http://127.0.0.1:${mockProvider.address().port}/v1`;
  const f = await fixture(t);
  const secret = 'mock-clean-secret-do-not-return';
  const saved = await f.request('/api/config', {
    method: 'POST',
    json: { expectedRevision: 1, base: { baseUrl: providerUrl, model: 'fixture-cleaner', apiKey: secret } },
  });
  assert.equal(saved.response.status, 200);

  const form = new FormData();
  form.set('title', '隔离清洗失败夹具');
  form.set('body', '只有本地 mock HTTP 模型会收到这段测试内容。');
  form.set('tags', JSON.stringify([]));
  form.set('source', JSON.stringify({ kind: 'test-fixture' }));
  form.append('files', new Blob(['本地清洗失败用的测试原件。'], { type: 'text/plain' }), 'fixture.txt');
  const imported = await f.request('/api/assets', { method: 'POST', body: form });
  assert.equal(imported.response.status, 201, JSON.stringify(imported.data));

  const started = await f.request(`/api/assets/${imported.data.asset.id}/clean`, {
    method: 'POST',
    json: { expectedRevision: imported.data.asset.revision },
  });
  assert.equal(started.response.status, 202);
  const terminal = await waitFor(async () => {
    const job = await readJob(f, started.data.job.id);
    return ['failed', 'succeeded', 'cancelled'].includes(job.status) ? job : null;
  }, 'invalid mock model output should fail the clean job');

  assert.equal(authorization, `Bearer ${secret}`);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.error.code, 'ERR_ASSET_CLEAN_FAILED');
  assert.match(terminal.error.message, /清洗失败/);
  assert.equal(terminal.result, null);
  const current = await f.request(`/api/assets/${imported.data.asset.id}`);
  assert.equal(current.response.status, 200);
  assert.equal(current.data.asset.status, 'clean_failed');
  assert.equal(current.data.asset.lastError.code, 'ERR_ASSET_CLEAN_FAILED');
  assert.equal(JSON.stringify({ terminal, current: current.data }).includes(secret), false);
  assert.equal(JSON.stringify({ terminal, current: current.data }).includes('not a JSON cleaning result'), false);
});

test('API binds same-origin writes, exposes task state, and applies expectedRevision CAS', async (t) => {
  const f = await fixture(t);
  const page = await f.request('/');
  assert.equal(page.response.status, 200);
  assert.match(Buffer.from(page.data).toString(), /fixture/);

  const denied = await fetch(`${f.origin}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://outside.invalid' },
    body: JSON.stringify({ title: '拒绝跨源写入', brief: 'test' }),
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'ERR_CSRF_REJECTED');

  const created = await f.request('/api/tasks', { method: 'POST', json: { title: 'Web API 夹具', brief: '初始需求' } });
  assert.equal(created.response.status, 201);
  const id = created.data.task.id;
  assert.equal(created.data.task.revision, 1);
  const changed = await f.request(`/api/tasks/${id}/set-brief`, { method: 'POST', json: { brief: '更新需求', expectedRevision: 1 } });
  assert.equal(changed.response.status, 200);
  assert.equal(changed.data.task.revision, 2);
  const stale = await f.request(`/api/tasks/${id}/set-brief`, { method: 'POST', json: { brief: '旧页面需求', expectedRevision: 1 } });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.data.error.code, 'ERR_TASK_REVISION_CONFLICT');
  const detail = await f.request(`/api/tasks/${id}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.data.task.brief, '更新需求');
  assert.deepEqual(detail.data.conversation, []);
  assert.deepEqual(detail.data.operations, []);
  const bootstrap = await f.request('/api/bootstrap');
  assert.equal(bootstrap.response.status, 200);
  assert.ok(bootstrap.data.tasks.some((task) => task.id === id));
});

test('references endpoint mixes existing and external sources in one CAS without accepting client paths', async (t) => {
  const f = await fixture(t);
  let task = await createTask({ title: '来源版本夹具', brief: '当前业务需求' }, f.root);
  task = await setSources(task.id, [{
    id: 'current-reference-1',
    type: 'external',
    title: '已有资料',
    body: '已保存的正文',
    decision: 'pending',
    purpose: '核对当前业务',
    factBoundary: '以用户提供资料为准',
    files: [],
    extractions: [{ name: 'prior.txt', text: '原有提取文本' }],
  }], { root: f.root, expectedRevision: task.revision });
  const changed = await f.request(`/api/tasks/${task.id}/references`, {
    method: 'POST',
    json: {
      expectedRevision: task.revision,
      items: [
        { kind: 'existing', id: 'current-reference-1', decision: 'retained', purpose: '仅核对结构', factBoundary: '不得沿用历史数字', path: '/etc/passwd' },
        { kind: 'external', id: 'new-reference-2', title: '外部页面', url: 'https://example.invalid/reference', body: '本次提供的公开参考', decision: 'excluded', purpose: '只作排除示例', factBoundary: '不进入制作单' },
      ],
    },
  });
  assert.equal(changed.response.status, 200);
  assert.equal(changed.data.task.revision, task.revision + 1);
  assert.deepEqual(changed.data.task.sources.map((source) => source.decision), ['retained', 'excluded']);
  assert.equal(changed.data.task.sources[0].extractions[0].text, '原有提取文本');
  assert.equal(JSON.stringify(changed.data).includes('/etc/passwd'), false);
  assert.equal(JSON.stringify(changed.data).includes('relativePath'), false);
  const stale = await f.request(`/api/tasks/${task.id}/references`, {
    method: 'POST',
    json: { expectedRevision: task.revision, items: [] },
  });
  assert.equal(stale.response.status, 409);
  assert.equal((await readTask(task.id, f.root)).sources.length, 2);
});

test('task attachment route uses chat instructions, persists upload idempotency, and rejects legacy fields', async (t) => {
  const f = await fixture(t);
  const created = await f.request('/api/tasks', { method: 'POST', json: { title: '附件夹具', brief: '读取当前资料' } });
  const task = created.data.task;
  const forged = new FormData();
  forged.set('expectedRevision', String(task.revision));
  forged.set('uploadId', crypto.randomUUID());
  forged.set('instructions', '这一轮说明');
  forged.set('title', '伪造提取结果');
  forged.set('extractions', '[]');
  forged.append('files', new Blob(['原始文本'], { type: 'text/plain' }), 'forged.txt');
  const rejected = await f.request(`/api/tasks/${task.id}/attachments`, { method: 'POST', body: forged });
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.data.error.code, 'ERR_MULTIPART_FIELD');
  assert.equal((await readTask(task.id, f.root)).revision, task.revision);

  const uploadId = crypto.randomUUID();
  const instructions = `本轮用途：请比较招生方案，并且不要把附件中未经本轮确认的数字当作事实。${'补充限制。'.repeat(250)}`;
  const form = new FormData();
  form.set('expectedRevision', String(task.revision));
  form.set('uploadId', uploadId);
  form.set('instructions', instructions);
  form.append('files', new Blob(['本期招生方案。事实仍待业务负责人确认。'], { type: 'text/plain' }), 'current-brief.txt');
  const uploaded = await f.request(`/api/tasks/${task.id}/attachments`, { method: 'POST', body: form });
  assert.equal(uploaded.response.status, 200, JSON.stringify(uploaded.data));
  assert.equal(uploaded.data.task.revision, task.revision + 1);
  assert.equal(uploaded.data.uploadRevision, task.revision + 1);
  assert.equal(uploaded.data.replayed, false);
  assert.match(uploaded.data.sourceId, /^[0-9a-f-]{36}$/i);
  const source = uploaded.data.task.sources[0];
  assert.equal(source.type, 'current_attachment');
  assert.equal(source.decision, 'pending');
  assert.equal(source.title, 'current-brief.txt');
  assert.equal(source.purpose, instructions.slice(0, 2000));
  assert.equal(source.factBoundary, '仅依照用户本轮说明使用；未经本次确认不引用附件中的品牌、价格或日期作为事实');
  assert.equal(source.files[0].name, 'current-brief.txt');
  assert.equal(source.files[0].mimeType, 'text/plain');
  assert.equal(source.extractions[0].text, '本期招生方案。事实仍待业务负责人确认。');
  assert.equal(source.uploadId, undefined);
  assert.equal(source.uploadFingerprint, undefined);
  assert.equal(source.uploadRevision, undefined);
  const storedSource = (await readTask(task.id, f.root)).sources[0];
  assert.equal(storedSource.uploadId, uploadId);
  assert.match(storedSource.uploadFingerprint, /^[0-9a-f]{64}$/i);
  assert.equal(storedSource.uploadRevision, uploaded.data.uploadRevision);
  assert.equal(JSON.stringify(uploaded.data.task).includes(f.root), false);
  const original = await f.request(source.files[0].fileUrl);
  assert.equal(original.response.status, 200);
  assert.equal(Buffer.from(original.data).toString(), '本期招生方案。事实仍待业务负责人确认。');

  const replay = new FormData();
  replay.set('expectedRevision', String(task.revision));
  replay.set('uploadId', uploadId);
  replay.set('instructions', instructions);
  replay.append('files', new Blob(['本期招生方案。事实仍待业务负责人确认。'], { type: 'text/plain' }), 'current-brief.txt');
  const replayed = await f.request(`/api/tasks/${task.id}/attachments`, { method: 'POST', body: replay });
  assert.equal(replayed.response.status, 200, JSON.stringify(replayed.data));
  assert.equal(replayed.data.replayed, true);
  assert.equal(replayed.data.sourceId, uploaded.data.sourceId);
  assert.equal(replayed.data.uploadRevision, uploaded.data.uploadRevision);
  assert.equal(replayed.data.task.revision, uploaded.data.task.revision);
  assert.equal((await readTask(task.id, f.root)).sources.length, 1);

  const changed = new FormData();
  changed.set('expectedRevision', String(task.revision));
  changed.set('uploadId', uploadId);
  changed.set('instructions', instructions);
  changed.append('files', new Blob(['不同附件内容'], { type: 'text/plain' }), 'current-brief.txt');
  const conflict = await f.request(`/api/tasks/${task.id}/attachments`, { method: 'POST', body: changed });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.data.error.code, 'ERR_ATTACHMENT_UPLOAD_ID_CONFLICT');
  assert.equal((await readTask(task.id, f.root)).sources.length, 1);
});

test('chat persists only validated attachment source IDs from this upload', async (t) => {
  const f = await fixture(t, { agent: { chat: async ({ text }) => ({ text: `收到：${text}` }) } });
  const first = await f.request('/api/tasks', { method: 'POST', json: { title: '附件消息', brief: '测试来源引用' } });
  const second = await f.request('/api/tasks', { method: 'POST', json: { title: '其他任务', brief: '隔离来源' } });
  const uploadId = crypto.randomUUID();
  const uploadFor = async (taskId, id, contents) => {
    const form = new FormData();
    form.set('expectedRevision', '1');
    form.set('uploadId', id);
    form.set('instructions', '本轮对话请分析附件。');
    form.append('files', new Blob([contents], { type: 'text/plain' }), 'chat.txt');
    return f.request(`/api/tasks/${taskId}/attachments`, { method: 'POST', body: form });
  };
  const firstUpload = await uploadFor(first.data.task.id, uploadId, 'task one');
  const otherUpload = await uploadFor(second.data.task.id, crypto.randomUUID(), 'task two');
  assert.equal(firstUpload.response.status, 200);
  assert.equal(otherUpload.response.status, 200);

  const forged = await f.request(`/api/tasks/${first.data.task.id}/chat`, {
    method: 'POST',
    json: { text: '跨任务引用', expectedRevision: firstUpload.data.uploadRevision, requestId: uploadId, attachmentSourceIds: [otherUpload.data.sourceId] },
  });
  assert.equal(forged.response.status, 400);
  assert.equal(forged.data.error.code, 'ERR_CHAT_ATTACHMENT_INVALID');

  const wrongRequest = await f.request(`/api/tasks/${first.data.task.id}/chat`, {
    method: 'POST',
    json: { text: '上传 ID 绑定校验', expectedRevision: firstUpload.data.uploadRevision, requestId: crypto.randomUUID(), attachmentSourceIds: [firstUpload.data.sourceId] },
  });
  assert.equal(wrongRequest.response.status, 400);
  assert.equal(wrongRequest.data.error.code, 'ERR_CHAT_ATTACHMENT_INVALID');

  const submitted = await f.request(`/api/tasks/${first.data.task.id}/chat`, {
    method: 'POST',
    json: { text: '请按本轮说明分析附件。', expectedRevision: firstUpload.data.uploadRevision, requestId: uploadId, attachmentSourceIds: [firstUpload.data.sourceId] },
  });
  assert.equal(submitted.response.status, 202);
  const completed = await waitFor(async () => {
    const job = await readJob(f, submitted.data.job.id);
    return job.status === 'succeeded' ? job : null;
  }, 'the attachment chat should finish');
  assert.equal(completed.status, 'succeeded');
  const detail = await f.request(`/api/tasks/${first.data.task.id}`);
  assert.deepEqual(detail.data.conversation[0].attachmentSourceIds, [firstUpload.data.sourceId]);
  assert.equal(detail.data.conversation[0].requestId, uploadId);
  assert.equal(JSON.stringify(detail.data.conversation).includes('fileUrl'), false);
});

test('review and final approval reject a Canvas image that is no longer fresh', async (t) => {
  let freshChecks = 0;
  let reviewCalls = 0;
  const canvas = {
    state: async () => ({ projectId: 'fixture-project', clientConnected: true, images: [] }),
    assertFresh: async () => {
      freshChecks += 1;
      const failure = new Error('Canvas image hash changed');
      failure.code = 'ERR_CANVAS_STALE_IMAGE';
      failure.safeMessage = 'Canvas 当前图片已变化，请重新同步。';
      throw failure;
    },
  };
  const agent = { review: async () => { reviewCalls += 1; return { text: 'reviewed' }; } };
  const f = await fixture(t, { canvas, agent });
  let { task, sha256 } = await prepareTask(f.root);

  const staleReview = await f.request(`/api/tasks/${task.id}/review`, {
    method: 'POST',
    json: { page: 1, expectedRevision: task.revision },
  });
  assert.equal(staleReview.response.status, 409);
  assert.equal(staleReview.data.error.code, 'ERR_CANVAS_STALE_IMAGE');
  assert.equal(reviewCalls, 0, 'stale Canvas images must not be sent for review');

  task = await recordReview(task.id, {
    page: 1, sha256, decision: 'pass', reviewer: '测试用户', notes: '隔离夹具读图记录',
  }, { root: f.root, expectedRevision: task.revision });
  const staleApproval = await f.request(`/api/tasks/${task.id}/approve-final`, {
    method: 'POST',
    json: { version: task.sheetVersion, images: [{ page: 1, sha256 }], by: '测试用户', note: '隔离夹具批准', expectedRevision: task.revision },
  });
  assert.equal(staleApproval.response.status, 409);
  assert.equal(staleApproval.data.error.code, 'ERR_CANVAS_STALE_IMAGE');
  assert.equal((await readTask(task.id, f.root)).finalApproval, null);
  assert.equal(freshChecks, 2);
});

test('explicit Canvas reconciliation revokes persisted reviews and approval after an image changes', async (t) => {
  let currentRevision = null;
  let freshChecks = 0;
  const canvas = {
    state: async (taskId) => ({
      state: 'ready',
      projectId: taskId,
      clientConnected: true,
      images: [],
      task: {
        revision: currentRevision,
        version: 1,
        pages: [{ page: 1, nodeId: 'task-node-1', imageNodeId: 'task-image-1', sha256: 'a'.repeat(64), currentSha256: 'a'.repeat(64), status: 'succeeded' }],
      },
    }),
    assertFresh: async (taskId, options) => {
      freshChecks += 1;
      assert.equal(options.expectedRevision, currentRevision);
      assert.equal(options.version, 1);
      assert.deepEqual(options.images, [{ page: 1, sha256: seeded.sha256 }]);
      const failure = new Error('Canvas output changed');
      failure.code = 'ERR_CANVAS_IMAGE_CHANGED';
      failure.safeMessage = 'Canvas 当前图片已变化';
      throw failure;
    },
  };
  const f = await fixture(t, { canvas });
  const seeded = await prepareTask(f.root);
  let task = await recordReview(seeded.task.id, {
    page: 1,
    sha256: seeded.sha256,
    decision: 'pass',
    reviewer: '测试用户',
    notes: '原成品审核记录',
  }, { root: f.root, expectedRevision: seeded.task.revision });
  task = await approveFinal(seeded.task.id, {
    version: task.sheetVersion,
    images: [{ page: 1, sha256: seeded.sha256 }],
    by: '测试用户',
    note: '原成品批准',
  }, { root: f.root, expectedRevision: task.revision });
  currentRevision = task.revision;

  const reconciled = await f.request(`/api/tasks/${task.id}/reconcile-canvas`, {
    method: 'POST',
    json: { expectedRevision: task.revision },
  });
  assert.equal(reconciled.response.status, 200, JSON.stringify(reconciled.data));
  assert.equal(reconciled.data.needsSync, true);
  assert.deepEqual(reconciled.data.changedPages, [{
    page: 1,
    code: 'ERR_CANVAS_IMAGE_CHANGED',
    previousSha256: seeded.sha256,
    currentSha256: 'a'.repeat(64),
  }]);
  assert.equal(reconciled.data.task.revision, task.revision + 1);
  assert.equal(freshChecks, 1);

  const persisted = await readTask(task.id, f.root);
  assert.deepEqual(persisted.reviews, []);
  assert.equal(persisted.finalApproval, null);
  assert.equal(persisted.execution.pages[0].image.sha256, seeded.sha256, 'the old image stays in the task until the user explicitly syncs a replacement');
});

test('Canvas reconciliation reports disconnection without revoking prior confirmation', async (t) => {
  let freshChecks = 0;
  const canvas = {
    state: async (taskId) => ({ state: 'disconnected', projectId: taskId, clientConnected: false, images: [], task: { revision: currentRevision, version: 1, pages: [] } }),
    assertFresh: async () => { freshChecks += 1; throw new Error('should not check a disconnected Canvas'); },
  };
  let currentRevision = null;
  const f = await fixture(t, { canvas });
  const seeded = await prepareTask(f.root);
  let task = await recordReview(seeded.task.id, {
    page: 1,
    sha256: seeded.sha256,
    decision: 'pass',
    reviewer: '测试用户',
    notes: '离线时保留的审核记录',
  }, { root: f.root, expectedRevision: seeded.task.revision });
  task = await approveFinal(seeded.task.id, {
    version: task.sheetVersion,
    images: [{ page: 1, sha256: seeded.sha256 }],
    by: '测试用户',
    note: '离线时保留的批准',
  }, { root: f.root, expectedRevision: task.revision });
  currentRevision = task.revision;

  const response = await f.request(`/api/tasks/${task.id}/reconcile-canvas`, {
    method: 'POST',
    json: { expectedRevision: task.revision },
  });
  assert.equal(response.response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.canvas.state, 'disconnected');
  assert.equal(response.data.needsSync, null);
  assert.deepEqual(response.data.changedPages, []);
  assert.equal(response.data.task.revision, task.revision);
  assert.equal(freshChecks, 0);
  const persisted = await readTask(task.id, f.root);
  assert.equal(persisted.reviews.length, 1);
  assert.ok(persisted.finalApproval);
});

test('Canvas reconciliation returns busy without reading Canvas while a task job owns the lease', async (t) => {
  let releaseAgent;
  let agentStarted;
  const gate = new Promise((resolve) => { releaseAgent = resolve; });
  const started = new Promise((resolve) => { agentStarted = resolve; });
  let stateReads = 0;
  const f = await fixture(t, {
    agent: { chat: async () => { agentStarted(); await gate; return { text: '已完成' }; } },
    canvas: {
      state: async () => { stateReads += 1; return { clientConnected: false, images: [] }; },
      assertFresh: async () => { throw new Error('Canvas should not be checked while a job is active'); },
    },
  });
  const created = await f.request('/api/tasks', { method: 'POST', json: { title: '活动任务夹具', brief: '测试租约' } });
  const task = created.data.task;
  const chat = await f.request(`/api/tasks/${task.id}/chat`, {
    method: 'POST',
    json: { text: '长时间运行的测试消息', expectedRevision: task.revision, requestId: crypto.randomUUID() },
  });
  assert.equal(chat.response.status, 202);
  await started;

  const response = await f.request(`/api/tasks/${task.id}/reconcile-canvas`, {
    method: 'POST',
    json: { expectedRevision: task.revision },
  });
  assert.equal(response.response.status, 409);
  assert.equal(response.data.error.code, 'ERR_TASK_BUSY');
  assert.equal(stateReads, 0);

  releaseAgent();
  await waitFor(async () => {
    const job = await readJob(f, chat.data.job.id);
    return job.status === 'succeeded' ? job : null;
  }, 'the held task job should finish after release');
});

test('final approval is revoked if Canvas changes after the core approval write', async (t) => {
  let freshChecks = 0;
  const canvas = {
    state: async () => ({ projectId: 'fixture-project', clientConnected: true, images: [] }),
    assertFresh: async () => {
      freshChecks += 1;
      if (freshChecks === 2) {
        const failure = new Error('Canvas changed during approval');
        failure.code = 'ERR_CANVAS_IMAGE_CHANGED';
        failure.safeMessage = 'Canvas 当前图片已变化，请重新同步。';
        throw failure;
      }
      return { ok: true };
    },
  };
  const f = await fixture(t, { canvas });
  const seeded = await prepareTask(f.root);
  const reviewed = await recordReview(seeded.task.id, {
    page: 1, sha256: seeded.sha256, decision: 'pass', reviewer: '测试用户', notes: '隔离夹具读图记录',
  }, { root: f.root, expectedRevision: seeded.task.revision });

  const response = await f.request(`/api/tasks/${seeded.task.id}/approve-final`, {
    method: 'POST',
    json: {
      version: reviewed.sheetVersion,
      images: [{ page: 1, sha256: seeded.sha256 }],
      by: '测试用户',
      note: '隔离夹具批准',
      expectedRevision: reviewed.revision,
    },
  });
  assert.equal(response.response.status, 409, JSON.stringify(response.data));
  assert.equal(response.data.error.code, 'ERR_CANVAS_IMAGE_CHANGED');
  const current = await readTask(seeded.task.id, f.root);
  assert.equal(current.finalApproval, null);
  assert.equal(current.revision, reviewed.revision + 2, 'approval creation and exact rollback each advance the task revision');
  assert.equal(freshChecks, 2);
});

test('failed post-export Canvas check removes only the new export and revokes approval', async (t) => {
  let freshChecks = 0;
  const canvas = {
    state: async () => ({ projectId: 'fixture-project', clientConnected: true, images: [] }),
    assertFresh: async () => {
      freshChecks += 1;
      if (freshChecks === 6) {
        const failure = new Error('Canvas changed during export');
        failure.code = 'ERR_CANVAS_IMAGE_CHANGED';
        failure.safeMessage = 'Canvas 当前图片已变化，请重新同步。';
        throw failure;
      }
      return { ok: true };
    },
  };
  const f = await fixture(t, { canvas });
  const seeded = await prepareTask(f.root);
  let task = await recordReview(seeded.task.id, {
    page: 1, sha256: seeded.sha256, decision: 'pass', reviewer: '测试用户', notes: '隔离夹具读图记录',
  }, { root: f.root, expectedRevision: seeded.task.revision });

  const approved = await f.request(`/api/tasks/${task.id}/approve-final`, {
    method: 'POST',
    json: {
      version: task.sheetVersion,
      images: [{ page: 1, sha256: seeded.sha256 }],
      by: '测试用户',
      note: '隔离夹具批准',
      expectedRevision: task.revision,
    },
  });
  assert.equal(approved.response.status, 200, JSON.stringify(approved.data));
  task = await readTask(task.id, f.root);

  const firstExport = await f.request(`/api/tasks/${task.id}/export`, {
    method: 'POST',
    json: { expectedRevision: task.revision },
  });
  assert.equal(firstExport.response.status, 200, JSON.stringify(firstExport.data));
  const retainedExport = firstExport.data.export;
  task = await readTask(task.id, f.root);

  const secondExport = await f.request(`/api/tasks/${task.id}/export`, {
    method: 'POST',
    json: { expectedRevision: task.revision },
  });
  assert.equal(secondExport.response.status, 409, JSON.stringify(secondExport.data));
  assert.equal(secondExport.data.error.code, 'ERR_CANVAS_IMAGE_CHANGED');

  const current = await readTask(task.id, f.root);
  assert.deepEqual(current.exports.map((record) => record.version), [retainedExport.version]);
  assert.equal(current.finalApproval, null);
  const exportsDirectory = path.join(taskDirectory(task.id, f.root), 'exports');
  assert.deepEqual((await fs.readdir(exportsDirectory)).sort(), ['export-001', 'export-001.zip']);
  await fs.access(path.join(exportsDirectory, 'export-001.zip'));
  await assert.rejects(fs.access(path.join(exportsDirectory, 'export-002')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(exportsDirectory, 'export-002.zip')), { code: 'ENOENT' });
  assert.equal(freshChecks, 6);
});

test('review rechecks Canvas immediately before the Agent records its observation', async (t) => {
  let freshChecks = 0;
  let pageHash = '';
  const canvas = {
    state: async () => ({ clientConnected: true, projectId: 'fixture-project', images: [] }),
    assertFresh: async () => {
      freshChecks += 1;
      if (freshChecks === 1) return;
      const failure = new Error('latest Canvas output changed after the model saw the image');
      failure.code = 'ERR_CANVAS_STALE_IMAGE';
      failure.safeMessage = 'Canvas 当前图片已变化，请重新同步。';
      throw failure;
    },
  };
  const f = await fixture(t, {
    canvas,
    agent: {
      review: async (input) => {
        await input.beforeRecordReview({
          taskId: input.taskId,
          page: input.page,
          sha256: pageHash,
          version: 1,
          expectedRevision: input.expectedRevision,
        });
        return { text: '已完成读图检查' };
      },
    },
  });
  const seeded = await prepareTask(f.root);
  pageHash = seeded.sha256;
  const started = await f.request(`/api/tasks/${seeded.task.id}/review`, {
    method: 'POST',
    json: { page: 1, expectedRevision: seeded.task.revision },
  });
  assert.equal(started.response.status, 202);
  const terminal = await waitFor(async () => {
    const job = await readJob(f, started.data.job.id);
    return ['failed', 'succeeded', 'cancelled'].includes(job.status) ? job : null;
  }, 'review job should finish after the save-time freshness check');
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.error.code, 'ERR_CANVAS_STALE_IMAGE');
  assert.equal((await readTask(seeded.task.id, f.root)).reviews.length, 0);
  assert.equal(freshChecks, 2);
});

test('chat cancellation reaches the agent and job history omits reasoning and secrets', async (t) => {
  let agentSignal;
  const agent = {
    chat: async ({ signal, onEvent }) => {
      agentSignal = signal;
      onEvent({ type: 'analysis', text: 'this hidden reasoning must not be stored' });
      onEvent({ type: 'tool', text: 'request failed Bearer abcdefghijklmnopqrstuvwxyz' });
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
      });
      return { text: 'unreachable' };
    },
  };
  const f = await fixture(t, { agent });
  const created = await f.request('/api/tasks', { method: 'POST', json: { title: '取消任务', brief: 'test' } });
  const taskId = created.data.task.id;
  const started = await f.request(`/api/tasks/${taskId}/chat`, {
    method: 'POST',
    json: { text: '继续整理', expectedRevision: created.data.task.revision, requestId: crypto.randomUUID() },
  });
  assert.equal(started.response.status, 202);
  const id = started.data.job.id;
  await waitFor(() => agentSignal, 'agent should start before cancellation');
  assert.ok(agentSignal instanceof AbortSignal);
  const cancelled = await f.request(`/api/jobs/${id}`, { method: 'DELETE' });
  assert.equal(cancelled.response.status, 200);
  const finished = await waitFor(async () => {
    const job = await readJob(f, id);
    return job.status === 'cancelled' ? job : null;
  }, 'job should persist cancelled state');
  const afterCancelWrite = await f.request(`/api/tasks/${taskId}/set-brief`, {
    method: 'POST',
    json: { brief: { topic: '取消后可继续写入' }, expectedRevision: created.data.task.revision },
  });
  assert.equal(afterCancelWrite.response.status, 200, JSON.stringify(afterCancelWrite.data));
  assert.equal(agentSignal.aborted, true);
  const visible = JSON.stringify(finished);
  assert.equal(visible.includes('hidden reasoning'), false);
  assert.equal(visible.includes('abcdefghijklmnopqrstuvwxyz'), false);

  const detail = await f.request(`/api/tasks/${taskId}`);
  assert.deepEqual(detail.data.conversation.map((message) => message.role), ['user']);
  const taskWeb = path.join(f.root, 'tasks', taskId, 'web');
  const persistedMessages = await fs.readFile(path.join(taskWeb, 'conversation.json'), 'utf8');
  const operationLog = await fs.readFile(path.join(taskWeb, 'operations.json'), 'utf8');
  const jobRecord = await fs.readFile(path.join(f.root, 'web', 'jobs', `${id}.json`), 'utf8');
  for (const stored of [persistedMessages, operationLog, jobRecord]) {
    assert.equal(stored.includes('hidden reasoning'), false);
    assert.equal(stored.includes('abcdefghijklmnopqrstuvwxyz'), false);
  }
});

test('structured chat questions persist while running and accept only one bound, current answer set', async (t) => {
  let releaseFirst;
  let questionsStored;
  let receivedAnswer;
  let calls = 0;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const questionsReady = new Promise((resolve) => { questionsStored = resolve; });
  const f = await fixture(t, {
    agent: {
      chat: async ({ onEvent, text, conversation }) => {
        calls += 1;
        if (calls === 1) {
          await onEvent({
            type: 'questions',
            questions: [{
              id: 'audience',
              question: '这份内容主要面向谁？',
              options: [{ id: 'parents', label: '家长' }, { id: 'students', label: '学生' }],
              allowOther: true,
            }],
          });
          questionsStored();
          await firstGate;
          return { text: '请在上方点选补充信息。' };
        }
        receivedAnswer = { text, conversation };
        return { text: '已收到你的选择。' };
      },
    },
  });
  const created = await f.request('/api/tasks', { method: 'POST', json: { title: '点选追问', brief: '测试' } });
  const taskId = created.data.task.id;
  const initialRequestId = crypto.randomUUID();
  const initial = await f.request(`/api/tasks/${taskId}/chat`, {
    method: 'POST',
    json: { text: '帮我开始整理', expectedRevision: created.data.task.revision, requestId: initialRequestId },
  });
  assert.equal(initial.response.status, 202);
  await questionsReady;
  const runningDetail = await f.request(`/api/tasks/${taskId}`);
  assert.equal(runningDetail.data.conversation[0].requestId, initialRequestId);
  const questionMessage = runningDetail.data.conversation.find((message) => message.questions?.length);
  assert.ok(questionMessage, 'structured questions are visible before the job finishes');
  assert.equal(questionMessage.questions[0].id, 'audience');
  assert.equal(questionMessage.questions[0].options[0].label, '家长');
  releaseFirst();
  const firstDone = await waitFor(async () => {
    const job = await readJob(f, initial.data.job.id);
    return job.status === 'succeeded' ? job : null;
  }, 'the question-producing chat should finish');
  assert.equal(firstDone.status, 'succeeded');

  const staleRevision = created.data.task.revision;
  const invalid = await f.request(`/api/tasks/${taskId}/chat`, {
    method: 'POST',
    json: {
      text: '随便选的摘要',
      answers: { messageId: questionMessage.id, items: [{ questionId: 'audience', optionIds: ['forged-option'] }] },
      expectedRevision: staleRevision,
      requestId: crypto.randomUUID(),
    },
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.data.error.code, 'ERR_CLARIFICATION_ANSWER_INVALID');
  assert.equal(calls, 1);

  const updatedTask = await f.request(`/api/tasks/${taskId}/set-brief`, {
    method: 'POST',
    json: { brief: { topic: '期间发生了任务更新' }, expectedRevision: staleRevision },
  });
  assert.equal(updatedTask.response.status, 200);
  const staleAnswer = await f.request(`/api/tasks/${taskId}/chat`, {
    method: 'POST',
    json: {
      text: '家长，并补充学生',
      answers: { messageId: questionMessage.id, items: [{ questionId: 'audience', optionIds: ['parents'], otherText: '学生' }] },
      expectedRevision: staleRevision,
      requestId: crypto.randomUUID(),
    },
  });
  assert.equal(staleAnswer.response.status, 409);
  assert.equal(staleAnswer.data.error.code, 'ERR_TASK_REVISION_CONFLICT');
  assert.equal(calls, 1);

  const answerRequestId = crypto.randomUUID();
  const answers = {
    messageId: questionMessage.id,
    items: [{ questionId: 'audience', optionIds: ['parents'], otherText: '也要适合学生阅读' }],
  };
  const accepted = await f.request(`/api/tasks/${taskId}/chat`, {
    method: 'POST',
    json: { text: '这段文本不会替代已选答案', answers, expectedRevision: updatedTask.data.task.revision, requestId: answerRequestId },
  });
  assert.equal(accepted.response.status, 202, JSON.stringify(accepted.data));
  const answerDone = await waitFor(async () => {
    const job = await readJob(f, accepted.data.job.id);
    return job.status === 'succeeded' ? job : null;
  }, 'the structured answer should reach the chat agent');
  assert.equal(answerDone.status, 'succeeded');
  assert.match(receivedAnswer.text, /家长/);
  assert.match(receivedAnswer.text, /也要适合学生阅读/);
  assert.equal(receivedAnswer.text.includes('这段文本不会替代'), false);
  const storedAnswer = receivedAnswer.conversation.find((message) => message.requestId === answerRequestId);
  assert.deepEqual(storedAnswer.answers, answers);
  assert.match(storedAnswer.text, /家长/);
  assert.equal(calls, 2);

  const replay = await f.request(`/api/tasks/${taskId}/chat`, {
    method: 'POST',
    json: { text: '这段文本不会替代已选答案', answers, expectedRevision: updatedTask.data.task.revision, requestId: answerRequestId },
  });
  assert.equal(replay.response.status, 202);
  assert.equal(replay.data.job.id, accepted.data.job.id);
  const secondAnswer = await f.request(`/api/tasks/${taskId}/chat`, {
    method: 'POST',
    json: { text: '重放', answers, expectedRevision: updatedTask.data.task.revision, requestId: crypto.randomUUID() },
  });
  assert.equal(secondAnswer.response.status, 409);
  assert.equal(secondAnswer.data.error.code, 'ERR_CLARIFICATION_ALREADY_ANSWERED');
  assert.equal(calls, 2);
});

test('a mock DSH question tool writes one visible assistant question message before the chat job completes', async (t) => {
  let releaseFinal;
  let finalModelRequest;
  const finalGate = new Promise((resolve) => { releaseFinal = resolve; });
  const finalRequested = new Promise((resolve) => { finalModelRequest = resolve; });
  const provider = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const afterTool = body.messages.some((message) => message.role === 'tool');
    if (afterTool) {
      finalModelRequest();
      await finalGate;
    }
    const questions = { questions: [{ id: 'format', question: '你希望做成什么形式？', options: [{ id: 'poster', label: '单张海报' }, { id: 'carousel', label: '多页图文' }] }] };
    const delta = afterTool
      ? { content: '请在上方点选回答。' }
      : { tool_calls: [{ index: 0, id: 'mock-question-call', type: 'function', function: { name: 'studio_ask_questions', arguments: JSON.stringify({ payload: JSON.stringify(questions) }) } }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'mock-clarification', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'mock-clarification', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: afterTool ? 'stop' : 'tool_calls' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    releaseFinal();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  });
  const f = await fixture(t, {
    agentFactory: (root) => createStudioAgent({
      root,
      readConfig: async () => ({ basic: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'mock-question-model', apiKey: 'fixture-agent-key' } }),
    }),
    readConfig: async () => ({
      basic: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'mock-question-model', apiKey: 'fixture-agent-key' },
      image: { baseUrl: '', model: '', apiKey: '' },
    }),
  });
  const created = await f.request('/api/tasks', { method: 'POST', json: { title: '真实 DSH 追问链路', brief: '先确认输出形式' } });
  const requestId = crypto.randomUUID();
  const started = await f.request(`/api/tasks/${created.data.task.id}/chat`, {
    method: 'POST',
    json: { text: '请先用点选确认内容形式。', expectedRevision: created.data.task.revision, requestId },
  });
  assert.equal(started.response.status, 202);
  await finalRequested;
  const duringRun = await f.request(`/api/tasks/${created.data.task.id}`);
  assert.equal(duringRun.data.job.status, 'running');
  assert.equal(duringRun.data.conversation.filter((message) => message.questions?.length).length, 1);
  const questionMessage = duringRun.data.conversation.find((message) => message.questions?.length);
  assert.deepEqual(questionMessage.questions[0].options.map((option) => option.label), ['单张海报', '多页图文']);
  releaseFinal();
  const completed = await waitFor(async () => {
    const job = await readJob(f, started.data.job.id);
    return job.status === 'succeeded' ? job : null;
  }, 'the mock DSH question chat should finish');
  assert.equal(completed.status, 'succeeded');
  const afterRun = await f.request(`/api/tasks/${created.data.task.id}`);
  assert.equal(afterRun.data.conversation[0].requestId, requestId);
  assert.equal(afterRun.data.conversation.filter((message) => message.questions?.length).length, 1);
  assert.equal(afterRun.data.conversation.at(-1).text, '请在上方点选回答。');
});

test('chat requestId deduplicates concurrent and completed requests and rejects changed payloads', async (t) => {
  let calls = 0;
  const modelsUsed = [];
  let releaseAgent;
  const agentGate = new Promise((resolve) => { releaseAgent = resolve; });
  const f = await fixture(t, {
    agent: {
      chat: async ({ model }) => {
        calls += 1;
        modelsUsed.push(model);
        await agentGate;
        return { text: '只处理一次的答复' };
      },
    },
  });
  const created = await f.request('/api/tasks', { method: 'POST', json: { title: '聊天幂等', brief: '测试' } });
  const taskId = created.data.task.id;
  const requestId = crypto.randomUUID();
  const payload = { text: '同一条消息', expectedRevision: created.data.task.revision, requestId };
  const first = await f.request(`/api/tasks/${taskId}/chat`, { method: 'POST', json: payload });
  assert.equal(first.response.status, 202);
  assert.equal(first.data.job.model, 'fixture-default-model');
  await waitFor(() => calls === 1, 'the first chat job should reach the fake agent');
  assert.deepEqual(modelsUsed, ['fixture-default-model']);

  const concurrentDuplicate = await f.request(`/api/tasks/${taskId}/chat`, { method: 'POST', json: payload });
  assert.equal(concurrentDuplicate.response.status, 202);
  assert.equal(concurrentDuplicate.data.job.id, first.data.job.id);
  assert.equal(calls, 1);
  releaseAgent();

  const terminal = await waitFor(async () => {
    const job = await readJob(f, first.data.job.id);
    return ['failed', 'succeeded', 'cancelled'].includes(job.status) ? job : null;
  }, 'the original chat job should finish');
  assert.equal(terminal.status, 'succeeded');

  const completedDuplicate = await f.request(`/api/tasks/${taskId}/chat`, { method: 'POST', json: payload });
  assert.equal(completedDuplicate.response.status, 202);
  assert.equal(completedDuplicate.data.job.id, first.data.job.id);
  assert.equal(calls, 1);

  const changedPayload = await f.request(`/api/tasks/${taskId}/chat`, {
    method: 'POST',
    json: { ...payload, text: '不同消息' },
  });
  assert.equal(changedPayload.response.status, 409);
  assert.equal(changedPayload.data.error.code, 'ERR_JOB_IDEMPOTENCY_CONFLICT');

  const changedModel = await f.request(`/api/tasks/${taskId}/chat`, {
    method: 'POST',
    json: { ...payload, model: 'alternate-fixture-model' },
  });
  assert.equal(changedModel.response.status, 409);
  assert.equal(changedModel.data.error.code, 'ERR_JOB_IDEMPOTENCY_CONFLICT');

  const missingId = await f.request(`/api/tasks/${taskId}/chat`, {
    method: 'POST',
    json: { text: '缺少幂等 ID', expectedRevision: created.data.task.revision },
  });
  assert.equal(missingId.response.status, 400);
  assert.equal(missingId.data.error.code, 'ERR_ID_INVALID');

  const detail = await f.request(`/api/tasks/${taskId}`);
  assert.deepEqual(detail.data.conversation.map((message) => message.role), ['user', 'assistant']);
  assert.equal(detail.data.conversation[1].model, 'fixture-default-model');
  const stored = JSON.parse(await fs.readFile(path.join(f.root, 'web', 'jobs', `${first.data.job.id}.json`), 'utf8'));
  assert.equal(stored.requestId, requestId);
  assert.match(stored.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(completedDuplicate.data.job).includes(stored.fingerprint), false);
});

test('chat and review freeze a selected model per job without changing saved configuration', async (t) => {
  const received = { chat: null, review: null };
  const f = await fixture(t, {
    agent: {
      chat: async ({ model }) => { received.chat = model; return { text: '按次模型已使用' }; },
      review: async ({ model }) => { received.review = model; return { text: '按次模型完成读图' }; },
    },
    canvas: { assertFresh: async () => {} },
  });
  const created = await f.request('/api/tasks', { method: 'POST', json: { title: '按次模型', brief: '测试模型来源' } });
  const chat = await f.request(`/api/tasks/${created.data.task.id}/chat`, {
    method: 'POST',
    json: {
      text: '使用本轮模型',
      expectedRevision: created.data.task.revision,
      requestId: crypto.randomUUID(),
      model: 'selected-chat-model',
    },
  });
  assert.equal(chat.response.status, 202);
  assert.equal(chat.data.job.model, 'selected-chat-model');
  const chatDone = await waitFor(async () => {
    const job = await readJob(f, chat.data.job.id);
    return job.status === 'succeeded' ? job : null;
  }, 'the selected-model chat job should finish');
  assert.equal(received.chat, 'selected-chat-model');
  assert.equal(chatDone.model, 'selected-chat-model');
  const afterChatWrite = await f.request(`/api/tasks/${created.data.task.id}/set-brief`, {
    method: 'POST',
    json: { brief: { topic: '成功后可继续写入' }, expectedRevision: created.data.task.revision },
  });
  assert.equal(afterChatWrite.response.status, 200, JSON.stringify(afterChatWrite.data));
  const chatDetail = await f.request(`/api/tasks/${created.data.task.id}`);
  assert.equal(chatDetail.data.conversation.at(-1).model, 'selected-chat-model');

  const { task } = await prepareTask(f.root);
  const review = await f.request(`/api/tasks/${task.id}/review`, {
    method: 'POST',
    json: { page: 1, expectedRevision: task.revision, model: 'selected-review-model' },
  });
  assert.equal(review.response.status, 202);
  assert.equal(review.data.job.model, 'selected-review-model');
  const reviewDone = await waitFor(async () => {
    const job = await readJob(f, review.data.job.id);
    return job.status === 'succeeded' ? job : null;
  }, 'the selected-model review job should finish');
  assert.equal(received.review, 'selected-review-model');
  assert.equal(reviewDone.model, 'selected-review-model');
  assert.equal((await readConfigRecord({ root: f.root })).base.model, '');
});

test('model ids are guarded and model configuration failures use safe actionable job messages', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    agent: {
      chat: async ({ text }) => {
        calls += 1;
        const failure = new Error('upstream secret response must stay hidden');
        failure.code = text === 'config failure' ? 'ERR_MODEL_CONFIG' : 'ERR_MODEL_ID_INVALID';
        throw failure;
      },
    },
  });
  const created = await f.request('/api/tasks', { method: 'POST', json: { title: '安全模型错误', brief: '测试' } });
  const taskId = created.data.task.id;
  let revision = created.data.task.revision;
  const invalid = await f.request(`/api/tasks/${taskId}/chat`, {
    method: 'POST',
    json: { text: 'bad id', expectedRevision: created.data.task.revision, requestId: crypto.randomUUID(), model: 'sk-secretcredential123456789' },
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.data.error.code, 'ERR_MODEL_ID_INVALID');
  assert.equal(JSON.stringify(invalid.data).includes('sk-secretcredential'), false);
  assert.equal(calls, 0);

  for (const [text, expectedMessage] of [
    ['config failure', '请先在模型与服务中保存完整基础模型配置。'],
    ['runtime model failure', '所选模型 ID 格式无效；请从模型列表重新选择。'],
  ]) {
    const started = await f.request(`/api/tasks/${taskId}/chat`, {
      method: 'POST',
      json: { text, expectedRevision: revision, requestId: crypto.randomUUID() },
    });
    assert.equal(started.response.status, 202);
    const failed = await waitFor(async () => {
      const job = await readJob(f, started.data.job.id);
      return job.status === 'failed' ? job : null;
    }, 'the mock model failure should be recorded');
    assert.equal(failed.error.message, expectedMessage);
    assert.equal(failed.error.message.includes('upstream secret'), false);
    const afterFailureWrite = await f.request(`/api/tasks/${taskId}/set-brief`, {
      method: 'POST',
      json: { brief: { topic: `失败后继续 ${text}` }, expectedRevision: revision },
    });
    assert.equal(afterFailureWrite.response.status, 200, JSON.stringify(afterFailureWrite.data));
    revision = afterFailureWrite.data.task.revision;
  }
  assert.equal(calls, 2);
});

test('chat requestId index survives server restart and bypasses a now-stale revision', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-studio-chat-idempotency-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const staticDir = path.join(root, 'web-dist');
  await fs.mkdir(staticDir, { recursive: true });
  await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>fixture</title>');
  let calls = 0;
  let running = await listenStudioServer({
    root,
    staticDir,
    agent: {
      chat: async ({ taskId, expectedRevision }) => {
        calls += 1;
        await setBrief(taskId, { topic: '模型整理后需求候选' }, { root, expectedRevision });
        return { text: '已整理候选需求' };
      },
    },
  });
  let origin = `http://127.0.0.1:${running.address.port}`;
  const request = async (url, payload) => {
    const response = await fetch(`${origin}${url}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { response, data: await response.json() };
  };

  const created = await request('/api/tasks', { title: '重启幂等夹具', brief: '初始需求' });
  const task = created.data.task;
  const requestId = crypto.randomUUID();
  const payload = { text: '整理候选', expectedRevision: task.revision, requestId, model: 'restart-fixture-model' };
  const first = await request(`/api/tasks/${task.id}/chat`, payload);
  assert.equal(first.response.status, 202);
  const finished = await waitFor(async () => {
    const jobResponse = await fetch(`${origin}/api/jobs/${first.data.job.id}`);
    const job = (await jobResponse.json()).job;
    return job.status === 'succeeded' ? job : null;
  }, 'the first chat should finish after updating the task');
  assert.equal(calls, 1);
  assert.equal((await readTask(task.id, root)).revision, task.revision + 1);

  const sameProcessDuplicate = await request(`/api/tasks/${task.id}/chat`, payload);
  assert.equal(sameProcessDuplicate.response.status, 202);
  assert.equal(sameProcessDuplicate.data.job.id, first.data.job.id);
  assert.equal(sameProcessDuplicate.data.job.status, 'succeeded');
  await running.close();

  running = await listenStudioServer({ root, staticDir, agent: { chat: async () => { calls += 1; throw new Error('must not run after recovery'); } } });
  origin = `http://127.0.0.1:${running.address.port}`;
  const afterRestart = await request(`/api/tasks/${task.id}/chat`, payload);
  assert.equal(afterRestart.response.status, 202);
  assert.equal(afterRestart.data.job.id, first.data.job.id);
  assert.equal(afterRestart.data.job.status, 'succeeded');
  assert.equal(calls, 1);
  const conversation = JSON.parse(await fs.readFile(path.join(root, 'tasks', task.id, 'web', 'conversation.json'), 'utf8'));
  assert.deepEqual(conversation.map((message) => message.role), ['user', 'assistant']);
  assert.equal(finished.id, first.data.job.id);
  await running.close();
});

test('job recovery clears a dead task entry even when the process stopped before writing a job', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-studio-entry-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const taskId = '8c8c13fd-52d9-42e9-8e83-e97991c6de6d';
  const taskPath = path.join(root, 'tasks', taskId);
  const entryPath = path.join(taskPath, '.entry.json');
  await fs.mkdir(taskPath, { recursive: true });
  await fs.writeFile(entryPath, JSON.stringify({
    pid: 99_999_999,
    token: 'dead-entry-token',
    entry: 'web',
    startedAt: new Date().toISOString(),
  }), { mode: 0o600 });

  const manager = createJobManager({ root });
  await manager.initialize();
  await manager.close();
  await assert.rejects(fs.access(entryPath), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.join(root, 'web', 'jobs')), []);
});

test('a job does not publish success when the task entry release cannot be confirmed', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-studio-job-release-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await createTask({ title: '锁释放失败', brief: '验证终态语义' }, root);
  const jobs = createJobManager({ root });
  await jobs.initialize();
  let markStarted;
  let finishRun;
  const runStarted = new Promise((resolve) => { markStarted = resolve; });
  const runGate = new Promise((resolve) => { finishRun = resolve; });
  const started = await jobs.start({
    taskId: task.id,
    kind: 'release-check',
    run: async () => { markStarted(); await runGate; return { complete: true }; },
  });
  await runStarted;
  const entryPath = path.join(root, 'tasks', task.id, '.entry.json');
  const entry = JSON.parse(await fs.readFile(entryPath, 'utf8'));
  await fs.writeFile(entryPath, JSON.stringify({ ...entry, token: crypto.randomUUID() }));
  finishRun();

  const failed = await waitFor(() => {
    const current = jobs.get(started.id);
    return current?.status === 'failed' ? current : null;
  }, 'a release mismatch must finish as a failed job');
  assert.equal(failed.error.code, 'ERR_JOB_RELEASE_FAILED');
  assert.equal(failed.error.message, '任务锁释放未能确认；请刷新状态后再重试。');
  assert.equal(failed.result, null);
  await jobs.close();
});

test('multipart asset import preserves file order and serves only allowlisted same-origin files', async (t) => {
  const f = await fixture(t);
  const form = new FormData();
  form.set('title', '导入夹具');
  form.set('body', '隔离测试素材');
  form.set('tags', JSON.stringify(['测试', 'Web']));
  form.set('source', JSON.stringify({ kind: 'user-provided' }));
  form.append('files', new Blob(['first file'], { type: 'text/plain' }), 'first.txt');
  form.append('files', new Blob(['second file'], { type: 'text/plain' }), 'second.txt');
  const imported = await f.request('/api/assets', { method: 'POST', body: form });
  assert.equal(imported.response.status, 201, JSON.stringify(imported.data));
  const asset = imported.data.asset;
  assert.deepEqual(asset.files.map((file) => file.name), ['first.txt', 'second.txt']);
  assert.ok(asset.files.every((file) => typeof file.fileUrl === 'string'));
  assert.equal(JSON.stringify(asset).includes('relativePath'), false);
  const first = await f.request(asset.files[0].fileUrl);
  assert.equal(first.response.status, 200);
  assert.equal(Buffer.from(first.data).toString(), 'first file');
  const searchQuery = encodeURIComponent('隔离测试素材');
  const pendingSearch = await f.request(`/api/assets?query=${searchQuery}&confirmedOnly=true`);
  assert.deepEqual(pendingSearch.data.assets, []);
  const managementSearch = await f.request(`/api/assets?query=${searchQuery}`);
  assert.equal(managementSearch.data.assets.length, 1);
  const traversal = await f.request(`/api/assets/${asset.id}/files/../metadata.json`);
  assert.notEqual(traversal.response.status, 200);
});

test('Canvas bootstrap ticket is only returned by the explicit open route; image preview is proxied', async (t) => {
  const png = Buffer.from('canvas image preview');
  const canvas = {
    state: async () => ({ projectId: 'project-fixture', clientConnected: true, bridgeToken: 'must-never-leak', images: [] }),
    ensure: async () => ({ openUrl: 'http://127.0.0.1:8123/#studioBootstrap=single-use-ticket', projectId: 'project-fixture', clientConnected: false }),
    sync: async (taskId, payload) => ({
      task: await readTask(taskId, root),
      candidates: [{ page: 1, nodeId: 'candidate-node', title: '隔离候选', width: 800, height: 1200, selected: false, sha256: crypto.createHash('sha256').update(png).digest('hex') }],
    }),
    candidateImage: async () => ({ buffer: png, contentType: 'image/png', sha256: crypto.createHash('sha256').update(png).digest('hex') }),
  };
  let root;
  const f = await fixture(t, { canvas });
  root = f.root;
  const { task } = await prepareTask(root);
  const detail = await f.request(`/api/tasks/${task.id}`);
  assert.equal(JSON.stringify(detail.data).includes('single-use-ticket'), false);
  assert.equal(JSON.stringify(detail.data).includes('must-never-leak'), false);
  const opened = await f.request(`/api/tasks/${task.id}/canvas/open`, { method: 'POST', json: {} });
  assert.equal(opened.response.status, 200);
  assert.match(opened.data.openUrl, /single-use-ticket/);
  const synced = await f.request(`/api/tasks/${task.id}/canvas-sync`, {
    method: 'POST',
    json: { expectedRevision: task.revision, version: task.sheetVersion },
  });
  assert.equal(synced.response.status, 200);
  assert.match(synced.data.candidates[0].imageUrl, /^\/api\/tasks\//);
  const preview = await f.request(synced.data.candidates[0].imageUrl);
  assert.equal(preview.response.status, 200);
  assert.equal(preview.response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(preview.data), png);
});
