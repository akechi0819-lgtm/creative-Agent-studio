import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const execute = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-company-service-'));
const launcher = path.resolve('scripts/launcher.mjs');
const env = { ...process.env, STUDIO_DATA_DIR: root };
const output = path.resolve('docs/evidence/company-service');
await fs.mkdir(output, { recursive: true });
async function command(...args) {
  const { stdout } = await execute(process.execPath, [launcher, ...args], { env, timeout: 600_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}
let browser;
try {
  const first = await command('start', '--port', '0', '--no-open');
  assert.equal(first.running, true);
  const repeated = await command('start', '--port', '0', '--no-open');
  assert.equal(repeated.reused, true); assert.equal(repeated.url, first.url);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(first.url);
  await page.getByRole('button', { name: '公司连接', exact: true }).click();
  await page.getByRole('heading', { name: '公司连接', exact: true }).waitFor();
  const configuration = await page.evaluate(() => fetch('/api/company/config').then(response => response.json()));
  assert.equal(configuration.config.teedy.passwordConfigured, false);
  assert.deepEqual(configuration.config.canvas, { webUrl: '' });
  const entries = await fs.readdir(root);
  assert.ok(!entries.includes('canvas-instance.json'));
  assert.deepEqual(errors, []);
  await command('stop');
  assert.equal((await command('status')).running, false);
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({ isolated: true, duplicateLaunchReused: true, actualCompanyWeb: true, noLocalCanvasStarted: true, stopped: true, pageErrors: errors }, null, 2));
  console.log('公司版正式启动入口、重复启动复用、真实浏览器与正常停机通过；未连接公司现网或付费模型。');
} finally {
  await browser?.close();
  await command('stop').catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
