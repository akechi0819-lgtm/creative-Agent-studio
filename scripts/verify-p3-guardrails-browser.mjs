import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const repo = path.resolve(import.meta.dirname, '..');
const evidence = path.join(repo, 'docs/evidence/p3-guardrail-rework');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'studio-p3-guardrails-'));
const webRoot = path.join(tempRoot, 'web');
const assetsRoot = path.join(webRoot, 'assets');
await mkdir(assetsRoot, { recursive: true });
await mkdir(evidence, { recursive: true });

const reviews = [];
const requests = [];
const dialogs = [];
const outsideRequests = [];
const jobs = new Map();
const jobsByTask = new Map();
const tasks = new Map();
const conversations = new Map();
const assets = new Map();
const report = {
  date: new Date().toISOString(),
  scope: '真实 Creative Studio React 工作台；隔离内存 API 与虚构本地任务；不调用模型或生图服务',
  browser: 'Chrome via Playwright',
  checks: [],
  apiActions: [],
  status: 'running',
};
let browser;
let server;
let chatSequence = 0;
let asset = {
  id: 'asset-needs-review',
  title: '隔离素材确认',
  status: 'needs_review',
  revision: 4,
  body: '只供浏览器交互回归使用的虚构正文。',
  summary: '隔离测试素材',
  tags: ['隔离测试'],
  source: { type: 'fixture' },
  files: [],
  extractions: [],
  updatedAt: '2026-10-16T00:00:00.000Z',
};
assets.set(asset.id, asset);

const testImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/c7sAAAAASUVORK5CYII=';
const imageHash = 'a'.repeat(64);
const now = '2026-10-16T00:00:00.000Z';
const makePage = () => ({ page: 1, copy: '隔离测试正文', prompt: '暖白背景与绿色方块，仅供界面回归。', size: '3:4', sourceIds: [], referenceImages: [] });
const makeSheet = (version = 1) => ({ version, title: `隔离制作单 v${version}`, inputsRevision: 1, sourceIds: [], pages: [makePage()] });

function makeTask(id, title, overrides = {}) {
  return {
    id,
    title,
    brief: { format: 'poster', pageCount: 1, content: '只供本次浏览器回归使用的虚构需求。' },
    revision: 1,
    status: '待补充需求',
    sources: [],
    inputConfirmation: null,
    sheets: [],
    sheetVersion: null,
    sheetConfirmation: null,
    sheetAuthorized: false,
    execution: null,
    executionHistory: [],
    reviews: [],
    finalApproval: null,
    exports: [],
    dna: { revision: 3, enabled: false },
    operations: [],
    ...overrides,
  };
}

tasks.set('dna-task', makeTask('dna-task', '隔离任务-DNA停用', {
  revision: 7,
  dna: { revision: 3, enabled: true },
}));
tasks.set('pending-refs-task', makeTask('pending-refs-task', '隔离任务-待选择参考', {
  sources: [{ id: 'pending-source', type: 'current_attachment', title: '未选择素材', decision: 'pending', purpose: '只作排版参考', factBoundary: '不引用任何事实', files: [] }],
}));
tasks.set('sheet-task', makeTask('sheet-task', '隔离任务-制作单确认', {
  revision: 11,
  inputConfirmation: { revision: 2, by: '本机用户', note: '隔离测试需求已确认', confirmedAt: now },
  sheets: [makeSheet(2)],
  sheetVersion: 2,
}));
tasks.set('approval-task', makeTask('approval-task', '隔离任务-成品批准', {
  revision: 15,
  inputConfirmation: { revision: 2, by: '本机用户', note: '隔离测试需求已确认', confirmedAt: now },
  sheets: [makeSheet(5)],
  sheetVersion: 5,
  sheetConfirmation: { version: 5, by: '本机用户', note: '隔离测试制作单已确认', confirmedAt: now },
  sheetAuthorized: true,
  execution: { version: 5, status: 'succeeded', pages: [{ page: 1, status: 'succeeded', image: { sha256: imageHash, imageUrl: testImage }, imageNodeId: 'fixture-image' }] },
  reviews: [{ version: 5, page: 1, sha256: imageHash, decision: 'pass', reviewer: '本机用户', notes: '虚构图片通过界面夹具', reviewedAt: now }],
}));
tasks.set('all-refs-task', makeTask('all-refs-task', '隔离任务-参考已明确', {
  sources: [{ id: 'retained-source', type: 'current_attachment', title: '已保留素材', decision: 'retained', purpose: '仅借鉴版式', factBoundary: '不引用其中事实', files: [] }],
}));

