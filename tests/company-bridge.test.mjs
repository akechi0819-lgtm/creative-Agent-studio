import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
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
