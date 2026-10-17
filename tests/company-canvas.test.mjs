import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCompanyCanvasManager } from '../src/company/canvas.mjs';
import { companyBridgeStatus, readCompanyCanvasBridgeConfig, startCompanyBridge, stopCompanyBridge } from '../src/company/bridge.mjs';
import { createTask } from '../src/creative/tasks.mjs';

const WEB_URL = 'https://canvas.fixture.invalid';
const IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=';
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'studio-company-canvas-'));
}

function timeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

async function companyBootstrap(openUrl) {
  const url = new URL(openUrl);
  const hash = new URLSearchParams(url.hash.slice(1));
  const bridgeUrl = hash.get('companyBridge');
  const ticket = hash.get('companyTicket');
  assert.ok(bridgeUrl && ticket, 'open URL carries only the loopback bridge and one-time ticket');
  assert.equal(url.searchParams.get('mode'), 'recent');
  const origin = url.origin;
  const preflight = await fetch(`${bridgeUrl}/__company/bootstrap`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-private-network': 'true',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
  const response = await fetch(`${bridgeUrl}/__company/bootstrap`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ ticket }),
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.projectId, url.searchParams.get('projectId'));
  assert.equal(result.bridgeUrl, bridgeUrl);
  assert.ok(typeof result.token === 'string' && result.token.length >= 32);
  assert.ok(Number.isSafeInteger(result.configRevision) && result.configRevision >= 1);
  assert.ok(result.imageConfig && typeof result.imageConfig.baseUrl === 'string');
  assert.equal(Object.hasOwn(result.imageConfig, 'apiKey'), false, 'bootstrap exposes model address only, never the saved image key');
  assert.equal(Object.hasOwn(result, 'clientId'), false, 'each browser tab receives a new clientId from SSE hello');

  const replay = await fetch(`${bridgeUrl}/__company/bootstrap`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ ticket }),
  });
  assert.equal(replay.status, 410, 'bootstrap tickets can be consumed once');
  return result;
}

async function connectCanvas({ bridgeUrl, token, projectId, origin }) {
  const address = new URL('/events', bridgeUrl);
  address.searchParams.set('token', token);
  address.searchParams.set('projectId', projectId);
  const controller = new AbortController();
  const response = await fetch(address, { headers: { origin }, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let resolveHello;
  let rejectHello;
  const hello = new Promise((resolve, reject) => { resolveHello = resolve; rejectHello = reject; });
  const toolCalls = [];

  async function answerToolCall(payload) {
    toolCalls.push(payload.name);
    let result = {};
    if (payload.name === 'canvas_read_image') {
      result = { nodeId: payload.input?.nodeId, dataUrl: IMAGE_DATA_URL, width: 1, height: 1 };
    }
    const resultUrl = new URL('/canvas/result', bridgeUrl);
    resultUrl.searchParams.set('projectId', projectId);
    resultUrl.searchParams.set('clientId', helloClientId);
    const saved = await fetch(resultUrl, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-canvas-agent-token': token },
      body: JSON.stringify({ requestId: payload.requestId, result }),
    });
    if (!saved.ok) throw new Error(`fixture Canvas result rejected (${saved.status})`);
  }

  let helloClientId = '';
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const event = /^event:\s*(.+)$/mu.exec(block)?.[1]?.trim();
          const data = /^data:\s*(.+)$/mu.exec(block)?.[1];
          if (!event || !data) continue;
          let payload;
          try { payload = JSON.parse(data); } catch { continue; }
          if (event === 'hello' && !helloClientId) {
            helloClientId = payload.clientId;
            resolveHello(payload);
          } else if (event === 'tool_call') {
            void answerToolCall(payload).catch((error) => { rejectHello(error); });
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) rejectHello(error);
    }
  })();
  const greeting = await timeout(hello, 5000, 'Canvas SSE hello');
  assert.equal(greeting.projectId, projectId);
  assert.equal(typeof greeting.instanceId, 'string');
  return {
    clientId: greeting.clientId,
    toolCalls,
    async publishState({ image = true } = {}) {
      const stateUrl = new URL('/canvas/state', bridgeUrl);
      stateUrl.searchParams.set('projectId', projectId);
      stateUrl.searchParams.set('clientId', greeting.clientId);
      const response = await fetch(stateUrl, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', 'x-canvas-agent-token': token },
        body: JSON.stringify({
          projectId,
          clientId: greeting.clientId,
          nodes: image ? [{
            id: 'fixture-image-node', type: 'image', title: 'Fixture image',
            position: { x: 0, y: 0 }, width: 1, height: 1,
            metadata: { storageKey: 'image:fixture', naturalWidth: 1, naturalHeight: 1 },
          }] : [],
          selectedNodeIds: [],
        }),
      });
      assert.equal(response.status, 200);
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
      await pump.catch(() => {});
    },
  };
}

