import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';

import { createCanvasRuntime } from '../src/canvas/runtime.mjs';
import { saveConfig } from '../src/lite/config.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const busyMessage = '该节点正在生成图片，请先查询 generation_get_status，完成后再生成。';
const missingConfigMessage = '图片服务尚未配置，请回到宿主智能体配置图片 API。';

test('canvas_run_generation acknowledges submission, rejects busy/missing config, and releases pre-submit failures', { timeout: 240_000 }, async (t) => {
  const roots = [];
  const scenarios = [];
  const previousProxyEnv = Object.fromEntries(['NO_PROXY', 'no_proxy'].map((key) => [key, process.env[key]]));
  process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
  process.env.no_proxy = [process.env.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(',');

  const mock = await createHeldImageServer();
  let browser;
  t.after(async () => {
    for (const request of mock.requests) if (!request.released) request.release();
    for (const scenario of scenarios.reverse()) await closeScenario(scenario);
    await browser?.close().catch(() => {});
    await mock.close();
    for (const root of roots) await fs.rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousProxyEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  browser = await chromium.launch({ headless: true });

  const configuredRoot = await makeRoot(roots, 'company-lite-generation-configured-');
  await saveConfig({
    expectedRevision: 1,
    image: { baseUrl: `${mock.baseUrl}/v1`, model: 'mock-image', apiKey: 'local-only-mock-key' },
  }, { root: configuredRoot });
  const configured = await createScenario({ root: configuredRoot, browser, scenarios });
  mock.setPng(await createFixturePng(configured.page));

  const createdReference = await configured.runtime.call('canvas_create_node', {
    nodeType: 'image',
    title: '故意损坏的本机参考图',
    metadata: { content: 'http://127.0.0.1:1/unavailable.png', mimeType: 'image/png', status: 'success' },
  }, configured.target);
  const imageNodeId = createdReference.nodes.find((node) => node.type === 'image')?.id;
  assert.ok(imageNodeId, 'broken reference fixture is present');
  await configured.runtime.call('canvas_create_config_node', {
    prompt: `绘制蓝色方块 @[node:${imageNodeId}]`,
  }, configured.target);
  const configState = await configured.runtime.call('canvas_get_state', {}, configured.target);
  const configNode = configState.nodes.find((node) => node.type === 'config');
  assert.ok(configNode, 'configured scenario contains an image configuration node');
  await configured.runtime.call('canvas_connect_nodes', {
    connections: [{ fromNodeId: imageNodeId, toNodeId: configNode.id }],
  }, configured.target);

  const failedReferenceArgs = toolArgs(configured.target, { nodeId: configNode.id, mode: 'image' });
  const failedReference = await configured.mcp.callTool({ name: 'canvas_run_generation', arguments: failedReferenceArgs });
  assert.equal(failedReference.isError, true, 'unreadable reference fails before generation submission');
  assert.equal(mock.requests.length, 0, 'reference hydration failure does not call the image API');
  const retryAfterReferenceFailure = await configured.mcp.callTool({ name: 'canvas_run_generation', arguments: failedReferenceArgs });
  assert.equal(retryAfterReferenceFailure.isError, true);
  assert.doesNotMatch(mcpErrorText(retryAfterReferenceFailure), new RegExp(escapeRegExp(busyMessage)), 'pre-submit failure releases the node lock');
  assert.equal(mock.requests.length, 0);

  await configured.runtime.call('canvas_update_node', {
    id: configNode.id,
    metadata: { composerContent: '绘制一个蓝色方块', prompt: '绘制一个蓝色方块' },
  }, configured.target);

  const runArgs = toolArgs(configured.target, { nodeId: configNode.id, mode: 'image' });
  const firstSubmitted = await withTimeout(
    configured.mcp.callTool({ name: 'canvas_run_generation', arguments: runArgs }),
    20_000,
    'canvas_run_generation submission acknowledgement while the mock response is held',
  );
  assert.notEqual(firstSubmitted.isError, true, mcpErrorText(firstSubmitted));
  assert.deepEqual(parseMcpJson(firstSubmitted), { submitted: true, nodeId: configNode.id });
  await waitUntil(() => mock.requests.length === 1, 'first upstream mock request');
  assert.equal(mock.requests[0].released, false, 'the API response is still held when MCP acknowledges submission');

  const busy = await configured.mcp.callTool({ name: 'canvas_run_generation', arguments: runArgs });
  assert.equal(busy.isError, true, 'a duplicate request is rejected');
  assert.match(mcpErrorText(busy), new RegExp(escapeRegExp(busyMessage)));
  assert.equal(mock.requests.length, 1, 'busy rejection does not submit a second POST');

  const applyOpsRetry = await configured.mcp.callTool({
    name: 'canvas_apply_ops',
    arguments: toolArgs(configured.target, { ops: [{ type: 'run_generation', nodeId: configNode.id, mode: 'image', prompt: '重复请求' }] }),
  });
  assert.notEqual(applyOpsRetry.isError, true, mcpErrorText(applyOpsRetry));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(mock.requests.length, 1, 'canvas_apply_ops uses the same busy guard and cannot duplicate the POST');

  const flowResult = await configured.mcp.callTool({
    name: 'canvas_generate_image',
    arguments: toolArgs(configured.target, { prompt: '绘制一个黄色圆形', title: '自动生成流程' }),
  });
  assert.notEqual(flowResult.isError, true, mcpErrorText(flowResult));
  const flowSnapshot = parseMcpJson(flowResult);
  const flowNode = flowSnapshot.nodes.find((node) => node.type === 'config' && node.id !== configNode.id);
  assert.ok(flowNode, 'canvas_generate_image returns the flow configuration node');
  await waitUntil(() => mock.requests.length === 2, 'image request from canvas_generate_image autoRun');
  const busyFlow = await configured.mcp.callTool({
    name: 'canvas_run_generation',
    arguments: toolArgs(configured.target, { nodeId: flowNode.id, mode: 'image' }),
  });
  assert.equal(busyFlow.isError, true, 'canvas_generate_image autoRun registers its node as busy');
  assert.match(mcpErrorText(busyFlow), new RegExp(escapeRegExp(busyMessage)));
  assert.equal(mock.requests.length, 2, 'a direct call cannot repeat an autoRun flow POST');

  mock.requests[0].release();
  mock.requests[1].release();
  await waitUntil(async () => {
    const state = await configured.runtime.call('canvas_get_state', {}, configured.target);
    return state.nodes.find((node) => node.id === configNode.id)?.metadata?.status === 'success'
      && state.nodes.find((node) => node.id === flowNode.id)?.metadata?.status === 'success';
  }, 'both held image generations to finish');

  const secondSubmitted = await withTimeout(
    configured.mcp.callTool({ name: 'canvas_run_generation', arguments: runArgs }),
    20_000,
    'second generation after the first has finished',
  );
  assert.notEqual(secondSubmitted.isError, true, mcpErrorText(secondSubmitted));
  assert.deepEqual(parseMcpJson(secondSubmitted), { submitted: true, nodeId: configNode.id });
  await waitUntil(() => mock.requests.length === 3, 'second upstream mock request for the original node');
  assert.equal(mock.requests[2].released, false);
  mock.requests[2].release();
  await waitUntil(async () => {
    const state = await configured.runtime.call('canvas_get_state', {}, configured.target);
    return state.nodes.find((node) => node.id === configNode.id)?.metadata?.status === 'success';
  }, 'second image generation to finish');

  const missingRoot = await makeRoot(roots, 'company-lite-generation-missing-');
  const missing = await createScenario({ root: missingRoot, browser, scenarios });
  await missing.runtime.call('canvas_create_config_node', { prompt: '绘制一个红色圆形' }, missing.target);
  const missingState = await missing.runtime.call('canvas_get_state', {}, missing.target);
  const missingNode = missingState.nodes.find((node) => node.type === 'config');
  assert.ok(missingNode);
  const requestCountBeforeMissingConfig = mock.requests.length;
  const missingResponse = await missing.mcp.callTool({
    name: 'canvas_run_generation',
    arguments: toolArgs(missing.target, { nodeId: missingNode.id, mode: 'image' }),
  });
  assert.equal(missingResponse.isError, true, 'missing image configuration is an explicit tool error');
  assert.match(mcpErrorText(missingResponse), new RegExp(escapeRegExp(missingConfigMessage)));
  assert.equal(mock.requests.length, requestCountBeforeMissingConfig, 'missing configuration never reaches the image API');
});

async function createScenario({ root, browser, scenarios }) {
  const runtime = createCanvasRuntime({ root });
  const scenario = { runtime };
  scenarios.push(scenario);
  const instance = await runtime.ensure();
  const launch = await runtime.open({ browser: false, mode: 'new' });
  scenario.context = await browser.newContext();
  await allowLocalStudioOrigins(scenario.context, [instance.webUrl, instance.bridgeUrl]);
  scenario.page = await scenario.context.newPage();
  scenario.page.on('pageerror', (error) => { scenario.pageError ||= error.message; });
  await scenario.page.goto(launch.openUrl, { waitUntil: 'domcontentloaded' });
  const projectId = await waitForProjectRoute(scenario.page);
  scenario.target = await waitForCanvasTarget(runtime, projectId);
  scenario.transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, 'scripts/canvas-mcp.mjs')],
    env: { STUDIO_DATA_DIR: root, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    stderr: 'pipe',
  });
  scenario.mcp = new Client({ name: 'canvas-generation-submission-test', version: '1.0.0' }, { capabilities: {} });
  await scenario.mcp.connect(scenario.transport);
  return scenario;
}

