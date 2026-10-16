import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCompanyMaterials, COMPANY_MATERIAL_MAX_DOWNLOAD_BYTES, COMPANY_MATERIAL_MAX_JSON_BYTES } from '../src/company/materials.mjs';

const config = {
  revision: 3,
  teedy: { baseUrl: 'https://teedy.fixture.test', username: 'fixture-user', password: 'fixture-password' },
  canvas: { webUrl: 'http://canvas.fixture.test', bridgeUrl: 'http://bridge.fixture.test', token: 'fixture-token', projectId: 'fixture', clientId: 'fixture' },
};

const jsonResponse = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json', ...headers },
});

function makeFixtureFetch({ documents = [], files = {}, detail = {}, downloadBytes = Buffer.from('fixture-file'), expireOneFileList = false, downloadHeaders = {} } = {}) {
  const calls = [];
  let sessions = 0;
  let expired = false;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const body = typeof init.body === 'string' ? init.body : init.body?.toString?.() ?? '';
    calls.push({ url, init, body });
    if (init.redirect !== 'manual') throw new Error('fixture expected manual redirects');
    if (url.origin !== 'https://teedy.fixture.test') throw new Error('fixture blocked off-origin request');
    if (url.pathname === '/api/user/login') {
      sessions += 1;
      return new Response(null, { status: 200, headers: { 'set-cookie': `JSESSIONID=s${sessions}; Path=/; HttpOnly` } });
    }
    const cookie = init.headers?.cookie ?? '';
    if (!cookie) return jsonResponse({ message: 'missing session' }, 401);
    if (url.pathname === '/api/document/list') return jsonResponse({ documents, total: documents.length });
    if (url.pathname === '/api/file/list') {
      if (expireOneFileList && !expired) {
        expired = true;
        return jsonResponse({ message: 'expired' }, 401);
      }
      return jsonResponse({ files: files[url.searchParams.get('id')] ?? [] });
    }
    if (url.pathname.startsWith('/api/document/')) return jsonResponse(detail[url.pathname.split('/').at(-1)] ?? {});
    if (/^\/api\/file\/[^/]+\/data$/.test(url.pathname)) {
      return new Response(downloadBytes, { status: 200, headers: { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="safe.png"', ...downloadHeaders } });
    }
    throw new Error(`unexpected fixture URL ${url.pathname}`);
  };
  return { fetchImpl, calls, sessions: () => sessions };
}

test('search preserves explicit tags and query, applies hard concept groups and excludes video with an image cover', async () => {
  const documents = [
    { id: 'doc-1', title: '日本高中生活', description: '留学攻略', tags: [{ name: '日本' }, { name: '图文' }] },
    { id: 'doc-tag-miss', title: '日本高中生活', description: '留学攻略', tags: [{ name: '日本' }] },
    { id: 'doc-video', title: '日本高中生活', description: '留学攻略', tags: [{ name: '日本' }, { name: '图文' }] },
    { id: 'doc-concept-miss', title: '日本大学生活', description: '留学攻略', tags: [{ name: '日本' }, { name: '图文' }] },
  ];
  const fixture = makeFixtureFetch({
    documents,
    files: {
      'doc-1': [{ id: 'img-1', name: 'guide.png', mimetype: 'image/png', size: 4 }],
      'doc-tag-miss': [{ id: 'img-2', name: 'guide.jpg', mimetype: 'image/jpeg' }],
      'doc-video': [{ id: 'img-3', name: 'cover.jpg', mimetype: 'image/jpeg' }, { id: 'vid-3', name: 'clip.mp4', mimetype: 'video/mp4' }],
      'doc-concept-miss': [{ id: 'img-4', name: 'guide.webp', mimetype: 'image/webp' }],
    },
  });
  const materials = createCompanyMaterials({ root: '/fixture', readConfig: async () => config, fetchImpl: fixture.fetchImpl });
  const result = await materials.search({
    query: '高中留学',
    tags: ['日本', '图文'],
    required_concepts: [['高中', '高一'], ['生活攻略', '留学攻略']],
    limit: 8,
  });

  assert.deepEqual(result.items.map(item => item.documentId), ['doc-1']);
  assert.equal(result.items[0].order, 0);
  assert.equal(result.items[0].sourceBoundary, 'company_teedy_readonly');
  assert.equal(result.items[0].files[0].fileId, 'img-1');
  assert.equal(result.items[0].previews[0].preview_url, 'https://teedy.fixture.test/api/file/img-1/data?size=web');
  assert.deepEqual(result.mediaFilter, { requested: 'image', excludedVideo: 1, excludedUnclassified: 0 });
  assert.equal(result.rejectedTags, 1);
  assert.equal(result.rejectedRequiredConcepts, 1);
  const searchCall = fixture.calls.find(call => call.url.pathname === '/api/document/list');
  assert.equal(searchCall.url.searchParams.get('search'), 'tag:日本 tag:图文 高中留学');
  assert.equal(searchCall.url.searchParams.get('limit'), '8');
  assert.equal(fixture.calls.filter(call => call.url.pathname === '/api/user/login').length, 1);
});

test('get returns text metadata and download rechecks ACL, size, filename and hash', async () => {
  const bytes = Buffer.from('approved fixture image');
  const fixture = makeFixtureFetch({
    detail: { 'doc-1': { id: 'doc-1', title: '详情', description: '摘要', content: '提取正文', source: '公司图文', subject: '案例', language: 'zh', tags: [{ name: '已确认' }] } },
    files: { 'doc-1': [{ id: 'file-1', name: 'article.png', mimetype: 'image/png', size: bytes.length }] },
    downloadBytes: bytes,
    expireOneFileList: true,
  });
  const materials = createCompanyMaterials({ root: '/fixture', readConfig: async () => config, fetchImpl: fixture.fetchImpl });
  const detail = await materials.get('doc-1');
  assert.equal(detail.body, '提取正文');
  assert.equal(detail.content, '提取正文');
  assert.equal(detail.sourceBoundary, 'company_teedy_readonly');

  const downloaded = await materials.download('file-1');
  assert.deepEqual(downloaded.bytes, bytes);
  assert.equal(downloaded.mimeType, 'image/png');
  assert.equal(downloaded.name, 'safe.png');
  assert.equal(downloaded.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(fixture.sessions(), 3, 'each operation logs in and an expired session is reauthenticated once');
  const fileListCalls = fixture.calls.filter(call => call.url.pathname === '/api/file/list');
  assert.equal(fileListCalls.length, 3, 'get, failed authorization check, and retry all use the documented file-list endpoint');
  assert.ok(fixture.calls.some(call => call.url.pathname === '/api/file/file-1/data'));
  await assert.rejects(materials.download('never-observed'), error => error.code === 'ERR_COMPANY_TEEDY_FILE_UNOBSERVED');
});

test('observed file authorization is bounded and old entries must be re-observed before download', async () => {
  const files = Array.from({ length: 2_001 }, (_, index) => ({
    id: `file-${index}`,
    name: `page-${index}.png`,
    mimetype: 'image/png',
    size: 1,
  }));
  const fixture = makeFixtureFetch({
    detail: { 'doc-1': { id: 'doc-1', title: 'large fixture' } },
    files: { 'doc-1': files },
    downloadBytes: Buffer.from('last file'),
  });
  const materials = createCompanyMaterials({ root: '/fixture', readConfig: async () => config, fetchImpl: fixture.fetchImpl });
  await materials.get('doc-1');

  await assert.rejects(materials.download('file-0'), error => error.code === 'ERR_COMPANY_TEEDY_FILE_UNOBSERVED');
  const latest = await materials.download('file-2000');
  assert.equal(latest.bytes.toString(), 'last file');
});

test('get preserves the 500,000-character body limit and rejects longer selected text', async () => {
  const maximumBody = '正文'.repeat(250_000);
  const maximumFixture = makeFixtureFetch({
    detail: { 'doc-1': { id: 'doc-1', title: 'maximum fixture', content: maximumBody } },
    files: { 'doc-1': [{ id: 'file-1', name: 'page.png', mimetype: 'image/png' }] },
  });
  const maximum = createCompanyMaterials({ root: '/fixture', readConfig: async () => config, fetchImpl: maximumFixture.fetchImpl });
  assert.equal((await maximum.get('doc-1')).body, maximumBody);

  const oversizedFixture = makeFixtureFetch({
    detail: { 'doc-1': { id: 'doc-1', title: 'oversized fixture', content: `${maximumBody}超` } },
    files: { 'doc-1': [{ id: 'file-1', name: 'page.png', mimetype: 'image/png' }] },
  });
  const oversized = createCompanyMaterials({ root: '/fixture', readConfig: async () => config, fetchImpl: oversizedFixture.fetchImpl });
  await assert.rejects(oversized.get('doc-1'), error => error.code === 'ERR_COMPANY_TEEDY_TEXT_TOO_LARGE');
  assert.equal(oversizedFixture.calls.some(call => call.url.pathname === '/api/file/list'), false, 'oversized text fails before file ACL reads');
});

test('login failure and redirects do not expose configured credentials or follow the redirect', async () => {
  const leakingFetch = async () => new Response('fixture-password should never appear', { status: 401 });
  const materials = createCompanyMaterials({ root: '/fixture', readConfig: async () => config, fetchImpl: leakingFetch });
  await assert.rejects(materials.search({ query: 'fixture' }), error => {
    assert.equal(error.code, 'ERR_COMPANY_TEEDY_LOGIN');
    assert.equal(error.message.includes(config.teedy.password), false);
    return true;
  });

  let followed = false;
  const redirectFetch = async (_url, init) => {
    assert.equal(init.redirect, 'manual');
    if (init.redirect !== 'manual') followed = true;
    return new Response(null, { status: 302, headers: { location: 'https://outside.fixture.test/steal' } });
  };
  const redirected = createCompanyMaterials({ root: '/fixture', readConfig: async () => config, fetchImpl: redirectFetch });
  await assert.rejects(redirected.search({ query: 'fixture' }), error => error.code === 'ERR_COMPANY_TEEDY_REDIRECT');
  assert.equal(followed, false);
});

test('unused login, HTTP error, and redirect response bodies are cancelled', async () => {
  function trackedResponse(value, status = 200, headers = {}) {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from(value)); },
      cancel() { cancelled = true; },
    }), { status, headers });
    return { response, cancelled: () => cancelled };
  }

  const loginResponse = trackedResponse('unused login body', 200);
  const failedResponse = trackedResponse('unused failure body', 503);
  const errorFetch = async input => new URL(input).pathname === '/api/user/login'
    ? loginResponse.response
    : failedResponse.response;
  const failed = createCompanyMaterials({ root: '/fixture', readConfig: async () => config, fetchImpl: errorFetch });
  await assert.rejects(failed.search({ query: 'fixture' }), error => error.code === 'ERR_COMPANY_TEEDY_HTTP');
  assert.equal(loginResponse.cancelled(), true);
  assert.equal(failedResponse.cancelled(), true);

  const redirectResponse = trackedResponse('unused redirect body', 302, { location: 'https://outside.fixture.test' });
  const redirected = createCompanyMaterials({
    root: '/fixture', readConfig: async () => config,
    fetchImpl: async () => redirectResponse.response,
  });
  await assert.rejects(redirected.search({ query: 'fixture' }), error => error.code === 'ERR_COMPANY_TEEDY_REDIRECT');
  assert.equal(redirectResponse.cancelled(), true);
});

