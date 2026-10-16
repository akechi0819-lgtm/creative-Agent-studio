import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { attachTaskFiles, createTask, readTask, setSources } from '../src/creative/tasks.mjs';
import { runCanvasOperation } from '../src/creative/canvas-operations.mjs';
import { appendConversation, readConversation } from '../src/web/jobs.mjs';
import { createCanvasManager } from '../src/web/canvas.mjs';
import { listenStudioServer } from '../src/web/server.mjs';

const PNG_RED = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64');
const PNG_BLUE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8AABQMBgH0eY4sAAAAASUVORK5CYII=', 'base64');
const dataUrl = (bytes) => `data:image/png;base64,${bytes.toString('base64')}`;
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function createFixture(t, { secondTask = false, regionDetector, agent } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-studio-canvas-ops-'));
  const staticDir = path.join(root, 'web-dist');
  await fs.mkdir(staticDir, { recursive: true });
  await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>fixture</title>');
  const firstTask = await createTask({ title: '机械操作隔离夹具', brief: '仅测试当前任务 Canvas' }, root);
  const tasks = [firstTask];
  if (secondTask) tasks.push(await createTask({ title: '另一个任务', brief: '隔离任务边界' }, root));
  const instances = new Map();
  const canvases = new Map();
  for (const task of tasks) {
    const instanceId = crypto.randomUUID();
    const clientId = `client-${task.id}`;
    const web = http.createServer((request, response) => {
      if (request.url !== '/__studio/health') { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ instanceId, projectId: task.id }));
    });
    await new Promise((resolve, reject) => {
      web.once('error', reject);
      web.listen(0, '127.0.0.1', resolve);
    });
    const webUrl = `http://127.0.0.1:${web.address().port}`;
    const config = {
      projectId: task.id,
      instanceId,
      clientId,
      token: `fixture-token-${task.id}`,
      webUrl,
      bridgeUrl: 'http://127.0.0.1:1',
    };
    const imageNode = {
      id: `image-${task.id}`,
      type: 'image',
      title: '原始图片',
      position: { x: 10, y: 20 },
      width: 320,
      height: 320,
      metadata: { content: dataUrl(PNG_RED), naturalWidth: 1, naturalHeight: 1, storageKey: 'private-storage-key', token: 'do-not-return' },
    };
    const textNode = {
      id: `text-${task.id}`,
      type: 'text',
      title: '说明文字',
      position: { x: 30, y: 40 },
      width: 240,
      height: 80,
      metadata: { content: '保留这段文字', arbitraryPrivateValue: 'do-not-return' },
    };
    const canvasState = { projectId: task.id, clientId, nodes: [imageNode, textNode], connections: [], selectedNodeIds: [imageNode.id, 'private-config-node'] };
    instances.set(task.id, { config, web });
    canvases.set(task.id, canvasState);
    await fs.mkdir(path.join(root, 'canvas', task.id), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(root, 'canvas', task.id, 'canvas-instance.json'), JSON.stringify(config), { mode: 0o600 });
    t.after(async () => new Promise((resolve) => web.close(() => resolve())));
  }

  const calls = [];
  const imageOperations = [];
  const generationCalls = [];
  const failures = new Map();
  const overrides = new Map();
  const canvasTool = async (name, input, config) => {
    calls.push({ name, input: structuredClone(input), projectId: config.projectId, clientId: config.clientId });
    const state = canvases.get(config.projectId);
    if (!state) throw new Error('wrong project');
    if (failures.has(name)) {
      const failure = failures.get(name);
      failures.delete(name);
      throw failure;
    }
    if (name === 'canvas_get_state') {
      const snapshot = structuredClone(state);
      return overrides.has(name) ? overrides.get(name)(snapshot) : snapshot;
    }
    if (name === 'canvas_read_image') {
      const node = state.nodes.find((item) => item.id === input.nodeId && item.type === 'image');
      if (!node) throw new Error('image node missing');
      const bytes = Buffer.from(node.metadata.content.split(',')[1], 'base64');
      return { dataUrl: node.metadata.content, width: node.metadata.naturalWidth, height: node.metadata.naturalHeight };
    }
    if (['canvas_crop_image', 'canvas_split_image', 'canvas_resample_image'].includes(name)) {
      imageOperations.push({ name, projectId: config.projectId, input: structuredClone(input) });
      const count = name === 'canvas_split_image' ? input.rows * input.columns : 1;
      const images = Array.from({ length: count }, (_, index) => {
        const nodeId = `derived-${name}-${imageOperations.length}-${index + 1}`;
        state.nodes.push({
          id: nodeId,
          type: 'image',
          title: `机械辅助图 ${index + 1}`,
          position: { x: 400 + index * 240, y: 20 },
          width: 320,
          height: 320,
          metadata: { content: dataUrl(PNG_BLUE), naturalWidth: 1, naturalHeight: 1 },
        });
        return { nodeId, width: 1, height: 1 };
      });
      const operation = name === 'canvas_crop_image' ? 'crop' : name === 'canvas_split_image' ? 'split' : 'resample';
      const response = { operation, sourceNodeId: input.nodeId, images };
      return overrides.has(name) ? overrides.get(name)(response) : response;
    }
    if (name === 'canvas_stitch_images') {
      imageOperations.push({ name, projectId: config.projectId, input: structuredClone(input) });
      const sources = input.nodeIds.map((id) => state.nodes.find((node) => node.id === id));
      const widths = sources.map((node) => Number(node.metadata.naturalWidth));
      const heights = sources.map((node) => Number(node.metadata.naturalHeight));
      const width = input.direction === 'horizontal' ? widths.reduce((sum, value) => sum + value, 0) + input.gap * (sources.length - 1) : Math.max(...widths);
      const height = input.direction === 'vertical' ? heights.reduce((sum, value) => sum + value, 0) + input.gap * (sources.length - 1) : Math.max(...heights);
      const nodeId = `derived-stitch-${imageOperations.length}`;
      state.nodes.push({ id: nodeId, type: 'image', title: '拼接图', position: { x: 500, y: 20 }, width, height, metadata: { content: dataUrl(PNG_BLUE), naturalWidth: width, naturalHeight: height } });
      const response = { operation: 'stitch', sourceNodeId: input.nodeIds[0], sourceNodeIds: [...new Set(input.nodeIds)], images: [{ nodeId, width, height }] };
      return overrides.has(name) ? overrides.get(name)(response) : response;
    }
    if (name === 'canvas_compose_images') {
      imageOperations.push({ name, projectId: config.projectId, input: structuredClone(input) });
      const base = state.nodes.find((node) => node.id === input.nodeId);
      const width = Number(base.metadata.naturalWidth);
      const height = Number(base.metadata.naturalHeight);
      const nodeId = `derived-compose-${imageOperations.length}`;
      state.nodes.push({ id: nodeId, type: 'image', title: '合成图', position: { x: 500, y: 20 }, width, height, metadata: { content: dataUrl(PNG_BLUE), naturalWidth: width, naturalHeight: height } });
      const response = { operation: 'compose', sourceNodeId: input.nodeId, sourceNodeIds: [...new Set([input.nodeId, ...input.layers.map((layer) => layer.nodeId)])], images: [{ nodeId, width, height }] };
      return overrides.has(name) ? overrides.get(name)(response) : response;
    }
    if (name === 'canvas_import_image') {
      imageOperations.push({ name, projectId: config.projectId, input: { nodeId: input.nodeId, title: input.title, dataUrlSha256: digest(Buffer.from(input.dataUrl.split(',')[1], 'base64')) } });
      const nodeId = input.nodeId;
      const bytes = Buffer.from(input.dataUrl.split(',')[1], 'base64');
      state.nodes.push({ id: nodeId, type: 'image', title: input.title, position: { x: 500, y: 20 }, width: 1, height: 1, metadata: { content: input.dataUrl, naturalWidth: 1, naturalHeight: 1 } });
      const response = { operation: 'import', sourceNodeId: nodeId, images: [{ nodeId, width: 1, height: 1 }] };
      return overrides.has(name) ? overrides.get(name)(response) : response;
    }
    if (name === 'canvas_move_nodes') {
      for (const item of input.items) {
        const node = state.nodes.find((candidate) => candidate.id === item.id);
        if (node) node.position = { x: item.x ?? node.position.x + (item.dx || 0), y: item.y ?? node.position.y + (item.dy || 0) };
      }
      return {};
    }
    if (name === 'canvas_resize_node') {
      const node = state.nodes.find((candidate) => candidate.id === input.id);
      if (node) { node.width = input.width; node.height = input.height; }
      return {};
    }
    if (name.includes('generate') || name === 'canvas_run_generation' || name === 'workbench_image_generate') generationCalls.push(name);
    throw new Error(`unexpected mock bridge tool ${name}`);
  };
  const bridgeHealth = async (config) => ({
    instanceId: config.instanceId,
    targets: [{ hasCanvas: true, projectId: config.projectId, clientId: config.clientId }],
  });
  const canvas = createCanvasManager({
    root,
    readConfig: async () => ({ image: null }),
    canvasTool,
    bridgeHealth,
    regionDetector: regionDetector || (async () => ({ width: 1, height: 1, regions: [], truncated: false, totalDetected: 0 })),
  });
  const running = await listenStudioServer({
    root,
    staticDir,
    canvas,
    agent,
    readConfig: async () => ({ basic: { model: 'fixture-model' }, image: null }),
  });
  t.after(async () => {
    await running.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${running.address.port}`;
  return {
    root,
    task: firstTask,
    tasks,
    canvas,
    canvases,
    calls,
    imageOperations,
    generationCalls,
    failures,
    overrides,
    server: running.server,
    async request(url, { json, ...options } = {}) {
      const headers = new Headers(options.headers || {});
      if (options.method && options.method !== 'GET' && options.method !== 'HEAD') headers.set('origin', origin);
      let body = options.body;
      if (json !== undefined) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(json);
      }
      const response = await fetch(`${origin}${url}`, { ...options, headers, body });
      return { response, data: response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.arrayBuffer() };
    },
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function addUploadedPng(f, task = f.task) {
  const filePath = path.join(f.root, `upload-${crypto.randomUUID()}.png`);
  await fs.writeFile(filePath, PNG_RED);
  const updated = await attachTaskFiles(task.id, {
    files: [{ path: filePath, name: '用户上传图.png', mimeType: 'image/png' }],
    title: '本轮上传图片',
  }, { root: f.root, expectedRevision: task.revision });
  return { task: updated, source: updated.sources.at(-1) };
}

test('agentState returns only enumerated node status without Canvas error details or metadata', async (t) => {
  const f = await createFixture(t);
  const canvas = f.canvases.get(f.task.id);
  canvas.nodes[0].metadata.status = 'loading';
  canvas.nodes[0].metadata.errorDetails = 'private-provider-error';
  canvas.nodes[1].metadata.status = 'error';
  canvas.nodes[1].metadata.errorDetails = 'private-config-secret';

  const state = await f.canvas.agentState(f.task.id, { expectedRevision: f.task.revision });
  assert.equal(state.nodes.find((node) => node.id === canvas.nodes[0].id).status, 'loading');
  assert.equal(state.nodes.find((node) => node.id === canvas.nodes[1].id).status, 'error');
  assert.doesNotMatch(JSON.stringify(state), /private-provider-error|private-config-secret|storageKey|data:image/);

  canvas.nodes[1].metadata.status = 'upstream-token-value';
  const unknownState = await f.canvas.agentState(f.task.id, { expectedRevision: f.task.revision });
  assert.equal(unknownState.nodes.find((node) => node.id === canvas.nodes[1].id).status, null);
  assert.doesNotMatch(JSON.stringify(unknownState), /upstream-token-value/);
});

test('Web mechanical crop returns only task-local hashed artifacts with preview, download, and replay-safe persistence', async (t) => {
  const f = await createFixture(t);
  const beforeTask = await readTask(f.task.id, f.root);
  const requestId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const splitOperationId = crypto.randomUUID();
  let callbackState;
  let callbackOutcome;
  let splitOutcome;
  let callbackPreview;
  const agent = {
    chat: async ({ taskId, text, canvasState, canvasOperation, canvasPreview }) => {
      assert.equal(taskId, f.task.id);
      assert.equal(text, '把当前图片裁切为中间区域，并保留原图。');
      callbackState = await canvasState({ expectedRevision: beforeTask.revision });
      callbackPreview = await canvasPreview({ nodeId: `image-${taskId}`, expectedRevision: beforeTask.revision });
      callbackOutcome = await canvasOperation({
        operation: 'crop',
        nodeId: `image-${taskId}`,
        crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        expectedRevision: beforeTask.revision,
        operationId,
      });
      const replay = await canvasOperation({
        operation: 'crop',
        nodeId: `image-${taskId}`,
        crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        expectedRevision: beforeTask.revision,
        operationId,
      });
      assert.equal(replay.replayed, true);
      splitOutcome = await canvasOperation({
        operation: 'split',
        nodeId: `image-${taskId}`,
        rows: 2,
        columns: 2,
        expectedRevision: beforeTask.revision,
        operationId: splitOperationId,
      });
      return { text: '已生成裁切辅助图片，原图和成品记录保持不变。', task: callbackOutcome.task };
    },
  };
  const chatServer = await listenStudioServer({
    root: f.root,
    staticDir: path.join(f.root, 'web-dist'),
    canvas: f.canvas,
    agent,
    readConfig: async () => ({ basic: { model: 'fixture-model' }, image: null }),
  });
  t.after(() => chatServer.close());
  const origin = `http://127.0.0.1:${chatServer.address.port}`;
  const startedResponse = await fetch(`${origin}/api/tasks/${f.task.id}/chat`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId,
      expectedRevision: beforeTask.revision,
      model: 'fixture-model',
      text: '把当前图片裁切为中间区域，并保留原图。',
    }),
  });
  assert.equal(startedResponse.status, 202);
  const started = await startedResponse.json();
  const job = await waitFor(async () => {
    const response = await fetch(`${origin}/api/jobs/${started.job.id}`);
    const current = await response.json();
    return ['succeeded', 'failed', 'cancelled'].includes(current.job.status) ? current.job : null;
  }, 'chat job did not finish');
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));

  assert.deepEqual(callbackState.nodes.map(({ id, type, title, position, displaySize, naturalSize }) => ({ id, type, title, position, displaySize, naturalSize })), [
    {
      id: `image-${f.task.id}`, type: 'image', title: '原始图片', position: { x: 10, y: 20 },
      displaySize: { width: 320, height: 320 }, naturalSize: { width: 1, height: 1 },
    },
    {
      id: `text-${f.task.id}`, type: 'text', title: '说明文字', position: { x: 30, y: 40 },
      displaySize: { width: 240, height: 80 }, naturalSize: null,
    },
  ]);
  assert.deepEqual(callbackState.selection, [`image-${f.task.id}`]);
  assert.doesNotMatch(JSON.stringify(callbackState), /private-storage-key|do-not-return|data:image|token/);
  assert.deepEqual(callbackPreview.bytes, PNG_RED, 'canvasPreview passes the current raw image bytes to the private runtime');
  assert.equal(callbackPreview.mimeType, 'image/png');
  assert.equal(callbackPreview.sha256, digest(PNG_RED));
  assert.equal(f.imageOperations.length, 2, 'same operationId replays without bridge resubmission while another call can execute');
  assert.equal(f.generationCalls.length, 0, 'mechanical crop never invokes image generation');
  assert.equal(f.imageOperations[0].projectId, f.task.id);
  assert.deepEqual(f.imageOperations[0].input, { nodeId: `image-${f.task.id}`, crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } });
  assert.equal(callbackOutcome.result.images[0].nodeId, `derived-canvas_crop_image-1-1`);
  assert.equal(callbackOutcome.attachments[0].sha256, digest(PNG_BLUE));
  assert.equal(callbackOutcome.attachments[0].fileUrl, `/api/tasks/${f.task.id}/canvas-operations/${operationId}/images/0`);
  assert.equal(splitOutcome.attachments.length, 4);
  assert.deepEqual(splitOutcome.attachments.map((item) => item.fileUrl), [0, 1, 2, 3].map((index) => `/api/tasks/${f.task.id}/canvas-operations/${splitOperationId}/images/${index}`));
  assert.equal(digest(Buffer.from(f.canvases.get(f.task.id).nodes[0].metadata.content.split(',')[1], 'base64')), digest(PNG_RED), 'pixel tools preserve the source image');
  assert.equal((await readTask(f.task.id, f.root)).revision, beforeTask.revision, 'mechanical artifacts do not change task, sheet, review, or approval state');
  assert.deepEqual(await readTask(f.task.id, f.root), beforeTask);

  const detail = await f.request(`/api/tasks/${f.task.id}`);
  assert.equal(detail.response.status, 200);
  const assistantMessage = detail.data.conversation.at(-1);
  assert.equal(assistantMessage.role, 'assistant');
  assert.equal(assistantMessage.attachments.length, 5, 'all separate operation outputs persist in one assistant message across reload');
  assert.equal(assistantMessage.attachments[0].fileUrl, callbackOutcome.attachments[0].fileUrl);
  assert.equal(assistantMessage.attachments[0].downloadUrl, callbackOutcome.attachments[0].downloadUrl);
  assert.deepEqual(assistantMessage.attachments.slice(1).map((item) => item.fileUrl), splitOutcome.attachments.map((item) => item.fileUrl));
  assert.equal((await f.canvas.mechanicalImage(f.task.id, operationId, 0)).sha256, digest(PNG_BLUE));

  const preview = await f.request(assistantMessage.attachments[0].fileUrl);
  assert.equal(preview.response.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.response.headers.get('content-type'), 'image/png');
  assert.match(preview.response.headers.get('content-disposition'), /^inline;/);
  assert.deepEqual(Buffer.from(preview.data), PNG_BLUE);
  const download = await f.request(assistantMessage.attachments[0].downloadUrl);
  assert.equal(download.response.status, 200);
  assert.match(download.response.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(download.data), PNG_BLUE);
  const splitDownload = await f.request(assistantMessage.attachments[4].downloadUrl);
  assert.equal(splitDownload.response.status, 200);
  assert.deepEqual(Buffer.from(splitDownload.data), PNG_BLUE);
});