async function closeScenario(scenario) {
  await scenario.mcp?.close().catch(() => {});
  await scenario.transport?.close().catch(() => {});
  await scenario.context?.close().catch(() => {});
  await scenario.runtime?.stop().catch(() => {});
}

async function createHeldImageServer() {
  const requests = [];
  let png = '';
  const server = http.createServer((request, response) => {
    const record = { released: false, release: null };
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    record.release = () => { record.released = true; release(); };
    requests.push(record);
    request.resume();
    void gate.then(() => {
      if (response.destroyed || response.writableEnded) return;
      const body = JSON.stringify({ data: [{ b64_json: png }] });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      response.end(body);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string' && address.address === '127.0.0.1');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    setPng(value) { png = value; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function makeRoot(roots, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function createFixturePng(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('fixture canvas context unavailable');
    context.fillStyle = '#3498db';
    context.fillRect(0, 0, 4, 4);
    return canvas.toDataURL('image/png').split(',')[1];
  });
}

function toolArgs(target, input) {
  return { ...input, projectId: target.projectId, clientId: target.clientId };
}

function parseMcpJson(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  assert.ok(text, 'MCP result includes text');
  return JSON.parse(text);
}

function mcpErrorText(result) {
  return result.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n') || '';
}

async function waitForProjectRoute(page) {
  await page.waitForFunction(() => /^\/canvas\/[A-Za-z0-9_-]+$/.test(location.pathname), { timeout: 30_000 });
  return decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1));
}

async function waitForCanvasTarget(runtime, projectId) {
  return waitUntil(async () => {
    const status = await runtime.status();
    return status.targets.find((target) => target.projectId === projectId && target.hasCanvas);
  }, `Canvas target for ${projectId}`, 30_000);
}

async function waitUntil(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function allowLocalStudioOrigins(context, values) {
  const origins = new Set(values.map((value) => new URL(value).origin));
  await context.route('**/*', (route) => origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort());
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