test('rejects oversized downloads before retaining the response bytes', async () => {
  const fixture = makeFixtureFetch({
    detail: { 'doc-1': { id: 'doc-1', title: 'oversized fixture' } },
    files: { 'doc-1': [{ id: 'file-big', name: 'big.png', mimetype: 'image/png' }] },
    downloadBytes: Buffer.from('small fixture'),
    downloadHeaders: { 'content-length': String(COMPANY_MATERIAL_MAX_DOWNLOAD_BYTES + 1) },
  });
  const materials = createCompanyMaterials({ root: '/fixture', readConfig: async () => config, fetchImpl: fixture.fetchImpl });
  await materials.get('doc-1');
  await assert.rejects(materials.download('file-big'), error => error.code === 'ERR_COMPANY_TEEDY_DOWNLOAD_TOO_LARGE');
});

test('preview checks the document ACL and requests only the bounded Teedy web preview', async () => {
  const fixture = makeFixtureFetch({
    files: { 'doc-preview': [{ id: 'cover-1', name: 'cover.jpg', mimetype: 'image/jpeg' }] },
    downloadBytes: Buffer.from('small preview'),
  });
  const materials = createCompanyMaterials({ root: '/fixture', readConfig: async () => config, fetchImpl: fixture.fetchImpl });
  const result = await materials.preview('doc-preview', 'cover-1');
  assert.deepEqual(result.bytes, Buffer.from('small preview'));
  assert.equal(result.mimeType, 'image/png');
  const dataCall = fixture.calls.find(call => call.url.pathname === '/api/file/cover-1/data');
  assert.equal(dataCall.url.searchParams.get('size'), 'web');
  assert.equal(fixture.calls.some(call => call.url.pathname === '/api/document/doc-preview'), false, 'preview does not load full document text');

  await assert.rejects(materials.preview('doc-preview', 'unknown-file'), error => error.code === 'ERR_COMPANY_TEEDY_ACL');
  assert.equal(fixture.calls.filter(call => call.url.pathname === '/api/file/unknown-file/data').length, 0);
});