function createManager(root, { request = fetch, detachedBridge = false } = {}) {
  return createCompanyCanvasManager({
    root,
    request,
    detachedBridge,
    readConfig: async () => ({
      image: { baseUrl: 'http://127.0.0.1:9/v1', model: 'local-only-model', apiKey: 'local-fixture-key' },
    }),
    readCompanyConfig: async () => ({ canvas: { webUrl: WEB_URL } }),
  });
}

async function privateTaskConfig(root, taskId) {
  return readCompanyCanvasBridgeConfig({ root, taskId });
}

test('company Canvas isolates task bridges, uses project-only tickets, diagnoses real SSE tools, and pins execution identity', async (t) => {
  const root = await temporaryDirectory(t);
  const taskA = await createTask({ title: '公司 Canvas 任务 A', brief: 'HTTP/SSE 隔离夹具' }, root);
  const taskB = await createTask({ title: '公司 Canvas 任务 B', brief: 'HTTP/SSE 隔离夹具' }, root);
  let driftInstance = false;
  let toolRequests = 0;
  const request = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === '/api/tools' && init.method === 'POST') toolRequests += 1;
    const response = await fetch(input, init);
    if (url.pathname !== '/health' || !driftInstance) return response;
    const body = await response.json();
    return new Response(JSON.stringify({ ...body, instanceId: 'changed-during-operation' }), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  const manager = createManager(root, { request });
  const pages = [];
  t.after(async () => {
    await Promise.all(pages.map((page) => page.close()));
    await manager.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  assert.equal((await manager.state(taskA.id)).state, 'stopped', 'an unconfigured state read does not cache an empty target');
  assert.equal((await manager.state(taskB.id)).state, 'stopped');
  const openedA = await manager.ensure(taskA.id);
  const openedB = await manager.ensure(taskB.id);
  assert.equal(openedA.projectId, taskA.id);
  assert.equal(openedA.targetProjectId, taskA.id);
  assert.equal(openedB.targetProjectId, taskB.id);
  assert.equal(openedA.clientConnected, false);
  assert.equal(openedB.clientConnected, false);

  const configA = await privateTaskConfig(root, taskA.id);
  const configB = await privateTaskConfig(root, taskB.id);
  assert.equal(configA.projectId, taskA.id);
  assert.equal(configB.projectId, taskB.id);
  assert.notEqual(new URL(configA.bridgeUrl).port, new URL(configB.bridgeUrl).port);
  assert.notEqual(digest(configA.token), digest(configB.token));
  assert.ok(!openedA.openUrl.includes(configA.token));
  assert.ok(!openedB.openUrl.includes(configB.token));
  assert.equal(new URL(openedA.openUrl).searchParams.get('projectId'), taskA.id);
  assert.equal(new URL(openedB.openUrl).searchParams.get('projectId'), taskB.id);
  const configFileA = path.join(root, 'canvas', taskA.id, 'company-canvas-bridge.json');
  if (process.platform !== 'win32') assert.equal((await fs.stat(configFileA)).mode & 0o777, 0o600);

  const bootstrapB = await companyBootstrap(openedB.openUrl);
  const pageB = await connectCanvas({ ...bootstrapB, projectId: taskB.id, origin: WEB_URL });
  pages.push(pageB);
  await pageB.publishState();
  const reportB = await manager.diagnose({ taskId: taskB.id });
  assert.equal(reportB.target.verified, true);
  assert.equal(reportB.page.state, 'verified');
  assert.equal(reportB.page.imageRead, 'verified');
  assert.equal(reportB.page.storageKey, 'verified-existing-images');

  const bootstrapA = await companyBootstrap(openedA.openUrl);
  const pageA = await connectCanvas({ ...bootstrapA, projectId: taskA.id, origin: WEB_URL });
  pages.push(pageA);
  await pageA.publishState();
  const reportA = await manager.diagnose({ taskId: taskA.id });
  assert.equal(reportA.protocolSupported, true);
  assert.equal(reportA.target.verified, true);
  assert.equal(reportA.page.state, 'verified');
  assert.equal(reportA.page.imageRead, 'verified');
  assert.equal(reportA.page.storageKey, 'verified-existing-images');
  assert.equal(reportA.readyForGeneration, true);
  assert.ok(reportA.unverified.some((entry) => entry.includes('canvas_import_image')));
  assert.ok(!JSON.stringify(reportA).includes(configA.token));
  assert.ok(pageA.toolCalls.includes('canvas_read_image'));
  assert.ok(!pageA.toolCalls.includes('canvas_import_image'));
  assert.ok(!pageA.toolCalls.includes('canvas_apply_ops'));

  const imageConfig = await manager.checkImageConfig(taskA.id);
  assert.equal(imageConfig.configured, true);
  assert.equal(imageConfig.provider, 'openai-compatible');
  assert.equal(imageConfig.model, 'local-only-model');
  assert.equal(imageConfig.connectionTested, false, 'ordinary config inspection does not call a provider');
  assert.ok(!JSON.stringify(imageConfig).includes('local-fixture-key'));
  assert.ok(!pageA.toolCalls.includes('workbench_image_get_config'), 'company execution does not read or mutate remote image settings');

  const execution = await manager.executionOptions(taskA.id, {});
  assert.equal(execution.model, 'local-only-model');
  const beforeDriftToolRequests = toolRequests;
  driftInstance = true;
  await assert.rejects(
    execution.tool('canvas_get_state', {}, execution.config),
    (error) => error?.code === 'ERR_CANVAS_TARGET_CHANGED',
  );
  assert.equal(toolRequests, beforeDriftToolRequests, 'instance drift is rejected before /api/tools');
  driftInstance = false;

  const reboundA = await privateTaskConfig(root, taskA.id);
  assert.equal(reboundA.clientId, pageA.clientId, 'unique active page is privately bound to its task');
  const reopenedA = await manager.ensure(taskA.id);
  const reopenConfig = await privateTaskConfig(root, taskA.id);
  assert.equal(reopenConfig.projectId, taskA.id);
  const bootstrapAgain = await companyBootstrap(reopenedA.openUrl);
  const pageA2 = await connectCanvas({ ...bootstrapAgain, projectId: taskA.id, origin: WEB_URL });
  pages.push(pageA2);
  await pageA2.publishState();
  assert.notEqual(pageA2.clientId, pageA.clientId);

  const ambiguous = await manager.diagnose({ taskId: taskA.id });
  assert.equal(ambiguous.target.verified, false);
  assert.equal(ambiguous.page.state, 'ambiguous');
  assert.ok(ambiguous.missing.some((item) => item.includes('多个 Canvas 页面')));
  assert.equal((await manager.state(taskA.id)).connectionError, 'ERR_CANVAS_AMBIGUOUS');
  assert.equal((await manager.state(taskB.id)).state, 'ready', 'another task remains bound to its own bridge and page');

  const statusA = await companyBridgeStatus({ root, taskId: taskA.id });
  const statusB = await companyBridgeStatus({ root, taskId: taskB.id });
  assert.equal(statusA.state, 'healthy');
  assert.equal(statusB.state, 'healthy');
  await manager.stop();
  assert.equal((await companyBridgeStatus({ root, taskId: taskA.id })).state, 'dead');
  assert.equal((await companyBridgeStatus({ root, taskId: taskB.id })).state, 'dead');
});

test('manager stop leaves a separate task bridge it did not start running', async (t) => {
  const root = await temporaryDirectory(t);
  const managedTask = await createTask({ title: '受管理 bridge', brief: '生命周期隔离' }, root);
  const otherTask = await createTask({ title: '独立 bridge', brief: '生命周期隔离' }, root);
  const manager = createManager(root);
  t.after(async () => {
    await manager.stop();
    await stopCompanyBridge({ root, taskId: otherTask.id });
    await fs.rm(root, { recursive: true, force: true });
  });

  await manager.ensure(managedTask.id);
  await startCompanyBridge({ root, taskId: otherTask.id, webUrl: WEB_URL });
  await manager.stop();
  assert.equal((await companyBridgeStatus({ root, taskId: managedTask.id })).state, 'dead');
  assert.equal((await companyBridgeStatus({ root, taskId: otherTask.id })).state, 'healthy');
});

test('detached company manager reuses task bridge across short-lived commands and leaves it running on manager stop', async (t) => {
  const root = await temporaryDirectory(t);
  const task = await createTask({ title: 'Detached Canvas CLI 夹具', brief: '仅测试独立 bridge 生命周期' }, root);
  const manager = createManager(root, { detachedBridge: true });
  t.after(async () => {
    await manager.stop();
    await stopCompanyBridge({ root, taskId: task.id });
    await fs.rm(root, { recursive: true, force: true });
  });

  const opened = await manager.ensure(task.id);
  assert.equal(opened.projectId, task.id);
  assert.equal((await companyBridgeStatus({ root, taskId: task.id })).state, 'healthy');
  await manager.stop();
  assert.equal((await companyBridgeStatus({ root, taskId: task.id })).state, 'healthy');
  const secondManager = createManager(root, { detachedBridge: true });
  const reopened = await secondManager.ensure(task.id);
  assert.equal(reopened.targetProjectId, task.id);
  await secondManager.stop();
  assert.equal((await companyBridgeStatus({ root, taskId: task.id })).state, 'healthy');
});