test('image-region results are image-only, scoped to the current task, and rechecked after detection', async (t) => {
  let f;
  let detectionCount = 0;
  f = await createFixture(t, {
    secondTask: true,
    regionDetector: async ({ bytes, mimeType, kinds }) => {
      assert.deepEqual(bytes, PNG_RED);
      assert.equal(mimeType, 'image/png');
      assert.deepEqual(kinds, undefined);
      detectionCount += 1;
      if (detectionCount === 2) f.canvases.get(f.task.id).nodes[0].metadata.content = dataUrl(PNG_BLUE);
      return {
        width: 1, height: 1, totalDetected: 1, truncated: false,
        regions: [{ kind: 'barcode', confidence: 1, bounds: { x: 0, y: 0, width: 1, height: 1 }, suggestedBounds: { x: 0, y: 0, width: 1, height: 1 }, suggestedPadding: 2 }],
      };
    },
  });
  const task = await readTask(f.task.id, f.root);
  const result = await f.canvas.agentRegions(task.id, {
    nodeId: `image-${task.id}`, expectedRevision: task.revision,
  });
  assert.equal(result.sha256, digest(PNG_RED));
  assert.deepEqual(result.regions[0].suggestedBounds, { x: 0, y: 0, width: 1, height: 1 });
  assert.doesNotMatch(JSON.stringify(result), /data:image|payload|secret|recognizedText/i);
  await assert.rejects(f.canvas.agentRegions(task.id, {
    nodeId: `image-${task.id}`, expectedRevision: task.revision,
  }), (error) => error.code === 'ERR_CANVAS_SOURCE_CHANGED');
  await assert.rejects(f.canvas.agentRegions(f.tasks[1].id, {
    nodeId: `image-${task.id}`, expectedRevision: f.tasks[1].revision,
  }), (error) => error.code === 'ERR_CANVAS_OPERATION_INPUT');
  assert.equal(f.calls.filter((call) => call.name === 'canvas_read_image').length, 8);
});

