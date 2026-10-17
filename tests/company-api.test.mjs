import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listenStudioServer } from '../src/web/server.mjs';
import { createTask, readTask } from '../src/creative/tasks.mjs';
import { saveCompanyConfig } from '../src/company/config.mjs';
import { configureCompanyServices } from './helpers/company-services.mjs';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-api-'));
  await configureCompanyServices(t, root);
  const server = await listenStudioServer({ root, port: 0, ...options });
  t.after(async () => { await server.close(); await fs.rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address.port}`;
  const call = (route, body, headers = {}) => fetch(origin + route, body === undefined ? {} : { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { root, call };
}

test('company config endpoints never return passwords or bridge tokens and reject cross-origin writes', async t => {
  const { call } = await fixture(t);
  const payload = { expectedRevision: 1, teedy: { username: 'reader', password: 'private-fixture-password' } };
  assert.equal((await call('/api/company/config', payload, { origin: 'https://outside.fixture.test' })).status, 403);
  const response = await call('/api/company/config', payload);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes('private-fixture-password')); assert.ok(!text.includes('private-fixture-bridge-token'));
  assert.equal((await call('/api/company/config', payload)).status, 409);
  const saved = await (await call('/api/company/config')).json();
  assert.equal(saved.config.teedy.passwordConfigured, true);
  assert.deepEqual(saved.config.canvas, { webUrl: 'https://canvas.fixture.test' });
});

test('company candidates require an explicit retained decision before the API freezes originals', async t => {
  let reads = 0, downloads = 0;
  const candidate = { documentId: 'doc-1', title: '公司样例', summary: '历史参考', tags: [], previews: [] };
  const { root, call } = await fixture(t, { companyMaterials: {
    search: async () => ({ items: [candidate], total: 1 }),
    get: async () => { reads++; return { ...candidate, body: '经授权的参考正文', files: [{ id: 'file-1', name: '正文.txt', mimeType: 'text/plain' }] }; },
    download: async () => { downloads++; return { bytes: Buffer.from('原件内容'), mimeType: 'text/plain' }; },
  } });
  let task = await createTask({ title: '公司 API 测试', brief: '一张海报' }, root);
  let response = await call('/api/company/search', { taskId: task.id, expectedRevision: task.revision, query: '样例' });
  assert.equal(response.status, 200); task = (await response.json()).task;
  assert.equal(task.sources[0].decision, 'pending'); assert.equal(reads, 0); assert.equal(downloads, 0);
  response = await call(`/api/tasks/${task.id}/references`, { expectedRevision: task.revision, items: [{ kind: 'existing', id: task.sources[0].id, decision: 'retained', purpose: '参考结构', factBoundary: '当前业务事实另行提供' }] });
  assert.equal(response.status, 200); task = (await response.json()).task;
  assert.equal(reads, 1); assert.equal(downloads, 1);
  assert.equal(task.sources[0].decision, 'retained'); assert.equal(task.sources[0].files.length, 1);
  const stored = await readTask(task.id, root);
  assert.equal(await fs.readFile(path.join(root, 'tasks', task.id, stored.sources[0].files[0].relativePath), 'utf8'), '原件内容');
  assert.equal((await call('/api/company/search', { taskId: task.id, expectedRevision: task.revision - 1, query: '样例' })).status, 409);
});

test('remote Canvas open links are confined to the configured HTTPS origin and project with no raw token', async t => {
  let openUrl = 'https://canvas.fixture.test/canvas?mode=recent&projectId=remote-project#companyBridge=http%3A%2F%2F127.0.0.1%3A18420&companyTicket=fixture-ticket';
  const { root, call } = await fixture(t, { canvas: { ensure: async () => ({ openUrl, projectId: 'remote-project', clientConnected: true }), connect: async () => ({ openUrl }) } });
  await saveCompanyConfig({ expectedRevision: 1 }, { root });
  const task = await createTask({ title: '远端连接', brief: '测试' }, root);
  const route = `/api/tasks/${task.id}/canvas/open`;
  openUrl = openUrl.replace('remote-project', task.id);
  assert.equal((await call(route, {})).status, 200);
  for (const invalid of [
    'https://outside.fixture.test/canvas?projectId=remote-project',
    'https://canvas.fixture.test/other?projectId=remote-project',
    'https://canvas.fixture.test/canvas?projectId=other-project',
    `https://canvas.fixture.test/canvas?projectId=${task.id}#agentToken=raw-private-token`,
  ]) { openUrl = invalid; assert.equal((await call(route, {})).status, 503); }
});