function taskListItem(task) {
  const sheet = task.sheets.find((item) => item.version === task.sheetVersion);
  const completedPages = task.execution?.pages?.filter((page) => page.status === 'succeeded').length || 0;
  return {
    id: task.id,
    title: task.title,
    status: task.finalApproval ? '已完成' : task.execution?.status === 'succeeded' ? '待审核' : task.inputConfirmation ? '待确认制作单' : '待确认需求',
    executionStatus: task.execution?.status || 'pending',
    sheetVersion: task.sheetVersion,
    sheetConfirmed: Boolean(task.sheetConfirmation?.version === task.sheetVersion || task.sheetAuthorized),
    totalPages: sheet?.pages?.length || 0,
    completedPages,
    finalApproved: Boolean(task.finalApproval?.version === task.sheetVersion),
  };
}

function taskDetail(id) {
  const task = tasks.get(id);
  if (!task) return null;
  return {
    task: structuredClone(task),
    conversation: structuredClone(conversations.get(id) || []),
    operations: structuredClone(task.operations || []),
    job: structuredClone(jobsByTask.get(id) || null),
    canvas: { state: 'disconnected', projectId: null, webUrl: null, clientConnected: false, selectedNodeIds: [], images: [] },
  };
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  return buffer.length ? JSON.parse(buffer.toString('utf8')) : {};
}

function recordAction(method, endpoint, body) {
  requests.push({ method, endpoint, body });
}

function updateTask(task) {
  tasks.set(task.id, task);
  return { task: structuredClone(task) };
}