test('server injects detected source SHA internally and rejects stale bounds before a pixel operation', async (t) => {
  let f;
  let callbackResult;
  let operationFailure;
  let staleOperationId;
  f = await createFixture(t, {
    regionDetector: async () => ({ width: 1, height: 1, regions: [], truncated: false, totalDetected: 0 }),
    agent: {
      chat: async ({ taskId, canvasRegions, canvasOperation }) => {
        const task = await readTask(taskId, f.root);
        callbackResult = await canvasRegions({ nodeId: `image-${taskId}`, expectedRevision: task.revision });
        assert.equal(callbackResult.sha256, digest(PNG_RED));
        f.canvases.get(taskId).nodes[0].metadata.content = dataUrl(PNG_BLUE);
        staleOperationId = crypto.randomUUID();
        try { await canvasOperation({
          operation: 'crop', nodeId: `image-${taskId}`, crop: { x: 0, y: 0, width: 1, height: 1 },
          expectedRevision: task.revision, operationId: staleOperationId,
        }); } catch (error) { operationFailure = error; }
        return { text: '已拒绝使用过期区域坐标。', task };
      },
    },
  });
  const task = await readTask(f.task.id, f.root);
  const started = await f.request(`/api/tasks/${task.id}/chat`, {
    method: 'POST', json: { requestId: crypto.randomUUID(), expectedRevision: task.revision, text: '检测区域后再操作。' },
  });
  assert.equal(started.response.status, 202);
  const job = await waitFor(async () => {
    const response = await f.request(`/api/jobs/${started.data.job.id}`);
    return ['succeeded', 'failed', 'cancelled'].includes(response.data.job.status) ? response.data.job : null;
  }, 'region-scoped chat job did not finish');
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  assert.equal(callbackResult.truncated, false);
  assert.equal(operationFailure?.code, 'ERR_CANVAS_SOURCE_CHANGED', operationFailure?.message || 'stale detected source was not rejected');
  assert.equal(f.imageOperations.length, 0, 'a source changed after detection, so no bridge pixel operation was submitted');
  const operationRecord = JSON.parse(await fs.readFile(path.join(f.root, 'tasks', task.id, 'canvas-operations', `${staleOperationId}.json`), 'utf8'));
  assert.equal(operationRecord.status, 'failed');
  assert.equal(operationRecord.canvasClientId, undefined, 'stale source coordinates fail before ledger submission');
  assert.equal(f.generationCalls.length, 0);
});

