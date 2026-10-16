import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { listenStudioServer } from '../src/web/server.mjs';
import { saveConfig } from '../src/web/config.mjs';
import { appendConversation } from '../src/web/jobs.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-whale-theme-'));
const evidence = path.resolve('docs/evidence/p3-whale-theme');
await fs.mkdir(evidence, { recursive: true });
const report = { date: new Date().toISOString(), scope: '隔离数据根、实际 Web 服务与浏览器；无模型请求', checks: [], views: [] };
let app, browser, releaseChat;
try {
  await saveConfig({expectedRevision:1,base:{baseUrl:'http://127.0.0.1:9/v1',model:'theme-fixture',apiKey:'isolated-theme-stub'}},{root});
  app = await listenStudioServer({ root, port: 0, agent: {chat:async()=>{await new Promise(resolve=>{releaseChat=resolve;});return {text:'隔离操作状态验证完成。'};}} });
  const url = `http://127.0.0.1:${app.address.port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '从一个想法开始' }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.whale-avatar')].every(image => image.complete && image.naturalWidth === 512));
  const icon = await page.request.get(url + '/brand/favicon.ico');
  assert.equal(icon.status(), 200);
  assert.equal(icon.headers()['content-type'], 'image/x-icon');
  assert.deepEqual([...Buffer.from(await icon.body()).subarray(0, 4)], [0, 0, 1, 0]);
  assert.equal(await page.locator('link[rel=icon]').getAttribute('href'), '/brand/favicon.ico');
  await page.screenshot({ path: path.join(evidence, 'empty-desktop.png') });
  report.checks.push('empty-state-avatar-and-v2-ico-loaded');

  const response = await page.request.post(url + '/api/tasks', { headers: { origin: url }, data: { title: '鲸鱼主题隔离预览', brief: { format: 'carousel', pageCount: 3, content: '面向家长的 KET 学习笔记，三页图文；参考内容结构，不引用品牌信息。' } } });
  assert.equal(response.ok(), true);
  const { task } = await response.json();
  for (let index = 0; index < 20; index++) {
    await appendConversation(task.id, { role: index % 2 ? 'assistant' : 'user', text: index % 2 ? '需求与参考会在右侧等待你确认。' + '本条是长对话布局的隔离测试文本。'.repeat(12) : '希望内容清晰、方便家长收藏。', model: 'theme-fixture' }, root);
  }
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '鲸鱼主题隔离预览', exact: true }).click();
  await page.locator('.message-row.assistant .whale-avatar').first().waitFor();
  const colors = await page.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, primary: getComputedStyle(document.querySelector('.create-button')).backgroundColor, text: getComputedStyle(document.body).color }));
  assert.equal(colors.background, 'rgb(233, 243, 252)');
  assert.equal(colors.primary, 'rgb(59, 98, 246)');
  report.colors = colors;
  const measure = () => page.evaluate(() => {
    const scroll = document.querySelector('.conversation-scroll');
    const right = document.querySelector('.object-panel');
    const composer = document.querySelector('.chat-composer-wrap');
    return { scrollTop: scroll.scrollTop, rightTop: right.getBoundingClientRect().top, rightBottom: right.getBoundingClientRect().bottom, composerBottom: composer.getBoundingClientRect().bottom, documentScrollTop: document.documentElement.scrollTop };
  });
  const before = await measure();
  await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 0; });
  const after = await measure();
  assert.equal(before.rightTop, after.rightTop);
  assert.equal(before.rightBottom, after.rightBottom);
  assert.ok(after.composerBottom <= 1000);
  assert.equal(after.documentScrollTop, 0);
  await page.screenshot({ path: path.join(evidence, 'workbench-desktop.png') });
  report.views.push({ viewport: '1440×1000', state: '长对话、双栏独立滚动', result: 'passed' });
  await page.getByRole('button', { name: '收起导航栏', exact: true }).click();
  await page.getByRole('button', { name: '展开导航栏', exact: true }).click();
  await page.getByRole('button', { name: '收起工作对象面板', exact: true }).click();
  await page.getByRole('button', { name: '展开工作对象面板', exact: true }).click();
  report.checks.push('brand-agent-avatar-colors-independent-scroll-and-panel-toggles');
  for (const name of ['素材库', 'DNA', '模型与服务']) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.screenshot({ path: path.join(evidence, ({ '素材库': 'library', DNA: 'dna', '模型与服务': 'models' })[name] + '-desktop.png') });
  }
  await page.getByRole('button', { name: '创作工作台', exact: true }).click();
  await page.getByLabel('告诉 Agent 想怎么改',{exact:true}).fill('检查角色状态反馈。');
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await page.locator('.job-activity .whale-character.busy').waitFor();
  await page.waitForFunction(()=>performance.getEntriesByType('resource').some(entry=>entry.name.endsWith('/brand/characters/motion-basic.png')));
  await page.screenshot({path:path.join(evidence,'job-working.png')});
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.job-activity .whale-character').evaluate(element=>getComputedStyle(element).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  releaseChat();
  await page.locator('.job-activity .whale-character.happy').waitFor();
  await page.screenshot({path:path.join(evidence,'job-completed.png')});
  report.checks.push('community-portrait-and-job-sprites-loaded-real-job-status-and-reduced-motion');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(evidence, 'workbench-mobile.png') });
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.screenshot({ path: path.join(evidence, 'navigation-mobile.png') });
  report.views.push({ viewport: '390×844', state: '对话与可展开导航，无横向溢出', result: 'passed' });
  assert.deepEqual(errors, []);
  report.checks.push('management-pages-and-mobile-navigation-no-runtime-errors');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.message; process.exitCode = 1;
} finally {
  releaseChat?.(); await browser?.close(); await app?.close();
  await fs.rm(root, { recursive: true, force: true });
  await fs.writeFile(path.join(evidence, 'verification.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
