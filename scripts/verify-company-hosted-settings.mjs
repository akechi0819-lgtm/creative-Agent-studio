import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createTask } from '../src/creative/tasks.mjs';
import { listenStudioServer } from '../src/web/server.mjs';
import { readConfig, readConfigRecord, saveConfig } from '../src/web/config.mjs';

const roots = [];
const baseUrl = 'https://base.fixture.test/v1';
const imageUrl = 'https://image.fixture.test/v1';
const baseKey = 'fixture-base-key-private';
const imageKey = 'fixture-image-key-private';
const pluginKey = 'a'.repeat(64);
const pluginId = 'company-settings-fixture';
const pluginRequests = [];
const upstreamModelRequests = [];
const configRequests = [];
const chatCalls = [];
let browser;
let pluginServer;
let hostedApp;
let emptyApp;

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-company-hosted-settings-'));
  roots.push(root);
  return root;
}

async function readRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function startPluginFixture() {
  pluginServer = http.createServer(async (request, response) => {
    const body = await readRequest(request);
    pluginRequests.push({ url: request.url, body });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health') {
      response.end(JSON.stringify({ service: 'studio-model-plugin', instanceId: pluginId }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${pluginKey}`) {
      response.statusCode = 401;
      response.end('{}');
      return;
    }
    if (request.url === '/studio/status') {
      response.end(JSON.stringify({ running: true, accounts: [], login: { status: 'idle' } }));
      return;
    }
    if (request.url === '/studio/models') {
      response.end(JSON.stringify({ models: body.source === 'kilo'
        ? [{ id: 'kilo/fixture-free', name: 'Fixture Free', vision: true }]
        : [] }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise((resolve, reject) => {
    pluginServer.once('error', reject);
    pluginServer.listen(0, '127.0.0.1', resolve);
  });
}

async function installPluginDescriptor(root) {
  const directory = path.join(root, 'model-plugin');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, 'instance.json'), JSON.stringify({
    instanceId: pluginId,
    baseUrl: `http://127.0.0.1:${pluginServer.address().port}`,
    apiKey: pluginKey,
  }), { mode: 0o600 });
}

async function startStudio(root, { agent } = {}) {
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    upstreamModelRequests.push({ url: url.href, authorization: init.headers?.authorization });
    const modelId = url.hostname === 'base.fixture.test' ? 'custom-base-model' : 'gpt-image-2';
    return Response.json({ data: [{ id: modelId, name: modelId }] });
  };
  return listenStudioServer({
    root,
    port: 0,
    fetchImpl,
    readConfig,
    ...(agent ? { agent } : {}),
  });
}

function captureConfigRequests(page) {
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const pathname = new URL(request.url()).pathname;
    if (!['/api/config', '/api/config/models'].includes(pathname)) return;
    configRequests.push({ pathname, body: JSON.parse(request.postData() || '{}') });
  });
}

async function openSettings(page) {
  await page.getByRole('button', { name: '模型与服务', exact: true }).click();
  await page.getByRole('heading', { name: '模型与服务', exact: true }).waitFor();
}

async function chooseKiloModel(card) {
  const response = pageResponse(card.page(), '/api/config/models');
  await card.getByRole('button', { name: '获取模型', exact: true }).click();
  await response;
  await card.getByText(/已获取 1 个模型/).waitFor();
  await card.locator('select[aria-label]').selectOption('kilo/fixture-free');
}

function pageResponse(page, pathname) {
  return page.waitForResponse((response) => new URL(response.url()).pathname === pathname
    && response.request().method() === 'POST');
}

async function saveFromSettings(page) {
  const responsePromise = pageResponse(page, '/api/config');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200, 'Settings should save through the local API');
  await page.getByText(/配置已保存/).first().waitFor();
  return response.json();
}

