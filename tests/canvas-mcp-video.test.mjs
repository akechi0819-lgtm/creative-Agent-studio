import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { chromium } from 'playwright';
import { createCompanyCanvasMcp } from '../src/canvas/mcp.mjs';
import { createCanvasRuntime } from '../src/canvas/runtime.mjs';
import { saveVideoConfig } from '../src/lite/config.mjs';

const mp4 = Buffer.from([
  0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0,
  0, 0, 0, 12, 0x6d, 0x64, 0x61, 0x74, 1, 2, 3, 4,
]);
const digest = createHash('sha256').update(mp4).digest('hex');

test('Lite MCP submits H3 through an explicit Canvas node flow and saves its completed video child', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-lite-video-mcp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await saveVideoConfig({ expectedRevision: 1, video: { apiKey: 'fixture-h3-key' } }, { root });
  const calls = [];
  const runtime = {
    status: async () => ({ running: false, targets: [] }),
    open: async (input) => ({ opened: input }),
    call: async (name, input, target) => {
      calls.push({ name, input, target });
      if (name === 'canvas_get_state') return {
        projectId: 'project-1',
        nodes: [{ id: 'existing-image', type: 'image', position: { x: 20, y: 40 }, width: 500, height: 300, metadata: {} }],
        connections: [],
      };
      if (name === 'canvas_apply_ops') return { ok: true };
      if (name === 'generation_get_status') return {
        total: 1, summary: { idle: 0, queued: 0, running: 0, succeeded: 1, failed: 0 },
        tasks: [{ id: 'video-node-1', source: 'canvas', status: 'succeeded' }],
      };
      if (name === 'canvas_read_video') return {
        nodeId: input.nodeId,
        dataUrl: `data:video/mp4;base64,${mp4.toString('base64')}`,
        mimeType: 'video/mp4',
        bytes: mp4.length,
        width: 640,
        height: 360,
        durationMs: 4000,
        sha256: digest,
        storageKey: 'video:fixture',
      };
      return { ok: true };
    },
  };
  const server = createCompanyCanvasMcp({ root, runtime });
  const client = new Client({ name: 'fixture-host', version: '1' });
  const [host, studio] = InMemoryTransport.createLinkedPair();
  await server.connect(host);
  await client.connect(studio);
  t.after(() => client.close());
  t.after(() => server.close());

  const toolDefinitions = (await client.listTools()).tools;
  const names = toolDefinitions.map((tool) => tool.name);
  const statusSchema = toolDefinitions.find((tool) => tool.name === 'generation_get_status').inputSchema;
  assert.ok(names.includes('canvas_generate_video'));
  assert.ok(names.includes('generation_get_status'));
  assert.ok(names.includes('canvas_save_video'));
  assert.ok(statusSchema.properties.nodeIds);
  assert.equal(statusSchema.properties.taskId, undefined);
  assert.ok(!names.includes('workbench_video_generate'));
  assert.ok(!names.includes('canvas_read_video'), 'raw video data stays inside the local wrapper');
  assert.ok(!names.some((name) => /task|approval|assets/.test(name)));

  const generated = await client.callTool({
    name: 'canvas_generate_video',
    arguments: {
      prompt: 'A cobalt glass bird turns gently in a quiet studio.',
      size: '9:16',
      seconds: '6',
      resolution: '2K',
      model: 'studio-video::minimax_h3',
      projectId: 'project-1',
      clientId: 'client-1',
    },
  });
  assert.equal(generated.isError, undefined);
  const submitted = JSON.parse(generated.content[0].text);
  assert.equal(submitted.submitted, true);
  assert.equal(submitted.model, 'studio-video::minimax_h3');
  assert.equal(submitted.size, '9:16');
  assert.equal(submitted.seconds, '6');
  assert.equal(submitted.resolution, '2K');
  assert.match(submitted.sourceNodeId, /^config-/);
  assert.match(submitted.textNodeId, /^text-/);
  assert.deepEqual(calls[0], { name: 'canvas_get_state', input: {}, target: { projectId: 'project-1', clientId: 'client-1' } });
  const opsCall = calls[1];
  assert.equal(opsCall.name, 'canvas_apply_ops');
  assert.deepEqual(opsCall.target, { projectId: 'project-1', clientId: 'client-1' });
  const ops = opsCall.input.ops;
  assert.deepEqual(ops.map((op) => op.type), ['add_node', 'add_node', 'connect_nodes', 'select_nodes', 'run_generation']);
  assert.equal(ops[0].id, submitted.textNodeId);
  assert.equal(ops[0].metadata.content, 'A cobalt glass bird turns gently in a quiet studio.');
  assert.equal(ops[1].id, submitted.sourceNodeId);
  assert.deepEqual(ops[1].metadata, {
    generationMode: 'video', composerContent: 'A cobalt glass bird turns gently in a quiet studio.', prompt: 'A cobalt glass bird turns gently in a quiet studio.', status: 'idle',
    model: 'studio-video::minimax_h3', size: '9:16', seconds: '6', vquality: '2K',
  });
  assert.equal(ops[2].fromNodeId, submitted.textNodeId);
  assert.equal(ops[2].toNodeId, submitted.sourceNodeId);
  assert.deepEqual(ops[4], { type: 'run_generation', nodeId: submitted.sourceNodeId, mode: 'video', prompt: 'A cobalt glass bird turns gently in a quiet studio.' });

  const status = await client.callTool({
    name: 'generation_get_status',
    arguments: { scope: 'canvas', nodeIds: ['video-node-1'], projectId: 'project-1', clientId: 'client-1' },
  });
  assert.equal(JSON.parse(status.content[0].text).tasks[0].status, 'succeeded');
  assert.deepEqual(calls[2], {
    name: 'generation_get_status',
    input: { scope: 'canvas', nodeIds: ['video-node-1'] },
    target: { projectId: 'project-1', clientId: 'client-1' },
  });
  const beforeWorkbenchStatus = calls.length;
  const workbenchStatus = await client.callTool({
    name: 'generation_get_status',
    arguments: { scope: 'video', taskId: 'unrelated-workbench-task', projectId: 'project-1', clientId: 'client-1' },
  });
  assert.equal(workbenchStatus.isError, true);
  assert.equal(calls.length, beforeWorkbenchStatus, 'Lite does not expose video workbench task IDs');

  const fileResult = await client.callTool({
    name: 'canvas_save_video',
    arguments: { nodeId: 'video-node-1', projectId: 'project-1', clientId: 'client-1' },
  });
  const saved = JSON.parse(fileResult.content[0].text);
  assert.equal(saved.mimeType, 'video/mp4');
  assert.equal(saved.width, 640);
  assert.equal(saved.height, 360);
  assert.equal(saved.durationMs, 4000);
  assert.equal(saved.sha256, digest);
  assert.deepEqual(await fs.readFile(saved.path), mp4);
  assert.equal(calls[3].name, 'canvas_read_video');
  assert.equal(calls[3].input.nodeId, 'video-node-1');
  assert.deepEqual(calls[3].target, { projectId: 'project-1', clientId: 'client-1' });

  const beforeUnsupported = calls.length;
  const unsupported = await client.callTool({
    name: 'canvas_generate_video',
    arguments: { prompt: 'must not run', mode: 'reference' },
  });
  assert.equal(unsupported.isError, true);
  const reference = await client.callTool({
    name: 'canvas_generate_video',
    arguments: { prompt: 'must not run', referenceNodeIds: ['image-1'] },
  });
  assert.equal(reference.isError, true);
  const audio = await client.callTool({
    name: 'canvas_generate_video',
    arguments: { prompt: 'must not run', generateAudio: true },
  });
  assert.equal(audio.isError, true);
  assert.equal(calls.length, beforeUnsupported, 'unsupported modes and references do not reach the Canvas bridge');
});

