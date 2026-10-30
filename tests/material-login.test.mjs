import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import {
  beginMaterialLogin,
  getSetupStatus,
  recordMaterialCheck,
  reportHostProbe,
  saveAndVerifyMaterials,
} from '../src/lite/setup.mjs';
import { readMaterialConfig, saveMaterialConfig } from '../src/materials/config.mjs';
import { startMaterialLogin } from '../src/lite/material-login.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const proofHash = 'a'.repeat(64);
const successResult = {
  authenticated: true,
  queryVerified: true,
  downloadVerified: true,
  bytes: 321,
  sha256: proofHash,
  failedStage: null,
  failureCode: null,
};

async function withRoot(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-lite-material-login-'));
  const defaultsFile = path.join(root, 'defaults.json');
  await fs.writeFile(defaultsFile, JSON.stringify({ materials: { baseUrl: 'https://teedy.example' } }));
  try { await run({ root, defaultsFile }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function status(root, defaultsFile) {
  return getSetupStatus({ root, repoRoot, nodeVersion: 'v24.1.0', env: { COMPANY_LITE_DEFAULTS_FILE: defaultsFile } });
}

test('native browser form submission passes the local Origin and completes the one-time login', async () => {
  const browser = await chromium.launch({ headless: true });
  const username = 'fixture-user@example.invalid';
  const password = 'fixture-browser-password-do-not-render';
  const verificationResult = { authenticated: true, queryVerified: true, downloadVerified: true };
  const credentialsReceived = [];
  let session;
  try {
    session = await startMaterialLogin({
      baseUrl: 'https://teedy.example',
      onCredentials: async (credentials) => {
        credentialsReceived.push(credentials);
        return verificationResult;
      },
    });

    const page = await browser.newPage();
    let submittedHeaders;
    page.on('request', (request) => {
      if (request.method() === 'POST') submittedHeaders = request.headers();
    });
    const pageResponse = await page.goto(session.url);
    assert.equal(pageResponse.status(), 200);
    assert.equal(pageResponse.headers()['referrer-policy'], 'strict-origin');
    assert.doesNotMatch(await page.locator('body').textContent(), /fixture-browser-password|fixture-user@example/);

    await page.locator('#username').fill(username);
    await page.locator('#password').fill(password);
    const [postResponse] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === 'POST'),
      page.getByRole('button', { name: '登录并验证素材访问' }).click(),
    ]);
    const localOrigin = new URL(session.url).origin;
    assert.equal(postResponse.status(), 200);
    assert.equal(submittedHeaders.origin, localOrigin);
    assert.equal(submittedHeaders.referer, `${localOrigin}/`, 'the one-time token path must not appear in Referer');
    assert.match(await page.locator('h1').textContent(), /素材库验证完成/);
    assert.deepEqual(credentialsReceived, [{ baseUrl: 'https://teedy.example', username, password }]);
    assert.deepEqual(await session.completed, verificationResult);
    await assert.rejects(fetch(session.url));
  } finally {
    session?.close();
    await browser.close();
  }
});

async function browserGetAndPost(session, username, password) {
  const opened = await fetch(session.url);
  assert.equal(opened.status, 200);
  const firstPage = await opened.text();
  assert.match(firstPage, /name="username"/);
  assert.match(firstPage, /name="password"/);
  assert.match(firstPage, /autocomplete="current-password"/);
  return { firstPage, post: (origin, fields = { username, password }) => fetch(session.url, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields),
  }) };
}

test('one-time local login server accepts browser-form posts, saves a private revision, and records no form secrets', async () => {
  await withRoot(async ({ root, defaultsFile }) => {
    const username = 'fixture-user@example.invalid';
    const password = 'fixture-browser-password-do-not-render';
    let seenCredentials;
    const session = await startMaterialLogin({
      baseUrl: 'https://teedy.example',
      onCredentials: (input) => saveAndVerifyMaterials(input, {
        root,
        verifyImpl: async (candidate) => {
          seenCredentials = { username: candidate.username, password: candidate.password };
          return successResult;
        },
      }),
    });
    try {
      const { firstPage, post } = await browserGetAndPost(session, username, password);
      assert.doesNotMatch(firstPage, /fixture-browser-password|fixture-user@example/);
      assert.equal(session.url.includes(username), false);
      assert.equal(session.url.includes(password), false);

      const rejectedOrigin = await post('https://attacker.example');
      assert.equal(rejectedOrigin.status, 403);
      assert.equal(seenCredentials, undefined, 'Origin is checked before credentials reach verification');

      const response = await post(new URL(session.url).origin);
      const resultPage = await response.text();
      assert.equal(response.status, 200);
      assert.match(resultPage, /Teedy 登录[\s\S]*已验证/);
      assert.match(resultPage, /素材查询[\s\S]*已验证/);
      assert.match(resultPage, /原件下载[\s\S]*已验证/);
      assert.doesNotMatch(resultPage, /fixture-browser-password|fixture-user@example/);
      await session.completed;

      assert.deepEqual(seenCredentials, { username, password });
      const saved = await readMaterialConfig({ root });
      assert.equal(saved.username, username);
      assert.equal(saved.password, password);
      if (process.platform !== 'win32') {
        assert.equal((await fs.stat(path.join(root, 'config', 'materials.json'))).mode & 0o777, 0o600);
      }
      const checkFile = path.join(root, 'setup', 'material-check.json');
      const checkText = await fs.readFile(checkFile, 'utf8');
      const check = JSON.parse(checkText);
      assert.equal(check.credentialId, saved.credentialId);
      assert.equal(check.authenticated, true);
      assert.equal(check.queryVerified, true);
      assert.equal(check.downloadVerified, true);
      assert.equal(check.bytes, 321);
      assert.equal(check.sha256, proofHash);
      assert.doesNotMatch(checkText, /fixture-browser-password|fixture-user@example/);

      await reportHostProbe({ status: 'connected', queryTool: 'search_documents', downloadTool: 'download_document' }, { root });
      const current = await status(root, defaultsFile);
      assert.equal(current.steps.find((step) => step.id === 'materials').complete, true);
    } finally {
      session.close();
    }
  });
});

