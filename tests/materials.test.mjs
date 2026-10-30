import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCompanyMaterials } from '../src/materials/client.mjs';
import { createCompanyMaterialsMcp } from '../src/materials/mcp.mjs';
import { readMaterialConfig, saveMaterialConfig } from '../src/materials/config.mjs';
import { verifyMaterials } from '../src/materials/verify.mjs';

const credentials = {
  baseUrl: 'https://teedy.example.test',
  username: 'employee@example.test',
  password: 'private-test-password',
};
const original = Buffer.from('private sample image bytes');

function mockTeedy({ loginStatus = 200, queryStatus = 200, downloadStatus = 200, documents } = {}) {
  const calls = [];
  const fetchImpl = async (requestUrl, init = {}) => {
    const url = new URL(requestUrl);
    calls.push({ path: url.pathname, method: init.method || 'GET', cookie: init.headers?.cookie || '', search: url.search });
    if (url.pathname === '/api/user/login') {
      if (loginStatus !== 200) return new Response('private server response', { status: loginStatus });
      return new Response('', { status: 200, headers: { 'set-cookie': 'JSESSIONID=fixture-session; Path=/; HttpOnly' } });
    }
    if (url.pathname === '/api/user/logout') return new Response(null, { status: 204 });
    if (!String(init.headers?.cookie || '').includes('JSESSIONID=fixture-session')) return new Response('', { status: 401 });
    if (url.pathname === '/api/tag/list') return Response.json({ tags: [{ id: 'tag-1', name: '测试标签' }, { id: 'system', name: '外部参考' }] });
    if (url.pathname === '/api/document/list') {
      if (queryStatus !== 200) return new Response('private query response', { status: queryStatus });
      return Response.json({ documents: documents ?? [{ id: 'doc-1', title: '测试图片', description: '摘要', tags: [{ name: '测试标签' }] }], total: 1 });
    }
    if (url.pathname === '/api/file/list') return Response.json({ files: [{ id: 'file-1', name: 'sample.jpg', mimetype: 'image/jpeg', size: original.length }] });
    if (url.pathname === '/api/document/doc-1') return Response.json({ id: 'doc-1', title: '测试图片', description: '摘要', tags: [{ name: '测试标签' }], body: '不得出现在工具摘要里的正文' });
    if (url.pathname === '/api/file/file-1/data') {
      if (downloadStatus !== 200) return new Response('private download response', { status: downloadStatus });
      return new Response(original, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-disposition': 'attachment; filename="sample.jpg"' } });
    }
    return new Response('', { status: 404 });
  };
  return { fetchImpl, calls };
}

async function withRoot(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-lite-materials-'));
  try { await run(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('Teedy credentials are private, HTTPS-only, and rotate credentialId on save', async () => {
  await withRoot(async root => {
    const saved = await saveMaterialConfig(credentials, { root });
    const config = await readMaterialConfig({ root });
    assert.equal(config.credentialId, saved.credentialId);
    assert.equal(config.password, credentials.password);
    assert.equal(JSON.stringify(saved).includes(credentials.password), false);
    assert.notEqual((await saveMaterialConfig(credentials, { root })).credentialId, saved.credentialId);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(saved.path)).mode & 0o777, 0o600);
      assert.equal((await fs.stat(path.join(root, 'config'))).mode & 0o777, 0o700);
    }
    await assert.rejects(saveMaterialConfig({ ...credentials, baseUrl: 'http://teedy.example.test' }, { root }), error => error.code === 'ERR_MATERIAL_CONFIG_INVALID');
    await assert.rejects(saveMaterialConfig({ ...credentials, baseUrl: 'https://user:pass@teedy.example.test' }, { root }), error => error.code === 'ERR_MATERIAL_CONFIG_INVALID');
    for (const baseUrl of ['https://localhost', 'https://service.localhost', 'https://127.0.0.2', 'https://[::1]', 'https://0.0.0.0']) {
      await assert.rejects(saveMaterialConfig({ ...credentials, baseUrl }, { root }), error => error.code === 'ERR_MATERIAL_CONFIG_INVALID');
    }
  });
});

test('verify reports login, query, and original-download phases without credential or material output', async () => {
  await withRoot(async root => {
    const badLogin = mockTeedy({ loginStatus: 401 });
    const loginReport = await verifyMaterials(credentials, { root, fetchImpl: badLogin.fetchImpl });
    assert.deepEqual(loginReport, {
      authenticated: false, queryVerified: false, downloadVerified: false,
      bytes: 0, sha256: '', failedStage: 'login', failureCode: 'login_failed',
    });

    const queryFail = mockTeedy({ queryStatus: 503 });
    const queryReport = await verifyMaterials(credentials, { root, fetchImpl: queryFail.fetchImpl });
    assert.equal(queryReport.authenticated, true);
    assert.equal(queryReport.queryVerified, false);
    assert.equal(queryReport.failedStage, 'query');
    assert.equal(queryReport.failureCode, 'query_failed');

    const downloadFail = mockTeedy({ downloadStatus: 503 });
    const failedDownload = await verifyMaterials(credentials, { root, fetchImpl: downloadFail.fetchImpl });
    assert.equal(failedDownload.authenticated, true);
    assert.equal(failedDownload.queryVerified, true);
    assert.equal(failedDownload.downloadVerified, false);
    assert.equal(failedDownload.failedStage, 'download');
    assert.equal(failedDownload.failureCode, 'download_failed');

    const success = mockTeedy();
    const verified = await verifyMaterials(credentials, { root, fetchImpl: success.fetchImpl });
    assert.equal(verified.authenticated, true);
    assert.equal(verified.queryVerified, true);
    assert.equal(verified.downloadVerified, true);
    assert.equal(verified.bytes, original.length);
    assert.equal(verified.sha256, createHash('sha256').update(original).digest('hex'));
    assert.equal(verified.failedStage, null);
    assert.equal(verified.failureCode, null);
    assert.equal(success.calls.some(call => call.path === '/api/user/logout' && call.method === 'POST'), true);
    assert.equal(JSON.stringify(verified).includes(credentials.username), false);
    assert.equal(JSON.stringify(verified).includes(credentials.password), false);
    assert.equal(JSON.stringify(verified).includes('private sample image bytes'), false);
    assert.deepEqual(await fs.readdir(root), []);
  });
});

test('empty or oversized non-image inventory is queried but cannot pass original download verification', async () => {
  await withRoot(async root => {
    const empty = mockTeedy({ documents: [] });
    const report = await verifyMaterials(credentials, { root, fetchImpl: empty.fetchImpl });
    assert.equal(report.authenticated, true);
    assert.equal(report.queryVerified, true);
    assert.equal(report.downloadVerified, false);
    assert.equal(report.failedStage, 'download');
    assert.equal(report.failureCode, 'no_small_image');

    const large = mockTeedy();
    const client = createCompanyMaterials({
      root,
      readConfig: async () => ({ teedy: credentials }),
      fetchImpl: async (url, init) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/api/file/list') return Response.json({ files: [{ id: 'slide', name: 'presentation.pptx', mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 43_318_694 }] });
        return large.fetchImpl(url, init);
      },
    });
    const inventory = await client.findDownloadable();
    assert.deepEqual(inventory, { queryVerified: true, candidate: null });
  });
});