test('preview responses have an 8 MiB bound', async () => {
  const fixture = makeFixtureFetch({
    files: { 'doc-preview': [{ id: 'cover-big', name: 'cover.jpg', mimetype: 'image/jpeg' }] },
    downloadBytes: Buffer.from('small fixture'),
    downloadHeaders: { 'content-length': String(8 * 1024 * 1024 + 1) },
  });
  const materials = createCompanyMaterials({ root: '/fixture', readConfig: async () => config, fetchImpl: fixture.fetchImpl });
  await assert.rejects(materials.preview('doc-preview', 'cover-big'), error => error.code === 'ERR_COMPANY_TEEDY_PREVIEW_TOO_LARGE');
});

test('search rejects missing hard conditions instead of silently broadening the search', async () => {
  const fixture = makeFixtureFetch();
  const materials = createCompanyMaterials({ root: '/fixture', readConfig: async () => config, fetchImpl: fixture.fetchImpl });
  await assert.rejects(materials.search({ tags: [''], query: 'x' }), error => error.code === 'ERR_COMPANY_MATERIALS_INPUT');
  await assert.rejects(materials.search({ query: 'x', required_concepts: [['required'], []] }), error => error.code === 'ERR_COMPANY_MATERIALS_INPUT');
  await assert.rejects(materials.search({ query: 'x', required_concepts: [['required', ' ']] }), error => error.code === 'ERR_COMPANY_MATERIALS_INPUT');
  await assert.rejects(materials.search({}), error => error.code === 'ERR_COMPANY_MATERIALS_INPUT');
  assert.equal(fixture.calls.length, 0, 'invalid search input does not log in or access Teedy');
});

