import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createCanvasManager } from '../src/web/canvas.mjs';
import { createTask, confirmInputs, setSheet, confirmSheet, readTask, taskDirectory, withTask } from '../src/creative/tasks.mjs';

const PNG_RED = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64');
const PNG_BLUE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8AABQMBgH0eY4sAAAAASUVORK5CYII=', 'base64');
const dataUrl = (buffer) => `data:image/png;base64,${buffer.toString('base64')}`;
const digest = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function confirmedTask(root, title, pageCount = 1) {
  let task = await createTask({ title, brief: '隔离 Canvas 连接与人工选图测试' }, root);
  task = await confirmInputs(task.id, { revision: task.revision, by: '隔离测试用户', note: '仅测试夹具' }, { root });
  task = await setSheet(task.id, {
    title,
    sourceIds: [],
    pages: Array.from({ length: pageCount }, (_, index) => ({ page: index + 1, copy: `测试图片 ${index + 1}`, prompt: '不触发真实模型请求', size: '1:1', sourceIds: [] })),
  }, { root, expectedRevision: task.revision, inputRevision: task.inputConfirmation.revision });
  task = await confirmSheet(task.id, { version: task.sheetVersion, by: '隔离测试用户', note: '仅测试夹具' }, { root, expectedRevision: task.revision });
  return task;
}

async function waitForConnection(manager, taskId, page, diagnostics) {
  for (let i = 0; i < 100; i += 1) {
    const state = await manager.state(taskId);
    if (state.clientConnected) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const location = await page.evaluate(async () => {
    const response = await fetch('/__studio/session', { cache: 'no-store', credentials: 'same-origin' }).catch(() => null);
    const body = response?.ok ? await response.json() : null;
    return { pathname: window.location.pathname, search: window.location.search, hashPresent: Boolean(window.location.hash), sessionStatus: response?.status ?? null, sessionProjectId: body?.projectId ?? null };
  }).catch(() => null);
  throw new Error(`隔离浏览器未连接到当前任务 Canvas; state=${JSON.stringify(await manager.state(taskId))}; location=${JSON.stringify(location)}; diagnostics=${JSON.stringify(diagnostics)}`);
}

async function persistedCanvasProjectIds(page) {
  return page.evaluate(async () => {
    const databases = await indexedDB.databases();
    const diagnostics = { databases: databases.map(({ name, version }) => ({ name, version })), stores: [], keys: [], projectIds: [] };
    if (!databases.some((database) => database.name === 'infinite-canvas')) return diagnostics;
    return new Promise((resolve) => {
    const request = indexedDB.open('infinite-canvas');
    request.onerror = () => resolve(diagnostics);
    request.onsuccess = () => {
      const database = request.result;
      diagnostics.stores = Array.from(database.objectStoreNames);
      const stores = diagnostics.stores;
      if (!stores.length) { database.close(); resolve(diagnostics); return; }
      const transaction = database.transaction(stores, 'readonly');
      const reads = stores.map((store) => new Promise((done) => {
        const request = transaction.objectStore(store).getAllKeys();
        request.onsuccess = () => { diagnostics.keys.push(...request.result.map(String)); done(); };
        request.onerror = () => done();
      }));
      Promise.all(reads).then(() => {
        const stateStore = stores.includes('app_state') ? transaction.objectStore('app_state') : null;
        if (!stateStore) { database.close(); resolve(diagnostics); return; }
        const read = stateStore.get('infinite-canvas:canvas_store');
        read.onsuccess = () => {
          try { diagnostics.projectIds = JSON.parse(read.result).state.projects.map((project) => project.id); } catch {}
          database.close(); resolve(diagnostics);
        };
        read.onerror = () => { database.close(); resolve(diagnostics); };
      });
    };
    });
  });
}

async function waitForPersistedCanvasProject(page, projectId) {
  let state;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    state = await persistedCanvasProjectIds(page);
    if (state.projectIds.includes(projectId)) return state;
    await page.waitForTimeout(100);
  }
  return state;
}