test('failed local login post is retryable, never echoes the password, and invalidates prior ready evidence', async () => {
  await withRoot(async ({ root, defaultsFile }) => {
    const previous = await saveMaterialConfig({
      baseUrl: 'https://teedy.example',
      username: 'previous-user',
      password: 'previous-password',
    }, { root });
    await recordMaterialCheck(successResult, { root, credentialId: previous.credentialId });
    await reportHostProbe({ status: 'connected', queryTool: 'search_documents', downloadTool: 'download_document' }, { root });
    assert.equal((await status(root, defaultsFile)).steps.find((step) => step.id === 'materials').complete, true);

    await beginMaterialLogin({ root });
    let verificationCount = 0;
    const session = await startMaterialLogin({
      baseUrl: 'https://teedy.example',
      onCredentials: (input) => saveAndVerifyMaterials(input, {
        root,
        verifyImpl: async (candidate) => {
          verificationCount += 1;
          assert.equal(candidate.password, 'bad-browser-password-do-not-render');
          return {
            authenticated: false,
            queryVerified: false,
            downloadVerified: false,
            bytes: 0,
            sha256: '',
            failedStage: 'login',
            failureCode: 'login_failed',
          };
        },
      }),
    });
    try {
      const username = 'new-user';
      const password = 'bad-browser-password-do-not-render';
      const { firstPage, post } = await browserGetAndPost(session, username, password);
      assert.doesNotMatch(firstPage, /bad-browser-password/);
      const response = await post(new URL(session.url).origin);
      const page = await response.text();
      assert.equal(response.status, 200, 'failed verification leaves the form open for a retry');
      assert.match(page, /身份验证未通过/);
      assert.match(page, /请检查用户名、密码或网络后重试/);
      assert.doesNotMatch(page, /bad-browser-password|new-user/);
      assert.equal(verificationCount, 1);

      const saved = await readMaterialConfig({ root });
      assert.equal(saved.credentialId, previous.credentialId, 'failed credentials never replace saved credentials');
      assert.equal(saved.password, 'previous-password');
      await assert.rejects(fs.stat(path.join(root, 'setup', 'material-check.json')), { code: 'ENOENT' });
      await assert.rejects(fs.stat(path.join(root, 'setup', 'host-report.json')), { code: 'ENOENT' });
      const current = await status(root, defaultsFile);
      const materials = current.steps.find((step) => step.id === 'materials');
      assert.equal(materials.complete, false);
      assert.equal(current.complete, false);
    } finally {
      session.close();
    }
  });
});

test('login-materials starts the local page without terminal input', async () => {
  await withRoot(async ({ root, defaultsFile }) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'setup.mjs'), 'login-materials'], {
      cwd: repoRoot,
      env: { ...process.env, STUDIO_DATA_DIR: root, COMPANY_LITE_DEFAULTS_FILE: defaultsFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    let buffered = '';
    const firstLine = new Promise((resolve, reject) => {
      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        buffered += chunk;
        const newline = buffered.indexOf('\n');
        if (newline >= 0) resolve(buffered.slice(0, newline));
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`login-materials exited before printing its URL (${code}): ${stderr}`)));
    });
    try {
      const startup = JSON.parse(await firstLine);
      assert.equal(startup.status, 'waiting_for_employee_login');
      assert.match(startup.url, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32,100}$/);
      const page = await fetch(startup.url);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /name="username"/);
      assert.match(html, /name="password"/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
      }
    }
    assert.equal(stderr, '');
  });
});