async function handleApi(request, response, url) {
  const method = request.method || 'GET';
  const endpoint = url.pathname;
  if (method === 'GET' && endpoint === '/api/bootstrap') {
    return json(response, 200, {
      tasks: [...tasks.values()].map(taskListItem),
      dna: structuredClone(dnaProfile),
      config: { revision: 1, base: { model: 'isolated-base', apiKeyConfigured: false }, image: { model: 'isolated-image', apiKeyConfigured: false } },
      assets: [...assets.values()].map(({ id, title, status, revision, tags }) => ({ id, title, status, revision, tags })),
      tags: { revision: 1, tags: ['隔离测试'] },
    });
  }
  if (method === 'GET' && endpoint.startsWith('/api/tasks/')) {
    const id = decodeURIComponent(endpoint.split('/')[3]);
    const detail = taskDetail(id);
    return detail ? json(response, 200, detail) : json(response, 404, { error: { code: 'ERR_NOT_FOUND', message: '隔离任务不存在' } });
  }
  if (method === 'GET' && endpoint.startsWith('/api/jobs/')) {
    const id = decodeURIComponent(endpoint.split('/').at(-1));
    const job = jobs.get(id);
    return job ? json(response, 200, { job: structuredClone(job) }) : json(response, 404, { error: { code: 'ERR_NOT_FOUND', message: '隔离 Job 不存在' } });
  }
  if (method === 'GET' && endpoint === '/api/assets') return json(response, 200, { assets: [...assets.values()].map((item) => structuredClone(item)) });
  if (method === 'GET' && endpoint === '/api/tags') return json(response, 200, { tags: { revision: 1, tags: ['隔离测试'] } });
  if (method === 'GET' && endpoint.startsWith('/api/assets/')) {
    const found = assets.get(decodeURIComponent(endpoint.split('/').at(-1)));
    return found ? json(response, 200, { asset: structuredClone(found) }) : json(response, 404, { error: { message: '隔离素材不存在' } });
  }

  const body = await readBody(request);
  recordAction(method, endpoint, body);

  if (method === 'POST' && endpoint === '/api/dna') {
    assert.equal(body.enabled, false, '普通草稿保存应保留关闭状态');
    dnaProfile = { ...dnaProfile, revision: dnaProfile.revision + 1, content: body.content, enabled: false, savedAt: now };
    report.apiActions.push({ action: 'save-dna-draft', revision: dnaProfile.revision, enabled: dnaProfile.enabled });
    return json(response, 200, { profile: structuredClone(dnaProfile) });
  }

  const taskMatch = endpoint.match(/^\/api\/tasks\/([^/]+)\/(apply-dna|confirm-inputs|confirm-sheet|approve-final|chat)$/u);
  if (method === 'POST' && taskMatch) {
    const id = decodeURIComponent(taskMatch[1]);
    const action = taskMatch[2];
    const task = tasks.get(id);
    if (!task) return json(response, 404, { error: { code: 'ERR_NOT_FOUND', message: '隔离任务不存在' } });

    if (action === 'apply-dna') {
      assert.equal(body.dnaRevision, dnaProfile.revision);
      assert.equal(body.expectedRevision, task.revision);
      task.revision += 1;
      task.dna = { revision: body.dnaRevision, enabled: dnaProfile.enabled };
      report.apiActions.push({ action, taskId: id, dnaRevision: body.dnaRevision, expectedRevision: body.expectedRevision });
      return json(response, 200, updateTask(task));
    }
    if (action === 'confirm-inputs') {
      assert.equal(body.expectedRevision, task.revision);
      task.revision += 1;
      task.inputConfirmation = { revision: task.revision, by: body.by, note: body.note, confirmedAt: now };
      report.apiActions.push({ action, taskId: id, revision: task.revision });
      return json(response, 200, updateTask(task));
    }
    if (action === 'confirm-sheet') {
      assert.equal(body.version, task.sheetVersion);
      assert.equal(body.expectedRevision, task.revision);
      task.revision += 1;
      task.sheetConfirmation = { version: body.version, by: body.by, note: body.note, confirmedAt: now };
      task.sheetAuthorized = true;
      report.apiActions.push({ action, taskId: id, version: body.version, expectedRevision: body.expectedRevision });
      return json(response, 200, updateTask(task));
    }
    if (action === 'approve-final') {
      assert.equal(body.version, task.sheetVersion);
      assert.equal(body.expectedRevision, task.revision);
      assert.deepEqual(body.images, [{ page: 1, sha256: imageHash }]);
      task.revision += 1;
      task.finalApproval = { version: body.version, by: body.by, note: body.note, approvedAt: now, images: body.images };
      report.apiActions.push({ action, taskId: id, version: body.version, expectedRevision: body.expectedRevision, imageHashes: body.images.map((image) => image.sha256) });
      return json(response, 200, updateTask(task));
    }
    if (action === 'references') {
      assert.equal(body.expectedRevision, task.revision);
      const byId = new Map(body.items.map((item) => [item.id, item]));
      task.sources = task.sources.map((source) => ({ ...source, ...(byId.get(source.id) || {}) }));
      task.revision += 1;
      report.apiActions.push({ action, taskId: id, decisions: task.sources.map((source) => source.decision) });
      return json(response, 200, updateTask(task));
    }
    if (action === 'chat') {
      assert.equal(body.expectedRevision, task.revision);
      if (body.text === '故意失败的请求') {
        await new Promise((resolve) => setTimeout(resolve, 500));
        report.apiActions.push({ action: 'chat-failed', taskId: id, expectedRevision: body.expectedRevision });
        return json(response, 503, { error: { code: 'MOCK_FAILURE', message: '隔离模拟的请求失败。' } });
      }
      if (body.text === '提交快照原文') await new Promise((resolve) => setTimeout(resolve, 600));
      chatSequence += 1;
      const job = { id: `isolated-chat-${chatSequence}`, taskId: id, kind: 'chat', status: 'running', events: [{ seq: 1, message: '隔离模拟任务运行中' }] };
      jobs.set(job.id, job);
      jobsByTask.set(id, job);
      report.apiActions.push({ action: 'chat', taskId: id, text: body.text, jobId: job.id });
      return json(response, 202, { job: structuredClone(job) });
    }
    return json(response, 404, { error: { code: 'ERR_NOT_FOUND', message: `未配置隔离 API: ${action}` } });
  }

  const referencesMatch = endpoint.match(/^\/api\/tasks\/([^/]+)\/references$/u);
  if (method === 'POST' && referencesMatch) {
    const id = decodeURIComponent(referencesMatch[1]);
    const task = tasks.get(id);
    if (!task) return json(response, 404, { error: { code: 'ERR_NOT_FOUND', message: '隔离任务不存在' } });
    assert.equal(body.expectedRevision, task.revision);
    const byId = new Map(body.items.map((item) => [item.id, item]));
    task.sources = task.sources.map((source) => ({ ...source, ...(byId.get(source.id) || {}) }));
    task.revision += 1;
    report.apiActions.push({ action: 'set-references', taskId: id, decisions: task.sources.map((source) => source.decision) });
    return json(response, 200, updateTask(task));
  }

  const assetMatch = endpoint.match(/^\/api\/assets\/([^/]+)\/confirm$/u);
  if (method === 'POST' && assetMatch) {
    const id = decodeURIComponent(assetMatch[1]);
    const current = assets.get(id);
    if (!current) return json(response, 404, { error: { code: 'ERR_NOT_FOUND', message: '隔离素材不存在' } });
    assert.equal(body.expectedRevision, current.revision);
    current.revision += 1;
    current.status = 'confirmed';
    current.confirmation = { by: body.by, note: body.note, at: now };
    report.apiActions.push({ action: 'confirm-asset', assetId: id, expectedRevision: body.expectedRevision, by: body.by });
    return json(response, 200, { asset: structuredClone(current) });
  }

  return json(response, 404, { error: { code: 'ERR_NOT_FOUND', message: `未配置隔离 API: ${method} ${endpoint}` } });
}

