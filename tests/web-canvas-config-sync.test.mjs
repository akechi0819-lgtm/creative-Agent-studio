import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createCanvasManager } from '../src/web/canvas.mjs';
import { createTask, readTask, withTask } from '../src/creative/tasks.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('an open Canvas refreshes the saved image key before generation and proxies without provider CORS', async (t) => {
  const oldKey = 'fixture-old-image-key-never-real';
  const newKey = 'fixture-new-image-key-never-real';
  const upstreamRequests = [];
  let providerCorsEnabled = false;
  let providerOrigin = '';
  const resultUrl = () => `${providerOrigin}/cdn/output.png?sig=fixture%2Fexact%2Bvalue&expires=1792080000`;
  const redirectUrl = () => `${providerOrigin}/cdn/redirect.png?sig=fixture-redirect`;
  const provider = http.createServer(async (request, response) => {
    response.once('finish', () => { providerCorsEnabled ||= Boolean(response.getHeader('access-control-allow-origin')); });
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const requestBody = Buffer.concat(chunks);
    let body = null;
    try { body = JSON.parse(requestBody.toString('utf8')); } catch {}
    upstreamRequests.push({
      method: request.method,
      path: request.url,
      contentType: request.headers['content-type'] || '',
      bodyHash: digest(requestBody),
      authorizedWithOldKey: request.headers.authorization === `Bearer ${oldKey}`,
      authorizedWithNewKey: request.headers.authorization === `Bearer ${newKey}`,
    });
    if (request.url === '/v1/images/edits') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(PNG);
    } else if (request.url === '/v1/images/generations') {
      const data = body?.prompt === 'proxy-url-preflight'
        ? [{ url: resultUrl() }, { url: redirectUrl() }]
        : [{ url: resultUrl() }];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ created: 1, data }));
    } else if (request.url === '/cdn/redirect.png?sig=fixture-redirect') {
      response.writeHead(302, { location: `${providerOrigin}/cdn/redirect-followed.png?sig=should-not-follow` });
      response.end();
    } else if (request.url === '/cdn/redirect-followed.png?sig=should-not-follow') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(PNG);
    } else if (request.url === new URL(resultUrl()).pathname + new URL(resultUrl()).search) {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(PNG);
    } else {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    }
  });
  providerOrigin = await listen(provider);
  let configRecord = {
    revision: 1,
    basic: {},
    image: { baseUrl: `${providerOrigin}/v1`, model: 'fixture-image', apiKey: oldKey },
  };
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-studio-image-sync-'));
  const root = path.join(base, 'profile');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const task = await createTask({ title: 'Canvas 图片配置同步夹具', brief: '只验证本机 fake upstream' }, root);
  let browser;
  let context;
  let isolatedContext;
  let page;
  let isolatedPage;
  let manager;
  let open;
  try {
    manager = createCanvasManager({
      root,
      readConfig: async () => configRecord,
    });
    open = await manager.ensure(task.id);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(open.openUrl, { waitUntil: 'domcontentloaded' });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await manager.state(task.id)).clientConnected) break;
      await page.waitForTimeout(100);
    }
    assert.equal((await manager.state(task.id)).clientConnected, true, 'the isolated Canvas session is connected');

    const instancePath = path.join(root, 'canvas', task.id, 'canvas-instance.json');
    const instance = JSON.parse(await fs.readFile(instancePath, 'utf8'));
    const cookie = (await context.cookies(open.webUrl)).find((item) => item.name.startsWith('studio_canvas_'));
    assert.ok(cookie, 'the browser has an HttpOnly Studio session cookie');
    const cookieHeader = `${cookie.name}=${cookie.value}`;
    const target = `${providerOrigin}/v1/models`;
    const proxyModelsUrl = `${instance.webUrl}/__studio/image-proxy/${target}`;
    const rejectedOrigin = await fetch(proxyModelsUrl, {
      headers: { origin: 'http://127.0.0.1:1', cookie: cookieHeader },
    });
    assert.equal(rejectedOrigin.status, 403, 'the private image proxy rejects a foreign Origin');
    const missingCookie = await fetch(proxyModelsUrl, { headers: { origin: instance.webUrl } });
    assert.equal(missingCookie.status, 401, 'the private image proxy requires a Canvas session cookie');
    const nonTarget = await fetch(`${instance.webUrl}/__studio/image-proxy/${providerOrigin}/v1/images/unlisted`, {
      method: 'POST',
      headers: { origin: instance.webUrl, cookie: cookieHeader, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(nonTarget.status, 403, 'the private image proxy rejects endpoints outside the configured allowlist');

    const sync = await manager.syncImageConfig({
      revision: 2,
      image: { baseUrl: `${providerOrigin}/v1`, model: 'fixture-image', apiKey: newKey },
    });
    assert.equal(sync.status, 'synced');
    assert.equal(sync.updated, 1);
    configRecord = { ...configRecord, revision: 2, image: { ...configRecord.image, apiKey: newKey } };

    await page.getByRole('button', { name: '生成配置', exact: true }).click();
    const compose = page.getByRole('button', { name: '组装提示词', exact: true });
    const editor = page.locator('[contenteditable="true"]');
    if (!(await editor.count())) await compose.click();
    await editor.waitFor({ state: 'visible' });
    await editor.fill('本地 fake upstream 同源代理验证');
    await page.locator('[data-canvas-no-zoom]:has([contenteditable="true"]) > div:first-child button').click();
    await page.getByRole('button', { name: '开始生成', exact: true }).click();
    for (let attempt = 0; attempt < 100 && !upstreamRequests.some((request) => request.path === '/v1/images/generations'); attempt += 1) await page.waitForTimeout(100);

    const generationRequest = upstreamRequests.find((request) => request.path === '/v1/images/generations');
    assert.ok(generationRequest, 'the actual Canvas generation action reached the fake image provider');
    assert.equal(generationRequest.method, 'POST');
    assert.equal(generationRequest.authorizedWithNewKey, true, 'the request used the newly saved key');
    assert.equal(generationRequest.authorizedWithOldKey, false, 'the request did not use the prior key');
    assert.equal(providerCorsEnabled, false, 'the fake provider does not enable CORS');

    const expectedResultUrl = resultUrl();
    const proxyGenerationUrl = `${instance.webUrl}/__studio/image-proxy/${encodeURIComponent(`${providerOrigin}/v1/images/generations`)}`;
    const preflightResponse = await fetch(proxyGenerationUrl, {
      method: 'POST',
      headers: { origin: instance.webUrl, cookie: cookieHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'proxy-url-preflight' }),
    });
    assert.equal(preflightResponse.status, 200);
    assert.equal(await preflightResponse.text(), JSON.stringify({ created: 1, data: [{ url: expectedResultUrl }, { url: redirectUrl() }] }), 'the proxy preserves provider JSON bytes and signed query text');

    const encodedResultUrl = `${instance.webUrl}/__studio/image-proxy/${encodeURIComponent(expectedResultUrl)}`;
    const recoveredResponse = await fetch(encodedResultUrl, { headers: { origin: instance.webUrl, cookie: cookieHeader } });
    assert.equal(recoveredResponse.status, 200, 'a URL returned by this session can be fetched through the same-origin proxy');
    const recoveredBytes = Buffer.from(await recoveredResponse.arrayBuffer());
    assert.equal(digest(recoveredBytes), digest(PNG), 'the signed remote image bytes arrive unchanged');
    const resultRequest = upstreamRequests.find((request) => request.path === new URL(expectedResultUrl).pathname + new URL(expectedResultUrl).search);
    assert.ok(resultRequest, 'the fake CDN received the signed result URL including its exact encoded query');
    assert.equal(resultRequest.method, 'GET');
    assert.equal(resultRequest.authorizedWithOldKey || resultRequest.authorizedWithNewKey, false, 'the Canvas image API key is never forwarded to a CDN URL');

    const rawSignedResponse = await fetch(`${instance.webUrl}/__studio/image-proxy/${expectedResultUrl}`, {
      headers: { origin: instance.webUrl, cookie: cookieHeader },
    });
    assert.equal(rawSignedResponse.status, 200, 'the supervisor still accepts existing raw URL fixtures with signed queries');
    assert.equal(digest(Buffer.from(await rawSignedResponse.arrayBuffer())), digest(PNG));

    const unissuedUrl = `${providerOrigin}/cdn/unissued.png?sig=not-returned`;
    const unissuedResponse = await fetch(`${instance.webUrl}/__studio/image-proxy/${encodeURIComponent(unissuedUrl)}`, {
      headers: { origin: instance.webUrl, cookie: cookieHeader },
    });
    assert.equal(unissuedResponse.status, 403, 'a URL that the provider did not return is not a generic proxy target');

    const redirectResponse = await fetch(`${instance.webUrl}/__studio/image-proxy/${encodeURIComponent(redirectUrl())}`, {
      headers: { origin: instance.webUrl, cookie: cookieHeader },
    });
    assert.equal(redirectResponse.status, 502, 'authorized result URLs do not follow redirects');
    assert.equal(upstreamRequests.some((request) => request.path === '/cdn/redirect-followed.png?sig=should-not-follow'), false, 'the CDN redirect target is never requested');

    isolatedContext = await browser.newContext();
    isolatedPage = await isolatedContext.newPage();
    const isolatedOpen = await manager.ensure(task.id);
    await isolatedPage.goto(isolatedOpen.openUrl, { waitUntil: 'domcontentloaded' });
    let isolatedCookie;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      isolatedCookie = (await isolatedContext.cookies(isolatedOpen.webUrl)).find((item) => item.name.startsWith('studio_canvas_'));
      if (isolatedCookie) break;
      await isolatedPage.waitForTimeout(100);
    }
    assert.ok(isolatedCookie, 'the second browser context receives a distinct cookie session');
    const crossSession = await fetch(encodedResultUrl, {
      headers: { origin: instance.webUrl, cookie: `${isolatedCookie.name}=${isolatedCookie.value}` },
    });
    assert.equal(crossSession.status, 403, 'a different cookie session cannot fetch another Canvas session result URL');

    let generatedImage = null;
    const canvasTarget = await manager.executionOptions(task.id);
    for (let attempt = 0; attempt < 100 && !generatedImage; attempt += 1) {
      try {
        const snapshot = await canvasTarget.tool('canvas_get_state', {}, canvasTarget.config, {});
        const imageNode = snapshot.nodes.find((node) => node.type === 'image' && node.metadata?.storageKey);
        if (imageNode) generatedImage = await canvasTarget.tool('canvas_read_image', { nodeId: imageNode.id }, canvasTarget.config, {});
      } catch {}
      if (!generatedImage) await page.waitForTimeout(100);
    }
    assert.ok(generatedImage?.dataUrl?.startsWith('data:image/png;base64,'), 'Canvas recovered and stored the returned remote URL as an image');
    assert.equal(digest(Buffer.from(generatedImage.dataUrl.split(',')[1], 'base64')), digest(PNG), 'canvas_read_image returns the complete recovered image');

    const boundary = 'canvas-proxy-multipart-boundary';
    const multipartBody = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nlocal edit fixture\r\n--${boundary}--\r\n`);
    const contentType = `multipart/form-data; boundary=${boundary}`;
    const editResponse = await fetch(`${instance.webUrl}/__studio/image-proxy/${providerOrigin}/v1/images/edits`, {
      method: 'POST',
      headers: { origin: instance.webUrl, cookie: cookieHeader, 'content-type': contentType },
      body: multipartBody,
    });
    assert.equal(editResponse.status, 200);
    assert.equal(editResponse.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await editResponse.arrayBuffer()), PNG, 'the proxy streams the upstream image response without rewriting it');
    const editRequest = upstreamRequests.find((request) => request.path === '/v1/images/edits');
    assert.equal(editRequest.contentType, contentType, 'the multipart boundary reaches the provider unchanged');
    assert.equal(editRequest.bodyHash, digest(multipartBody), 'the multipart request body reaches the provider byte-for-byte');
    assert.equal(editRequest.authorizedWithNewKey, true);

    const stored = await page.evaluate(() => localStorage.getItem('infinite-canvas:ai_config_store') || '');
    assert.equal(stored.includes(oldKey) || stored.includes(newKey), false, 'neither image key is persisted in Canvas local storage');

    const originalTarget = await manager.executionOptions(task.id);
    const secondOpen = await manager.ensure(task.id);
    const secondPage = await context.newPage();
    await secondPage.goto(secondOpen.openUrl, { waitUntil: 'domcontentloaded' });
    let ambiguous = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await manager.state(task.id);
      if (state.connectionError === 'ERR_CANVAS_AMBIGUOUS') { ambiguous = true; break; }
      await secondPage.waitForTimeout(100);
    }
    assert.equal(ambiguous, true, 'multiple tabs without a saved target remain an explicit ambiguity');
    await assert.rejects(manager.executionOptions(task.id), (error) => error.code === 'ERR_CANVAS_AMBIGUOUS');
    const latestTask = await readTask(task.id, root);
    await withTask(task.id, (draft) => {
      draft.execution = { ...(draft.execution || {}), target: {
        projectId: task.id, webUrl: originalTarget.config.webUrl, clientId: originalTarget.config.clientId,
      } };
    }, { root, expectedRevision: latestTask.revision });
    const restoredTarget = await manager.executionOptions(task.id);
    assert.equal(restoredTarget.config.clientId, originalTarget.config.clientId, 'a healthy persisted clientId restores the original tab precisely');
    await secondPage.close();

    t.diagnostic('Isolated browser used two fake keys; only key booleans and multipart content hashes are retained, and no provider credential or request body is logged.');
  } finally {
    await isolatedPage?.close().catch(() => {});
    await isolatedContext?.close().catch(() => {});
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await manager?.stop().catch(() => {});
    await new Promise((resolve) => provider.close(resolve));
    await fs.rm(base, { recursive: true, force: true });
  }
});