test('layout operations use the real move schema and never fabricate image attachments', async (t) => {
  const f = await createFixture(t);
  const task = await readTask(f.task.id, f.root);
  const beforeNodeIds = f.canvases.get(task.id).nodes.map((node) => node.id);
  const moved = await f.canvas.mechanicalOperation(task.id, {
    operation: 'move', nodeId: `text-${task.id}`, x: 150, y: 80,
    expectedRevision: task.revision, operationId: crypto.randomUUID(), requestId: crypto.randomUUID(),
    callId: crypto.randomUUID(), userText: '把说明文字移到右下角。',
  });
  const moveCall = f.calls.find((call) => call.name === 'canvas_move_nodes');
  assert.deepEqual(moveCall.input, { items: [{ id: `text-${task.id}`, x: 150, y: 80 }] });
  assert.deepEqual(moved.result, { operation: 'move', sourceNodeId: `text-${task.id}`, position: { x: 150, y: 80 } });
  assert.deepEqual(moved.attachments, []);
  assert.deepEqual(f.canvases.get(task.id).nodes.map((node) => node.id), beforeNodeIds);

  const resized = await f.canvas.mechanicalOperation(task.id, {
    operation: 'resize', nodeId: `image-${task.id}`, width: 500, height: 260,
    expectedRevision: task.revision, operationId: crypto.randomUUID(), requestId: crypto.randomUUID(),
    callId: crypto.randomUUID(), userText: '把图片节点显示尺寸调整为 500 乘 260。',
  });
  const resizeCall = f.calls.find((call) => call.name === 'canvas_resize_node');
  assert.deepEqual(resizeCall.input, { id: `image-${task.id}`, width: 500, height: 260 });
  assert.deepEqual(resized.result, { operation: 'resize', sourceNodeId: `image-${task.id}`, displaySize: { width: 500, height: 260 } });
  assert.deepEqual(resized.attachments, []);
  assert.equal(f.generationCalls.length, 0);
  assert.equal((await readTask(task.id, f.root)).revision, task.revision);
});

