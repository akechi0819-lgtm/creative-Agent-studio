import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const repo = path.resolve(import.meta.dirname, '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'studio-ui-interactions-'));
const webRoot = path.join(tempRoot, 'web');
const assetRoot = path.join(webRoot, 'assets');
const selectedFolder = path.join(tempRoot, 'synthetic-folder');
await mkdir(assetRoot, { recursive: true });
await mkdir(path.join(selectedFolder, 'article-one'), { recursive: true });
await mkdir(path.join(selectedFolder, 'article-two'), { recursive: true });

const report = { checks: [], uploads: null, chat: null, attachments: null, cleans: [] };
const tasks = new Map();
const conversations = new Map();
const jobs = new Map();
const assets = new Map();
const cleanRequests = [];
const cleanRevisionRequests = [];
const attachmentUploadRecords = new Map();
let activeClean = '';
let mainChatStarted = false;
let mainChatRequestId = '';
let mainChatResponseReturned = false;
let mainJobPolls = 0;
let attachmentUploadReturned = false;
let attachmentFirstAttemptReturned = false;
let firstCleanPolls = 0;
let browser;
let mockServer;
let staticServer;

function makeTask(id, title) {
  return {
    id,
    title,
    brief: { format: 'poster', pageCount: 1, content: `只供本次浏览器隔离验证：${title}` },
    revision: 1,
    status: '待补充需求',
    sources: [],
    inputConfirmation: null,
    sheets: [],
    sheetVersion: null,
    sheetConfirmation: null,
    execution: null,
    executionHistory: [],
    reviews: [],
    finalApproval: null,
    exports: [],
    dna: { revision: 1, enabled: false },
  };
}

for (const [id, title] of [['task-a', '隔离任务甲'], ['task-b', '隔离任务乙']]) {
  tasks.set(id, makeTask(id, title));
  conversations.set(id, id === 'task-b' ? Array.from({ length: 28 }, (_, index) => ({
    id: `history-${index + 1}`,
    role: 'assistant',
    text: `隔离历史消息 ${index + 1}：${'用于检查左右独立滚动的合成文本。'.repeat(9)}`,
    createdAt: new Date(Date.now() - (28 - index) * 60000).toISOString(),
  })) : []);
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function bodyBuffer(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function parseMultipart(buffer, contentType) {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.slice(1).find(Boolean);
  assert.ok(boundary, 'multipart boundary must be present');
  const fields = new Map();
  const files = [];
  const raw = buffer.toString('latin1');
  for (const part of raw.split(`--${boundary}`).slice(1)) {
    if (part.startsWith('--')) continue;
    const separator = part.indexOf('\r\n\r\n');
    if (separator < 0) continue;
    const headers = part.slice(0, separator);
    const value = part.slice(separator + 4).replace(/\r\n$/, '');
    const name = headers.match(/name="([^"]+)"/i)?.[1];
    if (!name) continue;
    const filename = headers.match(/filename="([^"]*)"/i)?.[1];
    if (filename != null) files.push({ name, filename, bytes: Buffer.from(value, 'latin1') });
    else fields.set(name, Buffer.from(value, 'latin1').toString('utf8'));
  }
  return { fields, files };
}

function conversationAnswerMessage(body) {
  return {
    id: `server-${body.requestId}`,
    requestId: body.requestId,
    role: 'user',
    text: body.text,
    ...(body.answers ? { answers: body.answers } : {}),
    ...(body.attachmentSourceIds?.length ? { attachmentSourceIds: body.attachmentSourceIds } : {}),
    createdAt: new Date().toISOString(),
  };
}

function taskDetail(id) {
  const task = tasks.get(id);
  assert.ok(task, `unknown mock task: ${id}`);
  return {
    task,
    conversation: conversations.get(id) || [],
    operations: [],
    job: jobs.get(`task:${id}`) || null,
    canvas: { state: 'disconnected', projectId: null, webUrl: null, clientConnected: false, selectedNodeIds: [], images: [] },
  };
}

function taskListItem(task) {
  return { id: task.id, title: task.title, status: task.status, executionStatus: 'pending', sheetVersion: null, sheetConfirmed: false, totalPages: 0, completedPages: 0, finalApproved: false };
}

mockServer = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
      return json(response, 200, {
        tasks: [...tasks.values()].map(taskListItem),
        dna: { revision: 1, enabled: false, content: '', savedAt: null },
        config: { revision: 1, base: { model: 'mock-base', apiKeyConfigured: true }, image: { model: 'mock-image', apiKeyConfigured: true } },
        assets: [...assets.values()],
        tags: { revision: 1, tags: [] },
      });
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/tasks/')) {
      const id = url.pathname.split('/')[3];
      return json(response, 200, taskDetail(id));
    }
    if (request.method === 'POST' && /^\/api\/tasks\/[^/]+\/attachments$/.test(url.pathname)) {
      const taskId = url.pathname.split('/')[3];
      const parsed = parseMultipart(await bodyBuffer(request), request.headers['content-type'] || '');
      const upload = tasks.get(taskId);
      const files = parsed.files.filter((file) => file.name === 'files');
      report.attachments ||= {};
      report.attachments.requestId = parsed.fields.get('uploadId');
      assert.match(report.attachments.requestId, /^[0-9a-f-]{36}$/iu, 'upload ID should be a UUID');
      assert.equal(parsed.fields.get('instructions'), '请参考这两份附件，帮我调整版式。');
      assert.deepEqual(files.map((file) => file.filename), ['layout.png', 'copy.pdf']);
      const uploadId = parsed.fields.get('uploadId');
      const expectedRevision = Number(parsed.fields.get('expectedRevision'));
      const fingerprint = JSON.stringify(files.map((file) => [file.filename, file.bytes.length]));
      let record = attachmentUploadRecords.get(uploadId);
      const replayed = Boolean(record);
      if (!record) {
        assert.equal(expectedRevision, upload.revision);
        const sourceId = 'chat-attachment-source';
        const source = {
          id: sourceId,
          type: 'current_attachment',
          title: '本次消息附件',
          files: files.map((file, order) => ({ name: file.filename, mimeType: file.filename.endsWith('.pdf') ? 'application/pdf' : 'image/png', fileUrl: `/mock/files/${file.filename}`, order })),
        };
        upload.sources = [...upload.sources.filter((item) => item.id !== sourceId), source];
        upload.revision += 1;
        record = { sourceId, uploadRevision: upload.revision, baseRevision: expectedRevision, fingerprint, attempts: 0 };
        attachmentUploadRecords.set(uploadId, record);
      } else {
        assert.equal(expectedRevision, record.baseRevision, 'upload retry must retain the original base revision');
        assert.equal(fingerprint, record.fingerprint, 'upload retry must retain the original file list');
      }
      record.attempts += 1;
      report.attachments.uploadAttempts = record.attempts;
      report.attachments.upload = { uploadId, expectedRevision, instructions: parsed.fields.get('instructions'), files: files.map((file) => ({ name: file.filename, size: file.bytes.length })), sourceId: record.sourceId, uploadRevision: record.uploadRevision, replayed };
      if (!replayed) {
        setTimeout(() => {
          attachmentFirstAttemptReturned = true;
          json(response, 503, { error: { code: 'MOCK_RESPONSE_LOST', message: '隔离模拟：服务已接收上传，但本次响应状态不确定。' } });
        }, 700);
        return;
      }
      setTimeout(() => {
        attachmentUploadReturned = true;
        json(response, 200, { task: upload, sourceId: record.sourceId, replayed: true, uploadRevision: record.uploadRevision });
      }, 500);
      return;
    }
    if (request.method === 'POST' && /^\/api\/tasks\/[^/]+\/chat$/.test(url.pathname)) {
      const taskId = url.pathname.split('/')[3];
      const body = JSON.parse((await bodyBuffer(request)).toString('utf8'));
      if (body.answers) {
        conversations.get(taskId).push(conversationAnswerMessage(body));
        report.chat.answerRequest = body;
        const answerJob = { id: 'answer-job', taskId, kind: 'chat', status: 'succeeded', events: [], result: { message: '隔离回答已收到。' } };
        jobs.set(`task:${taskId}`, answerJob);
        return json(response, 202, { job: answerJob });
      }
      if (body.attachmentSourceIds?.length) {
        assert.deepEqual(body.attachmentSourceIds, ['chat-attachment-source']);
        assert.equal(body.expectedRevision, 2, 'chat must use the upload revision');
        assert.equal(body.requestId, report.attachments.upload.uploadId, 'upload and chat must share one stable request ID');
        assert.equal(body.text, '请参考这两份附件，帮我调整版式。');
        conversations.get(taskId).push(conversationAnswerMessage(body));
        report.attachments.chat = body;
        const attachmentJob = { id: 'attachment-chat-job', taskId, kind: 'chat', status: 'succeeded', events: [], result: { message: '隔离附件对话已收到。' } };
        jobs.set(`task:${taskId}`, attachmentJob);
        return json(response, 202, { job: attachmentJob });
      }
      if (mainChatStarted) return json(response, 409, { error: { code: 'ERR_DUPLICATE', message: '不应生成新的聊天请求。' } });
      mainChatStarted = true;
      mainChatRequestId = body.requestId;
      report.chat = { request: body };
      setTimeout(() => {
        conversations.get(taskId).push(conversationAnswerMessage(body));
        const pending = { id: 'question-1', role: 'assistant', text: '请选择最合适的方向后继续。', questions: [
          { id: 'goal', question: '这次内容主要希望达成什么？', options: [{ id: 'awareness', label: '提升认知' }, { id: 'action', label: '引导行动' }], multiple: false, allowOther: true },
          { id: 'tone', question: '偏好的表达方向？', options: [{ id: 'warm', label: '温暖亲切' }, { id: 'concise', label: '简洁直接' }], multiple: true, allowOther: false },
        ], createdAt: new Date().toISOString() };
        const chatJob = { id: 'chat-job', taskId, kind: 'chat', status: 'running', events: [{ seq: 1, message: '正在整理需求' }] };
        jobs.set(`task:${taskId}`, chatJob);
        jobs.set(chatJob.id, chatJob);
        report.chat.questionId = pending.id;
        report.chat.questionPayload = pending.questions;
        report.chat.taskId = taskId;
        // The question appears only after the job poll observes an in-progress tool update.
        report.chat.pendingQuestion = pending;
        mainChatResponseReturned = true;
        json(response, 202, { job: chatJob });
      }, 2300);
      return;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
      const id = url.pathname.split('/').at(-1);
      if (id === 'chat-job') {
        mainJobPolls += 1;
        if (mainJobPolls === 1 && report.chat.pendingQuestion) conversations.get(report.chat.taskId).push(report.chat.pendingQuestion);
        const chatJob = jobs.get(id);
        if (mainJobPolls > 1) {
          chatJob.status = 'succeeded';
          chatJob.result = { message: '已生成结构化追问。' };
          jobs.set(`task:${report.chat.taskId}`, chatJob);
        }
        return json(response, 200, { job: chatJob });
      }
      if (id.startsWith('clean-job-')) {
        const ordinal = Number(id.split('-').at(-1));
        if (ordinal === 1 && firstCleanPolls < 3) {
          firstCleanPolls += 1;
          return json(response, 200, { job: { id, kind: 'asset-clean', status: 'running', events: [] } });
        }
        const terminal = ordinal === 1
          ? { status: 'failed', error: { code: 'MOCK_CLEAN_FAILURE', message: '隔离清洗失败，验证队列继续。' } }
          : { status: 'succeeded', result: { message: '隔离清洗完成。' } };
        const cleanedAsset = assets.get(cleanRequests[ordinal - 1]);
        if (cleanedAsset) {
          cleanedAsset.revision = ordinal === 1 ? cleanedAsset.revision + 2 : cleanedAsset.revision + 1;
          cleanedAsset.status = terminal.status === 'succeeded' ? 'needs_review' : 'clean_failed';
        }
        if (activeClean === id) activeClean = '';
        const job = { id, kind: 'asset-clean', status: terminal.status, events: [], ...terminal };
        jobs.set(id, job);
        return json(response, 200, { job });
      }
      const existingJob = jobs.get(id);
      if (existingJob) return json(response, 200, { job: existingJob });
      return json(response, 404, { error: { code: 'ERR_NOT_FOUND', message: 'unknown job' } });
    }
    if (request.method === 'GET' && url.pathname === '/api/assets') return json(response, 200, { assets: [...assets.values()] });
    if (request.method === 'GET' && url.pathname === '/api/tags') return json(response, 200, { revision: 1, tags: [] });
    if (request.method === 'GET' && url.pathname.startsWith('/api/assets/')) {
      const id = url.pathname.split('/').at(-1);
      const asset = assets.get(id);
      return asset ? json(response, 200, { asset }) : json(response, 404, { error: { message: 'asset missing' } });
    }
    if (request.method === 'POST' && url.pathname === '/api/assets/import-folder') {
      const parsed = parseMultipart(await bodyBuffer(request), request.headers['content-type'] || '');
      const paths = JSON.parse(parsed.fields.get('paths') || '[]');
      const uploaded = parsed.files.filter((file) => file.name === 'files');
      assert.equal(paths.length, uploaded.length, 'paths order must match repeated files fields');
      assert.deepEqual(uploaded.map((file) => file.filename), paths.map((item) => item.split('/').at(-1)), 'multipart filenames must be leaf names');
      const groups = new Map();
      for (let index = 0; index < paths.length; index += 1) {
        const segments = paths[index].split('/').filter(Boolean);
        const directory = segments.length > 2 ? segments.slice(1, -1).join('/') : '';
        const group = groups.get(directory) || [];
        group.push({ path: paths[index], file: uploaded[index] });
        groups.set(directory, group);
      }
      assert.equal(groups.size, 2, 'two article folders must stay as two separate assets');
      report.uploads = { batchId: parsed.fields.get('batchId'), paths, filenames: uploaded.map((file) => file.filename), groups: [...groups].map(([directory, files]) => ({ directory, files: files.map((item) => item.file.filename) })) };
      const entries = [...groups].map(([directory, files], index) => {
        const id = `asset-${index + 1}`;
        const asset = { id, title: directory.split('/').at(-1) || `文章 ${index + 1}`, status: 'staged', revision: 1, files: files.map((item, order) => ({ name: item.file.filename, order, size: item.file.bytes.length, mimeType: item.file.filename.endsWith('.md') ? 'text/markdown' : item.file.filename.endsWith('.txt') ? 'text/plain' : 'image/png' })) };
        assets.set(id, asset);
        return { directory, title: asset.title, status: 'staged', asset };
      });
      return json(response, 200, { batchId: parsed.fields.get('batchId'), entries, ignored: [], totals: { articles: entries.length, staged: entries.length, failed: 0, files: paths.length } });
    }
    if (request.method === 'POST' && /^\/api\/assets\/[^/]+\/clean$/.test(url.pathname)) {
      const id = url.pathname.split('/')[3];
      const body = JSON.parse((await bodyBuffer(request)).toString('utf8'));
      assert.equal(activeClean, '', 'batch cleaning must run one article at a time');
      assert.equal(body.expectedRevision, assets.get(id).revision, 'clean requests must use the revision snapshotted for this run');
      const jobId = `clean-job-${cleanRequests.length + 1}`;
      activeClean = jobId;
      cleanRequests.push(id);
      cleanRevisionRequests.push({ id, expectedRevision: body.expectedRevision });
      report.cleans = [...cleanRequests];
      return json(response, 202, { job: { id: jobId, kind: 'asset-clean', status: 'running', taskId: null, events: [] } });
    }
    return json(response, 404, { error: { code: 'ERR_NOT_FOUND', message: `${request.method} ${url.pathname} was not mocked` } });
  } catch (error) {
    console.error(error);
    return json(response, 500, { error: { code: 'MOCK_ERROR', message: error.message } });
  }
});

