import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import test from 'node:test';

import { createCanvasWindowManager } from '../web/src/canvas-windows.mjs';

function browser() {
  const opened = [];
  const windowObject = {
    setTimeout,
    open(url, target) {
      const child = {
        closed: false,
        opener: windowObject,
        focusCount: 0,
        navigations: [],
        focus() { this.focusCount += 1; },
        close() { this.closed = true; },
        location: {
          replace: (nextUrl) => child.navigations.push(nextUrl),
        },
      };
      opened.push({ url, target, child });
      return child;
    },
  };
  return { windowObject, opened };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('real browser reuses cross-origin task windows after opener is severed', async (t) => {
  const helperSource = await readFile(new URL('../web/src/canvas-windows.mjs', import.meta.url), 'utf8');
  const canvasRequests = new Map();
  const canvasServer = createServer((request, response) => {
    const taskId = decodeURIComponent(new URL(request.url, 'http://canvas.local').pathname.split('/').at(-1));
    canvasRequests.set(taskId, (canvasRequests.get(taskId) || 0) + 1);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>${taskId}</title><body data-task="${taskId}">Canvas ${taskId}</body>`);
  });
  const canvasOrigin = await listen(canvasServer);
  const workbenchServer = createServer((request, response) => {
    if (request.url === '/canvas-windows.mjs') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(helperSource);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
      <button id="task-a" onclick="window.openTask('task-a')">Open task A</button>
      <button id="task-b" onclick="window.openTask('task-b')">Open task B</button>
      <script type="module">
        import { createCanvasWindowManager } from '/canvas-windows.mjs';
        const api = {
          canvasOpen: async (taskId) => ({
            openUrl: ${JSON.stringify(canvasOrigin)} + '/canvas/' + encodeURIComponent(taskId),
            projectId: taskId,
            clientConnected: false,
          }),
        };
        window.managerReady = Promise.resolve().then(() => {
          window.manager = createCanvasWindowManager({ windowObject: window, api });
          window.openTask = (taskId) => window.manager.open(taskId);
        });
      </script>`);
  });
  const workbenchOrigin = await listen(workbenchServer);
  t.after(async () => {
    await new Promise((resolve) => workbenchServer.close(resolve));
    await new Promise((resolve) => canvasServer.close(resolve));
  });

  const browser = await chromium.launch({ headless: process.env.STUDIO_TEST_HEADED !== '1' });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(workbenchOrigin);
  await page.evaluate(() => window.managerReady);

  const firstPopupPromise = page.waitForEvent('popup');
  await page.locator('#task-a').click();
  const taskA = await firstPopupPromise;
  await taskA.waitForURL(`${canvasOrigin}/canvas/task-a`);
  await taskA.waitForLoadState('domcontentloaded');
  assert.equal(await taskA.evaluate(() => window.opener === null), true, 'Canvas page has no opener after cross-origin navigation');
  assert.equal(await taskA.evaluate(() => document.body.dataset.task), 'task-a');
  assert.equal(new URL(taskA.url()).origin, canvasOrigin, 'Canvas is on a different origin from the workbench');
  assert.equal(canvasRequests.get('task-a'), 1);

  await page.locator('#task-a').click();
  await page.waitForTimeout(100);
  assert.equal(context.pages().length, 2, 'reopening the same task does not create another page');
  assert.equal(taskA.isClosed(), false, 'the original WindowProxy still points to the task page');
  assert.equal(taskA.url(), `${canvasOrigin}/canvas/task-a`, 'the existing Canvas document is not reloaded or replaced');
  assert.equal(canvasRequests.get('task-a'), 1, 'no second task page request was made');

  const secondPopupPromise = page.waitForEvent('popup');
  await page.locator('#task-b').click();
  const taskB = await secondPopupPromise;
  await taskB.waitForURL(`${canvasOrigin}/canvas/task-b`);
  await taskB.waitForLoadState('domcontentloaded');
  assert.equal(await taskB.evaluate(() => window.opener === null), true);
  assert.equal(await taskB.evaluate(() => document.body.dataset.task), 'task-b');
  assert.equal(context.pages().length, 3, 'a different task gets its own Canvas page');

  await taskA.close();
  const reopenedPopupPromise = page.waitForEvent('popup');
  await page.locator('#task-a').click();
  const reopenedTaskA = await reopenedPopupPromise;
  await reopenedTaskA.waitForURL(`${canvasOrigin}/canvas/task-a`);
  await reopenedTaskA.waitForLoadState('domcontentloaded');
  assert.equal(await reopenedTaskA.evaluate(() => document.body.dataset.task), 'task-a');
  assert.equal(canvasRequests.get('task-a'), 2, 'closing a task window allows a fresh task page to be opened');
  await context.close();
});

test('repeated open clicks share an in-flight task request and popup', async () => {
  const { windowObject, opened } = browser();
  const response = deferred();
  let openCalls = 0;
  const manager = createCanvasWindowManager({
    windowObject,
    api: { canvasOpen: () => { openCalls += 1; return response.promise; } },
  });

  const first = manager.open('task-a');
  const second = manager.open('task-a');
  assert.equal(opened.length, 1);
  assert.equal(openCalls, 1);
  assert.equal(opened[0].target, '_blank');
  assert.equal(opened[0].url, 'about:blank');
  assert.equal(opened[0].child.focusCount, 1, 'repeat click focuses the reserved task tab');

  response.resolve({ openUrl: 'http://canvas.local/canvas?projectId=task-a', projectId: 'task-a', clientConnected: false });
  await Promise.all([first, second]);
  assert.equal(opened[0].child.opener, null);
  assert.deepEqual(opened[0].child.navigations, ['http://canvas.local/canvas?projectId=task-a']);
});