test('an uncertain Canvas bridge submission returns the exact nodes to inspect and never reports success', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-lite-video-unknown-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await saveVideoConfig({ expectedRevision: 1, video: { apiKey: 'fixture-h3-key' } }, { root });
  const calls = [];
  const runtime = {
    status: async () => ({}),
    open: async () => ({}),
    call: async (name, input) => {
      calls.push({ name, input });
      if (name === 'canvas_get_state') return { nodes: [], connections: [] };
      if (name === 'canvas_apply_ops') throw new Error('simulated lost bridge response');
      throw new Error(`unexpected ${name}`);
    },
  };
  const server = createCompanyCanvasMcp({ root, runtime });
  const client = new Client({ name: 'fixture-host', version: '1' });
  const [host, studio] = InMemoryTransport.createLinkedPair();
  await server.connect(host);
  await client.connect(studio);
  t.after(() => client.close());
  t.after(() => server.close());

  const result = await client.callTool({ name: 'canvas_generate_video', arguments: { prompt: 'local fixture only' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /结果未知/);
  assert.match(result.content[0].text, /不要再次调用 canvas_generate_video/);
  assert.match(result.content[0].text, /sourceNodeId=config-[a-f\d-]+/);
  assert.match(result.content[0].text, /textNodeId=text-[a-f\d-]+/);
  assert.equal(calls.filter((item) => item.name === 'canvas_apply_ops').length, 1);
});

test('Lite MCP refuses H3 submission until the local video key is configured', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-lite-video-unconfigured-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const runtime = { status: async () => ({}), open: async () => ({}), call: async (...args) => { calls.push(args); return {}; } };
  const server = createCompanyCanvasMcp({ root, runtime });
  const client = new Client({ name: 'fixture-host', version: '1' });
  const [host, studio] = InMemoryTransport.createLinkedPair();
  await server.connect(host);
  await client.connect(studio);
  t.after(() => client.close());
  t.after(() => server.close());
  const result = await client.callTool({ name: 'canvas_generate_video', arguments: { prompt: 'not submitted' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /configure-video/);
  assert.equal(calls.length, 0);
});

test('real MCP Canvas generation submits one fake H3 request, completes a video child, and saves matching MP4 SHA-256', { timeout: 180_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-lite-video-canvas-'));
  await saveVideoConfig({ expectedRevision: 1, video: { apiKey: 'fixture-h3-key-never-sent-to-provider' } }, { root });
  const runtime = createCanvasRuntime({ root });
  let browser;
  let context;
  let client;
  let server;
  const providerRequests = [];
  const rawProviderRequests = [];
  t.after(async () => {
    await client?.close().catch(() => {});
    await server?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await runtime.stop().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });

  const instance = await runtime.ensure();
  const launch = await runtime.open({ browser: false, mode: 'new' });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  const localOrigins = new Set([instance.webUrl, instance.bridgeUrl].map((value) => new URL(value).origin));
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'api.osodm.com') {
      rawProviderRequests.push(url.href);
      return route.abort();
    }
    if (localOrigins.has(url.origin)) {
      if (url.pathname.startsWith('/__studio/video-proxy/')) {
        const target = decodeURIComponent(url.pathname.slice('/__studio/video-proxy/'.length));
        const targetUrl = new URL(target);
        const method = route.request().method();
        const headers = route.request().headers();
        assert.equal(headers.authorization, undefined, 'the browser request does not contain an H3 API key');
        const request = { method, url: target, body: route.request().postData() };
        providerRequests.push(request);
        if (method === 'POST' && targetUrl.pathname === '/v1/videos') {
          assert.equal(headers['content-type'], 'application/json');
          assert.deepEqual(JSON.parse(request.body), {
            version: 'video.v1',
            model: 'minimax_h3',
            operation: 'text_to_video',
            prompt: 'A cobalt glass bird turns gently in a quiet studio.',
            duration_seconds: 4,
            resolution: '768',
            aspect_ratio: '16:9',
          });
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'synthetic-h3-video-1', status: 'queued' }) });
        }
        if (method === 'GET' && targetUrl.pathname === '/v1/videos/synthetic-h3-video-1') {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'synthetic-h3-video-1', status: 'completed' }) });
        }
        if (method === 'GET' && targetUrl.pathname === '/v1/videos/synthetic-h3-video-1/content') {
          return route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from(fixtureBytes) });
        }
        throw new Error(`unexpected fake H3 route: ${method} ${target}`);
      }
      return route.continue();
    }
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(launch.openUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /^\/canvas\/[A-Za-z0-9_-]+$/.test(location.pathname), { timeout: 30_000 });
  const projectId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1));
  const target = await waitForCanvasTarget(runtime, projectId);
  const fixture = await makePlayableMp4(page);
  const fixtureBytes = Buffer.from(fixture.base64, 'base64');

  server = createCompanyCanvasMcp({ root, runtime });
  client = new Client({ name: 'fixture-host', version: '1' });
  const [host, studio] = InMemoryTransport.createLinkedPair();
  await server.connect(host);
  await client.connect(studio);
  const result = await client.callTool({
    name: 'canvas_generate_video',
    arguments: {
      prompt: 'A cobalt glass bird turns gently in a quiet studio.',
      size: '16:9',
      seconds: '4',
      resolution: '768',
      projectId,
      clientId: target.clientId,
    },
  });
  assert.equal(result.isError, undefined, result.content?.map((item) => item.text || '').join('\n'));
  const submitted = JSON.parse(result.content[0].text);
  assert.equal(submitted.submitted, true);
  assert.match(submitted.sourceNodeId, /^config-/);
  assert.match(submitted.textNodeId, /^text-/);
  const child = await waitForGeneratedVideoChild(runtime, target, submitted.sourceNodeId);
  assert.ok(providerRequests.some((request) => request.method === 'POST'), 'the fake H3 received a native Canvas generation request');
  assert.equal(providerRequests.filter((request) => request.method === 'POST').length, 1, 'the H3 generation was submitted exactly once');
  assert.ok(providerRequests.some((request) => request.method === 'GET' && request.url.endsWith('/v1/videos/synthetic-h3-video-1')));
  assert.ok(providerRequests.some((request) => request.method === 'GET' && request.url.endsWith('/v1/videos/synthetic-h3-video-1/content')));
  assert.deepEqual(rawProviderRequests, [], 'the browser never calls the provider directly');

  assert.notEqual(child.id, submitted.sourceNodeId, 'the saved media is the generated child, not a pre-created video node');
  assert.equal(child.type, 'video');
  assert.equal(child.metadata.status, 'success');
  assert.ok(child.metadata.storageKey.startsWith('video:'));
  const statusResult = await client.callTool({
    name: 'generation_get_status',
    arguments: { scope: 'canvas', nodeIds: [child.id], projectId, clientId: target.clientId },
  });
  assert.equal(JSON.parse(statusResult.content[0].text).tasks[0].status, 'succeeded');

  const savedResult = await client.callTool({
    name: 'canvas_save_video',
    arguments: { nodeId: child.id, projectId, clientId: target.clientId },
  });
  assert.equal(savedResult.isError, undefined, savedResult.content?.map((item) => item.text || '').join('\n'));
  const saved = JSON.parse(savedResult.content[0].text);
  const savedBytes = await fs.readFile(saved.path);
  const expectedHash = createHash('sha256').update(Buffer.from(fixture.base64, 'base64')).digest('hex');
  assert.equal(saved.nodeId, child.id);
  assert.equal(saved.mimeType, 'video/mp4');
  assert.equal(saved.width, fixture.width);
  assert.equal(saved.height, fixture.height);
  assert.ok(Math.abs(saved.durationMs - fixture.durationMs) <= 250);
  assert.equal(saved.bytes, fixture.bytes);
  assert.equal(saved.sha256, expectedHash);
  assert.equal(createHash('sha256').update(savedBytes).digest('hex'), expectedHash);
  assert.deepEqual(savedBytes, Buffer.from(fixture.base64, 'base64'));
  assert.equal(providerRequests.filter((request) => request.method === 'POST').length, 1);
});

