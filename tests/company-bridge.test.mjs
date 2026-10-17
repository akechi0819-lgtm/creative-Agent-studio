import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { saveConfig } from '../src/web/config.mjs';
import {
  companyBridgeStatus,
  ensureDetachedCompanyBridge,
  readCompanyCanvasBridgeConfig,
  startCompanyBridge,
  stopCompanyBridge,
} from '../src/company/bridge.mjs';

const WEB_URL = 'https://company-canvas.fixture.invalid';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function temporaryDirectory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-company-bridge-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function runNode(source, env, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8').trim();
      if (timedOut) return reject(new Error('fixture parent process timed out'));
      if (code !== 0) return reject(new Error(`fixture parent process failed (${signal || code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 1000)}`));
      resolve(output);
    });
  });
}

function bridgePaths(root, taskId) {
  const directory = path.join(root, 'canvas', taskId);
  return {
    directory,
    config: path.join(directory, 'company-canvas-bridge.json'),
    lock: path.join(directory, 'company-canvas-bridge.lock'),
    descriptor: path.join(directory, 'company-canvas-bridge-instance.json'),
  };
}

async function descriptor(root, taskId) {
  return JSON.parse(await fs.readFile(bridgePaths(root, taskId).descriptor, 'utf8'));
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

test('detached bridge outlives its launcher process, reuses the task instance, and stops through authenticated HTTP', async (t) => {
  const root = await temporaryDirectory(t);
  const taskId = crypto.randomUUID();
  const moduleUrl = pathToFileURL(path.join(REPO_ROOT, 'src/company/bridge.mjs')).href;
  const parentScript = `
    import { ensureDetachedCompanyBridge } from ${JSON.stringify(moduleUrl)};
    const handle = await ensureDetachedCompanyBridge({
      root: process.env.STUDIO_DATA_DIR,
      taskId: ${JSON.stringify(taskId)},
      webUrl: ${JSON.stringify(WEB_URL)},
    });
    process.stdout.write(JSON.stringify({ state: handle.state, reused: handle.reused, tokenConfigured: handle.tokenConfigured }));
  `;
  const launched = JSON.parse(await runNode(parentScript, { STUDIO_DATA_DIR: root }));
  assert.deepEqual(launched, { state: 'healthy', reused: false, tokenConfigured: true });

  const first = await descriptor(root, taskId);
  assert.notEqual(first.pid, process.pid, 'the detached service has its own process');
  assert.equal((await companyBridgeStatus({ root, taskId })).state, 'healthy');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await companyBridgeStatus({ root, taskId })).state, 'healthy', 'the bridge remains healthy after its short-lived launcher exits');

  const reused = await ensureDetachedCompanyBridge({ root, taskId, webUrl: WEB_URL });
  assert.equal(reused.state, 'healthy');
  assert.equal(reused.reused, true);
  assert.equal((await descriptor(root, taskId)).pid, first.pid, 'reuse does not spawn a second bridge process');

  const config = await readCompanyCanvasBridgeConfig({ root, taskId });
  const endpoint = `${config.bridgeUrl}/__company/stop`;
  const rejectedToken = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-canvas-agent-token': '0'.repeat(64) },
    body: JSON.stringify({ instanceId: first.instanceId }),
  });
  assert.equal(rejectedToken.status, 403);
  const rejectedInstance = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-canvas-agent-token': config.token },
    body: JSON.stringify({ instanceId: 'another-instance' }),
  });
  assert.equal(rejectedInstance.status, 409);
  assert.equal((await companyBridgeStatus({ root, taskId })).state, 'healthy', 'rejected stop attempts leave the bridge running');

  const stopped = await stopCompanyBridge({ root, taskId });
  assert.deepEqual(stopped, { state: 'stopped', stopped: true, owned: true, taskId, projectId: taskId });
  assert.equal((await companyBridgeStatus({ root, taskId })).state, 'dead');
  await assert.rejects(fs.lstat(bridgePaths(root, taskId).descriptor), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(bridgePaths(root, taskId).lock), { code: 'ENOENT' });
  const exitDeadline = Date.now() + 3000;
  while (processAlive(first.pid) && Date.now() < exitDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(processAlive(first.pid), false, 'the detached CLI exits after the authenticated stop endpoint closes its bridge');
});