test('search rejects oversized hard conditions and bounds Teedy JSON responses', async () => {
  const fixture = makeFixtureFetch();
  const materials = createCompanyMaterials({ root: '/fixture', readConfig: async () => config, fetchImpl: fixture.fetchImpl });
  await assert.rejects(materials.search({ query: 'q'.repeat(2001) }), error => error.code === 'ERR_COMPANY_MATERIALS_INPUT');
  await assert.rejects(materials.search({ query: 'x', tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`) }), error => error.code === 'ERR_COMPANY_MATERIALS_INPUT');
  await assert.rejects(materials.search({ query: 'x', required_concepts: [Array.from({ length: 11 }, (_, index) => `term-${index}`)] }), error => error.code === 'ERR_COMPANY_MATERIALS_INPUT');
  assert.equal(fixture.calls.length, 0, 'oversized conditions are rejected before login');

  const oversizedJsonFetch = async input => {
    const url = new URL(input);
    if (url.pathname === '/api/user/login') return new Response(null, { status: 200 });
    return new Response('{"documents":[]}', { status: 200, headers: {
      'content-type': 'application/json',
      'content-length': String(COMPANY_MATERIAL_MAX_JSON_BYTES + 1),
    } });
  };
  const oversized = createCompanyMaterials({ root: '/fixture', readConfig: async () => config, fetchImpl: oversizedJsonFetch });
  await assert.rejects(oversized.search({ query: 'fixture' }), error => error.code === 'ERR_COMPANY_TEEDY_RESPONSE_TOO_LARGE');
});

test('a caller abort cancels an in-flight request even when the fetch adapter does not settle itself', async () => {
  const controller = new AbortController();
  let capturedSignal;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === '/api/user/login') return new Response(null, { status: 200 });
    capturedSignal = init.signal;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('fixture abort')), { once: true }));
  };
  const materials = createCompanyMaterials({ root: '/fixture', readConfig: async () => config, fetchImpl });
  const pending = materials.search({ query: 'fixture' }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, error => error.code === 'ERR_COMPANY_MATERIALS_ABORTED');
  assert.equal(capturedSignal.aborted, true);
});

test('a caller abort also interrupts a pending response body read', async () => {
  const controller = new AbortController();
  const fetchImpl = async input => {
    const url = new URL(input);
    if (url.pathname === '/api/user/login') return new Response(null, { status: 200 });
    if (url.pathname === '/api/document/list') {
      return new Response(new ReadableStream({ pull() {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('unexpected fixture URL');
  };
  const materials = createCompanyMaterials({ root: '/fixture', readConfig: async () => config, fetchImpl });
  const pending = materials.search({ query: 'fixture' }, { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(pending, error => error.code === 'ERR_COMPANY_MATERIALS_ABORTED');
});
