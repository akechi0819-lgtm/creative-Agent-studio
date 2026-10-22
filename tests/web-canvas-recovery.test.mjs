import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createCanvasManager } from '../src/web/canvas.mjs';
import { createTask } from '../src/creative/tasks.mjs';

async function eventually(check, message, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(message);
}

test('real Canvas recovers failed state uploads and closed streams without replaying a tool', { timeout: 90_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-canvas-recovery-'));
  const task = await createTask({ title: '画布断线恢复隔离夹具', brief: '不使用真实图片接口' }, root);
  const manager = createCanvasManager({ root, readConfig: async () => ({ revision: 1, image: {} }) });
  let browser;
  let blockState = true;
  let blockResults = false;
  let stateAttempts = 0;
  let unexpectedNetwork = 0;
  try {
    const opened = await manager.ensure(task.id);
    const instance = JSON.parse(await fs.readFile(path.join(root, 'canvas', task.id, 'canvas-instance.json'), 'utf8'));
    const health = async () => (await fetch(`${instance.bridgeUrl}/health`)).json();
    browser = await chromium.launch({ headless: process.env.STUDIO_TEST_HEADED !== '1' });
    const context = await browser.newContext();
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
        // The bundled prompt catalog checks its public registry on startup.
        // Block that too; it is unrelated to connection recovery.
        const isPromptRegistry = route.request().method() === 'GET'
          && url.hostname === 'raw.githubusercontent.com'
          && url.pathname.startsWith('/yukkcat/image-prompts/main/dist/sources/');
        if (!isPromptRegistry) unexpectedNetwork += 1;
        return route.abort();
      }
      if (url.pathname === '/canvas/state') {
        stateAttempts += 1;
        if (blockState) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"fixture state upload interrupted"}' });
      }
      if (url.pathname === '/canvas/result' && blockResults) return route.abort();
      return route.continue();
    });
    await context.addInitScript(() => {
      const NativeEventSource = window.EventSource;
      const streams = [];
      const toolNames = [];
      window.__canvasFaults = {
        streams,
        toolNames,
        disconnect() {
          const source = streams.at(-1);
          source.close();
          source.dispatchEvent(new Event('error'));
        },
      };
      window.EventSource = class extends NativeEventSource {
        constructor(...args) {
          super(...args);
          streams.push(this);
          this.addEventListener('tool_call', event => toolNames.push(JSON.parse(event.data).name));
        }
      };
    });
    const page = await context.newPage();
    await page.goto(opened.openUrl, { waitUntil: 'domcontentloaded' });
    await eventually(() => stateAttempts >= 2, 'failed initial state upload must retry without user interaction');
    assert.equal((await manager.state(task.id)).clientConnected, false);
    assert.equal(await page.getByText('工具已连接', { exact: true }).count(), 0, 'UI cannot report ready before its snapshot is accepted');
    blockState = false;
    await eventually(async () => (await manager.state(task.id)).clientConnected, 'initial upload recovers automatically');
    await page.getByText('工具已连接', { exact: true }).waitFor();
    const initialTarget = (await health()).targets.find(target => target.hasCanvas);
    assert.ok(initialTarget);

    let options = await manager.executionOptions(task.id);
    await options.tool('canvas_apply_ops', { ops: [{ type: 'add_node', id: 'recovery-preserved-node', nodeType: 'text', title: '保留节点', position: { x: 0, y: 0 }, metadata: { content: '隔离测试' } }] }, options.config);

    for (let round = 0; round < 3; round += 1) {
      blockState = true;
      const before = stateAttempts;
      const streamCount = await page.evaluate(() => window.__canvasFaults.streams.length);
      await page.evaluate(() => window.__canvasFaults.disconnect());
      await eventually(async () => await page.evaluate(() => window.__canvasFaults.streams.length) > streamCount, 'a CLOSED event stream must be recreated');
      await eventually(() => stateAttempts > before, 'reconnected stream republishes its snapshot');
      assert.equal(await page.getByText('工具已连接', { exact: true }).count(), 0);
      blockState = false;
      await eventually(async () => (await manager.state(task.id)).clientConnected, 'state upload retry restores readiness after stream recovery');
      await page.getByText('工具已连接', { exact: true }).waitFor();
      const targets = (await health()).targets;
      assert.equal(targets.length, 1, 'recovery leaves exactly one target');
      assert.equal(targets[0].clientId, initialTarget.clientId, 'transport reconnection retains the client binding');
      options = await manager.executionOptions(task.id);
      const snapshot = await options.tool('canvas_get_state', {}, options.config);
      assert.ok(snapshot.nodes.some(node => node.id === 'recovery-preserved-node'));
    }

    // Switching away and returning must not replace a healthy transport.
    const other = await context.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    const streamCount = await page.evaluate(() => window.__canvasFaults.streams.length);
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert.equal(await page.evaluate(() => window.__canvasFaults.streams.length), streamCount);
    await other.close();

    // Apply one mutation, lose its acknowledgement, and disconnect. Recovery must
    // restore state only: retrying this tool could duplicate a paid generation.
    blockResults = true;
    const callsBefore = await page.evaluate(() => window.__canvasFaults.toolNames.length);
    const pending = options.tool('canvas_apply_ops', { ops: [{ type: 'add_node', id: 'uncertain-preserved-node', nodeType: 'text', title: '回执丢失节点', position: { x: 200, y: 0 }, metadata: { content: '仅提交一次' } }] }, options.config)
      .then(() => ({ succeeded: true }), () => ({ succeeded: false }));
    await eventually(async () => await page.evaluate(() => window.__canvasFaults.toolNames.length) > callsBefore, 'mutation reached the real Canvas');
    await eventually(async () => {
      const result = await options.tool('canvas_get_state', {}, options.config);
      return result.nodes.some(node => node.id === 'uncertain-preserved-node');
    }, 'mutation state is visible before losing its acknowledgement');
    await page.evaluate(() => window.__canvasFaults.disconnect());
    assert.equal((await pending).succeeded, false, 'the original caller receives uncertainty rather than false success');
    blockResults = false;
    await eventually(async () => (await manager.state(task.id)).clientConnected, 'connection recovers after an interrupted tool');
    assert.equal(await page.evaluate(() => window.__canvasFaults.toolNames.length), callsBefore + 1, 'transport never replays tool calls');
    options = await manager.executionOptions(task.id);
    const recovered = await options.tool('canvas_get_state', {}, options.config);
    assert.equal(recovered.nodes.filter(node => node.id === 'uncertain-preserved-node').length, 1);
    assert.equal(unexpectedNetwork, 0, 'no model or other external requests are attempted; public catalog checks are blocked');
  } finally {
    await browser?.close();
    await manager.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
