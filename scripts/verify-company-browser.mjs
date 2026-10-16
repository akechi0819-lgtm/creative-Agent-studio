import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { listenStudioServer } from '../src/web/server.mjs';
import { createTask, readTask } from '../src/creative/tasks.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-company-browser-'));
const output = path.resolve('docs/evidence/company-browser');
await fs.mkdir(output, { recursive: true });
const image = await fs.readFile(new URL('../tests/fixtures/image-regions/poster-mixed.png', import.meta.url));
let downloads = 0;
const file = { fileId: 'fixture-file', id: 'fixture-file', name: '公司参考.png', mimeType: 'image/png' };
const candidate = { documentId: 'fixture-document', title: '公司图文参考样例', summary: '合成检索结果，只供隔离测试。', tags: ['图文'], files: [file], previews: [file] };
const materials = {
  search: async () => ({ items: [candidate], total: 1 }),
  get: async () => ({ ...candidate, body: '经人工保留的参考正文' }),
  download: async () => { downloads++; return { bytes: image, mimeType: 'image/png', name: file.name }; },
  preview: async () => ({ bytes: image, mimeType: 'image/png' }),
};
const task = await createTask({ title: '公司浏览器隔离测试', brief: '制作一张使用公司参考的海报' }, root);
const server = await listenStudioServer({ root, port: 0, companyMaterials: materials, canvas: {
  state: async () => ({ clientConnected: false }),
  diagnose: async () => ({ ok: false, message: '旧桥接缺少明确目标及原图工具；未发送写操作。' }),
} });
const url = `http://127.0.0.1:${server.address.port}`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', cause => errors.push(cause.message));
  await page.addInitScript(id => localStorage.setItem('studio.activeTask', id), task.id);
  await page.goto(url);
  await page.getByRole('button', { name: '公司连接', exact: true }).click();
  await page.getByRole('heading', { name: '公司连接', exact: true }).waitFor();
  await page.getByLabel('Teedy HTTPS 地址').fill('https://materials.example.invalid');
  await page.getByLabel('个人账号', { exact: true }).fill('fixture-reader');
  await page.getByLabel('密码', { exact: true }).fill('fixture-password-private');
  await page.getByRole('button', { name: '保存公司连接', exact: true }).click();
  await page.getByText('公司连接已保存。账号与连接密钥保存在当前电脑的公司版私有目录。').waitFor();
  assert.equal(await page.getByLabel('密码', { exact: true }).inputValue(), '');
  const config = await page.evaluate(() => fetch('/api/company/config').then(response => response.json()));
  assert.ok(!JSON.stringify(config).includes('fixture-password-private'));
  await page.getByRole('button', { name: '检查画布连接' }).click();
  await page.getByText('旧桥接缺少明确目标及原图工具；未发送写操作。').waitFor();
  await page.screenshot({ path: path.join(output, 'company-settings.png'), fullPage: true });
  await page.getByRole('button', { name: '创作工作台', exact: true }).click();
  const search = page.locator('.reference-panel .company-search');
  await search.getByLabel('检索公司素材', { exact: true }).fill('图文');
  await search.getByRole('button', { name: '检索公司库', exact: true }).click();
  await page.locator('.reference-list .reference-item').getByText('公司图文参考样例', { exact: true }).waitFor();
  assert.equal(downloads, 0);
  await page.locator('.reference-list .reference-item').getByRole('button', { name: '保留', exact: true }).click();
  await page.locator('.reference-list .decision-pill.retained').waitFor();
  assert.equal(downloads, 1);
  const current = await readTask(task.id, root);
  assert.equal(current.sources[0].files.length, 1);
  assert.equal(current.sources[0].decision, 'retained');
  await page.screenshot({ path: path.join(output, 'company-reference.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'company-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({ fixtureOnly: true, configRedaction: true, candidateNoOriginalDownload: true, retainedSnapshot: true, canvasDiagnosticOnly: true, pageErrors: errors }, null, 2));
  console.log('公司版真实浏览器隔离回归通过：配置脱敏、候选预览、人工保留原件快照、不支持协议的诊断、窄屏渲染。未连接真实公司服务或付费模型。');
} finally {
  await browser.close(); await server.close(); await fs.rm(root, { recursive: true, force: true });
}