test('mechanical bridge ambiguity and unknown outcomes are recorded without resubmission or cross-task access', async (t) => {
  const f = await createFixture(t, { secondTask: true });
  const first = f.tasks[0];
  const second = f.tasks[1];
  const secondState = await f.canvas.agentState(second.id, { expectedRevision: second.revision });
  assert.equal(secondState.nodes.some((node) => node.id === `image-${first.id}`), false);
  await assert.rejects(f.canvas.mechanicalOperation(second.id, {
    operation: 'crop', nodeId: `image-${first.id}`, crop: { x: 0, y: 0, width: 1, height: 1 },
    expectedRevision: second.revision, operationId: crypto.randomUUID(), requestId: crypto.randomUUID(),
    callId: crypto.randomUUID(), userText: '尝试操作另一任务的图片',
  }), (error) => error.code === 'ERR_CANVAS_OPERATION_INPUT');
  assert.equal(f.imageOperations.length, 0, 'a node from another task is rejected before bridge submission');

  const operationId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const call = (extra = {}) => f.canvas.mechanicalOperation(first.id, {
    operation: 'crop', nodeId: `image-${first.id}`, crop: { x: 0, y: 0, width: 1, height: 1 },
    expectedRevision: first.revision, operationId, requestId, callId: operationId,
    userText: '裁切当前任务图片',
    ...extra,
  });
  f.failures.set('canvas_crop_image', new Error('bridge disconnected after the submit could have landed'));
  await assert.rejects(call(), (error) => error.code === 'ERR_CANVAS_OPERATION_UNKNOWN');
  const submitsBeforeReplay = f.calls.filter((item) => item.name === 'canvas_crop_image').length;
  await assert.rejects(call({ width: 100 }), (error) => error.code === 'ERR_CANVAS_OPERATION_INPUT');
  await assert.rejects(call(), (error) => error.code === 'ERR_CANVAS_OPERATION_UNKNOWN');
  assert.equal(f.calls.filter((item) => item.name === 'canvas_crop_image').length, submitsBeforeReplay, 'unknown operationId never auto-resubmits');
  assert.equal(f.generationCalls.length, 0);
});

test('pixel and layout readback requires the exact declared output count and finite dimensions', async (t) => {
  const f = await createFixture(t);
  const task = await readTask(f.task.id, f.root);
  const operationId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const base = {
    nodeId: `image-${task.id}`, expectedRevision: task.revision, requestId,
    userText: '按要求生成机械辅助结果并确认布局尺寸。',
  };
  f.overrides.set('canvas_split_image', (result) => ({ ...result, images: result.images.slice(1) }));
  await assert.rejects(f.canvas.mechanicalOperation(task.id, {
    ...base, operation: 'split', rows: 2, columns: 2, operationId, callId: operationId,
  }), (error) => error.code === 'ERR_CANVAS_OPERATION_UNKNOWN');
  const splitSubmits = f.calls.filter((call) => call.name === 'canvas_split_image').length;
  await assert.rejects(f.canvas.mechanicalOperation(task.id, {
    ...base, operation: 'split', rows: 2, columns: 2, operationId, callId: operationId,
  }), (error) => error.code === 'ERR_CANVAS_OPERATION_UNKNOWN');
  assert.equal(f.calls.filter((call) => call.name === 'canvas_split_image').length, splitSubmits);

  f.overrides.delete('canvas_split_image');
  f.overrides.set('canvas_get_state', (snapshot) => {
    const source = snapshot.nodes.find((node) => node.id === base.nodeId);
    delete source.width;
    delete source.height;
    return snapshot;
  });
  const resizeOperationId = crypto.randomUUID();
  const resize = () => f.canvas.mechanicalOperation(task.id, {
    ...base, operation: 'resize', width: 420, height: 280, operationId: resizeOperationId, callId: resizeOperationId,
  });
  await assert.rejects(resize(), (error) => error.code === 'ERR_CANVAS_OPERATION_UNKNOWN');
  const resizeSubmits = f.calls.filter((call) => call.name === 'canvas_resize_node').length;
  await assert.rejects(resize(), (error) => error.code === 'ERR_CANVAS_OPERATION_UNKNOWN');
  assert.equal(f.calls.filter((call) => call.name === 'canvas_resize_node').length, resizeSubmits);
});