test('Canvas manager binds isolated browser projects, selection hashes, and same-origin bootstrap', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-studio-canvas-'));
  const root = path.join(base, 'profile');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const firstTask = await confirmedTask(root, 'Canvas 隔离夹具 A', 5);
  const secondTask = await confirmedTask(root, 'Canvas 隔离夹具 B');
  const configRoots = new Set();
  const manager = createCanvasManager({
    root,
    readConfig: async ({ root: configRoot }) => {
      configRoots.add(configRoot);
      return { basic: {}, image: { baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture-image', apiKey: 'fixture-only-secret' } };
    },
  });
  let browser;
  let context;
  const pages = [];
  const externalRequests = [];
  const diagnostics = [];
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    context = await browser.newContext();
    const [openFirst, openSecond] = await Promise.all([manager.ensure(firstTask.id), manager.ensure(secondTask.id)]);
    const firstInstance = JSON.parse(await fs.readFile(path.join(root, 'canvas', firstTask.id, 'canvas-instance.json'), 'utf8'));
    assert.equal(openFirst.projectId, firstTask.id);
    assert.equal(openSecond.projectId, secondTask.id);
    assert.notEqual(openFirst.webUrl, openSecond.webUrl, 'each task receives a distinct browser origin');
    assert.ok(!openFirst.openUrl.includes('fixture-only-secret'));
    assert.ok(!openFirst.openUrl.includes('bridgeUrl=') && !openFirst.openUrl.includes('agentToken='));

    const firstPage = await context.newPage(); pages.push(firstPage);
    firstPage.on('pageerror', (error) => diagnostics.push(`pageerror:${error.name}`));
    firstPage.on('requestfailed', (request) => diagnostics.push(`requestfailed:${new URL(request.url()).pathname}:${request.failure()?.errorText || 'unknown'}`));
    firstPage.on('response', (response) => { if (response.status() >= 400) diagnostics.push(`http${response.status()}:${new URL(response.url()).pathname}`); });
    firstPage.on('request', (request) => { if (request.url().includes('127.0.0.1:1')) externalRequests.push(request.url()); });
    await firstPage.goto(openFirst.openUrl, { waitUntil: 'domcontentloaded' });
    assert.equal(new URL(firstPage.url()).hash, '', 'one-time bootstrap ticket is removed before the Canvas UI renders');
    let firstState = await waitForConnection(manager, firstTask.id, firstPage, diagnostics);
    assert.equal(firstState.projectId, firstTask.id);
    assert.equal(firstState.state, 'ready');
    const canvasText = await firstPage.locator('body').innerText();
    assert.ok(canvasText.includes('Canvas 隔离夹具 A'));
    assert.ok(!canvasText.includes('Canvas P0') && !canvasText.includes('Studio P0'));

    const secondPage = await context.newPage(); pages.push(secondPage);
    secondPage.on('pageerror', (error) => diagnostics.push(`second-pageerror:${error.name}`));
    secondPage.on('requestfailed', (request) => diagnostics.push(`second-requestfailed:${new URL(request.url()).pathname}:${request.failure()?.errorText || 'unknown'}`));
    secondPage.on('request', (request) => { if (request.url().includes('127.0.0.1:1')) externalRequests.push(request.url()); });
    const secondProjectRoute = secondPage.waitForURL((url) => url.pathname === `/canvas/${secondTask.id}`);
    await secondPage.goto(openSecond.openUrl, { waitUntil: 'domcontentloaded' });
    await secondProjectRoute;
    assert.equal(new URL(secondPage.url()).pathname, `/canvas/${secondTask.id}`);
    await secondPage.reload({ waitUntil: 'domcontentloaded' });
    const secondState = await waitForConnection(manager, secondTask.id, secondPage, diagnostics);
    assert.equal(secondState.projectId, secondTask.id, 'an immediate reload after task-project creation recovers the same bound project');

    const instancePath = path.join(root, 'canvas', firstTask.id, 'canvas-instance.json');
    const instance = JSON.parse(await fs.readFile(instancePath, 'utf8'));
    assert.equal((await fs.stat(instancePath)).mode & 0o777, 0o600);
    assert.equal(instance.projectId, firstTask.id);
    assert.ok(!Object.hasOwn(instance, 'browserUrl'), 'task instances do not persist ticket-bearing browser URLs');
    assert.equal((await fetch(`${instance.bridgeUrl}/agent/codex/threads/new`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-canvas-agent-token': instance.token }, body: '{}',
    })).status, 404, 'the bridge has no agent or chat startup route');

    const options = await manager.executionOptions(firstTask.id);
    const fixturePages = Array.from({ length: 5 }, (_, index) => ({ page: index + 1, configNodeId: `fixture-config-node-${index + 1}`, imageNodeId: `fixture-result-image-${index + 1}` }));
    const configNodeId = fixturePages[0].configNodeId;
    const imageNodeId = fixturePages[0].imageNodeId;
    await options.tool('canvas_apply_ops', { ops: [
      ...fixturePages.flatMap(({ page, configNodeId: configId, imageNodeId: imageId }) => [
        { type: 'add_node', id: configId, nodeType: 'config', title: `隔离夹具生成节点 ${page}`, position: { x: 0, y: (page - 1) * 200 }, metadata: { generationMode: 'image', status: 'succeeded' } },
        { type: 'add_node', id: imageId, nodeType: 'image', title: `隔离夹具图片 ${page}`, position: { x: 400, y: (page - 1) * 200 }, metadata: { content: dataUrl(PNG_RED), status: 'success', naturalWidth: 1, naturalHeight: 1 } },
        { type: 'connect_nodes', fromNodeId: configId, toNodeId: imageId },
      ]),
    ] }, options.config, {});

    const taskDir = taskDirectory(firstTask.id, root);
    const fixtureRecords = [];
    for (const { page, configNodeId: configId, imageNodeId: imageId } of fixturePages) {
      const imagePath = path.join(taskDir, 'images', 'v1', `fixture-${page}.png`);
      await fs.mkdir(path.dirname(imagePath), { recursive: true, mode: 0o700 });
      await fs.writeFile(imagePath, PNG_RED, { mode: 0o600 });
      fixtureRecords.push({ page, status: 'succeeded', nodeId: configId, imageNodeId: imageId, image: { path: imagePath, sha256: digest(PNG_RED), bytes: PNG_RED.length, width: 1, height: 1 } });
    }
    await withTask(firstTask.id, (draft) => {
      draft.execution = {
        version: 1, status: 'succeeded',
        pages: fixtureRecords,
      };
    }, { root, expectedRevision: firstState.task.revision });

    firstState = await waitForConnection(manager, firstTask.id, firstPage, diagnostics);
    assert.equal(firstState.images.length, 5);
    assert.equal(firstState.images[0].nodeId, imageNodeId);
    assert.equal(firstState.images[0].sha256, digest(PNG_RED), 'state exposes the actual current Canvas Blob hash');
    const preview = await manager.candidateImage(firstTask.id, { version: 1, page: 1, nodeId: imageNodeId });
    assert.equal(preview.contentType, 'image/png');
    assert.deepEqual(preview.buffer, PNG_RED);
    assert.equal(preview.sha256, digest(PNG_RED));

    const currentCanvas = await options.tool('canvas_get_state', {}, options.config, {});
    assert.ok(currentCanvas.selectedNodeIds.length < fixturePages.length, 'normal Canvas focus is not a Ctrl+A selection of all page images');
    const initialImages = firstState.task.pages.map((page) => ({ page: page.page, sha256: page.sha256 }));
    for (const count of [1, 3, 5]) {
      const fresh = await manager.assertFresh(firstTask.id, {
        expectedRevision: firstState.task.revision, version: 1, images: initialImages.slice(0, count),
      });
      assert.equal(fresh.images.length, count, `${count}-page review freshness does not depend on all Canvas output nodes being selected`);
    }

    const alternateNodeId = 'fixture-alternate-image-1';
    await options.tool('canvas_apply_ops', { ops: [
      { type: 'add_node', id: alternateNodeId, nodeType: 'image', title: '候选替代图片', position: { x: 800, y: 0 }, metadata: { content: dataUrl(PNG_BLUE), status: 'success', naturalWidth: 1, naturalHeight: 1 } },
      { type: 'connect_nodes', fromNodeId: configNodeId, toNodeId: alternateNodeId },
    ] }, options.config, {});
    await assert.rejects(manager.assertFresh(firstTask.id, {
      expectedRevision: firstState.task.revision, version: 1, images: initialImages.slice(0, 1),
    }), (error) => error.code === 'ERR_CANVAS_SYNC_REQUIRED');

    const discovery = await manager.sync(firstTask.id, { expectedRevision: firstState.task.revision, version: 1 });
    assert.equal(discovery.candidates[0].nodeId, imageNodeId);
    const selected = await manager.sync(firstTask.id, {
      expectedRevision: discovery.revision,
      version: 1,
      selections: [{ page: 1, nodeId: alternateNodeId }],
    });
    const selectedHash = selected.task.execution.pages[0].image.sha256;
    assert.equal(selectedHash, digest(PNG_BLUE));
    assert.ok(selected.candidates.some((candidate) => candidate.nodeId === alternateNodeId && candidate.selected));
    assert.equal((await fs.stat(path.join(root, 'canvas', firstTask.id, 'canvas-selection-evidence.json'))).mode & 0o777, 0o600);
    assert.deepEqual(await manager.assertFresh(firstTask.id, {
      expectedRevision: selected.revision, version: 1, images: [{ page: 1, sha256: selectedHash }],
    }), { ok: true, projectId: firstTask.id, version: 1, revision: selected.revision, images: [{ page: 1, sha256: selectedHash }] });

    await options.tool('canvas_delete_nodes', { ids: [alternateNodeId] }, options.config, {});
    await assert.rejects(manager.assertFresh(firstTask.id, {
      expectedRevision: selected.revision, version: 1, images: [{ page: 1, sha256: selectedHash }],
    }), (error) => error.code === 'ERR_CANVAS_SYNC_REQUIRED');

    const reselection = await manager.sync(firstTask.id, {
      expectedRevision: selected.revision, version: 1, selections: [{ page: 1, nodeId: imageNodeId }],
    });
    const reselectionHash = reselection.task.execution.pages[0].image.sha256;
    assert.equal(reselectionHash, digest(PNG_RED));
    assert.deepEqual(await manager.assertFresh(firstTask.id, {
      expectedRevision: reselection.revision, version: 1, images: [{ page: 1, sha256: reselectionHash }],
    }), { ok: true, projectId: firstTask.id, version: 1, revision: reselection.revision, images: [{ page: 1, sha256: reselectionHash }] });

    await options.tool('canvas_update_node', { id: imageNodeId, metadata: { content: dataUrl(PNG_BLUE), status: 'success', naturalWidth: 1, naturalHeight: 1 } }, options.config, {});
    await assert.rejects(manager.assertFresh(firstTask.id, {
      expectedRevision: reselection.revision, version: 1, images: [{ page: 1, sha256: reselectionHash }],
    }), (error) => error.code === 'ERR_CANVAS_IMAGE_CHANGED');
    assert.equal((await manager.candidateImage(firstTask.id, { version: 1, page: 1, nodeId: imageNodeId })).sha256, digest(PNG_BLUE));

    const storage = await firstPage.evaluate(() => localStorage.getItem('infinite-canvas:ai_config_store'));
    assert.ok(storage);
    assert.ok(!storage.includes('fixture-only-secret'), 'image API key remains memory-only in the Canvas browser');
    const storedConfig = JSON.parse(storage).state;
    assert.equal(storedConfig.config.channels[0].apiKey, '');
    assert.ok(!new URL(firstPage.url()).hash.includes('studioBootstrap='));
    assert.equal(new URL(firstPage.url()).pathname, `/canvas/${firstTask.id}`, 'the task opens its bound Canvas project route');
    const persistedProjectState = await waitForPersistedCanvasProject(firstPage, firstTask.id);
    assert.ok(persistedProjectState.projectIds.includes(firstTask.id), `the browser project is persisted before reload: ${JSON.stringify(persistedProjectState)}`);

    await firstPage.reload({ waitUntil: 'domcontentloaded' });
    firstState = await waitForConnection(manager, firstTask.id, firstPage, diagnostics);
    assert.equal(firstState.projectId, firstTask.id, 'reload recovers the same project through its HttpOnly session');

    assert.equal(secondState.projectId, secondTask.id);
    assert.equal((await manager.state(firstTask.id)).projectId, firstTask.id, 'opening another task never cross-binds the first Canvas');
    assert.deepEqual(externalRequests, [], 'fixture never makes an image-provider request');
    assert.deepEqual([...configRoots], [root], 'manager reads config only from the isolated test root');
    assert.equal((await readTask(secondTask.id, root)).id, secondTask.id);
    assert.equal((await manager.checkImageConfig()).connectionTested, false);
    t.diagnostic('Isolated browser test used only the temporary profile root and local fake image configuration.');
  } finally {
    for (const page of pages) await page.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await manager.stop().catch(() => {});
    await fs.rm(base, { recursive: true, force: true });
  }
});