try {
  await startPluginFixture();

  const separateRoot = await makeRoot();
  await saveConfig({
    expectedRevision: 1,
    base: { baseUrl, model: 'custom-base-model', apiKey: baseKey },
    image: { baseUrl: imageUrl, model: 'gpt-image-2', apiKey: imageKey },
  }, { root: separateRoot });
  await installPluginDescriptor(separateRoot);
  const task = await createTask({
    title: '托管基础模型对话隔离验证',
    brief: '检查保存托管基础模型后，Web 对话能否正常提交。',
  }, separateRoot);
  hostedApp = await startStudio(separateRoot, {
    agent: { chat: async ({ model, text }) => {
      chatCalls.push({ model, text });
      return { text: '隔离 Kilo 对话已收到。' };
    } },
  });

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (cause) => pageErrors.push(cause.message));
  captureConfigRequests(page);
  await page.addInitScript((taskId) => {
    localStorage.setItem('studio.onboardingDismissed', '1');
    localStorage.setItem('studio.activeTask', taskId);
  }, task.id);
  await page.goto(`http://127.0.0.1:${hostedApp.address.port}`, { waitUntil: 'networkidle' });
  await openSettings(page);

  assert.equal(await page.getByLabel('图片模型与对话模型共用服务地址和 API 密钥').count(), 0,
    'company Settings must not offer shared base and image credentials');
  const baseCard = page.locator('.provider-card').nth(0);
  const imageCard = page.locator('.provider-card').nth(1);
  assert.equal(await baseCard.getByLabel('服务地址').inputValue(), baseUrl);
  assert.equal(await imageCard.getByLabel('服务地址').inputValue(), imageUrl);

  const baseListResponse = pageResponse(page, '/api/config/models');
  await baseCard.getByRole('button', { name: '获取模型', exact: true }).click();
  assert.equal((await baseListResponse).status(), 200);
  await baseCard.getByText(/已获取 1 个模型/).waitFor();

  const imageListResponse = pageResponse(page, '/api/config/models');
  await imageCard.getByRole('button', { name: '获取模型', exact: true }).click();
  assert.equal((await imageListResponse).status(), 200);
  await imageCard.getByText(/已获取 1 个模型/).waitFor();

  const baseUpstream = upstreamModelRequests.find((request) => request.url === `${baseUrl}/models`);
  const imageUpstream = upstreamModelRequests.find((request) => request.url === `${imageUrl}/models`);
  assert.equal(baseUpstream?.authorization, `Bearer ${baseKey}`, 'base model listing must use the base key');
  assert.equal(imageUpstream?.authorization, `Bearer ${imageKey}`, 'image model listing must use the image key');
  assert.deepEqual(configRequests.filter((request) => request.pathname === '/api/config/models').map(({ body }) => body), [
    { kind: 'base', source: 'custom', baseUrl },
    { kind: 'image', baseUrl: imageUrl },
  ]);

  await page.getByLabel('基础模型来源').selectOption('kilo');
  assert.equal(await page.getByLabel('图片模型与对话模型共用服务地址和 API 密钥').count(), 0);
  assert.equal(await imageCard.getByLabel('服务地址').inputValue(), imageUrl,
    'switching the base source must leave the independent image URL in place');
  await chooseKiloModel(baseCard);
  const kiloModelsRequest = configRequests.filter((request) => request.pathname === '/api/config/models').at(-1);
  assert.deepEqual(kiloModelsRequest.body, { kind: 'base', source: 'kilo' },
    'Kilo model listing must not include custom URL, API keys, or shared-credential flags');
  assert.deepEqual(pluginRequests.filter((request) => request.url === '/studio/models').at(-1).body, { source: 'kilo' });

  const savedResponse = await saveFromSettings(page);
  assert.equal(savedResponse.config.base.source, 'kilo');
  const savedHostedConfig = await readConfigRecord({ root: separateRoot });
  assert.equal(savedHostedConfig.base.model, 'kilo/fixture-free');
  assert.equal(savedHostedConfig.base.apiKey, baseKey, 'the existing personal base key must remain saved');
  assert.deepEqual(savedHostedConfig.image, {
    baseUrl: imageUrl,
    model: 'gpt-image-2',
    apiKey: imageKey,
  }, 'the Image2 channel must survive a hosted base save');
  const hostedSaveRequest = configRequests.filter((request) => request.pathname === '/api/config').at(-1);
  assert.equal(hostedSaveRequest.body.image.useBaseCredentials, undefined);
  assert.equal(hostedSaveRequest.body.clearKeys.includes('base'), false);

  const imageListAfterKilo = pageResponse(page, '/api/config/models');
  await imageCard.getByRole('button', { name: '获取模型', exact: true }).click();
  assert.equal((await imageListAfterKilo).status(), 200);
  const imageRequestAfterKilo = configRequests.filter((request) => request.pathname === '/api/config/models').at(-1).body;
  assert.deepEqual(imageRequestAfterKilo, { kind: 'image', baseUrl: imageUrl });

  await page.getByRole('button', { name: '创作工作台', exact: true }).click();
  const chatText = 'Kilo 保存后发送一条隔离对话。';
  await page.getByLabel('告诉 Agent 想怎么改').fill(chatText);
  const chatResponse = pageResponse(page, `/api/tasks/${task.id}/chat`);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  assert.equal((await chatResponse).status(), 202);
  await page.locator('.message-row.assistant').filter({ hasText: '隔离 Kilo 对话已收到。' }).waitFor({ timeout: 20000 });
  assert.deepEqual(chatCalls.map(({ model, text }) => ({ model, text })), [{ model: 'kilo/fixture-free', text: chatText }]);

  await openSettings(page);
  await page.getByLabel('基础模型来源').selectOption('custom');
  assert.equal(await page.getByLabel('图片模型与对话模型共用服务地址和 API 密钥').count(), 0,
    'returning to custom must not restore a credential-sharing control');
  assert.equal(await page.locator('.provider-card').nth(1).getByLabel('服务地址').inputValue(), imageUrl);

  const emptyRoot = await makeRoot();
  await installPluginDescriptor(emptyRoot);
  emptyApp = await startStudio(emptyRoot);
  const emptyPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  emptyPage.on('pageerror', (cause) => pageErrors.push(cause.message));
  captureConfigRequests(emptyPage);
  await emptyPage.addInitScript(() => localStorage.setItem('studio.onboardingDismissed', '1'));
  await emptyPage.goto(`http://127.0.0.1:${emptyApp.address.port}`, { waitUntil: 'networkidle' });
  await openSettings(emptyPage);
  assert.equal(await emptyPage.locator('.provider-card').nth(1).getByLabel('API 密钥').count(), 1);
  await emptyPage.getByLabel('基础模型来源').selectOption('kilo');
  const emptyBaseCard = emptyPage.locator('.provider-card').nth(0);
  await chooseKiloModel(emptyBaseCard);
  const emptySaveResponse = await saveFromSettings(emptyPage);
  assert.equal(emptySaveResponse.config.base.source, 'kilo');
  const emptySavedConfig = await readConfigRecord({ root: emptyRoot });
  assert.equal(emptySavedConfig.base.model, 'kilo/fixture-free');
  assert.deepEqual(emptySavedConfig.image, { baseUrl: '', model: '', apiKey: '' },
    'Kilo must save successfully when no image API is configured');
  assert.equal(configRequests.some((request) => request.pathname === '/api/config'
    && request.body.image.useBaseCredentials === true), false);
  assert.deepEqual(pageErrors, []);

  console.log('公司版 Settings 隔离回归通过：基础/图片模型列表各用本通道凭据；Kilo 保存保留图片配置与个人密钥；托管来源无图片 API 也可保存；保存后 Kilo 对话正常提交。未访问真实上游或发起付费请求。');
} finally {
  await browser?.close();
  await hostedApp?.close();
  await emptyApp?.close();
  if (pluginServer?.listening) {
    pluginServer.closeAllConnections();
    await new Promise((resolve, reject) => pluginServer.close((cause) => cause ? reject(cause) : resolve()));
  }
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
}