let dnaProfile = { revision: 8, enabled: false, content: '只供隔离回归使用的已保存 DNA。', savedAt: now };

server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    if (url.pathname === '/favicon.ico') return response.writeHead(204).end();
    const pathname = decodeURIComponent(url.pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//u, '');
    const target = path.resolve(webRoot, relative);
    if (!target.startsWith(`${webRoot}${path.sep}`)) return response.writeHead(403).end();
    try {
      const contents = await readFile(target);
      const type = target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : target.endsWith('.html') ? 'text/html' : target.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(contents);
    } catch { response.writeHead(404).end(); }
  } catch (error) {
    report.error = String(error?.stack || error);
    json(response, 500, { error: { code: 'MOCK_ERROR', message: error.message } });
  }
});

async function waitForJob(page, taskId, status) {
  await page.locator('.job-activity').filter({ hasText: 'Agent 对话' }).waitFor({ state: 'visible', timeout: 10000 });
  if (status === 'running') await page.locator('.job-activity.active').waitFor({ state: 'visible', timeout: 10000 });
  if (status === 'succeeded') await page.locator('.job-activity.succeeded').waitFor({ state: 'visible', timeout: 10000 });
  const job = jobsByTask.get(taskId);
  assert.ok(job, `task ${taskId} should have an isolated chat job`);
  return job;
}

function dialogsSince(before) { return dialogs.slice(before); }
function actionCount(action, taskId) { return report.apiActions.filter((item) => item.action === action && (!taskId || item.taskId === taskId)).length; }

