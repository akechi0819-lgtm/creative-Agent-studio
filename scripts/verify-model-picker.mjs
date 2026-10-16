import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {listenStudioServer} from '../src/web/server.mjs';
import {saveConfig,readConfig} from '../src/web/config.mjs';
import {createStudioAgent} from '../adapters/dsh/runtime.mjs';
import {createCanvasManager} from '../src/web/canvas.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const evidence = path.join(repo, 'docs/evidence/p3-model-picker');
await mkdir(evidence, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), 'studio-model-picker-'));
const report = {
  date: new Date().toISOString(),
  scope: '隔离临时数据根与本地 OpenAI-compatible mock 下的浏览器模型选择验收',
  checks: [],
  modelFetchRequests: [],
  browserChatModels: [],
  dshRequestModels: [],
};

let holdNextStream = null;
const upstream = createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'authorization,content-type');
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  if (request.url?.endsWith('/models')) {
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization !== 'Bearer unsaved-ui-key') {
      response.writeHead(401).end(JSON.stringify({ error: { message: 'mock authentication failure' } }));
      return;
    }
    response.end(JSON.stringify({ data: [
      { id: 'default-model', name: 'Default Model' },
      { id: 'saved-model', name: 'Saved Model' },
      { id: 'selected-model', name: 'Selected Model' },
    ] }));
    return;
  }
  if (!request.url?.endsWith('/chat/completions')) {
    response.writeHead(404).end();
    return;
  }
  report.dshRequestModels.push(body.model || '');
  const last = body.messages?.at(-1);
  const text = typeof last?.content === 'string' ? last.content : '';
  const tool = last?.role !== 'tool' && /整理制作单/.test(text)
    ? {
      id: `call-${Date.now()}`,
      type: 'function',
      function: {
        name: 'studio_write_sheet',
        arguments: JSON.stringify({
          payload: JSON.stringify({ title: '隔离模型选择测试', sourceIds: [], pages: [{ page: 1, copy: '本地测试', prompt: '暖白背景，墨绿色简洁排版。', size: '3:4', sourceIds: [] }] }),
        }),
      },
    }
    : null;
  if (holdNextStream) {
    const hold = holdNextStream;
    holdNextStream = null;
    hold.observe({ model: body.model || '' });
    await hold.gate;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const events = tool
    ? [
      { delta: { role: 'assistant', tool_calls: [{ index: 0, ...tool }] }, finish_reason: null },
      { delta: {}, finish_reason: 'tool_calls' },
    ]
    : [
      { delta: { role: 'assistant', content: '隔离 mock 已收到本次请求。' }, finish_reason: null },
      { delta: {}, finish_reason: 'stop' },
    ];
  for (const choice of events) {
    response.write(`data: ${JSON.stringify({ id: `mock-${Date.now()}`, object: 'chat.completion.chunk', created: 1, model: body.model || 'mock-model', choices: [{ index: 0, ...choice }] })}\n\n`);
  }
  response.end('data: [DONE]\n\n');
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const modelBaseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
await saveConfig({
  expectedRevision: 1,
  base: { baseUrl: 'http://127.0.0.1:1/v1', model: '', apiKey: 'old-key-stays-on-server' },
  image: { baseUrl: 'http://127.0.0.1:1/v1', model: 'image-existing', apiKey: 'image-key' },
}, { root });

const readCurrentConfig = () => readConfig({ root });
const canvas = createCanvasManager({ root, readConfig: readCurrentConfig });
const agent = createStudioAgent({ root, readConfig: readCurrentConfig });
const app = await listenStudioServer({ root, agent, canvas, readConfig: readCurrentConfig, port: 0, host: '127.0.0.1' });
const appUrl = `http://127.0.0.1:${app.address.port}`;
let browser;
let page;
let modelFetchResponse;

async function readJson(url) {
  const response = await fetch(url);
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${value?.error?.message || 'request failed'}`);
  return value;
}

async function waitForJob(jobId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { job } = await readJson(`${appUrl}/api/jobs/${encodeURIComponent(jobId)}`);
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      if (job.status !== 'succeeded') throw new Error(`mock Job ${job.status}: ${job.error?.message || ''}`);
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('等待隔离 mock Job 完成超时');
}

async function acceptNativeConfirm(button) {
  const dialogPromise = page.waitForEvent('dialog');
  const clickPromise = button.click();
  const dialog = await dialogPromise;
  assert.equal(dialog.type(), 'confirm', '确认动作应使用浏览器二次确认');
  const message = dialog.message();
  await dialog.accept();
  await clickPromise;
  return message;
}

async function assertConfirmationFieldsRemoved() {
  for (const label of ['确认人', '确认说明']) {
    assert.equal(await page.getByLabel(label, { exact: true }).count(), 0, `${label} 输入应已移除`);
  }
}

try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && pathname === '/api/config/models') {
      const body = request.postDataJSON();
      report.modelFetchRequests.push({
        kind: body.kind,
        baseUrlProvided: typeof body.baseUrl === 'string',
        usedCurrentUnsavedUrl: body.baseUrl === modelBaseUrl,
        apiKeyProvided: typeof body.apiKey === 'string',
      });
    }
    if (request.method() === 'POST' && pathname.endsWith('/chat')) {
      const body = request.postDataJSON();
      report.browserChatModels.push(body.model || '');
    }
  });
  page.on('response', async (response) => {
    if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/config/models') {
      modelFetchResponse = { status: response.status(), body: await response.json().catch(() => ({})) };
    }
  });

  await page.goto(appUrl, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '模型与服务', exact: true }).click();
  const cards = page.locator('.provider-card');
  const baseCard = cards.filter({ has: page.getByRole('heading', { name: '基础模型', exact: true }) });
  const imageCard = cards.filter({ has: page.getByRole('heading', { name: '图片模型', exact: true }) });
  assert.equal(await baseCard.getByLabel('服务地址').inputValue(), 'http://127.0.0.1:1/v1');
  assert.equal(await baseCard.getByLabel('模型名称').inputValue(), '');
  assert.equal(await imageCard.getByLabel('服务地址').inputValue(), 'http://127.0.0.1:1/v1');
  assert.equal(await imageCard.getByLabel('模型名称').inputValue(), 'image-existing');
  await page.screenshot({ path: path.join(evidence, 'settings-initial.png') });
  report.checks.push('same-revision-initial-provider-url-and-image-model-visible', 'base-model-can-start-empty');

  await baseCard.getByLabel('服务地址').fill(modelBaseUrl);
  await baseCard.getByLabel('API 密钥').fill('unsaved-ui-key');
  const fetchResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/config/models');
  await baseCard.getByRole('button', { name: '获取模型', exact: true }).click();
  const fetched = await (await fetchResponse).json();
  assert.equal(modelFetchResponse.status, 200);
  assert.equal(Array.isArray(fetched.models), true);
  assert.equal(fetched.apiKey, undefined);
  assert.equal(report.modelFetchRequests.at(-1).usedCurrentUnsavedUrl, true);
  assert.equal(report.modelFetchRequests.at(-1).apiKeyProvided, true);
  await baseCard.getByLabel('基础模型模型列表').selectOption('saved-model');
  assert.equal(await baseCard.getByLabel('模型名称').inputValue(), 'saved-model');
  await page.screenshot({ path: path.join(evidence, 'settings-model-selected.png') });
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.provider-card input[type="password"]')?.value === '');
  assert.equal(await baseCard.getByLabel('服务地址').inputValue(), modelBaseUrl);
  assert.equal(await baseCard.getByLabel('模型名称').inputValue(), 'saved-model');
  assert.equal(await baseCard.getByLabel('API 密钥').inputValue(), '');
  await page.screenshot({ path: path.join(evidence, 'settings-saved.png') });
  report.checks.push('unsaved-url-and-key-used-for-model-fetch', 'model-list-selection-populates-model-field', 'saved-default-model-displayed-without-key-echo');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  const settingsWidth = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth }));
  assert.equal(settingsWidth.scrollWidth <= settingsWidth.innerWidth, true, `settings overflow at 390px: ${JSON.stringify(settingsWidth)}`);
  await page.screenshot({ path: path.join(evidence, 'settings-390.png') });
  report.checks.push('settings-390px-no-horizontal-overflow');
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.getByRole('button', { name: '新建创作', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('你想做什么？').fill('请围绕亲子阅读习惯做一页简洁说明。内容仅用于本地模型选择验证。');
  const firstChatResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/chat'));
  await dialog.getByRole('button', { name: '创建并开始沟通', exact: true }).click();
  const firstResponse = await firstChatResponse;
  const firstPayload = firstResponse.request().postDataJSON();
  assert.equal(firstPayload.model, 'saved-model');
  const firstJob = await firstResponse.json();
  assert.ok(firstJob.job?.id);
  await waitForJob(firstJob.job.id);
  await page.getByRole('heading', { name: '请围绕亲子阅读习惯做一页简洁说明。内容仅用于本地模型选择验证。'.slice(0,30), exact: true }).waitFor({ state: 'visible' });
  const modelSelect = page.getByLabel('选择基础模型');
  await page.waitForFunction(() => document.querySelector('select[aria-label="选择基础模型"]')?.value === 'saved-model');
  report.checks.push('new-task-chat-defaults-to-saved-base-model');

  const workbenchFetchResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/config/models');
  await page.getByRole('button', { name: '获取模型', exact: true }).click();
  const workbenchFetch = await (await workbenchFetchResponse).json();
  assert.equal(workbenchFetch.models.some((model) => model.id === 'selected-model'), true);
  assert.deepEqual(report.modelFetchRequests.at(-1), { kind: 'base', baseUrlProvided: false, usedCurrentUnsavedUrl: false, apiKeyProvided: false });
  await modelSelect.selectOption('selected-model');
  assert.equal(await modelSelect.inputValue(), 'selected-model');
  await page.screenshot({ path: path.join(evidence, 'workbench-model-selected.png') });

  let observeHeld;
  let releaseHeld;
  const heldModelRequest = new Promise((resolve) => { observeHeld = resolve; });
  const heldGate = new Promise((resolve) => { releaseHeld = resolve; });
  holdNextStream = { observe: observeHeld, gate: heldGate };
  await page.getByLabel('告诉 Agent 想怎么改').fill('请补充一个本地 mock 对话测试。');
  const selectedChatResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/chat'));
  await page.getByRole('button', { name: '发送消息' }).click();
  const held = await Promise.race([
    heldModelRequest,
    new Promise((_, reject) => setTimeout(() => reject(new Error('mock DSH 请求未到达上游')), 15000)),
  ]);
  assert.equal(held.model, 'selected-model');
  await page.waitForFunction(() => document.querySelector('select[aria-label="选择基础模型"]')?.disabled === true);
  assert.equal(await modelSelect.isDisabled(), true);
  await page.screenshot({ path: path.join(evidence, 'workbench-model-busy.png') });
  releaseHeld();
  const selectedResponse = await selectedChatResponse;
  const selectedPayload = selectedResponse.request().postDataJSON();
  assert.equal(selectedPayload.model, 'selected-model');
  const selectedJob = await selectedResponse.json();
  await waitForJob(selectedJob.job.id);
  report.checks.push('chat-payload-and-real-mock-dsh-request-use-selected-model', 'model-selector-disabled-while-job-running');

  await assertConfirmationFieldsRemoved();
  assert.equal(await page.getByRole('checkbox', { name: '我确认本次不使用任何参考来源' }).count(), 0, '空来源选择应合并进确认对话框');
  const confirmResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/confirm-inputs'));
  const draftResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/chat'));
  const confirmMessage = await acceptNativeConfirm(page.getByRole('button', { name: '不使用参考并继续', exact: true }));
  assert.match(confirmMessage, /本次不使用参考素材/);
  assert.equal((await confirmResponse).status(), 200);

  const draftHttpResponse = await draftResponse;
  assert.equal(draftHttpResponse.request().postDataJSON().model, 'selected-model');
  const draftJob = await draftHttpResponse.json();
  await waitForJob(draftJob.job.id);
  assert.equal(report.dshRequestModels.includes('selected-model'), true);
  report.checks.push('sheet-draft-chat-payload-uses-current-task-model');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  const workbenchWidth = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth }));
  assert.equal(workbenchWidth.scrollWidth <= workbenchWidth.innerWidth, true, `workbench overflow at 390px: ${JSON.stringify(workbenchWidth)}`);
  await page.screenshot({ path: path.join(evidence, 'workbench-390.png') });
  report.checks.push('workbench-390px-no-horizontal-overflow');
  assert.deepEqual(pageErrors, []);
  report.checks.push('no-browser-runtime-errors');
  report.status = 'passed';
  console.log(`模型选择浏览器验收通过：${report.checks.length} 项；证据：${path.relative(repo, evidence)}`);
} catch (error) {
  report.status = 'failed';
  report.error = error?.message || String(error);
  throw error;
} finally {
  if (holdNextStream) holdNextStream = null;
  await writeFile(path.join(evidence, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
  await browser?.close().catch(() => {});
  await app.close().catch(() => {});
  await canvas.stop().catch(() => {});
  await new Promise((resolve) => upstream.close(resolve)).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
