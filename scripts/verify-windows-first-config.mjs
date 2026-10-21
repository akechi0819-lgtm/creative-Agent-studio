#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const TEEDY_USERNAME = 'windows-first-config-reader';
const TEEDY_PASSWORD = 'windows-first-config-synthetic-only';
const BASE_API_KEY = 'windows-first-config-fixture-base-key';
const IMAGE_API_KEY = 'windows-first-config-fixture-image-key';
const BASE_MODEL = 'fixture-base-model';
const IMAGE_MODEL = 'fixture-image-model';
const KILO_MODEL = 'kilo/fixture-free';
const SUMMARY_FILE = 'windows-first-config.json';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--resume') {
      options.resume = true;
      continue;
    }
    const names = {
      '--package-root': 'packageRoot',
      '--profile': 'profile',
      '--data-dir': 'dataDir',
      '--evidence-dir': 'evidenceDir',
      '--url': 'url',
    };
    const name = names[argument];
    if (!name) throw new Error('Unknown argument: ' + argument);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('Missing value for ' + argument);
    options[name] = value;
    index += 1;
  }
  for (const required of ['packageRoot', 'profile', 'dataDir', 'evidenceDir']) {
    if (!options[required]) throw new Error('Required argument is missing: --' + required.replace(/[A-Z]/gu, match => '-' + match.toLowerCase()));
  }
  if (!['general', 'company'].includes(options.profile)) throw new Error('--profile must be general or company.');
  options.packageRoot = path.resolve(options.packageRoot);
  options.dataDir = path.resolve(options.dataDir);
  options.evidenceDir = path.resolve(options.evidenceDir);
  if (path.resolve(options.packageRoot) === path.resolve(options.dataDir)) {
    throw new Error('The application data directory must be isolated from the read-only package root.');
  }
  return options;
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/gu, '');
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function assertLocalWorkbenchUrl(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:', 'The packaged workbench must use local HTTP.');
  assert.ok(isLoopbackHost(url.hostname), 'Refusing to automate a non-loopback workbench URL.');
  assert.equal(url.username, '', 'The workbench URL must not contain credentials.');
  assert.equal(url.password, '', 'The workbench URL must not contain credentials.');
  assert.equal(url.search, '', 'The workbench URL must not contain query parameters.');
  assert.equal(url.hash, '', 'The workbench URL must not contain a fragment.');
  return url;
}

async function loadRuntime(options) {
  const runtimePath = path.join(options.dataDir, 'web', 'runtime.json');
  let runtime;
  try {
    runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));
  } catch (error) {
    if (!options.url) throw new Error('The running package did not write data-dir/web/runtime.json: ' + error.message);
  }

  let workbenchUrl = options.url || runtime?.url;
  if (!workbenchUrl) throw new Error('No running workbench URL was provided.');
  const selectedUrl = assertLocalWorkbenchUrl(workbenchUrl);
  if (runtime?.url) {
    const runtimeUrl = assertLocalWorkbenchUrl(runtime.url);
    assert.equal(selectedUrl.origin, runtimeUrl.origin, 'The supplied URL must identify the running data directory instance.');
    if (runtime.controlUrl && runtime.token && runtime.instanceId) {
      const controlUrl = new URL(runtime.controlUrl);
      assert.equal(controlUrl.protocol, 'http:');
      assert.ok(isLoopbackHost(controlUrl.hostname), 'Refusing a non-loopback launcher control URL.');
      const response = await fetch(new URL('/health', controlUrl), {
        headers: { authorization: 'Bearer ' + runtime.token },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200, 'The launcher health endpoint must identify a live packaged process.');
      const body = await response.json();
      assert.equal(body.instanceId, runtime.instanceId, 'The launcher health identity must match runtime.json.');
    }
  }
  return selectedUrl.href;
}