await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
const mockPort = mockServer.address().port;
await writeFile(path.join(selectedFolder, 'article-one', '01-cover.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
await writeFile(path.join(selectedFolder, 'article-one', '02-detail.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2]));
await writeFile(path.join(selectedFolder, 'article-one', 'body.md'), '# 第一篇\n隔离测试正文');
await writeFile(path.join(selectedFolder, 'article-two', '01-cover.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 3]));
await writeFile(path.join(selectedFolder, 'article-two', 'body.txt'), '第二篇隔离测试正文');
  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/c7sAAAAASUVORK5CYII=', 'base64');

try {
  await build({
    entryPoints: [path.join(repo, 'web/src/main.jsx')],
    outfile: path.join(assetRoot, 'app.js'),
    bundle: true,
  external: ['/brand/*'],
    jsx: 'automatic',
    loader: { '.png': 'file', '.svg': 'file' },
    assetNames: 'assets/[name]-[hash]',
    logLevel: 'warning',
  });
  await writeFile(path.join(webRoot, 'index.html'), await readFile(path.join(repo, 'web/index.html')));
  await cp(path.join(repo, 'web/public'), webRoot, { recursive: true });
  staticServer = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname.startsWith('/api/')) {
      const body = ['GET', 'HEAD'].includes(request.method || 'GET') ? undefined : await bodyBuffer(request);
      const upstream = await fetch(`http://127.0.0.1:${mockPort}${request.url}`, {
        method: request.method,
        headers: request.headers['content-type'] ? { 'content-type': request.headers['content-type'] } : undefined,
        ...(body ? { body } : {}),
      });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
      response.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    if (pathname === '/mock/files/layout.png') {
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      response.end(tinyPng);
      return;
    }
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const target = path.resolve(webRoot, relative);
    if (!target.startsWith(`${webRoot}${path.sep}`)) { response.writeHead(403).end(); return; }
    try {
      const contents = await readFile(target);
      const type = target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : target.endsWith('.html') ? 'text/html' : target.endsWith('.png') ? 'image/png' : target.endsWith('.ico') ? 'image/x-icon' : 'application/octet-stream';
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(contents);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => staticServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${staticServer.address().port}`;
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  const expectedServiceErrors = [];
  page.on('pageerror', (error) => { pageErrors.push(error.message); console.error('browser page error:', error.message); });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (message.text().includes('status of 503')) expectedServiceErrors.push(message.text());
    else { pageErrors.push(message.text()); console.error('browser console error:', message.text()); }
  });
  page.on('requestfailed', (request) => console.error('browser request failed:', request.method(), request.url(), request.failure()?.errorText));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(baseUrl, { waitUntil: 'networkidle' });

  await page.locator('.task-list-item').filter({ hasText: '隔离任务甲' }).click();
  await page.getByRole('heading', { name: '隔离任务甲', exact: true }).waitFor({ state: 'visible' });
  const originalText = '这条消息只属于隔离任务甲。';
  await page.getByLabel('告诉 Agent 想怎么改').fill(originalText);
  await page.getByRole('button', { name: '发送消息' }).click();
  const optimistic = page.locator('.conversation-scroll .message-row.user').filter({ hasText: originalText });
  await optimistic.waitFor({ state: 'visible', timeout: 800 });
  await optimistic.locator('.message-delivery.sending').waitFor({ state: 'visible' });
  assert.ok(mainChatRequestId, 'chat request should have reached the mock server');
  assert.equal(mainChatResponseReturned, false, 'the mock response must still be delayed while the optimistic message is visible');
  report.checks.push('chat-optimistic-before-delayed-response');

  await page.locator('.task-list-item').filter({ hasText: '隔离任务乙' }).click();
  await page.getByRole('heading', { name: '隔离任务乙', exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('.conversation-scroll .message-row.user').filter({ hasText: originalText }).count(), 0, 'optimistic message must not leak into another task');
  await page.locator('.task-list-item').filter({ hasText: '隔离任务甲' }).click();
  await page.getByRole('heading', { name: '隔离任务甲', exact: true }).waitFor({ state: 'visible' });
  await page.locator('.conversation-scroll .message-row.user').filter({ hasText: originalText }).waitFor({ state: 'visible' });
  await page.locator('.conversation-scroll .message-row.assistant .question-card').waitFor({ state: 'visible', timeout: 12000 });
  await page.locator('.job-activity.succeeded').waitFor({ state: 'visible', timeout: 12000 });
  await page.getByRole('heading', { name: '隔离任务甲', exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('.conversation-scroll .message-row.user').filter({ hasText: originalText }).count(), 1, 'requestId reconciliation must leave exactly one user message');
  assert.equal(mainChatRequestId, report.chat.request.requestId);
  assert.match(mainChatRequestId, /^[0-9a-f-]{36}$/iu, 'a stable UUID must be sent');
  assert.ok(mainJobPolls >= 1, 'active-job polling must observe a tool update');
  report.checks.push('chat-requestid-reconciliation', 'active-job-poll-refreshes-questions');

  const questionCard = page.locator('.question-card');
  await questionCard.getByRole('radio', { name: '提升认知' }).focus();
  await questionCard.getByRole('radio', { name: '提升认知' }).press('ArrowRight');
  assert.equal(await questionCard.getByRole('radio', { name: '引导行动' }).isChecked(), true, 'native radio controls should support keyboard navigation');
  await questionCard.getByLabel('提升认知').check();
  await questionCard.getByPlaceholder('用几个词说明即可').fill('面向新手家长');
  await questionCard.getByLabel('温暖亲切').check();
  await questionCard.getByLabel('简洁直接').check();
  await questionCard.getByRole('button', { name: '提交选择' }).click();
  await questionCard.getByText('已回答', { exact: true }).waitFor({ state: 'visible' });
  assert.ok(report.chat.answerRequest, 'the structured answer request should be captured');
  assert.equal(report.chat.answerRequest.answers.messageId, 'question-1');
  assert.deepEqual(report.chat.answerRequest.answers.items, [
    { questionId: 'goal', optionIds: ['awareness'], otherText: '面向新手家长' },
    { questionId: 'tone', optionIds: ['warm', 'concise'] },
  ]);
  assert.equal(await questionCard.getByRole('button', { name: '提交选择' }).count(), 0, 'answered questions must not be resubmittable');
  report.checks.push('structured-question-submit-and-answer-lock', 'question-controls-keyboard-accessible');

  const chatFiles = page.locator('input[aria-label="选择图片或 PDF 附件"]');
  await chatFiles.setInputFiles([
    { name: 'layout.png', mimeType: 'image/png', buffer: tinyPng },
    { name: 'copy.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nsynthetic attachment\n%%EOF') },
  ]);
  await page.locator('.chat-attachment-chip').getByText('layout.png', { exact: true }).waitFor({ state: 'visible' });
  await page.locator('.chat-attachment-chip').getByText('copy.pdf', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('.chat-attachment-chip img').count(), 1, 'image attachments should show a thumbnail before sending');
  const composer = page.locator('.chat-composer-shell');
  assert.equal(await composer.getByText(/借鉴用途|事实边界|附件用途/u).count(), 0, 'the composer should not ask for the removed attachment form fields');
  const attachmentText = '请参考这两份附件，帮我调整版式。';
  report.attachments = { ...(report.attachments || {}), requestId: '' };
  await page.getByLabel('告诉 Agent 想怎么改').fill(attachmentText);
  await page.getByRole('button', { name: '发送消息' }).click();
  const attachmentMessage = page.locator('.conversation-scroll .message-row.user').filter({ hasText: attachmentText });
  await attachmentMessage.waitFor({ state: 'visible', timeout: 800 });
  await attachmentMessage.locator('.message-delivery.sending').waitFor({ state: 'visible' });
  assert.equal(await page.getByLabel('选择基础模型').isDisabled(), true, 'task writes and model changes should stay disabled while attachments upload');
  assert.equal(await page.getByRole('button', { name: /确认素材并继续|不使用参考并继续|继续整理制作单/u }).isDisabled(), true, 'right-side confirmations should stay disabled while attachments upload');
  await attachmentMessage.getByText('layout.png', { exact: true }).waitFor({ state: 'visible' });
  await attachmentMessage.getByText('copy.pdf', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(attachmentFirstAttemptReturned, false, 'the optimistic attachment message must appear before the first upload response');
  const firstUploadDeadline = Date.now() + 5000;
  while (!attachmentFirstAttemptReturned && Date.now() < firstUploadDeadline) await page.waitForTimeout(20);
  await attachmentMessage.locator('.message-delivery.uncertain').waitFor({ state: 'visible', timeout: 5000 });
  assert.match(await attachmentMessage.locator('.message-delivery.uncertain').innerText(), /发送状态待确认/u);
  await attachmentMessage.getByRole('button', { name: '以同一请求 ID 重试' }).click();
  await attachmentMessage.locator('.message-delivery.sending').waitFor({ state: 'visible' });
  const uploadSuccessDeadline = Date.now() + 5000;
  while (!attachmentUploadReturned && Date.now() < uploadSuccessDeadline) await page.waitForTimeout(20);
  assert.equal(attachmentUploadReturned, true, 'the same upload ID should replay the accepted upload');
  assert.equal(report.attachments.uploadAttempts, 2, 'retry should submit the same upload ID for an idempotent replay');
  assert.equal(report.attachments.upload.replayed, true);
  assert.equal(tasks.get('task-a').revision, 2, 'replay must not create a second attachment source or task revision');
  assert.ok(report.attachments.upload, 'multipart attachment upload should reach the isolated HTTP server');
  assert.equal(report.attachments.upload.instructions, attachmentText);
  assert.deepEqual(report.attachments.upload.files.map((file) => file.name), ['layout.png', 'copy.pdf']);
  const attachmentDeadline = Date.now() + 6000;
  while (!report.attachments.chat && Date.now() < attachmentDeadline) await page.waitForTimeout(50);
  assert.ok(report.attachments.chat, 'chat should follow the successful attachment upload');
  assert.equal(report.attachments.chat.requestId, report.attachments.requestId);
  assert.deepEqual(report.attachments.chat.attachmentSourceIds, ['chat-attachment-source']);
  assert.equal(report.attachments.chat.expectedRevision, report.attachments.upload.uploadRevision);
  await attachmentMessage.locator('.message-attachments img').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await attachmentMessage.count(), 1, 'requestId reconciliation must preserve one attachment message');
  const durableAttachmentNames = await attachmentMessage.locator('.message-attachment-name').allTextContents();
  assert.deepEqual(durableAttachmentNames, ['layout.png', 'copy.pdf'], 'source files should resolve again after server reconciliation');
  const durablePreview = await attachmentMessage.locator('.message-attachments img').evaluate((image) => ({ complete: image.complete, width: image.naturalWidth, src: image.getAttribute('src') }));
  assert.equal(durablePreview.complete, true);
  assert.ok(durablePreview.width > 0, 'durable source preview should load an actual image');
  assert.equal(durablePreview.src, '/mock/files/layout.png', 'durable preview should use the task source file URL instead of a temporary blob URL');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '隔离任务甲', exact: true }).waitFor({ state: 'visible' });
  const reloadedAttachmentMessage = page.locator('.conversation-scroll .message-row.user').filter({ hasText: attachmentText });
  await reloadedAttachmentMessage.getByText('layout.png', { exact: true }).waitFor({ state: 'visible' });
  await reloadedAttachmentMessage.getByText('copy.pdf', { exact: true }).waitFor({ state: 'visible' });
  const reloadedPreviewWidth = await reloadedAttachmentMessage.locator('.message-attachments img').evaluate((image) => image.naturalWidth);
  assert.ok(reloadedPreviewWidth > 0, 'attachment names and image preview should persist after a page reload');
  report.checks.push('chat-attachment-previews-upload-retry-idempotency-source-reconciliation-and-reload');

  // The long synthetic conversation must scroll within its own pane, without moving the object column/page.
  await page.locator('.task-list-item').filter({ hasText: '隔离任务乙' }).click();
  await page.getByRole('heading', { name: '隔离任务乙', exact: true }).waitFor({ state: 'visible' });
  const scrollProbe = await page.evaluate(() => {
    const conversation = document.querySelector('.conversation-scroll');
    const object = document.querySelector('.object-content');
    const pageScroll = document.scrollingElement;
    const objectBefore = object?.scrollTop || 0;
    const pageBefore = pageScroll?.scrollTop || 0;
    conversation.scrollTop = 0;
    const independent = (object?.scrollTop || 0) === objectBefore && (pageScroll?.scrollTop || 0) === pageBefore;
    return { independent, conversationClient: conversation.clientHeight, conversationScroll: conversation.scrollHeight, objectClient: object?.clientHeight || 0, objectScroll: object?.scrollHeight || 0, pageScroll: pageScroll?.scrollHeight || 0, viewport: innerHeight };
  });
  assert.ok(scrollProbe.conversationScroll > scrollProbe.conversationClient, 'synthetic conversation should overflow its own pane');
  assert.equal(scrollProbe.independent, true, 'scrolling message history must not move the object pane or whole page');
  report.checks.push('split-conversation-scroll');

  await page.getByRole('button', { name: '素材库' }).click();
  await page.getByRole('heading', { name: '素材库', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /导入素材/ }).first().click();
  await page.getByRole('button', { name: '选择文件夹', exact: true }).click();
  const folderInput = page.locator('input[webkitdirectory]');
  await folderInput.setInputFiles(selectedFolder);
  await page.getByText('article-one', { exact: true }).waitFor({ state: 'visible' });
  await page.getByText('article-two', { exact: true }).waitFor({ state: 'visible' });
  const previews = await page.locator('.folder-preview-item').evaluateAll((rows) => rows.map((row) => row.innerText));
  assert.equal(previews.length, 2, 'two child folders must preview as two articles');
  assert.match(previews[0], /2 张图片/u);
  assert.match(previews[0], /1 个正文\/PDF/u);
  assert.match(previews[1], /1 张图片/u);
  assert.match(previews[1], /1 个正文\/PDF/u);
  report.checks.push('directory-preview-two-article-groups-and-file-counts');

  await page.getByRole('button', { name: '批量导入并提取' }).click();
  await page.locator('.folder-result-item').nth(0).waitFor({ state: 'visible', timeout: 12000 });
  await page.locator('.folder-result-item').nth(0).getByText(/AI 清洗中/u).waitFor({ state: 'visible', timeout: 8000 });
  await page.getByRole('button', { name: '创作工作台' }).click();
  await page.getByRole('heading', { name: '隔离任务乙', exact: true }).waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: '素材库' }).click();
  await page.getByRole('heading', { name: '素材库', exact: true }).waitFor({ state: 'visible' });
  await page.getByText(/清洗失败：隔离清洗失败/u).waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('.folder-result-item').getByText('待人工确认', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  assert.equal(report.uploads.groups.length, 2);
  assert.equal(report.uploads.paths.length, 5);
  assert.equal(new Set(report.uploads.groups.map((group) => group.directory)).size, 2);
  assert.equal(cleanRequests.length, 2, 'cleaning should continue to the second article after the first fails');
  assert.deepEqual(cleanRequests, ['asset-1', 'asset-2']);
  assert.deepEqual(report.uploads.groups.map((group) => group.files.length), [3, 2]);
  await page.getByText(/清洗队列结束：1 篇完成，1 篇失败或停止/u).waitFor({ state: 'visible', timeout: 15000 });
  report.checks.push('folder-import-order-paths-grouping-sequential-clean-continues-after-failure-and-navigation');
  const retriedClean = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/assets/asset-1/clean'));
  await page.getByRole('button', { name: '批量 AI 提取清洗' }).click();
  assert.equal((await retriedClean).ok(), true);
  assert.deepEqual(cleanRevisionRequests, [
    { id: 'asset-1', expectedRevision: 1 },
    { id: 'asset-2', expectedRevision: 1 },
    { id: 'asset-1', expectedRevision: 3 },
  ], 'retry should snapshot the failed asset latest revision and skip the successful article');
  await page.getByText(/清洗队列结束：2 篇完成，0 篇失败或停止/u).waitFor({ state: 'visible', timeout: 15000 });
  assert.deepEqual(cleanRequests, ['asset-1', 'asset-2', 'asset-1']);
  report.checks.push('folder-retry-snapshots-latest-revision-and-skips-success');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  const mobileWidth = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(mobileWidth.scrollWidth <= mobileWidth.width, `mobile layout must not overflow horizontally: ${JSON.stringify(mobileWidth)}`);
  report.checks.push('mobile-layout-no-horizontal-overflow');
  assert.deepEqual(pageErrors, [], 'browser should have no runtime errors');
  assert.equal(expectedServiceErrors.length, 1, 'the only browser resource error should be the intentional upload 503 used to exercise safe retry');
  report.checks.push('upload-in-progress-disables-task-edits-and-model-switching');
  console.log(JSON.stringify({ ...report, pageErrors, expectedServiceErrors, scrollProbe, mobileWidth }, null, 2));
} finally {
  await browser?.close();
  if (staticServer?.listening) await new Promise((resolve) => staticServer.close(resolve));
  if (mockServer?.listening) await new Promise((resolve) => mockServer.close(resolve));
  await rm(tempRoot, { recursive: true, force: true });
}