test('a live but unverifiable task bridge is reported as unverified and is never reported stopped', async (t) => {
  const root = await temporaryDirectory(t);
  const taskId = crypto.randomUUID();
  const paths = bridgePaths(root, taskId);
  await fs.mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const instanceId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  await fs.writeFile(paths.config, `${JSON.stringify({
    schemaVersion: 1,
    taskId,
    projectId: taskId,
    webUrl: WEB_URL,
    bridgeUrl: 'http://127.0.0.1:1',
    token,
    clientId: '',
  })}\n`, { mode: 0o600 });
  const owner = { pid: process.pid, instanceId, taskId };
  await fs.writeFile(paths.lock, JSON.stringify(owner), { mode: 0o600 });
  await fs.writeFile(paths.descriptor, JSON.stringify({
    ...owner,
    port: 1,
    dataDir: path.join(paths.directory, 'company-canvas-agent-data'),
  }), { mode: 0o600 });

  const status = await companyBridgeStatus({ root, taskId });
  assert.equal(status.state, 'unverified');
  assert.equal(status.running, true, 'the recorded live owner is not represented as stopped');
  assert.equal(status.owned, false);
  assert.equal(Object.hasOwn(status, 'token'), false);
  const stopped = await stopCompanyBridge({ root, taskId });
  assert.equal(stopped.state, 'unverified');
  assert.equal(stopped.stopped, false);
  assert.equal(process.kill(process.pid, 0), true, 'the stop path does not signal or kill the owner PID');
  assert.equal(JSON.parse(await fs.readFile(paths.lock, 'utf8')).pid, process.pid);
  assert.equal(JSON.parse(await fs.readFile(paths.descriptor, 'utf8')).instanceId, instanceId);
});

test('open-ticket refuses a client already connected to the task bridge', async (t) => {
  const root = await temporaryDirectory(t);
  const taskId = crypto.randomUUID();
  const handle = await startCompanyBridge({ root, taskId, webUrl: WEB_URL });
  const config = await readCompanyCanvasBridgeConfig({ root, taskId });
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await handle.stop();
  });

  const events = new URL('/events', config.bridgeUrl);
  events.searchParams.set('projectId', taskId);
  events.searchParams.set('clientId', 'already-connected-client');
  events.searchParams.set('token', config.token);
  const connected = await fetch(events, { headers: { origin: WEB_URL }, signal: controller.signal });
  assert.equal(connected.status, 200);
  const reader = connected.body.getReader();
  await reader.read();

  const ticket = await fetch(`${config.bridgeUrl}/__company/open-ticket`, {
    method: 'POST',
    headers: { origin: WEB_URL, 'content-type': 'application/json', 'x-canvas-agent-token': config.token },
    body: JSON.stringify({ projectId: taskId, clientId: 'already-connected-client' }),
  });
  assert.equal(ticket.status, 409);
  assert.equal((await ticket.json()).ok, false);
  controller.abort();
  await reader.cancel().catch(() => {});
});