async function readPackageProfile(options) {
  const manifestPath = path.join(options.packageRoot, 'release-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (options.profile === 'company') {
    assert.equal(manifest.profile, 'company', 'The extracted package must be the Company profile.');
    assert.equal(manifest.product, 'Creative Agent Studio Company');
  } else {
    assert.equal(manifest.product, 'Creative Agent Studio', 'The extracted package must be the general product.');
    assert.notEqual(manifest.profile, 'company', 'Refusing to use a Company package for the general UI flow.');
    return null;
  }

  const servicesPath = path.join(options.packageRoot, 'company-services.json');
  const services = JSON.parse(await fs.readFile(servicesPath, 'utf8'));
  const value = services?.teedy?.baseUrl;
  assert.equal(typeof value, 'string', 'The Company package must include its readonly Teedy service URL.');
  const serviceUrl = new URL(value);
  assert.equal(serviceUrl.protocol, 'https:');
  assert.equal(serviceUrl.username, '');
  assert.equal(serviceUrl.password, '');
  assert.equal(serviceUrl.search, '');
  assert.equal(serviceUrl.hash, '');
  assert.ok(!isLoopbackHost(serviceUrl.hostname), 'The Company package must retain its real readonly service provisioning.');
  return {
    baseUrl: serviceUrl.toString().replace(/\/$/u, ''),
    hostname: serviceUrl.hostname.toLowerCase(),
  };
}

