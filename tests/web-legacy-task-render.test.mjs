import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createTask } from '../src/creative/tasks.mjs';
import { listenStudioServer } from '../src/web/server.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..');

test('Workbench renders an isolated legacy task with no video state', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-studio-legacy-task-'));
  const dataRoot = path.join(temporaryRoot, 'profile');
  const staticDir = path.join(temporaryRoot, 'web');
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(staticDir, 'assets'), { recursive: true });
  await fs.copyFile(path.join(repositoryRoot, 'web/index.html'), path.join(staticDir, 'index.html'));
  await fs.cp(path.join(repositoryRoot, 'web/public'), staticDir, { recursive: true });
  await build({
    entryPoints: [path.join(repositoryRoot, 'web/src/main.jsx')],
    outfile: path.join(staticDir, 'assets/app.js'),
    bundle: true,
    external: ['/brand/*'],
    jsx: 'automatic',
    loader: { '.png': 'file', '.svg': 'file' },
    logLevel: 'silent',
  });

  const title = '无视频字段的旧版任务';
  const task = await createTask({ title, brief: '仅用于隔离验证旧任务工作台渲染。' }, dataRoot);
  assert.equal(task.video, undefined, 'fixture must retain the legacy task shape');

  const server = await listenStudioServer({ root: dataRoot, staticDir, host: '127.0.0.1', port: 0 });
  let browser;
  t.after(async () => {
    await browser?.close();
    await server.close();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(({ taskId }) => {
    window.localStorage.setItem('studio.activeTask', taskId);
    window.localStorage.setItem('studio.onboardingDismissed', '1');
  }, { taskId: task.id });
  await page.goto(`http://127.0.0.1:${server.address.port}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  await page.getByRole('region', { name: '创作对话' }).waitFor();
  await page.getByRole('region', { name: '当前任务预览' }).waitFor();
  assert.deepEqual(pageErrors, [], 'legacy task should not crash Workbench rendering');
  assert.equal(await page.getByRole('region', { name: '独立视频预览' }).count(), 0);
});