async function waitForGeneratedVideoChild(runtime, target, sourceNodeId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await runtime.call('canvas_get_state', {}, target);
    const source = state.nodes.find((node) => node.id === sourceNodeId);
    if (source?.metadata?.status === 'error') throw new Error(source.metadata.errorDetails || `sourceNodeId=${sourceNodeId} failed`);
    const connections = state.connections || state.edges || [];
    const children = connections
      .filter((edge) => edge.fromNodeId === sourceNodeId)
      .map((edge) => state.nodes.find((node) => node.id === edge.toNodeId))
      .filter((node) => node?.type === 'video');
    const child = children[0];
    if (child?.metadata?.status === 'error') throw new Error(child.metadata.errorDetails || 'fake H3 generated video failed');
    if (children.length === 1 && child?.metadata?.status === 'success' && child.metadata.storageKey) return child;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待 sourceNodeId=${sourceNodeId} 的 video child 完成超时`);
}

async function waitForCanvasTarget(runtime, projectId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await runtime.status();
    const target = status.targets.find((item) => item.projectId === projectId && item.hasCanvas);
    if (target) return target;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待项目 ${projectId} 的 Canvas 连接超时`);
}

async function makePlayableMp4(page) {
  return page.evaluate(async () => {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported('video/mp4')) {
      throw new Error('当前 Playwright Chromium 不支持 MediaRecorder video/mp4');
    }
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d');
    if (!context || typeof canvas.captureStream !== 'function') throw new Error('当前 Chromium 无法录制合成视频');
    const stream = canvas.captureStream(24);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/mp4', videoBitsPerSecond: 320_000 });
    const chunks = [];
    recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
    const stopped = new Promise((resolve, reject) => {
      recorder.addEventListener('stop', resolve, { once: true });
      recorder.addEventListener('error', () => reject(new Error('合成 MP4 录制失败')), { once: true });
    });
    recorder.start(250);
    const start = performance.now();
    while (performance.now() - start < 4_000) {
      const elapsed = performance.now() - start;
      context.fillStyle = `hsl(${Math.floor(elapsed / 20) % 360} 70% 45%)`;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#fff';
      context.font = '24px sans-serif';
      context.fillText('Synthetic Studio Video', 18, 94);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    recorder.stop();
    await stopped;
    for (const track of stream.getTracks()) track.stop();
    const recording = new Blob(chunks, { type: 'video/mp4' });
    if (!recording.size) throw new Error('MediaRecorder 没有写入视频字节');
    const url = URL.createObjectURL(recording);
    try {
      const video = document.createElement('video');
      video.muted = true;
      video.src = url;
      await new Promise((resolve, reject) => {
        video.addEventListener('loadedmetadata', resolve, { once: true });
        video.addEventListener('error', () => reject(new Error('合成 MP4 无法读取元数据')), { once: true });
      });
      await video.play();
      video.pause();
      if (video.videoWidth !== canvas.width || video.videoHeight !== canvas.height || !Number.isFinite(video.duration) || video.duration <= 0) {
        throw new Error('合成 MP4 未通过真实解码检查');
      }
      const bytes = await recording.arrayBuffer();
      let binary = '';
      for (const value of new Uint8Array(bytes)) binary += String.fromCharCode(value);
      return {
        base64: btoa(binary),
        bytes: recording.size,
        width: video.videoWidth,
        height: video.videoHeight,
        durationMs: Math.round(video.duration * 1000),
      };
    } finally { URL.revokeObjectURL(url); }
  });
}