test('stitch and compose preserve source order, dedupe provenance, recycle outputs, and reject changed sources', async (t) => {
  const f = await createFixture(t);
  const task = await readTask(f.task.id, f.root);
  const canvasState = f.canvases.get(task.id);
  const baseId = `image-${task.id}`;
  const layerId = `layer-${task.id}`;
  const base = canvasState.nodes.find((node) => node.id === baseId);
  base.metadata.naturalWidth = 4;
  base.metadata.naturalHeight = 3;
  base.width = 4;
  base.height = 3;
  canvasState.nodes.push({
    id: layerId, type: 'image', title: '第二图片', position: { x: 50, y: 50 }, width: 1, height: 1,
    metadata: { content: dataUrl(PNG_BLUE), naturalWidth: 1, naturalHeight: 1 },
  });

  const stitchOperationId = crypto.randomUUID();
  const stitch = await f.canvas.mechanicalOperation(task.id, {
    operation: 'stitch', nodeIds: [baseId, layerId, baseId], direction: 'horizontal', gap: 2, background: '#112233ff',
    expectedRevision: task.revision, operationId: stitchOperationId, requestId: crypto.randomUUID(),
    callId: stitchOperationId, userText: '按原始像素把三张图拼接起来。',
  });
  assert.deepEqual(f.imageOperations[0], {
    name: 'canvas_stitch_images', projectId: task.id,
    input: { nodeIds: [baseId, layerId, baseId], direction: 'horizontal', gap: 2, background: '#112233ff' },
  });
  assert.deepEqual(stitch.result.sourceNodeIds, [baseId, layerId]);
  assert.deepEqual(stitch.result.images.map(({ width, height }) => ({ width, height })), [{ width: 13, height: 3 }]);
  assert.equal(stitch.attachments.length, 1);
  assert.match(stitch.attachments[0].name, /^canvas-stitch-/);
  await appendConversation(task.id, { role: 'assistant', text: '拼接结果', attachments: stitch.attachments }, f.root);
  assert.equal((await readConversation(task.id, f.root)).at(-1).attachments[0].name, stitch.attachments[0].name);
  assert.equal((await f.canvas.mechanicalImage(task.id, stitchOperationId, 0)).sha256, digest(PNG_BLUE));

  const swappedOperationId = crypto.randomUUID();
  f.overrides.set('canvas_stitch_images', (result) => ({ ...result, sourceNodeIds: [layerId, baseId] }));
  await assert.rejects(f.canvas.mechanicalOperation(task.id, {
    operation: 'stitch', nodeIds: [baseId, layerId], direction: 'horizontal',
    expectedRevision: task.revision, operationId: swappedOperationId, requestId: crypto.randomUUID(),
    callId: swappedOperationId, userText: '来源顺序错配时不能确认拼接。',
  }), (error) => error.code === 'ERR_CANVAS_OPERATION_UNKNOWN');

  const composeOperationId = crypto.randomUUID();
  const layers = [
    { nodeId: layerId, x: 0, y: 1, width: 2, height: 2, fit: 'contain', clear: '#ffffff' },
    { nodeId: layerId, x: 2, y: 1, width: 2, height: 2, fit: 'stretch', smoothing: 'smooth' },
  ];
  const normalizedLayers = [
    { ...layers[0], smoothing: 'nearest' },
    layers[1],
  ];
  const composed = await f.canvas.mechanicalOperation(task.id, {
    operation: 'compose', nodeId: baseId, layers,
    expectedRevision: task.revision, operationId: composeOperationId, requestId: crypto.randomUUID(),
    callId: composeOperationId, userText: '把第二张图按坐标贴进底图。',
  });
  const composeCall = f.imageOperations.find((item) => item.name === 'canvas_compose_images');
  assert.deepEqual(composeCall.input, { nodeId: baseId, layers: normalizedLayers });
  assert.deepEqual(composed.result.sourceNodeIds, [baseId, layerId]);
  assert.deepEqual(composed.result.images.map(({ width, height }) => ({ width, height })), [{ width: 4, height: 3 }]);
  assert.equal(composed.attachments.length, 1);
  assert.match(composed.attachments[0].name, /^canvas-compose-/);
  await appendConversation(task.id, { role: 'assistant', text: '合成结果', attachments: composed.attachments }, f.root);
  assert.equal((await readConversation(task.id, f.root)).at(-1).attachments[0].name, composed.attachments[0].name);
  assert.equal((await f.canvas.mechanicalImage(task.id, composeOperationId, 0)).sha256, digest(PNG_BLUE));

  const changedOperationId = crypto.randomUUID();
  f.overrides.set('canvas_compose_images', (result) => {
    canvasState.nodes.find((node) => node.id === layerId).metadata.content = dataUrl(PNG_RED);
    return result;
  });
  await assert.rejects(f.canvas.mechanicalOperation(task.id, {
    operation: 'compose', nodeId: baseId, layers: [{ nodeId: layerId, x: 0, y: 0, width: 1, height: 1 }],
    expectedRevision: task.revision, operationId: changedOperationId, requestId: crypto.randomUUID(),
    callId: changedOperationId, userText: '复合期间图片被改动时应拒绝确认。',
  }), (error) => error.code === 'ERR_CANVAS_SOURCE_CHANGED');
  assert.equal(f.generationCalls.length, 0, 'stitch and compose never call image generation');
  assert.equal((await readTask(task.id, f.root)).revision, task.revision);
});