try {
  await build({
    entryPoints: [path.join(repo, 'web/src/main.jsx')],
    outfile: path.join(assetsRoot, 'app.js'),
    bundle: true,
    external: ['/brand/*'],
    jsx: 'automatic',
    loader: { '.png': 'file', '.svg': 'file' },
    assetNames: 'assets/[name]-[hash]',
    logLevel: 'warning',
  });
  await writeFile(path.join(webRoot, 'index.html'), await readFile(path.join(repo, 'web/index.html')));
  await cp(path.join(repo, 'web/public'), webRoot, { recursive: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('studio.activeTask', 'dna-task'));
  const page = await context.newPage();
  page.on('pageerror', (error) => { report.browserErrors ||= []; report.browserErrors.push(error.message); });
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.accept(); });
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(baseUrl) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    outsideRequests.push(new URL(url).origin);
    return route.abort();
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '隔离任务-DNA停用', exact: true }).waitFor({ state: 'visible' });

  await page.getByRole('button', { name: 'DNA 未启用' }).click();
  const applyButton = page.getByRole('button', { name: '在当前任务停用 DNA', exact: true });
  await applyButton.waitFor({ state: 'visible' });
  assert.equal(await applyButton.isDisabled(), false, 'the saved disabled DNA version should be explicitly applicable to an older task');
  await page.getByText(/固定关闭版 v8.*需求、制作单和成品的下游确认需要重新检查/u).waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(evidence, 'guardrail-dna-disabled-apply.png') });
  const beforeApplyDialogs = dialogs.length;
  const applyResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/tasks/dna-task/apply-dna');
  await applyButton.click();
  assert.equal((await applyResponse).status(), 200);
  assert.equal(dialogsSince(beforeApplyDialogs).length, 0, 'the explicit DNA action must not open a duplicate confirm');
  assert.equal(actionCount('apply-dna', 'dna-task'), 1, 'applying the disabled DNA snapshot should be recorded once');
  assert.equal(tasks.get('dna-task').dna.enabled, false);
  report.checks.push('disabled-dna-applies-explicitly-to-old-task-with-invalidation-copy');

  await page.locator('.dna-editor textarea').fill('隔离回归中的普通草稿保存。');
  const beforeDraftDialogs = dialogs.length;
  const saveDnaResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/dna');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  assert.equal((await saveDnaResponse).status(), 200);
  assert.equal(dialogsSince(beforeDraftDialogs).length, 0, 'ordinary DNA draft save must not open a second approval prompt');
  assert.equal(actionCount('save-dna-draft'), 1);
  report.checks.push('dna-draft-save-has-no-extra-confirm');

  await page.getByRole('button', { name: '创作工作台', exact: true }).click();
  await page.locator('.task-list-item').filter({ hasText: '隔离任务-制作单确认' }).click();
  await page.getByRole('heading', { name: '隔离任务-制作单确认', exact: true }).waitFor({ state: 'visible' });
  const beforeSheetDialogs = dialogs.length;
  const sheetResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/tasks/sheet-task/confirm-sheet');
  await page.getByRole('button', { name: '确认 v2', exact: true }).click();
  assert.equal((await sheetResponse).status(), 200);
  assert.equal(dialogsSince(beforeSheetDialogs).length, 0, 'the production sheet confirmation button is the explicit confirmation');
  assert.equal(actionCount('confirm-sheet', 'sheet-task'), 1);
  report.checks.push('sheet-confirm-button-records-once-without-extra-confirm');

  await page.locator('.task-list-item').filter({ hasText: '隔离任务-成品批准' }).click();
  await page.getByRole('heading', { name: '隔离任务-成品批准', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('tab', { name: '成品审核', exact: true }).click();
  await page.getByRole('button', { name: '人工批准当前成品', exact: true }).waitFor({ state: 'visible' });
  const beforeApprovalDialogs = dialogs.length;
  const approvalResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/tasks/approval-task/approve-final');
  await page.getByRole('button', { name: '人工批准当前成品', exact: true }).click();
  assert.equal((await approvalResponse).status(), 200);
  assert.equal(dialogsSince(beforeApprovalDialogs).length, 0, 'the final approval button must not ask for the same approval again');
  assert.equal(actionCount('approve-final', 'approval-task'), 1);
  assert.equal(report.apiActions.find((item) => item.action === 'approve-final').imageHashes[0], imageHash, 'the final approval must retain its current-image SHA binding');
  report.checks.push('final-artwork-approval-records-once-with-sha-without-extra-confirm');

  await page.getByRole('button', { name: '素材库', exact: true }).click();
  await page.getByRole('heading', { name: '素材库', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '确认入库', exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  const beforeAssetDialogs = dialogs.length;
  const assetResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/assets/${asset.id}/confirm`);
  await page.getByRole('button', { name: '确认入库', exact: true }).click();
  assert.equal((await assetResponse).status(), 200);
  assert.equal(dialogsSince(beforeAssetDialogs).length, 0, 'the check-in button is the explicit human confirmation');
  assert.equal(actionCount('confirm-asset'), 1);
  assert.equal(asset.confirmation.by, '本机用户');
  report.checks.push('asset-check-in-records-once-without-extra-confirm');

  await page.getByRole('button', { name: '创作工作台', exact: true }).click();
  await page.locator('.task-list-item').filter({ hasText: '隔离任务-待选择参考' }).click();
  await page.getByRole('heading', { name: '隔离任务-待选择参考', exact: true }).waitFor({ state: 'visible' });
  const beforePendingDialogs = dialogs.length;
  const excludedText = '继续整理制作单时将排除 1 项尚未选择的参考素材';
  const pendingChatResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/tasks/pending-refs-task/chat');
  await page.getByRole('button', { name: '不使用参考并继续', exact: true }).click();
  const pendingDialogMessages = dialogsSince(beforePendingDialogs);
  assert.equal(pendingDialogMessages.length, 1, 'an unresolved reference with an exclusion side effect should get exactly one confirmation');
  assert.match(pendingDialogMessages[0], new RegExp(excludedText));
  assert.equal((await pendingChatResponse).status(), 202);
  await waitForJob(page, 'pending-refs-task', 'running');
  assert.equal(actionCount('set-references', 'pending-refs-task'), 1);
  assert.deepEqual(tasks.get('pending-refs-task').sources.map((source) => source.decision), ['excluded']);
  assert.equal(actionCount('confirm-inputs', 'pending-refs-task'), 1);
  jobsByTask.get('pending-refs-task').status = 'succeeded';
  await page.waitForTimeout(1400);
  report.checks.push('unresolved-reference-exclusion-has-one-clear-confirm-and-one-write');

  await page.locator('.task-list-item').filter({ hasText: '隔离任务-参考已明确' }).click();
  await page.getByRole('heading', { name: '隔离任务-参考已明确', exact: true }).waitFor({ state: 'visible' });
  const beforeResolvedDialogs = dialogs.length;
  const allRefsChatResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/tasks/all-refs-task/chat');
  const inputsResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/tasks/all-refs-task/confirm-inputs');
  await page.getByRole('button', { name: '确认素材并继续', exact: true }).click();
  assert.equal((await inputsResponse).status(), 200);
  assert.equal((await allRefsChatResponse).status(), 202);
  assert.equal(dialogsSince(beforeResolvedDialogs).length, 0, 'all references were explicitly decided, so continue should not prompt again');
  await waitForJob(page, 'all-refs-task', 'running');
  assert.equal(actionCount('confirm-inputs', 'all-refs-task'), 1);
  report.checks.push('resolved-reference-continue-has-no-extra-confirm');

  const composer = page.getByLabel('告诉 Agent 想怎么改', { exact: true });
  const sendButton = page.getByRole('button', { name: '发送消息', exact: true });
  assert.equal(await composer.isDisabled(), false, 'the local text draft stays editable during a task Job');
  const attachmentInput = page.locator('.chat-file-input');
  assert.equal(await attachmentInput.isDisabled(), false, 'local attachments stay selectable during a task Job');
  await composer.fill('Job 忙时保留的下一条草稿');
  await attachmentInput.setInputFiles({ name: 'busy-local.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nlocal fixture\n%%EOF') });
  await page.getByText('busy-local.pdf', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await sendButton.isDisabled(), true, 'sending remains disabled while the Job is active');
  await composer.press('Enter');
  await page.waitForTimeout(150);
  assert.equal(requests.filter((item) => item.endpoint === '/api/tasks/all-refs-task/chat').length, 1, 'editing the draft must not submit another request');
  await page.screenshot({ path: path.join(evidence, 'guardrail-busy-local-draft.png') });
  report.checks.push('job-busy-allows-local-text-and-attachment-editing-but-blocks-submit');

  jobsByTask.get('all-refs-task').status = 'succeeded';
  await page.locator('.job-activity.succeeded').waitFor({ state: 'visible', timeout: 8000 });
  assert.equal(await composer.inputValue(), 'Job 忙时保留的下一条草稿', 'job polling/completion must not clear the local text draft');
  await page.getByText('busy-local.pdf', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await sendButton.isDisabled(), false, 'submit becomes available after the Job completes');
  await page.screenshot({ path: path.join(evidence, 'guardrail-draft-after-job-complete.png') });
  report.checks.push('job-completion-keeps-local-text-and-attachment-draft');

  await page.getByRole('button', { name: '移除附件 busy-local.pdf', exact: true }).click();
  await composer.fill('提交快照原文');
  const delayedChatResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/tasks/all-refs-task/chat');
  await sendButton.click();
  await composer.fill('请求结束前新写的文字草稿');
  await attachmentInput.setInputFiles({ name: 'later-local.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nsecond fixture\n%%EOF') });
  assert.equal(await composer.isDisabled(), false, 'text remains editable while the current send is awaiting a response');
  assert.equal((await delayedChatResponse).status(), 202);
  await page.getByRole('heading', { name: '隔离任务-参考已明确', exact: true }).waitFor({ state: 'visible' });
  await page.getByText('提交快照原文', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await composer.inputValue(), '请求结束前新写的文字草稿', 'success cleanup must clear only the sent text snapshot');
  await page.getByText('later-local.pdf', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(requests.filter((item) => item.endpoint === '/api/tasks/all-refs-task/chat' && item.body?.text === '提交快照原文').length, 1);
  await page.screenshot({ path: path.join(evidence, 'guardrail-send-snapshot-preserves-next-draft.png') });
  report.checks.push('successful-send-clears-only-its-own-text-and-attachment-snapshot');

  jobsByTask.get('all-refs-task').status = 'succeeded';
  await page.locator('.job-activity.succeeded').waitFor({ state: 'visible', timeout: 8000 });
  await page.getByRole('button', { name: '移除附件 later-local.pdf', exact: true }).click();
  await composer.fill('故意失败的请求');
  const failedChatResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/tasks/all-refs-task/chat');
  await sendButton.click();
  await composer.fill('失败期间另写的新草稿');
  assert.equal((await failedChatResponse).status(), 503);
  await page.locator('.global-message[role="alert"]').filter({ hasText: '隔离模拟的请求失败' }).waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await composer.inputValue(), '失败期间另写的新草稿', 'failure recovery must not replace a newer draft');
  report.checks.push('failed-send-recovery-keeps-newer-text-draft');

  assert.deepEqual(outsideRequests, [], 'the browser must not call an external service');
  assert.deepEqual(report.browserErrors || [], [], 'the real React app should have no browser runtime errors');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error?.stack || error);
  process.exitCode = 1;
} finally {
  report.apiRequestCount = requests.length;
  report.dialogMessages = dialogs;
  report.outsideRequestOrigins = outsideRequests;
  report.temporaryRootRemoved = true;
  report.tempWorkspaceWasSynthetic = true;
  const safetyReceipt = {
    date: report.date,
    testOnlySyntheticTaskAndAssetData: true,
    isolatedLocalHttpServer: true,
    externalRequestsBlocked: true,
    externalRequestCount: outsideRequests.length,
    realModelCalls: 0,
    imageGenerationCalls: 0,
    realTasksOrAssetsModified: false,
    globalConfigurationReadOrChanged: false,
    existingServiceRestarted: false,
    temporaryWorkspaceRemoved: true,
  };
  await browser?.close();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true });
  await writeFile(path.join(evidence, 'browser-regression-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(evidence, 'browser-regression.log'), `${report.status}\n${report.checks.map((check) => `PASS ${check}`).join('\n')}\n${report.error || ''}\n`, { mode: 0o600 });
  await writeFile(path.join(evidence, 'browser-regression-safety-receipt.json'), `${JSON.stringify(safetyReceipt, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
