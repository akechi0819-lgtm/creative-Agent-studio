import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { importAsset } from '../src/assets/library.mjs';
import { saveConfig } from '../src/web/config.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), 'studio-cleaner-config-'));
}

async function fakeModel({ summary = '本机测试摘要', tags = ['测试标签'] } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      url: request.url,
      headers: request.headers,
      payload: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary, tags }) } }],
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    requests,
    config: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: 'fixture-basic-model',
      apiKey: 'fixture-basic-secret',
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function runCli(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

function cliEnvironment(dataDir) {
  return {
    ...process.env,
    STUDIO_DATA_DIR: dataDir,
    STUDIO_TEXT_BASE_URL: 'http://127.0.0.1:1/v1',
    STUDIO_TEXT_MODEL: 'legacy-environment-model',
    STUDIO_TEXT_API_KEY: 'legacy-environment-test-key',
  };
}

async function configureBasic(root, basic) {
  await saveConfig({
    expectedRevision: 1,
    base: basic,
    image: {
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'fixture-image-model',
      apiKey: 'fixture-image-secret',
    },
  }, { root });
}

test('clean-materials CLI reads basic config from the shared model settings', async (t) => {
  const dir = await temporaryDirectory();
  const dataDir = path.join(dir, 'app-data');
  const inputPath = path.join(dir, 'input.json');
  const server = await fakeModel({ summary: 'fixture-basic-secret' });
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  await configureBasic(dataDir, server.config);
  await writeFile(inputPath, JSON.stringify({ title: '本机输入', body: '隔离测试', files: [] }));

  const script = path.join(projectRoot, 'scripts', 'clean-materials.mjs');
  const result = await runCli(script, [`@${inputPath}`], cliEnvironment(dataDir));

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].headers.authorization, `Bearer ${server.config.apiKey}`);
  assert.equal(server.requests[0].payload.model, server.config.model);
  assert.doesNotMatch(result.stdout, /fixture-basic-secret/u);
  assert.match(result.stdout, /\[已隐藏凭据\]/u);
});

test('assets CLI clean reads the same basic config and ignores payload credentials', async (t) => {
  const root = await temporaryDirectory();
  const sourcePath = path.join(root, 'source.md');
  const payloadPath = path.join(root, 'clean.json');
  const server = await fakeModel();
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  await configureBasic(root, server.config);
  await writeFile(sourcePath, '隔离的原始素材');
  const asset = await importAsset({
    title: '隔离素材',
    body: '',
    source: { kind: 'user-provided', note: 'CLI 配置隔离测试' },
    files: [{ path: sourcePath, name: 'source.md', mimeType: 'text/markdown' }],
  }, { root });
  await writeFile(payloadPath, JSON.stringify({
    expectedRevision: asset.revision,
    config: {
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'payload-model',
      apiKey: 'payload-test-secret',
    },
  }));

  const script = path.join(projectRoot, 'scripts', 'assets.mjs');
  const result = await runCli(script, ['clean', asset.id, `@${payloadPath}`], cliEnvironment(root));

  assert.equal(result.code, 0, result.stderr);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].headers.authorization, `Bearer ${server.config.apiKey}`);
  assert.equal(server.requests[0].payload.model, server.config.model);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-basic-secret|payload-test-secret/u);
  assert.equal(JSON.parse(result.stdout).status, 'needs_review');
});