test('MCP SDK in-memory transport exposes read-only tools and saves originals outside the repository', async t => {
  await withRoot(async root => {
    await saveMaterialConfig(credentials, { root });
    const mock = mockTeedy();
    const materials = createCompanyMaterials({ root, fetchImpl: mock.fetchImpl });
    const server = createCompanyMaterialsMcp({ root, client: materials });
    const client = new Client({ name: 'fixture-host', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(() => client.close());
    t.after(() => server.close());

    const tools = new Set((await client.listTools()).tools.map(tool => tool.name));
    assert.deepEqual([...tools].sort(), ['download_file', 'get_material', 'list_tags', 'search_materials']);
    const searchResult = await client.callTool({ name: 'search_materials', arguments: { query: '测试图片' } });
    const search = JSON.parse(searchResult.content[0].text);
    assert.equal(search.total, 1);
    assert.equal(search.items[0].files[0].id, 'file-1');
    assert.equal(search.items[0].zip_url, 'https://teedy.example.test/api/file/zip?id=doc-1');

    const detail = JSON.parse((await client.callTool({ name: 'get_material', arguments: { document_id: 'doc-1' } })).content[0].text);
    assert.equal(detail.id, 'doc-1');
    assert.equal(JSON.stringify(detail).includes('不得出现在工具摘要里的正文'), false);

    const downloaded = JSON.parse((await client.callTool({ name: 'download_file', arguments: { file_id: 'file-1' } })).content[0].text);
    assert.equal(path.isAbsolute(downloaded.path), true);
    assert.equal(downloaded.bytes, original.length);
    assert.equal(path.dirname(downloaded.path), path.join(await fs.realpath(root), 'material-downloads'));
    assert.deepEqual(await fs.readFile(downloaded.path), original);
    assert.equal(downloaded.path.startsWith(`${path.resolve(import.meta.dirname, '..')}${path.sep}`), false);
    assert.equal(JSON.stringify({ search, detail, downloaded }).includes(credentials.password), false);
    assert.ok(mock.calls.filter(call => call.path === '/api/user/login').length >= 3);
  });
});