test('company image proxy keeps the key local, checks exact origin and task, and reads saved config dynamically', async (t) => {
  const root = await temporaryDirectory(t);
  const taskId = crypto.randomUUID();
  const providerRequests = [];
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    providerRequests.push({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fixture-image-v1' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${provider.address().port}/generated/fixture.png` }] }));
      return;
    }
    if (req.method === 'GET' && req.url === '/generated/fixture.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from('fixture-png'));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  await saveConfig({
    expectedRevision: 1,
    image: { baseUrl, model: 'fixture-image-v1', apiKey: 'local-image-secret-v1' },
  }, { root });
  const handle = await startCompanyBridge({ root, taskId, webUrl: WEB_URL });
  const config = await readCompanyCanvasBridgeConfig({ root, taskId });
  t.after(async () => {
    await handle.stop();
    await new Promise((resolve) => provider.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });

  const publicConfigUrl = `${config.bridgeUrl}/__company/config/${taskId}`;
  const configResponse = await fetch(publicConfigUrl, {
    headers: { origin: WEB_URL, 'x-canvas-agent-token': config.token },
  });
  const publicConfig = await configResponse.json();
  assert.equal(configResponse.status, 200);
  assert.equal(publicConfig.projectId, taskId);
  assert.equal(publicConfig.imageConfig.model, 'fixture-image-v1');
  assert.equal(publicConfig.imageConfig.configured, true);
  assert.equal(Object.hasOwn(publicConfig.imageConfig, 'apiKey'), false);
  assert.equal(JSON.stringify(publicConfig).includes('local-image-secret-v1'), false);
  assert.equal(providerRequests.length, 0, 'bootstrap/config reads do not contact the model service');

  const ticketResponse = await fetch(`${config.bridgeUrl}/__company/open-ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-canvas-agent-token': config.token },
    body: JSON.stringify({ projectId: taskId }),
  });
  const ticket = await ticketResponse.json();
  assert.equal(ticketResponse.status, 200);
  const rejectedBootstrapOrigin = await fetch(`${config.bridgeUrl}/__company/bootstrap`, {
    method: 'POST',
    headers: { origin: 'https://other.fixture.invalid', 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: ticket.ticket }),
  });
  assert.equal(rejectedBootstrapOrigin.status, 403);
  const bootstrapResponse = await fetch(`${config.bridgeUrl}/__company/bootstrap`, {
    method: 'POST',
    headers: { origin: WEB_URL, 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: ticket.ticket }),
  });
  const bootstrap = await bootstrapResponse.json();
  assert.equal(bootstrapResponse.status, 200);
  assert.equal(bootstrap.projectId, taskId);
  assert.equal(bootstrap.configRevision, publicConfig.configRevision);
  assert.equal(bootstrap.imageConfig.model, 'fixture-image-v1');
  assert.equal(Object.hasOwn(bootstrap.imageConfig, 'apiKey'), false);
  assert.equal(JSON.stringify(bootstrap).includes('local-image-secret-v1'), false);
  assert.equal(JSON.stringify(bootstrap).includes('local-image-secret-v2'), false);
  assert.equal(bootstrapResponse.headers.get('access-control-allow-origin'), WEB_URL);
  assert.equal(providerRequests.length, 0, 'ticket/bootstrap do not call the image provider');

  const proxyUrl = (target, project = taskId) =>
    `${config.bridgeUrl}/__company/image-proxy/${project}/${encodeURIComponent(target)}`;
  const listUrl = `${baseUrl}/models`;
  const rejectedOrigin = await fetch(proxyUrl(listUrl), {
    headers: { origin: 'https://other.fixture.invalid', 'x-canvas-agent-token': config.token },
  });
  assert.equal(rejectedOrigin.status, 403);
  const rejectedToken = await fetch(proxyUrl(listUrl), {
    headers: { origin: WEB_URL, 'x-canvas-agent-token': '0'.repeat(64) },
  });
  assert.equal(rejectedToken.status, 403);
  const rejectedTask = await fetch(proxyUrl(listUrl, crypto.randomUUID()), {
    headers: { origin: WEB_URL, 'x-canvas-agent-token': config.token },
  });
  assert.equal(rejectedTask.status, 403);
  assert.equal(providerRequests.length, 0, 'rejected origins, tokens, and project paths never reach the provider');

  const modelsResponse = await fetch(proxyUrl(listUrl), {
    headers: { origin: WEB_URL, 'x-canvas-agent-token': config.token },
  });
  assert.equal(modelsResponse.status, 200);
  assert.equal(modelsResponse.headers.get('access-control-allow-origin'), WEB_URL);
  assert.deepEqual((await modelsResponse.json()).data.map((item) => item.id), ['fixture-image-v1']);
  assert.equal(providerRequests.at(-1).authorization, 'Bearer local-image-secret-v1');

  const createResponse = await fetch(proxyUrl(`${baseUrl}/images/generations`), {
    method: 'POST',
    headers: { origin: WEB_URL, 'x-canvas-agent-token': config.token, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fixture-image-v1', prompt: 'isolated fixture request' }),
  });
  assert.equal(createResponse.status, 200);
  const resultUrl = (await createResponse.json()).data[0].url;
  const resultResponse = await fetch(proxyUrl(resultUrl), {
    headers: { origin: WEB_URL, 'x-canvas-agent-token': config.token },
  });
  assert.equal(resultResponse.status, 200, 'the issued image URL is relayed through the task proxy');
  assert.equal(await resultResponse.text(), 'fixture-png');

  await saveConfig({
    expectedRevision: 2,
    image: { model: 'fixture-image-v2', apiKey: 'local-image-secret-v2' },
  }, { root });
  const refreshedResponse = await fetch(publicConfigUrl, {
    headers: { origin: WEB_URL, 'x-canvas-agent-token': config.token },
  });
  const refreshed = await refreshedResponse.json();
  assert.equal(refreshed.configRevision, 3);
  assert.equal(refreshed.imageConfig.model, 'fixture-image-v2');
  assert.equal(JSON.stringify(refreshed).includes('local-image-secret-v2'), false);
  const refreshedModels = await fetch(proxyUrl(listUrl), {
    headers: { origin: WEB_URL, 'x-canvas-agent-token': config.token },
  });
  assert.equal(refreshedModels.status, 200);
  assert.equal(refreshedModels.headers.get('access-control-allow-origin'), WEB_URL);
  assert.equal(providerRequests.at(-1).authorization, 'Bearer local-image-secret-v2', 'the proxy reads the saved key for every request');

  const forbiddenTarget = await fetch(proxyUrl(`${baseUrl}/chat/completions`), {
    method: 'POST',
    headers: { origin: WEB_URL, 'x-canvas-agent-token': config.token, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fixture-image-v2' }),
  });
  assert.equal(forbiddenTarget.status, 403);
  assert.equal(providerRequests.some((item) => item.path === '/v1/chat/completions'), false);
});
