import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCompanyMaterials } from '../src/company/materials.mjs';
import { createTask, readTask, setReferences, stageCompanySources, taskDirectory } from '../src/creative/tasks.mjs';

const companyConfig = {
  revision: 1,
  teedy: { baseUrl: 'https://teedy.fixture.test', username: 'reader-fixture', password: 'password-fixture' },
  canvas: { webUrl: '', bridgeUrl: '', token: '', projectId: '', clientId: '' },
};
const fileBytes = new Map([
  ['image-1', Buffer.from('company image bytes')],
  ['pdf-1', Buffer.from('company pdf bytes')],
]);

function makeTeedyFixture({ failFileId, content = '隔离夹具提取正文', extraFiles = [], extraBytes = {}, additionalDocuments = [], responseMimeOverrides = {}, emptyFilesOnListCall } = {}) {
  const calls = [];
  const document = {
    id: 'document-1', title: '公司图文样例', description: '一份隔离素材摘要', content,
    tags: [{ name: '明确标签' }], language: 'zh', source: '公司图文',
  };
  const documents = [document, ...additionalDocuments.map(({ document: extraDocument }) => extraDocument)];
  const filesByDocument = new Map([
    [document.id, [
      { id: 'image-1', name: '页面.jpg', mimetype: 'image/jpeg', size: fileBytes.get('image-1').length },
      { id: 'pdf-1', name: '原件.pdf', mimetype: 'application/pdf', size: fileBytes.get('pdf-1').length },
      ...extraFiles,
    ]],
    ...additionalDocuments.map(({ document: extraDocument, files }) => [extraDocument.id, files]),
  ]);
  const allFiles = [...filesByDocument.values()].flat();
  const bytesById = new Map([...fileBytes, ...Object.entries(extraBytes).map(([id, bytes]) => [id, Buffer.from(bytes)])]);
  let fileListCalls = 0;
  for (const extra of additionalDocuments) {
    for (const [id, bytes] of Object.entries(extra.bytes || {})) bytesById.set(id, Buffer.from(bytes));
  }
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (init.redirect !== 'manual') throw new Error('fixture expects redirects to be disabled');
    if (url.pathname === '/api/user/login') return new Response(null, { status: 200, headers: { 'set-cookie': 'JSESSIONID=fixture-session; Path=/; HttpOnly' } });
    if (!init.headers?.cookie?.includes('JSESSIONID=fixture-session')) return new Response(null, { status: 401 });
    if (url.pathname === '/api/document/list') return new Response(JSON.stringify({ documents, total: documents.length }), { status: 200, headers: { 'content-type': 'application/json' } });
    const documentMatch = /^\/api\/document\/([^/]+)$/.exec(url.pathname);
    if (documentMatch) {
      const matchedDocument = documents.find(candidate => candidate.id === decodeURIComponent(documentMatch[1]));
      return matchedDocument ? new Response(JSON.stringify(matchedDocument), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response(null, { status: 404 });
    }
    if (url.pathname === '/api/file/list') {
      fileListCalls += 1;
      if (fileListCalls === emptyFilesOnListCall) return new Response(JSON.stringify({ files: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      const matchedFiles = filesByDocument.get(url.searchParams.get('id'));
      return matchedFiles ? new Response(JSON.stringify({ files: matchedFiles }), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response(null, { status: 404 });
    }
    const fileMatch = /^\/api\/file\/([^/]+)\/data$/.exec(url.pathname);
    if (fileMatch) {
      const fileId = decodeURIComponent(fileMatch[1]);
      if (fileId === failFileId) return new Response('internal error must not escape', { status: 503 });
      const bytes = bytesById.get(fileId);
      const mimeType = responseMimeOverrides[fileId] || allFiles.find(file => file.id === fileId)?.mimetype || 'application/octet-stream';
      return bytes ? new Response(bytes, { status: 200, headers: { 'content-type': mimeType } }) : new Response(null, { status: 404 });
    }
    throw new Error(`unexpected fixture endpoint ${url.pathname}`);
  };
  return { calls, fetchImpl };
}

async function setupTask(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-company-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await createTask({ title: '公司素材快照夹具', brief: '仅隔离测试' }, root);
  return { root, task };
}

function retainItems(task) {
  return task.sources.map(source => ({
    kind: 'existing',
    id: source.id,
    decision: 'retained',
    purpose: '仅验证快照链路',
    factBoundary: '仅隔离 fixture，不作为实际业务事实',
  }));
}

test('company search stays pending until human retention, then freezes readable source text and hash-verified originals', async t => {
  const { root, task: initial } = await setupTask(t);
  const fixture = makeTeedyFixture();
  const materials = createCompanyMaterials({ root, readConfig: async () => companyConfig, fetchImpl: fixture.fetchImpl });

  const found = await materials.search({ query: '图文样例', tags: ['明确标签'] });
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0].files[0].mimetype, 'image/jpeg');
  const staged = await stageCompanySources(initial.id, found.items, { root, expectedRevision: initial.revision });
  assert.equal(staged.sources[0].decision, 'pending');
  assert.equal(staged.sources[0].body, '');
  assert.deepEqual(staged.sources[0].files, []);
  assert.equal(fixture.calls.some(call => /\/api\/file\/[^/]+\/data$/.test(call.url.pathname)), false, 'candidate search does not download original files');
  assert.equal(fixture.calls.some(call => call.url.pathname === '/api/document/document-1'), false, 'candidate search does not fetch full text');

  const retained = await setReferences(initial.id, retainItems(staged), {
    root,
    expectedRevision: staged.revision,
    companyMaterials: materials,
  });
  const snapshot = retained.sources[0];
  assert.equal(snapshot.decision, 'retained');
  assert.equal(snapshot.title, '公司图文样例');
  assert.equal(snapshot.body, '隔离夹具提取正文');
  assert.equal(snapshot.summary, '一份隔离素材摘要');
  assert.ok(snapshot.company.snapshotAt);
  assert.deepEqual(snapshot.files.map(file => [file.order, file.name, file.mimeType]), [
    [1, '页面.jpg', 'image/jpeg'],
    [2, '原件.pdf', 'application/pdf'],
  ]);
  for (const file of snapshot.files) {
    const bytes = await fs.readFile(path.join(taskDirectory(initial.id, root), file.relativePath));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    assert.equal(bytes.toString(), fileBytes.get(file.order === 1 ? 'image-1' : 'pdf-1').toString());
  }
  assert.equal(fixture.calls.filter(call => /^\/api\/file\/[^/]+\/data$/.test(call.url.pathname)).length, 2, 'originals are fetched only after retention');
});

test('company retention preserves full readable text beyond 20,000 characters', async t => {
  const { root, task: initial } = await setupTask(t);
  const content = '正文完整保留。'.repeat(3_000);
  const fixture = makeTeedyFixture({ content });
  const materials = createCompanyMaterials({ root, readConfig: async () => companyConfig, fetchImpl: fixture.fetchImpl });
  const found = await materials.search({ query: '图文样例' });
  const staged = await stageCompanySources(initial.id, found.items, { root, expectedRevision: initial.revision });

  const retained = await setReferences(initial.id, retainItems(staged), {
    root,
    expectedRevision: staged.revision,
    companyMaterials: materials,
  });
  assert.equal(content.length > 20_000, true);
  assert.equal(retained.sources[0].body, content);
});

test('retention rejects an image candidate whose Teedy attachment list became empty', async t => {
  const { root, task: initial } = await setupTask(t);
  const fixture = makeTeedyFixture({ emptyFilesOnListCall: 2 });
  const materials = createCompanyMaterials({ root, readConfig: async () => companyConfig, fetchImpl: fixture.fetchImpl });
  const found = await materials.search({ query: '图文样例' });
  const staged = await stageCompanySources(initial.id, found.items, { root, expectedRevision: initial.revision });

  await assert.rejects(setReferences(initial.id, retainItems(staged), {
    root,
    expectedRevision: staged.revision,
    companyMaterials: materials,
  }), /附件当前不可读取/);

  const current = await readTask(initial.id, root);
  assert.equal(current.revision, staged.revision);
  assert.equal(current.sources[0].decision, 'pending');
  assert.equal(current.sources[0].body, '');
  assert.deepEqual(current.sources[0].files, []);
  assert.equal(current.sources[0].company.snapshotAt, undefined);
  const sourcesDirectory = path.join(taskDirectory(initial.id, root), 'sources');
  const remainingEntries = await fs.readdir(sourcesDirectory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  assert.deepEqual(remainingEntries, [], 'an empty ACL result must not commit retained metadata or files');
});

test('failed company freeze leaves the task candidate pending and rolls back partial source files', async t => {
  const { root, task: initial } = await setupTask(t);
  const fixture = makeTeedyFixture({ failFileId: 'pdf-1' });
  const materials = createCompanyMaterials({ root, readConfig: async () => companyConfig, fetchImpl: fixture.fetchImpl });
  const found = await materials.search({ query: '图文样例' });
  const staged = await stageCompanySources(initial.id, found.items, { root, expectedRevision: initial.revision });

  await assert.rejects(setReferences(initial.id, retainItems(staged), {
    root,
    expectedRevision: staged.revision,
    companyMaterials: materials,
  }));
  assert.equal(fixture.calls.filter(call => /^\/api\/file\/[^/]+\/data$/.test(call.url.pathname)).length, 2, 'failure occurs after one original has been written and while the next is being fetched');
  const current = await readTask(initial.id, root);
  assert.equal(current.revision, staged.revision);
  assert.equal(current.sources[0].decision, 'pending');
  assert.equal(current.sources[0].body, '');
  assert.deepEqual(current.sources[0].files, []);
  assert.equal(current.sources[0].company.snapshotAt, undefined);
  const snapshotDirectory = path.join(taskDirectory(initial.id, root), 'sources', current.sources[0].id);
  const remainingFiles = await fs.readdir(snapshotDirectory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  assert.deepEqual(remainingFiles, [], 'a failed retain transaction must not leave downloaded source files behind');
});

test('two-source retention is atomic when the second company source fails after the first was frozen', async t => {
  const { root, task: initial } = await setupTask(t);
  const secondImage = Buffer.from('second company image bytes');
  const fixture = makeTeedyFixture({
    failFileId: 'image-2',
    additionalDocuments: [{
      document: {
        id: 'document-2', title: '第二份公司图文样例', description: '第二份隔离摘要',
        content: '第二份隔离正文', tags: [{ name: '明确标签' }], language: 'zh',
      },
      files: [{ id: 'image-2', name: '第二页.jpg', mimetype: 'image/jpeg', size: secondImage.length }],
      bytes: { 'image-2': secondImage },
    }],
  });
  const materials = createCompanyMaterials({ root, readConfig: async () => companyConfig, fetchImpl: fixture.fetchImpl });
  const found = await materials.search({ query: '图文样例' });
  assert.equal(found.items.length, 2);
  const staged = await stageCompanySources(initial.id, found.items, { root, expectedRevision: initial.revision });
  assert.equal(staged.sources.length, 2);

  await assert.rejects(setReferences(initial.id, retainItems(staged), {
    root,
    expectedRevision: staged.revision,
    companyMaterials: materials,
  }));

  const dataRequests = fixture.calls.filter(call => /^\/api\/file\/[^/]+\/data$/.test(call.url.pathname));
  assert.deepEqual(dataRequests.map(call => call.url.pathname), [
    '/api/file/image-1/data', '/api/file/pdf-1/data', '/api/file/image-2/data',
  ], 'the first source fully freezes before the second source fails during download');
  const current = await readTask(initial.id, root);
  assert.equal(current.revision, staged.revision);
  assert.deepEqual(current.sources.map(source => [source.decision, source.body, source.files.length, source.company?.snapshotAt]), [
    ['pending', '', 0, undefined],
    ['pending', '', 0, undefined],
  ], 'failure rolls back both retain decisions and every source snapshot');
  const sourcesDirectory = path.join(taskDirectory(initial.id, root), 'sources');
  const remainingEntries = await fs.readdir(sourcesDirectory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  assert.deepEqual(remainingEntries, [], 'a failed multi-source transaction removes the first source snapshot too');
});

test('credential-like Teedy text is rejected and the downloaded temporary snapshot is removed', async t => {
  const { root, task: initial } = await setupTask(t);
  const fixture = makeTeedyFixture({ content: 'Bearer abcdefghijklmnopqrstuvwxyz012345' });
  const materials = createCompanyMaterials({ root, readConfig: async () => companyConfig, fetchImpl: fixture.fetchImpl });
  const found = await materials.search({ query: '图文样例' });
  const staged = await stageCompanySources(initial.id, found.items, { root, expectedRevision: initial.revision });

  await assert.rejects(setReferences(initial.id, retainItems(staged), {
    root,
    expectedRevision: staged.revision,
    companyMaterials: materials,
  }), /疑似包含凭据/);
  const current = await readTask(initial.id, root);
  assert.equal(current.sources[0].decision, 'pending');
  assert.equal(current.sources[0].body, '');
  const sourcesDirectory = path.join(taskDirectory(initial.id, root), 'sources');
  const entries = await fs.readdir(sourcesDirectory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  assert.deepEqual(entries, [], 'neither credential-bearing text nor fetched originals remain in the task directory');
});

test('credential-like text attachments are rejected before they enter a task snapshot or export', async t => {
  const { root, task: initial } = await setupTask(t);
  const secret = Buffer.from('Bearer attachmentSecretTokenThatIsLongEnough123');
  const fixture = makeTeedyFixture({
    extraFiles: [{ id: 'text-1', name: 'notes.txt', mimetype: 'text/plain', size: secret.length }],
    extraBytes: { 'text-1': secret },
  });
  const materials = createCompanyMaterials({ root, readConfig: async () => companyConfig, fetchImpl: fixture.fetchImpl });
  const found = await materials.search({ query: '图文样例' });
  const staged = await stageCompanySources(initial.id, found.items, { root, expectedRevision: initial.revision });

  await assert.rejects(setReferences(initial.id, retainItems(staged), {
    root,
    expectedRevision: staged.revision,
    companyMaterials: materials,
  }), /凭据/);
  const current = await readTask(initial.id, root);
  assert.equal(current.sources[0].decision, 'pending');
  const sourcesDirectory = path.join(taskDirectory(initial.id, root), 'sources');
  const entries = await fs.readdir(sourcesDirectory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  assert.deepEqual(entries, [], 'credential-like attachment content does not remain on disk');
});

test('credential-like attachment is rejected when Teedy data MIME is text but list metadata is generic', async t => {
  const { root, task: initial } = await setupTask(t);
  const secret = Buffer.from('Bearer mismarkedSecretTokenThatIsLongEnough123');
  const fixture = makeTeedyFixture({
    extraFiles: [{ id: 'mismarked-1', name: 'payload.bin', mimetype: 'application/octet-stream', size: secret.length }],
    extraBytes: { 'mismarked-1': secret },
    responseMimeOverrides: { 'mismarked-1': 'text/plain' },
  });
  const materials = createCompanyMaterials({ root, readConfig: async () => companyConfig, fetchImpl: fixture.fetchImpl });
  const found = await materials.search({ query: '图文样例' });
  const staged = await stageCompanySources(initial.id, found.items, { root, expectedRevision: initial.revision });

  await assert.rejects(setReferences(initial.id, retainItems(staged), {
    root,
    expectedRevision: staged.revision,
    companyMaterials: materials,
  }), /凭据/);
  const current = await readTask(initial.id, root);
  assert.equal(current.sources[0].decision, 'pending');
  const sourcesDirectory = path.join(taskDirectory(initial.id, root), 'sources');
  const entries = await fs.readdir(sourcesDirectory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  assert.deepEqual(entries, [], 'response MIME must participate in credential scanning before source commit');
});