test('task windows stay isolated and a known window is focused without reloading', async () => {
  const { windowObject, opened } = browser();
  let openCalls = 0;
  const manager = createCanvasWindowManager({
    windowObject,
    api: {
      canvasOpen: async (taskId) => {
        openCalls += 1;
        return {
          openUrl: `http://canvas.local/canvas?projectId=${taskId}`,
          projectId: taskId,
          clientConnected: openCalls === 3,
        };
      },
    },
  });

  await manager.open('task-a');
  await manager.open('task-b');
  assert.equal(opened.length, 2);
  assert.notEqual(opened[0].child, opened[1].child);
  assert.deepEqual(opened.map(({ child }) => child.navigations), [
    ['http://canvas.local/canvas?projectId=task-a'],
    ['http://canvas.local/canvas?projectId=task-b'],
  ]);

  await manager.ensureConnected('task-a');
  assert.equal(opened.length, 2);
  assert.equal(opened[0].child.focusCount, 1);
  assert.equal(opened[0].child.navigations.length, 1, 'connected Canvas tab is not navigated again');
});

test('a server-confirmed connection closes an unused blank tab', async () => {
  const { windowObject, opened } = browser();
  const manager = createCanvasWindowManager({
    windowObject,
    api: { canvasOpen: async () => ({ openUrl: 'http://canvas.local/canvas', projectId: 'task-a', clientConnected: true }) },
  });

  const result = await manager.open('task-a');
  assert.equal(result.clientConnected, true);
  assert.equal(opened.length, 1, 'the popup was reserved synchronously');
  assert.equal(opened[0].child.closed, true);
  assert.deepEqual(opened[0].child.navigations, []);
});

test('concurrent ensure requests share one popup and wait for that task connection', async () => {
  const { windowObject, opened } = browser();
  let openCalls = 0;
  let stateCalls = 0;
  const manager = createCanvasWindowManager({
    windowObject,
    wait: async () => {},
    api: {
      canvasOpen: async () => { openCalls += 1; return { openUrl: 'http://canvas.local/canvas?projectId=task-a', projectId: 'task-a', clientConnected: false }; },
      task: async () => { stateCalls += 1; return { canvas: { clientConnected: true, projectId: 'task-a' } }; },
    },
  });

  const first = manager.ensureConnected('task-a');
  const second = manager.ensureConnected('task-a');
  await Promise.all([first, second]);
  assert.equal(opened.length, 1);
  assert.equal(openCalls, 1);
  assert.equal(stateCalls, 1);
  assert.deepEqual(opened[0].child.navigations, ['http://canvas.local/canvas?projectId=task-a']);
});

test('closed task windows are replaced while a live reloaded window is reused', async () => {
  const { windowObject, opened } = browser();
  let openCalls = 0;
  const manager = createCanvasWindowManager({
    windowObject,
    api: { canvasOpen: async (taskId) => { openCalls += 1; return { openUrl: `http://canvas.local/canvas?projectId=${taskId}`, projectId: taskId, clientConnected: false }; } },
  });

  await manager.open('task-a');
  opened[0].child.closed = true;
  await manager.open('task-a');
  assert.equal(opened.length, 2);
  assert.equal(openCalls, 2);

  // A reload keeps the WindowProxy alive. Treat it as the same task tab and
  // focus it, rather than replacing its document during a possible generation.
  const reused = await manager.open('task-a');
  assert.equal(opened.length, 2);
  assert.equal(openCalls, 2);
  assert.equal(reused.reusedWindow, true, 'the caller can explain that an existing tab was focused');
  assert.equal(opened[1].child.focusCount, 1);
  assert.equal(opened[1].child.navigations.length, 1);
});

test('failed open closes and forgets its unused popup', async () => {
  const { windowObject, opened } = browser();
  let openCalls = 0;
  const manager = createCanvasWindowManager({
    windowObject,
    api: { canvasOpen: () => {
      openCalls += 1;
      if (openCalls === 1) throw new Error('synchronous service failure');
      return Promise.reject(new Error('asynchronous service failure'));
    } },
  });

  await assert.rejects(manager.open('task-a'), /synchronous service failure/);
  await assert.rejects(manager.open('task-a'), /asynchronous service failure/);
  assert.equal(opened.length, 2);
  assert.equal(openCalls, 2);
  assert.ok(opened.every(({ child }) => child.closed));
});

test('popup blocking is reported before the Canvas API is called', async () => {
  let apiCalls = 0;
  const manager = createCanvasWindowManager({
    windowObject: { open: () => null },
    api: { canvasOpen: async () => { apiCalls += 1; return {}; } },
  });

  await assert.rejects(manager.open('task-a'), /阻止了 Canvas 新标签页/);
  assert.equal(apiCalls, 0);
});
