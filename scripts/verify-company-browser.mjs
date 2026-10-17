import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { listenStudioServer } from '../src/web/server.mjs';
import { createTask } from '../src/creative/tasks.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-company-browser-'));
const output = path.resolve('docs/evidence/company-browser');
await fs.mkdir(output, { recursive: true });
const previousServicesFile = process.env.STUDIO_COMPANY_SERVICES_FILE;
const servicesFile = path.join(root, 'fixture-company-services.json');
await fs.writeFile(servicesFile, JSON.stringify({
  schemaVersion: 1,
  teedy: { baseUrl: 'https://library.fixture.test' },
}));
process.env.STUDIO_COMPANY_SERVICES_FILE = servicesFile;

const image = await fs.readFile(new URL('../tests/fixtures/image-regions/poster-mixed.png', import.meta.url));
let downloads = 0;
let previews = 0;
const file = { fileId: 'fixture-file', id: 'fixture-file', name: '公司参考.png', mimeType: 'image/png' };
const candidate = { documentId: 'fixture-document', title: '公司图文参考样例', summary: '合成检索结果，只供隔离测试。', tags: ['图文'], files: [file], previews: [file] };
const materials = {
  search: async () => ({ items: [candidate], total: 1 }),
  get: async () => ({ ...candidate, body: '经人工保留的参考正文' }),
  download: async () => { downloads++; return { bytes: image, mimeType: 'image/png', name: file.name }; },
  preview: async () => { previews++; return { bytes: image, mimeType: 'image/png' }; },
};
const task = await createTask({ title: '公司浏览器隔离测试', brief: '制作一张使用公司参考的海报' }, root);
const server = await listenStudioServer({ root, port: 0, companyMaterials: materials });
const url = `http://127.0.0.1:${server.address.port}`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', cause => errors.push(cause.message));
  await page.addInitScript(id => localStorage.setItem('studio.activeTask', id), task.id);
  await page.goto(url);

  // First-run onboarding saves only each employee's Teedy credentials and
  // personal model channels. The company service origins come from the fixture.
  await page.getByRole('button', { name: /继续/ }).click();
  await page.getByText('公司服务地址（管理员预配置）').waitFor();
  assert.equal(await page.locator('.onboarding-company-access').getByText('https://library.fixture.test').count(), 1);
  await page.getByLabel('个人 Teedy 账号').fill('fixture-reader');
  await page.getByLabel('个人 Teedy 密码').fill('fixture-password-private');
  await page.getByRole('button', { name: '保存个人账号' }).click();
  await page.getByRole('button', { name: '个人账号已保存' }).waitFor();

  await page.getByLabel('兼容 OpenAI API 的服务地址').fill('https://models.fixture.test/v1');
  await page.getByLabel('基础模型 API 密钥').fill('fixture-base-key-private');
  await page.getByLabel('图片模型与对话模型共用服务地址和 API 密钥').uncheck();
  await page.getByLabel('图片服务地址').fill('https://images.fixture.test/v1');
  await page.getByLabel('图片模型 API 密钥').fill('fixture-image-key-private');
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await page.locator('.onboarding-model-card').nth(0).getByLabel('模型 ID').fill('fixture-base-model');
  await page.locator('.onboarding-model-card').nth(1).getByLabel('图片模型 ID').fill('fixture-image-model');
  await page.getByRole('button', { name: /保存并检查/ }).click();
  await page.getByRole('heading', { name: '分级检查' }).waitFor();
  const storedModelConfig = await page.evaluate(() => fetch('/api/config').then(response => response.json()));
  assert.equal(storedModelConfig.config.base.apiKeyConfigured, true);
  assert.equal(storedModelConfig.config.image.apiKeyConfigured, true);
  assert.equal(JSON.stringify(storedModelConfig).includes('fixture-base-key-private'), false);
  assert.equal(JSON.stringify(storedModelConfig).includes('fixture-image-key-private'), false);
  await page.getByRole('button', { name: '先跳过' }).click();

  await page.getByRole('button', { name: '公司连接', exact: true }).click();
  await page.getByRole('heading', { name: '公司连接', exact: true }).waitFor();
  assert.equal(await page.locator('.readonly-service-address').count(), 1);
  assert.equal(await page.getByLabel('Teedy HTTPS 地址').count(), 0, 'employee settings must not expose a service URL editor');
  assert.equal(await page.locator('body').innerText().then(text => text.includes('fixture-password-private')), false);
  const publicCompanyConfig = await page.evaluate(() => fetch('/api/company/config').then(response => response.json()));
  assert.equal(publicCompanyConfig.config.deploymentConfigured, true);
  assert.equal(publicCompanyConfig.config.teedy.baseUrl, 'https://library.fixture.test');
  assert.equal(Object.hasOwn(publicCompanyConfig.config, 'canvas'), false);
  assert.equal(JSON.stringify(publicCompanyConfig).includes('fixture-password-private'), false);
  await page.screenshot({ path: path.join(output, 'company-settings.png'), fullPage: true });

  await page.getByRole('button', { name: '模型与服务', exact: true }).click();
  await page.getByRole('heading', { name: '图片模型', exact: true }).waitFor();
  assert.equal(await page.locator('.provider-grid input[type=password]').count(), 2, 'base and image credentials are separate in model settings');

  await page.getByRole('button', { name: '公司连接', exact: true }).click();
  const searchDetails = page.locator('details.company-auxiliary').filter({ hasText: '手动检索公司素材' });
  await searchDetails.locator('summary').first().click();
  await searchDetails.getByLabel('检索公司素材').fill('图文');
  await searchDetails.getByRole('button', { name: '检索公司库' }).click();
  await searchDetails.getByText('公司图文参考样例', { exact: true }).waitFor();
  assert.equal(downloads, 0, 'search results must not download originals');

  await page.getByRole('button', { name: '创作工作台', exact: true }).click();
  const candidateCard = page.locator('.source-preview-card').filter({ hasText: '公司图文参考样例' });
  await candidateCard.waitFor();
  await candidateCard.locator('img').waitFor();
  await page.waitForFunction(() => {
    const image = document.querySelector('.source-preview-card img');
    return image && image.complete && image.naturalWidth > 0;
  });
  assert.equal(await candidateCard.locator('.source-preview-number').innerText(), '1');
  assert.equal(await candidateCard.locator('.source-preview-status').innerText(), '待选择');
  assert.equal(await candidateCard.getByText('公司素材 · fixture-document').count(), 1);
  assert.equal(await candidateCard.getByText('参考结构、表达或视觉方向，由用户决定是否保留').count(), 1);
  assert.equal(await candidateCard.locator('button').count(), 0, 'the P5 right-side reference card is read-only');
  assert.equal(await candidateCard.locator('a').count(), 1);
  assert.match(await candidateCard.locator('a').getAttribute('href'), /^\/api\/company\/preview\//);
  assert.equal(downloads, 0, 'read-only previews must not download originals');
  assert.ok(previews > 0, 'candidate preview should be served through the local ACL-checked route');
  await page.screenshot({ path: path.join(output, 'company-reference.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'company-mobile.png'), fullPage: true });

  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({
    fixtureOnly: true,
    personalTeedyCredentials: true,
    fixedServiceAddressesReadOnly: true,
    personalBaseAndImageApiCredentials: true,
    credentialRedaction: true,
    candidatePreviewViaLocalProxy: true,
    searchDoesNotDownloadOriginals: downloads === 0,
    pageErrors: errors,
  }, null, 2));
  console.log('公司版浏览器隔离回归通过：首次引导、固定服务地址、个人 Teedy 与双模型配置、脱敏、候选只读预览及窄屏渲染。未连接真实公司服务或付费模型。');
} finally {
  await browser.close();
  await server.close();
  await fs.rm(root, { recursive: true, force: true });
  if (previousServicesFile === undefined) delete process.env.STUDIO_COMPANY_SERVICES_FILE;
  else process.env.STUDIO_COMPANY_SERVICES_FILE = previousServicesFile;
}