async function startModelFixture() {
  const requests = [];
  const unexpectedRequests = [];
  const server = http.createServer((request, response) => {
    const route = request.url === '/base/v1/models' ? 'base'
      : request.url === '/image/v1/models' ? 'image'
        : '';
    const expectedKey = route === 'base' ? BASE_API_KEY : IMAGE_API_KEY;
    const keyMatches = Boolean(route && request.headers.authorization === 'Bearer ' + expectedKey);
    requests.push({
      method: request.method || '',
      pathname: request.url || '',
      kind: route,
      keyMatches,
    });
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    if (request.method !== 'GET' || !route) {
      unexpectedRequests.push({ method: request.method || '', pathname: request.url || '' });
      response.statusCode = 404;
      response.end('{}');
      return;
    }
    if (!keyMatches) {
      response.statusCode = 401;
      response.end('{}');
      return;
    }
    const id = route === 'base' ? BASE_MODEL : IMAGE_MODEL;
    response.statusCode = 200;
    response.end(JSON.stringify({ data: [{ id, name: id }] }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  return {
    server,
    requests,
    unexpectedRequests,
    baseUrl: origin + '/base/v1',
    imageUrl: origin + '/image/v1',
  };
}

function companyHostMatches(hostname, teedy) {
  return Boolean(teedy && (hostname === teedy.hostname || hostname.endsWith('.' + teedy.hostname)));
}

function safePostJson(request) {
  try { return request.postDataJSON(); } catch { return null; }
}

function responseFor(page, pathname, method = 'POST', predicate = () => true) {
  return page.waitForResponse((response) => {
    const request = response.request();
    let url;
    try { url = new URL(response.url()); } catch { return false; }
    if (url.pathname !== pathname || request.method() !== method) return false;
    return predicate(request);
  }, { timeout: 30_000 });
}

async function readPageJson(page, pathname) {
  const result = await page.evaluate(async (route) => {
    const response = await fetch(route, { cache: 'no-store' });
    return { status: response.status, value: await response.json() };
  }, pathname);
  assert.equal(result.status, 200, 'The local read-only API should return HTTP 200 for ' + pathname);
  return result.value;
}

async function waitForWorkbench(page) {
  await page.getByRole('button', { name: '创作工作台', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal(await page.locator('.onboarding-page').count(), 0, 'First-run setup must remain dismissed.');
}

async function verifyCompanyCredentials(page, teedy) {
  if (!teedy) return { configured: false, saved: false };
  await page.getByRole('button', { name: '公司连接', exact: true }).click();
  await page.getByRole('heading', { name: '公司连接', exact: true }).waitFor();
  assert.equal(await page.locator('.readonly-service-address').innerText(), teedy.baseUrl,
    'The Company UI must display the package-provisioned readonly Teedy service.');
  assert.equal(await page.getByLabel('个人账号').inputValue(), TEEDY_USERNAME,
    'The synthetic Teedy username should persist in the UI.');
  const password = page.getByLabel('个人密码');
  assert.equal(await password.inputValue(), '', 'The UI must never reveal a saved password.');
  assert.match(await password.getAttribute('placeholder'), /已保存/u, 'The UI should indicate that the synthetic password was saved.');
  const publicCompany = await readPageJson(page, '/api/company/config');
  assert.equal(publicCompany.config.deploymentConfigured, true);
  assert.equal(publicCompany.config.teedy.baseUrl, teedy.baseUrl);
  assert.equal(publicCompany.config.teedy.username, TEEDY_USERNAME);
  assert.equal(publicCompany.config.teedy.passwordConfigured, true);
  assert.equal(JSON.stringify(publicCompany).includes(TEEDY_PASSWORD), false, 'The public Company config must redact the synthetic password.');
  return { configured: true, saved: true };
}

async function openSettings(page) {
  await page.getByRole('button', { name: '模型与服务', exact: true }).click();
  await page.getByRole('heading', { name: '模型与服务', exact: true }).waitFor();
}

async function verifyModelSettings(page, expected) {
  await openSettings(page);
  const baseCard = page.locator('.provider-card').nth(0);
  const imageCard = page.locator('.provider-card').nth(1);
  assert.equal(await baseCard.getByLabel('基础模型来源').inputValue(), expected.baseSource);
  assert.equal(await baseCard.getByLabel('模型名称').inputValue(), expected.baseModel);
  if (expected.baseSource === 'custom') {
    assert.equal(await baseCard.getByLabel('服务地址').inputValue(), expected.baseUrl);
    const baseKey = baseCard.getByLabel('API 密钥');
    assert.equal(await baseKey.inputValue(), '');
    assert.match(await baseKey.getAttribute('placeholder'), /已保存密钥/u);
  } else {
    assert.equal(await baseCard.getByLabel('API 密钥').count(), 0, 'Managed Kilo UI must not ask for a personal API key.');
  }
  assert.equal(await imageCard.getByLabel('服务地址').inputValue(), expected.imageUrl);
  assert.equal(await imageCard.getByLabel('模型名称').inputValue(), expected.imageModel);
  const imageKey = imageCard.getByLabel('API 密钥');
  assert.equal(await imageKey.inputValue(), '');
  assert.match(await imageKey.getAttribute('placeholder'), /已保存密钥/u);
}

async function openLocalCanvas({ browserContext, page, taskId, pageErrors }) {
  const taskPath = '/api/tasks/' + taskId + '/canvas/open';
  const responsePromise = responseFor(page, taskPath);
  const popupPromise = browserContext.waitForEvent('page', { timeout: 30_000 });
  await page.getByRole('button', { name: /打开 Canvas/u }).click();
  const [response, canvasPage] = await Promise.all([responsePromise, popupPromise]);
  canvasPage.on('pageerror', (cause) => pageErrors.push(cause.message));
  assert.equal(response.status(), 200, 'The real workbench UI should open the task Canvas.');
  const opened = await response.json();
  assert.equal(typeof opened.openUrl, 'string');
  const localCanvasUrl = new URL(opened.openUrl);
  assert.equal(localCanvasUrl.protocol, 'http:', 'Canvas must use the bundled local HTTP runtime.');
  assert.ok(isLoopbackHost(localCanvasUrl.hostname), 'Canvas must stay on the local computer.');
  assert.equal(localCanvasUrl.username, '');
  assert.equal(localCanvasUrl.password, '');
  assert.equal(localCanvasUrl.pathname, '/canvas', 'Canvas should be served by the bundled local Canvas runtime.');
  assert.equal(localCanvasUrl.searchParams.get('projectId'), taskId);
  await canvasPage.waitForURL((url) => url.pathname === '/canvas/' + taskId && !url.hash, { timeout: 45_000 });
  await canvasPage.locator('#root').waitFor({ state: 'attached', timeout: 30_000 });
  await canvasPage.waitForFunction(async (expectedProjectId) => {
    try {
      const response = await fetch('/__studio/session', { cache: 'no-store' });
      if (!response.ok) return false;
      const session = await response.json();
      return session.projectId === expectedProjectId;
    } catch {
      return false;
    }
  }, taskId, { timeout: 45_000 });
  const session = await canvasPage.evaluate(async () => {
    const response = await fetch('/__studio/session', { cache: 'no-store' });
    return response.json();
  });
  assert.equal(session.projectId, taskId, 'The local Canvas session must bind to the current test task.');
  return { canvasPage, canvasUrl: localCanvasUrl, session };
}

async function createCanvasTestTask(page) {
  const bootstrap = await readPageJson(page, '/api/bootstrap');
  assert.equal(Array.isArray(bootstrap.tasks), true);
  assert.equal(bootstrap.tasks.length, 0,
    'The first-run test requires an isolated empty data directory; it will not reuse or touch other tasks.');
  const created = await page.evaluate(async () => {
    const response = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Windows 首次配置本机 Canvas 验证',
        brief: '隔离的本地运行包验证任务，仅用于打开 Canvas；不提交聊天或模型请求。',
      }),
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(created.status, 201, 'The local fixture task should be created in the isolated package data directory.');
  assert.equal(typeof created.body.task?.id, 'string');
  return created.body.task.id;
}

async function resumeCanvasTask(page, taskId) {
  const detail = await readPageJson(page, '/api/tasks/' + encodeURIComponent(taskId));
  assert.equal(detail.task?.title, 'Windows 首次配置本机 Canvas 验证',
    'Resume should reopen only the isolated fixture task created by the initial UI smoke.');
}

const options = parseArgs(process.argv.slice(2));
await fs.mkdir(options.evidenceDir, { recursive: true });
const packageManifest = await readPackageProfile(options);
const workbenchUrl = await loadRuntime(options);
const priorEvidencePath = path.join(options.evidenceDir, SUMMARY_FILE);
let priorEvidence = null;
if (options.resume) {
  priorEvidence = JSON.parse(await fs.readFile(priorEvidencePath, 'utf8'));
  assert.equal(priorEvidence.profile, options.profile);
  assert.equal(priorEvidence.resumed, false);
  assert.equal(typeof priorEvidence.canvas?.taskId, 'string',
    'The initial run must leave a synthetic task identifier for resume verification.');
}

let fixture = null;
let browser = null;
let browserContext = null;
let page = null;
const pageErrors = [];
const teedyRequests = [];
const externalRequests = [];
const configWrites = [];
const companyWrites = [];
const modelListWrites = [];
const modelWorkRequests = [];

try {
  if (!options.resume) fixture = await startModelFixture();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  browserContext = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  browserContext.setDefaultTimeout(20_000);
  await browserContext.route('**/*', async (route) => {
    let url;
    try { url = new URL(route.request().url()); } catch {
      await route.continue();
      return;
    }
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !isLoopbackHost(url.hostname)) {
      const entry = { method: route.request().method(), hostname: url.hostname.toLowerCase(), pathname: url.pathname };
      externalRequests.push(entry);
      if (companyHostMatches(url.hostname.toLowerCase(), packageManifest)) teedyRequests.push(entry);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });

  page = await browserContext.newPage();
  page.on('pageerror', (cause) => pageErrors.push(cause.message));
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    let url;
    try { url = new URL(request.url()); } catch { return; }
    const body = safePostJson(request);
    if (!body) return;
    if (url.pathname === '/api/config') {
      configWrites.push({
        baseSource: body.base?.source || '',
        baseUrl: body.base?.baseUrl || '',
        baseModel: body.base?.model || '',
        baseKeyMatchesFixture: body.base?.apiKey === BASE_API_KEY,
        imageUrl: body.image?.baseUrl || '',
        imageModel: body.image?.model || '',
        imageKeyMatchesFixture: body.image?.apiKey === IMAGE_API_KEY,
        imageUsesBaseCredentials: body.image?.useBaseCredentials === true,
        clearsBaseKey: Array.isArray(body.clearKeys) && body.clearKeys.includes('base'),
      });
    } else if (url.pathname === '/api/company/config') {
      companyWrites.push({
        usernameMatchesSynthetic: body.teedy?.username === TEEDY_USERNAME,
        passwordMatchesSynthetic: body.teedy?.password === TEEDY_PASSWORD,
        containsServiceUrl: Object.hasOwn(body.teedy || {}, 'baseUrl'),
      });
    } else if (url.pathname === '/api/config/models') {
      modelListWrites.push({
        kind: body.kind || '',
        source: body.source || '',
        baseUrl: body.baseUrl || '',
        keyMatchesFixture: body.apiKey === BASE_API_KEY || body.apiKey === IMAGE_API_KEY,
        baseKeyMatchesFixture: body.apiKey === BASE_API_KEY,
        imageKeyMatchesFixture: body.apiKey === IMAGE_API_KEY,
      });
    } else if (url.pathname === '/api/config/check'
      || /^\/api\/tasks\/[^/]+\/(?:chat|execute|resume|review|confirm-and-execute)$/u.test(url.pathname)
      || /^\/api\/assets\/[^/]+\/clean$/u.test(url.pathname)) {
      modelWorkRequests.push(url.pathname);
    }
  });

  await page.goto(workbenchUrl, { waitUntil: 'domcontentloaded' });
  if (!options.resume) {
    await page.locator('.onboarding-page').waitFor({ state: 'visible', timeout: 30_000 });
    const initialPublic = await readPageJson(page, '/api/config');
    assert.equal(initialPublic.config.base.model, '', 'The initial test data directory must have no configured base model.');
    assert.equal(initialPublic.config.base.apiKeyConfigured, false);
    assert.equal(initialPublic.config.image.model, '', 'The initial test data directory must have no configured image model.');
    assert.equal(initialPublic.config.image.apiKeyConfigured, false);
    const initialBootstrap = await readPageJson(page, '/api/bootstrap');
    assert.equal(initialBootstrap.tasks.length, 0,
      'The first-run test requires a clean, isolated package data directory.');

    const fixtureUrls = {
      base: fixture.baseUrl,
      image: fixture.imageUrl,
    };
    if (packageManifest) {
      const initialCompany = await readPageJson(page, '/api/company/config');
      assert.equal(initialCompany.config.deploymentConfigured, true);
      assert.equal(initialCompany.config.teedy.baseUrl, packageManifest.baseUrl);
      assert.equal(initialCompany.config.teedy.username, '');
      assert.equal(initialCompany.config.teedy.passwordConfigured, false);
    }

    await page.getByRole('button', { name: /继续/u }).click();
    if (packageManifest) {
      await page.locator('.onboarding-company-access').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.onboarding-company-access dd').innerText(), packageManifest.baseUrl);
      await page.getByLabel('个人 Teedy 账号').fill(TEEDY_USERNAME);
      await page.getByLabel('个人 Teedy 密码').fill(TEEDY_PASSWORD);
      const companySave = responseFor(page, '/api/company/config');
      await page.getByRole('button', { name: '保存个人账号', exact: true }).click();
      const companyResponse = await companySave;
      assert.equal(companyResponse.status(), 200, 'The Company UI should save synthetic credentials locally.');
      await page.getByRole('button', { name: '个人账号已保存', exact: true }).waitFor();
      assert.equal(companyWrites.length, 1);
      assert.equal(companyWrites[0].usernameMatchesSynthetic, true);
      assert.equal(companyWrites[0].passwordMatchesSynthetic, true);
      assert.equal(companyWrites[0].containsServiceUrl, false,
        'Saving personal credentials must not send a Teedy service URL or perform a login.');
    }

    await page.getByLabel('兼容 OpenAI API 的服务地址').fill(fixtureUrls.base);
    await page.getByLabel('基础模型 API 密钥').fill(BASE_API_KEY);
    await page.getByLabel('图片模型与对话模型共用服务地址和 API 密钥').uncheck();
    await page.getByLabel('图片服务地址').fill(fixtureUrls.image);
    await page.getByLabel('图片模型 API 密钥').fill(IMAGE_API_KEY);
    await page.getByRole('button', { name: '选择模型', exact: true }).click();

    const baseCard = page.locator('.onboarding-model-card').nth(0);
    const baseList = responseFor(page, '/api/config/models', 'POST', request => {
      const body = safePostJson(request);
      return body?.kind === 'base';
    });
    await baseCard.getByRole('button', { name: '获取模型列表', exact: true }).click();
    const baseResponse = await baseList;
    assert.equal(baseResponse.status(), 200, 'The custom base model list should come from the localhost fixture.');
    await baseCard.getByText(/已读取 1 个模型/u).waitFor();
    await baseCard.getByLabel('模型 ID').fill(BASE_MODEL);

    const imageCard = page.locator('.onboarding-model-card').nth(1);
    const imageList = responseFor(page, '/api/config/models', 'POST', request => {
      const body = safePostJson(request);
      return body?.kind === 'image';
    });
    await imageCard.getByRole('button', { name: '获取模型列表', exact: true }).click();
    const imageResponse = await imageList;
    assert.equal(imageResponse.status(), 200, 'The image model list should come from the separate localhost fixture endpoint.');
    await imageCard.getByText(/已读取 1 个模型/u).waitFor();
    await imageCard.getByLabel('图片模型 ID').fill(IMAGE_MODEL);

    const customSave = responseFor(page, '/api/config');
    await page.getByRole('button', { name: /保存并检查/u }).click();
    const customResponse = await customSave;
    assert.equal(customResponse.status(), 200, 'The first configuration must be saved through the onboarding UI.');
    await page.getByRole('heading', { name: '分级检查', exact: true }).waitFor();

    const customPublic = await readPageJson(page, '/api/config');
    assert.equal(customPublic.config.base.source, 'custom');
    assert.equal(customPublic.config.base.baseUrl, fixtureUrls.base);
    assert.equal(customPublic.config.base.model, BASE_MODEL);
    assert.equal(customPublic.config.base.apiKeyConfigured, true);
    assert.equal(customPublic.config.image.baseUrl, fixtureUrls.image);
    assert.equal(customPublic.config.image.model, IMAGE_MODEL);
    assert.equal(customPublic.config.image.apiKeyConfigured, true);
    assert.notEqual(customPublic.config.base.baseUrl, customPublic.config.image.baseUrl,
      'The base and image API endpoints must stay separate.');
    assert.equal(JSON.stringify(customPublic).includes(BASE_API_KEY), false);
    assert.equal(JSON.stringify(customPublic).includes(IMAGE_API_KEY), false);
    assert.equal(configWrites.length, 1);
    assert.equal(configWrites[0].baseKeyMatchesFixture, true);
    assert.equal(configWrites[0].imageKeyMatchesFixture, true);
    assert.equal(configWrites[0].imageUsesBaseCredentials, false);
    assert.equal(configWrites[0].baseUrl, fixtureUrls.base);
    assert.equal(configWrites[0].imageUrl, fixtureUrls.image);
    assert.deepEqual(modelListWrites.map(entry => ({
      kind: entry.kind,
      baseUrl: entry.baseUrl,
      baseKeyMatchesFixture: entry.baseKeyMatchesFixture,
      imageKeyMatchesFixture: entry.imageKeyMatchesFixture,
    })), [
      { kind: 'base', baseUrl: fixtureUrls.base, baseKeyMatchesFixture: true, imageKeyMatchesFixture: false },
      { kind: 'image', baseUrl: fixtureUrls.image, baseKeyMatchesFixture: false, imageKeyMatchesFixture: true },
    ]);
    assert.deepEqual(fixture.requests.map(entry => ({ kind: entry.kind, keyMatches: entry.keyMatches })), [
      { kind: 'base', keyMatches: true },
      { kind: 'image', keyMatches: true },
    ]);
    assert.deepEqual(fixture.unexpectedRequests, []);

    await page.getByRole('button', { name: '先跳过', exact: true }).click();
    await waitForWorkbench(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForWorkbench(page);

    if (packageManifest) await verifyCompanyCredentials(page, packageManifest);
    await verifyModelSettings(page, {
      baseSource: 'custom',
      baseModel: BASE_MODEL,
      baseUrl: fixtureUrls.base,
      imageUrl: fixtureUrls.image,
      imageModel: IMAGE_MODEL,
    });
    await page.screenshot({ path: path.join(options.evidenceDir, 'windows-first-config-custom-settings.png'), fullPage: true });

    const baseProvider = page.locator('.provider-card').nth(0);
    await baseProvider.getByLabel('明确清除已保存密钥').check();
    await baseProvider.getByLabel('基础模型来源').selectOption('kilo');
    assert.equal(await baseProvider.getByLabel('API 密钥').count(), 0,
      'Kilo must not require a personal base API key in the real packaged UI.');
    await baseProvider.getByLabel('模型名称').fill(KILO_MODEL);
    const imageProvider = page.locator('.provider-card').nth(1);
    assert.equal(await imageProvider.getByLabel('服务地址').inputValue(), fixtureUrls.image,
      'Selecting Kilo must keep the independent image service address.');
    const kiloSave = responseFor(page, '/api/config');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    const kiloResponse = await kiloSave;
    assert.equal(kiloResponse.status(), 200, 'Kilo should save through Settings with no base key.');
    await page.getByText(/配置已保存/u).first().waitFor();
    const kiloPublic = await readPageJson(page, '/api/config');
    assert.equal(kiloPublic.config.base.source, 'kilo');
    assert.equal(kiloPublic.config.base.model, KILO_MODEL);
    assert.equal(kiloPublic.config.base.apiKeyConfigured, false);
    assert.equal(kiloPublic.config.image.baseUrl, fixtureUrls.image);
    assert.equal(kiloPublic.config.image.model, IMAGE_MODEL);
    assert.equal(kiloPublic.config.image.apiKeyConfigured, true);
    assert.equal(configWrites.length, 2);
    assert.equal(configWrites[1].baseSource, 'kilo');
    assert.equal(configWrites[1].baseModel, KILO_MODEL);
    assert.equal(configWrites[1].clearsBaseKey, true,
      'The Kilo regression must prove a saved managed source can persist without a stale custom API key.');
    assert.equal(configWrites[1].imageUrl, fixtureUrls.image);
    assert.equal(configWrites[1].imageKeyMatchesFixture, false,
      'Settings must preserve the saved image key without resending it in the Kilo base save.');
    assert.equal(configWrites[1].imageUsesBaseCredentials, false);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForWorkbench(page);
    const finalPublic = await readPageJson(page, '/api/config');
    assert.equal(finalPublic.config.base.source, 'kilo');
    assert.equal(finalPublic.config.base.model, KILO_MODEL);
    assert.equal(finalPublic.config.base.apiKeyConfigured, false);
    assert.equal(finalPublic.config.image.baseUrl, fixtureUrls.image);
    assert.equal(finalPublic.config.image.apiKeyConfigured, true);
    await verifyModelSettings(page, {
      baseSource: 'kilo',
      baseModel: KILO_MODEL,
      imageUrl: fixtureUrls.image,
      imageModel: IMAGE_MODEL,
    });

    const companyResult = packageManifest
      ? await verifyCompanyCredentials(page, packageManifest)
      : { configured: false, saved: false };
    const taskId = await createCanvasTestTask(page);
    await page.evaluate((id) => window.localStorage.setItem('studio.activeTask', id), taskId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForWorkbench(page);
    const opened = await openLocalCanvas({
      browserContext,
      page,
      taskId,
      pageErrors,
    });
    await opened.canvasPage.screenshot({
      path: path.join(options.evidenceDir, 'windows-first-config-local-canvas.png'),
      fullPage: true,
    });
    await opened.canvasPage.close();
    assert.equal(teedyRequests.length, 0, 'The Company first-config flow must never contact Teedy.');
    assert.equal(modelWorkRequests.length, 0, 'Configuration smoke must not submit model, review, cleanup, or generation jobs.');
    assert.deepEqual(pageErrors, [], 'The packaged workbench and Canvas must not emit browser exceptions.');

    const summary = {
      schemaVersion: 1,
      profile: options.profile,
      resumed: false,
      onboarding: {
        initialWizardCompletedThroughUi: true,
        didNotRepeatAfterRefresh: true,
      },
      models: {
        localFixtureUsedForModelLists: true,
        generationCalls: modelWorkRequests.length,
        customBase: {
          savedThroughUi: true,
          baseUrl: fixtureUrls.base,
          model: BASE_MODEL,
          apiKeyConfigured: true,
          separateFromImageChannel: true,
        },
        image: {
          savedThroughUi: true,
          baseUrl: fixtureUrls.image,
          model: IMAGE_MODEL,
          apiKeyConfigured: true,
        },
        finalBase: {
          source: 'kilo',
          model: KILO_MODEL,
          apiKeyConfigured: false,
          savedThroughUiWithoutKey: true,
        },
      },
      company: packageManifest ? {
        syntheticAccountSavedThroughUi: companyResult.saved,
        serviceAddressReadFromPackage: true,
        outboundTeedyRequests: teedyRequests.length,
      } : { applicable: false },
      canvas: {
        taskId,
        createdAsLocalTestFixtureWithoutChat: true,
        openedFromWorkbenchUi: true,
        localRuntime: true,
        sessionBoundToTask: true,
      },
      outboundHttpRequests: externalRequests.length,
      blockedExternalHosts: [...new Set(externalRequests.map(entry => entry.hostname))],
      pageErrors,
    };
    await fs.writeFile(path.join(options.evidenceDir, SUMMARY_FILE), JSON.stringify(summary, null, 2) + '\n');
    console.log('Windows first-run UI smoke passed for profile ' + options.profile + ': custom base/image configuration, key separation, keyless Kilo save, no repeated onboarding, and local Canvas open.');
  } else {
    await waitForWorkbench(page);
    const previousImage = priorEvidence.models?.image;
    assert.equal(typeof previousImage?.baseUrl, 'string');
    const currentPublic = await readPageJson(page, '/api/config');
    assert.equal(currentPublic.config.base.source, 'kilo');
    assert.equal(currentPublic.config.base.model, KILO_MODEL);
    assert.equal(currentPublic.config.base.apiKeyConfigured, false);
    assert.equal(currentPublic.config.image.baseUrl, previousImage.baseUrl);
    assert.equal(currentPublic.config.image.model, IMAGE_MODEL);
    assert.equal(currentPublic.config.image.apiKeyConfigured, true);
    await verifyModelSettings(page, {
      baseSource: 'kilo',
      baseModel: KILO_MODEL,
      imageUrl: previousImage.baseUrl,
      imageModel: IMAGE_MODEL,
    });
    const companyResult = packageManifest
      ? await verifyCompanyCredentials(page, packageManifest)
      : { configured: false, saved: false };
    await page.screenshot({ path: path.join(options.evidenceDir, 'windows-first-config-resume-settings.png'), fullPage: true });
    await resumeCanvasTask(page, priorEvidence.canvas.taskId);
    await page.evaluate((id) => window.localStorage.setItem('studio.activeTask', id), priorEvidence.canvas.taskId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForWorkbench(page);
    const opened = await openLocalCanvas({
      browserContext,
      page,
      taskId: priorEvidence.canvas.taskId,
      pageErrors,
    });
    await opened.canvasPage.screenshot({
      path: path.join(options.evidenceDir, 'windows-first-config-resume-canvas.png'),
      fullPage: true,
    });
    await opened.canvasPage.close();
    assert.equal(teedyRequests.length, 0, 'The resumed Company flow must never contact Teedy.');
    assert.equal(modelWorkRequests.length, 0, 'Resume verification must not submit model, review, cleanup, or generation jobs.');
    assert.deepEqual(pageErrors, [], 'The resumed packaged workbench and Canvas must not emit browser exceptions.');

    const summary = {
      schemaVersion: 1,
      profile: options.profile,
      resumed: true,
      onboarding: {
        didNotRepeatAfterRestart: true,
        didNotSubmitAnyConfiguration: true,
      },
      models: {
        persistedBaseSource: 'kilo',
        persistedBaseModel: KILO_MODEL,
        baseApiKeyConfigured: false,
        persistedImageBaseUrl: previousImage.baseUrl,
        persistedImageModel: IMAGE_MODEL,
        imageApiKeyConfigured: true,
        modelListRequestsDuringResume: modelListWrites.length,
        generationCalls: modelWorkRequests.length,
      },
      company: packageManifest ? {
        syntheticAccountStillConfigured: companyResult.saved,
        outboundTeedyRequests: teedyRequests.length,
      } : { applicable: false },
      canvas: {
        taskId: priorEvidence.canvas.taskId,
        openedFromWorkbenchUi: true,
        localRuntime: true,
        sessionBoundToTask: true,
      },
      outboundHttpRequests: externalRequests.length,
      blockedExternalHosts: [...new Set(externalRequests.map(entry => entry.hostname))],
      pageErrors,
    };
    await fs.writeFile(path.join(options.evidenceDir, 'windows-first-config-resume.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log('Windows restart UI smoke passed for profile ' + options.profile + ': saved configuration and synthetic Company account persisted without onboarding or outbound model calls.');
  }
} finally {
  await browserContext?.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (fixture?.server) await new Promise(resolve => fixture.server.close(resolve));
}