test('import is task scoped, hash bound, stable across repeats, and does not create duplicate attachments', async (t) => {
  const f = await createFixture(t, { secondTask: true });
  const { task, source } = await addUploadedPng(f);
  const importOperationId = crypto.randomUUID();
  const importPayload = {
    operation: 'import', image: { sourceId: source.id, fileOrder: 1 }, expectedRevision: task.revision,
    operationId: importOperationId, requestId: crypto.randomUUID(), callId: importOperationId,
    userText: '把本轮上传图片导入当前画布。',
  };
  const imported = await f.canvas.mechanicalOperation(task.id, importPayload);
  assert.deepEqual(imported.attachments, []);
  assert.equal(imported.result.operation, 'import');
  assert.match(imported.result.sourceNodeId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(imported.result.images, [{ nodeId: imported.result.sourceNodeId, width: 1, height: 1 }]);
  assert.equal(f.imageOperations.filter((item) => item.name === 'canvas_import_image').length, 1);
  assert.equal(f.imageOperations.find((item) => item.name === 'canvas_import_image').input.dataUrlSha256, digest(PNG_RED));
  assert.deepEqual(await readTask(task.id, f.root), task, 'import leaves task decisions and confirmations unchanged');

  const recordPath = path.join(f.root, 'tasks', task.id, 'canvas-operations', `${importOperationId}.json`);
  const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  assert.deepEqual(record.sourceBinding, { type: 'task-upload', sourceId: source.id, fileOrder: 1, sha256: digest(PNG_RED) });
  assert.doesNotMatch(JSON.stringify(record), /data:image|iVBORw0KGgo|用户上传图\.png|把本轮上传图片导入当前画布/);

  const repeatedId = crypto.randomUUID();
  const repeated = await f.canvas.mechanicalOperation(task.id, {
    ...importPayload, operationId: repeatedId, callId: repeatedId, requestId: crypto.randomUUID(),
  });
  assert.equal(repeated.result.sourceNodeId, imported.result.sourceNodeId);
  assert.equal(f.imageOperations.filter((item) => item.name === 'canvas_import_image').length, 1, 'same task attachment reuses its stable Canvas node');
  assert.equal(repeated.attachments.length, 0, 'source attachment bytes are not returned as another chat attachment');

  f.canvases.get(task.id).nodes.find((node) => node.id === imported.result.sourceNodeId).metadata.content = dataUrl(PNG_BLUE);
  const conflictingId = crypto.randomUUID();
  await assert.rejects(f.canvas.mechanicalOperation(task.id, {
    ...importPayload, operationId: conflictingId, callId: conflictingId, requestId: crypto.randomUUID(),
  }), (error) => error.code === 'ERR_CANVAS_OPERATION_INPUT');
  assert.equal(f.imageOperations.filter((item) => item.name === 'canvas_import_image').length, 1, 'an existing stable node with different bytes is never overwritten');

  const uploadedFilePath = path.join(f.root, 'tasks', task.id, source.files[0].relativePath);
  await fs.writeFile(uploadedFilePath, PNG_BLUE);
  const tamperedId = crypto.randomUUID();
  await assert.rejects(f.canvas.mechanicalOperation(task.id, {
    ...importPayload, operationId: tamperedId, callId: tamperedId, requestId: crypto.randomUUID(),
  }), (error) => error.code === 'ERR_CANVAS_OPERATION_INPUT');
  assert.equal(f.imageOperations.filter((item) => item.name === 'canvas_import_image').length, 1, 'a changed task file fails its saved SHA before Canvas submission');

  const secondTask = f.tasks[1];
  await assert.rejects(f.canvas.mechanicalOperation(secondTask.id, {
    ...importPayload, expectedRevision: secondTask.revision, operationId: crypto.randomUUID(),
    callId: crypto.randomUUID(), requestId: crypto.randomUUID(),
  }), (error) => error.code === 'ERR_CANVAS_OPERATION_INPUT');

  const excluded = await setSources(task.id, task.sources.map((item) => ({ ...item, decision: 'excluded' })), {
    root: f.root, expectedRevision: task.revision,
  });
  await assert.rejects(f.canvas.mechanicalOperation(task.id, {
    ...importPayload, expectedRevision: excluded.revision, operationId: crypto.randomUUID(),
    callId: crypto.randomUUID(), requestId: crypto.randomUUID(),
  }), (error) => error.code === 'ERR_CANVAS_OPERATION_INPUT');
  assert.equal(f.imageOperations.filter((item) => item.name === 'canvas_import_image').length, 1);
  assert.equal(f.generationCalls.length, 0, 'import does not invoke AI or write source bytes into task evidence');
});

test('pixel operations reject noninteger or out-of-bounds rectangles before bridge submission', async (t) => {
  const f = await createFixture(t);
  const task = await readTask(f.task.id, f.root);
  const nodeId = `image-${task.id}`;
  const before = f.imageOperations.length;
  const base = {
    operation: 'compose', nodeId, expectedRevision: task.revision,
    requestId: crypto.randomUUID(), userText: '检查合成坐标校验。',
  };
  await assert.rejects(f.canvas.mechanicalOperation(task.id, {
    ...base, operationId: crypto.randomUUID(), callId: crypto.randomUUID(),
    layers: [{ nodeId, x: 0.5, y: 0, width: 1, height: 1 }],
  }), (error) => error.code === 'ERR_CANVAS_OPERATION_INPUT');
  await assert.rejects(f.canvas.mechanicalOperation(task.id, {
    ...base, operationId: crypto.randomUUID(), callId: crypto.randomUUID(),
    layers: [{ nodeId, x: 0, y: 0, width: 2, height: 1 }],
  }), (error) => error.code === 'ERR_CANVAS_OPERATION_INPUT');
  assert.equal(f.imageOperations.length, before);
});

test('compose records all 21 unique source hashes for a base and twenty distinct layers', async (t) => {
  const f = await createFixture(t);
  const task = await readTask(f.task.id, f.root);
  const canvasState = f.canvases.get(task.id);
  const baseId = `image-${task.id}`;
  const base = canvasState.nodes.find((node) => node.id === baseId);
  base.metadata.naturalWidth = 32;
  base.metadata.naturalHeight = 32;
  const layerIds = Array.from({ length: 20 }, (_, index) => `distinct-layer-${index + 1}-${task.id}`);
  for (const [index, id] of layerIds.entries()) {
    canvasState.nodes.push({
      id, type: 'image', title: `图层 ${index + 1}`, position: { x: 20 + index, y: 20 }, width: 1, height: 1,
      metadata: { content: dataUrl(PNG_BLUE), naturalWidth: 1, naturalHeight: 1 },
    });
  }
  const operationId = crypto.randomUUID();
  const result = await f.canvas.mechanicalOperation(task.id, {
    operation: 'compose', nodeId: baseId,
    layers: layerIds.map((nodeId) => ({ nodeId, x: 0, y: 0, width: 1, height: 1 })),
    expectedRevision: task.revision, operationId, requestId: crypto.randomUUID(),
    callId: operationId, userText: '记录底图和全部二十个不同图层。',
  });
  const sourceNodeIds = [baseId, ...layerIds];
  assert.deepEqual(result.result.sourceNodeIds, sourceNodeIds);
  const recordPath = path.join(f.root, 'tasks', task.id, 'canvas-operations', `${operationId}.json`);
  const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  assert.deepEqual(record.sourceBindings.map((source) => source.nodeId), sourceNodeIds);
  assert.deepEqual(record.sourceBindings.map((source) => source.sha256), [digest(PNG_RED), ...layerIds.map(() => digest(PNG_BLUE))]);
  assert.equal(result.attachments.length, 1);
  assert.equal(f.generationCalls.length, 0);
});

test('compose accepts the 32 Mi-pixel boundary and rejects the first larger source before submission', async (t) => {
  const f = await createFixture(t);
  const task = await readTask(f.task.id, f.root);
  const baseId = `image-${task.id}`;
  const base = f.canvases.get(task.id).nodes.find((node) => node.id === baseId);
  base.metadata.naturalWidth = 16_384;
  base.metadata.naturalHeight = 2_048;
  const acceptedId = crypto.randomUUID();
  const accepted = await f.canvas.mechanicalOperation(task.id, {
    operation: 'compose', nodeId: baseId, layers: [{ nodeId: baseId, x: 0, y: 0, width: 1, height: 1 }],
    expectedRevision: task.revision, operationId: acceptedId, requestId: crypto.randomUUID(),
    callId: acceptedId, userText: '使用完整的32 Mi像素边界。',
  });
  assert.equal(accepted.result.images[0].width * accepted.result.images[0].height, 32 * 1024 * 1024);
  const composeSubmits = f.imageOperations.filter((item) => item.name === 'canvas_compose_images').length;

  base.metadata.naturalHeight = 2_049;
  await assert.rejects(f.canvas.mechanicalOperation(task.id, {
    operation: 'compose', nodeId: baseId, layers: [{ nodeId: baseId, x: 0, y: 0, width: 1, height: 1 }],
    expectedRevision: task.revision, operationId: crypto.randomUUID(), requestId: crypto.randomUUID(),
    callId: crypto.randomUUID(), userText: '超出32 Mi像素边界时不降采样。',
  }), (error) => error.code === 'ERR_CANVAS_OPERATION_INPUT');
  assert.equal(f.imageOperations.filter((item) => item.name === 'canvas_compose_images').length, composeSubmits);
});

test('operation ledger rejects over-limit and malformed source hash bindings explicitly', async (t) => {
  const f = await createFixture(t);
  const bindings = (count) => Array.from({ length: count }, (_, index) => ({ nodeId: `source-${index + 1}`, sha256: digest(PNG_RED) }));
  const invoke = (operationId, sourceBindings) => runCanvasOperation({
    root: f.root, taskId: f.task.id, operationId, requestId: crypto.randomUUID(), callId: operationId,
    userText: '记录来源哈希。', expectedRevision: f.task.revision, operation: 'compose', nodeId: 'base', input: {},
    run: async ({ markSubmitted }) => {
      await markSubmitted({ sourceBindings });
      return { result: {}, attachments: [] };
    },
  });
  await assert.rejects(invoke(crypto.randomUUID(), bindings(22)), (error) => error.code === 'ERR_CANVAS_OPERATION_INPUT');
  await assert.rejects(invoke(crypto.randomUUID(), [
    { nodeId: 'duplicate-source', sha256: digest(PNG_RED) },
    { nodeId: 'duplicate-source', sha256: digest(PNG_BLUE) },
  ]), (error) => error.code === 'ERR_CANVAS_OPERATION_INPUT');
});

