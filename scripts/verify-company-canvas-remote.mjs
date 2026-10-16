#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = join(root, '.studio-runtime', 'company-canvas', 'web');
const testProject = {
    id: 'company-canvas-fixture-project',
    title: 'Remote IndexedDB Fixture Project',
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    nodes: [],
    connections: [],
    backgroundMode: 'lines',
    showImageInfo: false,
    viewport: { x: 0, y: 0, k: 1 },
};
const persistedCanvasState = JSON.stringify({ state: { projects: [testProject], deletedProjects: [] }, version: 0 });
const importedNodeId = 'company-image-import-fixture-node';
const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jUioAAAAASUVORK5CYII=';
const imageBytes = Buffer.from(imageBase64, 'base64');
const imageDataUrl = `data:image/png;base64,${imageBase64}`;
const imageSha256 = createHash('sha256').update(imageBytes).digest('hex');
const modelConfigStorageKey = 'infinite-canvas:ai_config_store';
const modelConfigApiKeys = { root: 'synthetic-root-image-key', channel: 'synthetic-channel-image-key' };
const modelConfigSeed = {
    baseUrl: 'https://root-model.example.invalid/v1',
    apiKey: modelConfigApiKeys.root,
    apiFormat: 'openai',
    imageModel: 'fixture-image::fixture-image-model',
    model: 'fixture-image::fixture-image-model',
    models: ['fixture-image::fixture-image-model'],
    channels: [{
        id: 'fixture-image',
        name: 'Synthetic image channel',
        baseUrl: 'https://image-model.example.invalid/v1',
        apiKey: modelConfigApiKeys.channel,
        apiFormat: 'openai',
        models: [{ name: 'fixture-image-model', capability: 'image' }],
    }],
};
const persistedModelConfig = JSON.stringify({
    state: { config: modelConfigSeed, webdav: { url: '', username: '', password: '', directory: 'infinite-canvas', lastSyncedAt: '' } },
    version: 0,
});

const tempRoot = await mkdtemp(join(tmpdir(), 'company-canvas-remote-'));
const certPath = join(tempRoot, 'fixture-cert.pem');
const keyPath = join(tempRoot, 'fixture-key.pem');
async function findOpenSsl() {
    if (process.platform === 'win32') {
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        const x86ProgramFiles = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const candidates = [
            join(programFiles, 'Git', 'usr', 'bin', 'openssl.exe'),
            join(programFiles, 'Git', 'mingw64', 'bin', 'openssl.exe'),
            join(x86ProgramFiles, 'Git', 'usr', 'bin', 'openssl.exe'),
            join(x86ProgramFiles, 'Git', 'mingw64', 'bin', 'openssl.exe'),
        ];
        for (const candidate of candidates) {
            try { await access(candidate); return candidate; } catch {}
        }
    }
    return 'openssl';
}

const openssl = await findOpenSsl();
const certResult = spawnSync(openssl, [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
    '-sha256', '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1',
], { stdio: 'ignore' });
if (certResult.error || certResult.status !== 0) {
    await rm(tempRoot, { recursive: true, force: true });
    throw new Error('HTTPS fixture certificate creation failed. Install openssl and retry.');
}

let expectedOrigin = '';
const bootstrapCalls = [];
const eventConnections = [];
const canvasStates = [];
const toolResults = [];
const activeSseConnections = new Map();
const forbiddenStudioRequests = [];
const usedTickets = new Set();
const validTickets = new Set(['fixture-ticket-1', 'fixture-ticket-2']);
const mimeTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

const bridgeServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const origin = req.headers.origin || '';
    if (url.pathname === '/__test-state' && req.method === 'GET' && !origin) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ bootstrapCalls, eventConnections, canvasStates, toolResults }));
        return;
    }
    if (origin !== expectedOrigin) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'origin not allowed' }));
        return;
    }
    res.setHeader('access-control-allow-origin', expectedOrigin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-private-network', 'true');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    if (url.pathname === '/__company/bootstrap' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const request = JSON.parse(body || '{}');
        bootstrapCalls.push({ origin, request, hasAgentToken: Boolean(req.headers['x-canvas-agent-token']) });
        if (!validTickets.has(request.ticket) || usedTickets.has(request.ticket)) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false }));
            return;
        }
        usedTickets.add(request.ticket);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({
            ok: true,
            bridgeUrl: `http://127.0.0.1:${bridgeServer.address().port}`,
            token: 'fixture-only-in-memory-token',
            projectId: testProject.id,
        }));
        return;
    }
    if (url.pathname === '/events' && req.method === 'GET') {
        const connection = {
            projectId: url.searchParams.get('projectId'),
            clientId: url.searchParams.get('clientId'),
            tokenValid: url.searchParams.get('token') === 'fixture-only-in-memory-token',
        };
        eventConnections.push(connection);
        if (!connection.tokenValid || connection.projectId !== testProject.id
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(connection.clientId || '')) {
            res.writeHead(401);
            res.end();
            return;
        }
        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
        });
        res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, projectId: testProject.id, clientId: connection.clientId })}\n\n`);
        activeSseConnections.set(connection.clientId, res);
        res.on('close', () => {
            if (activeSseConnections.get(connection.clientId) === res) activeSseConnections.delete(connection.clientId);
        });
        return;
    }
    if (url.pathname === '/canvas/state' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const snapshot = JSON.parse(body || '{}');
        canvasStates.push({ ...snapshot, query: {
            projectId: url.searchParams.get('projectId'),
            clientId: url.searchParams.get('clientId'),
            tokenValid: url.searchParams.get('token') === 'fixture-only-in-memory-token',
        } });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }
    if (url.pathname === '/canvas/result' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const result = JSON.parse(body || '{}');
        toolResults.push(result);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

const webServer = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, async (req, res) => {
    const url = new URL(req.url || '/', expectedOrigin || 'https://127.0.0.1');
    if (url.pathname === '/__test_seed') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`<!doctype html><meta charset="utf-8"><body><script>
localStorage.setItem(${JSON.stringify(modelConfigStorageKey)},${JSON.stringify(persistedModelConfig)});
const request=indexedDB.open('infinite-canvas',1);
request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('app_state'))request.result.createObjectStore('app_state');};
request.onerror=()=>document.body.dataset.seeded='error';
request.onsuccess=()=>{const tx=request.result.transaction('app_state','readwrite');tx.objectStore('app_state').put(${JSON.stringify(persistedCanvasState)},'infinite-canvas:canvas_store');tx.oncomplete=()=>{document.body.dataset.seeded='yes';request.result.close();};tx.onerror=()=>document.body.dataset.seeded='error';};
</script><p>fixture</p></body>`);
        return;
    }

    const pathname = decodeURIComponent(url.pathname);
    const requestedPath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    let filePath = resolve(webRoot, requestedPath);
    if (filePath !== webRoot && !filePath.startsWith(`${webRoot}${sep}`)) filePath = join(webRoot, 'index.html');
    try {
        await stat(filePath);
    } catch {
        filePath = join(webRoot, 'index.html'); // Simulate the required static-host SPA fallback.
    }
    try {
        const content = await readFile(filePath);
        res.writeHead(200, {
            'content-type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
            'cache-control': 'no-store',
        });
        res.end(content);
    } catch {
        res.writeHead(404);
        res.end('missing fixture build');
    }
});

async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
}

async function hasPersistedBootstrapSecret(page) {
    return page.evaluate(async () => {
        const values = [JSON.stringify(localStorage), JSON.stringify(sessionStorage)];
        try {
            const database = await new Promise((resolveOpen, rejectOpen) => {
                const request = indexedDB.open('infinite-canvas');
                request.onsuccess = () => resolveOpen(request.result);
                request.onerror = () => rejectOpen(request.error);
            });
            const transaction = database.transaction([...database.objectStoreNames], 'readonly');
            const records = await Promise.all([...database.objectStoreNames].map((storeName) => new Promise((resolveGet, rejectGet) => {
                const request = transaction.objectStore(storeName).getAll();
                request.onsuccess = () => resolveGet(request.result);
                request.onerror = () => rejectGet(request.error);
            })));
            database.close();
            values.push(JSON.stringify(records));
        } catch {}
        const content = values.join('\n');
        return ['fixture-only-in-memory-token', 'fixture-ticket-1', 'fixture-ticket-2'].some((secret) => content.includes(secret));
    });
}

async function hasPersistedRemoteModelKeys(page) {
    return page.evaluate(({ storageKey, rootKey, channelKey }) => {
        try {
            const value = JSON.parse(localStorage.getItem(storageKey) || 'null');
            const config = value?.state?.config;
            return config?.apiKey === rootKey
                && config?.channels?.some((channel) => channel.id === 'fixture-image' && channel.apiKey === channelKey);
        } catch { return false; }
    }, { storageKey: modelConfigStorageKey, rootKey: modelConfigApiKeys.root, channelKey: modelConfigApiKeys.channel });
}

async function readIndexedCanvasAndImage(page, storageKey) {
    return page.evaluate(async ({ storageKey }) => {
        let database;
        try {
            database = await new Promise((resolveOpen, rejectOpen) => {
                const request = indexedDB.open('infinite-canvas');
                request.onsuccess = () => resolveOpen(request.result);
                request.onerror = () => rejectOpen(request.error);
            });
            const read = (storeName, key) => new Promise((resolveGet, rejectGet) => {
                const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(key);
                request.onsuccess = () => resolveGet(request.result);
                request.onerror = () => rejectGet(request.error);
            });
            const stored = await read('app_state', 'infinite-canvas:canvas_store');
            const state = typeof stored === 'string' ? JSON.parse(stored) : stored;
            const blob = database.objectStoreNames.contains('image_files')
                ? await read('image_files', storageKey)
                : null;
            return {
                projects: (state?.state?.projects || []).map((project) => ({
                    id: project.id,
                    nodeIds: (project.nodes || []).map((node) => node.id),
                    storageKeys: (project.nodes || []).map((node) => node.metadata?.storageKey || ''),
                })),
                imageBlob: blob instanceof Blob ? { type: blob.type, size: blob.size } : null,
            };
        } catch (error) { return { error: String(error) }; }
        finally { database?.close(); }
    }, { storageKey });
}

async function waitForPersistedCanvasNode(page, projectId, nodeId, storageKey, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let stableSince = null;
    let state;
    do {
        state = await readIndexedCanvasAndImage(page, storageKey);
        const persisted = state.projects?.some((project) => project.id === projectId && project.nodeIds.includes(nodeId));
        if (persisted) {
            stableSince ??= Date.now();
            if (Date.now() - stableSince >= 500) {
                assert.deepEqual(state.imageBlob, { type: 'image/png', size: imageBytes.length },
                    'the original image blob should be committed alongside the canvas node');
                return state;
            }
        } else {
            stableSince = null;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    } while (Date.now() < deadline);
    assert.fail(`Timed out waiting for a stable persisted canvas node: ${JSON.stringify(state)}`);
}

async function waitForBridgeReport(predicate, description, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let report;
    do {
        report = await fetch(`http://127.0.0.1:${bridgeServer.address().port}/__test-state`).then((response) => response.json());
        if (predicate(report)) return report;
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    } while (Date.now() < deadline);
    assert.fail(`Timed out waiting for ${description}`);
}

async function sendToolCall(clientId, requestId, name, input) {
    const connection = activeSseConnections.get(clientId);
    assert.ok(connection?.writable, `SSE connection ${clientId} should be active before ${name}`);
    connection.write(`event: tool_call\ndata: ${JSON.stringify({ requestId, name, input })}\n\n`);
    const report = await waitForBridgeReport(
        (state) => state.toolResults.some((result) => result.requestId === requestId),
        `Canvas tool result ${requestId}`,
    );
    return report.toolResults.find((result) => result.requestId === requestId);
}

function assertOriginalImageDataUrl(dataUrl, context) {
    assert.match(dataUrl || '', /^data:image\/png;base64,/u, `${context} should return PNG data URL bytes`);
    const actualBytes = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
    assert.equal(createHash('sha256').update(actualBytes).digest('hex'), imageSha256,
        `${context} should preserve the exact imported PNG bytes`);
}

function latestSnapshotWithImportedNode(report, clientId = '') {
    return report.canvasStates.filter((snapshot) => snapshot.projectId === testProject.id
        && (!clientId || snapshot.query?.clientId === clientId)
        && Array.isArray(snapshot.nodes) && snapshot.nodes.some((node) => node.id === importedNodeId)).at(-1);
}

let browser;
try {
    await stat(join(webRoot, 'index.html'));
    const bridgePort = await listen(bridgeServer);
    const webPort = await listen(webServer);
    expectedOrigin = `https://127.0.0.1:${webPort}`;
    const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const browserDiagnostics = { console: [], pageErrors: [], requestFailures: [], responses: [] };
    const sanitizeDiagnostic = (value) => String(value)
        .replaceAll('fixture-only-in-memory-token', '[redacted-token]')
        .replaceAll('fixture-ticket-1', '[redacted-ticket]')
        .replaceAll('fixture-ticket-2', '[redacted-ticket]')
        .replaceAll(modelConfigApiKeys.root, '[redacted-model-key]')
        .replaceAll(modelConfigApiKeys.channel, '[redacted-model-key]');
    page.on('console', (message) => {
        const text = sanitizeDiagnostic(message.text());
        browserDiagnostics.console.push({ type: message.type(), text });
    });
    page.on('pageerror', (error) => browserDiagnostics.pageErrors.push(sanitizeDiagnostic(error.message)));
    page.on('requestfailed', (request) => {
        browserDiagnostics.requestFailures.push({
            method: request.method(),
            path: new URL(request.url()).pathname,
            failure: sanitizeDiagnostic(request.failure()?.errorText || 'unknown'),
        });
    });
    page.on('response', (response) => {
        const url = new URL(response.url());
        if (response.status() >= 400 || url.pathname === '/events' || url.pathname === '/__company/bootstrap') {
            browserDiagnostics.responses.push({ method: response.request().method(), path: url.pathname, status: response.status() });
        }
    });
    page.on('request', (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname.startsWith('/__studio/')) forbiddenStudioRequests.push(request.url());
    });

    await page.goto(`${expectedOrigin}/__test_seed`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.dataset.seeded === 'yes');

    const firstUrl = new URL(`/canvas?mode=recent&projectId=${encodeURIComponent(testProject.id)}`, expectedOrigin);
    firstUrl.hash = new URLSearchParams({ companyBridge: bridgeUrl, companyTicket: 'fixture-ticket-1' }).toString();
    await page.goto(firstUrl.toString(), { waitUntil: 'domcontentloaded' });
    await page.getByText(testProject.title, { exact: true }).waitFor({ timeout: 45_000 });
    try {
        await page.getByText(/纯绘图工具已连接/u).waitFor({ timeout: 15_000 });
    } catch (error) {
        const body = await page.locator('body').innerText().catch(() => '');
        const bridgeReport = await fetch(`http://127.0.0.1:${bridgeServer.address().port}/__test-state`)
            .then((response) => response.json()).catch(() => null);
        console.error(JSON.stringify({
            url: page.url(),
            body: sanitizeDiagnostic(body).slice(0, 10_000),
            browserDiagnostics,
            bridgeReport,
        }, null, 2));
        throw error;
    }
    await page.waitForFunction(() => !location.hash.includes('companyTicket'));

    assert.equal(bootstrapCalls.length, 1, 'the one-use ticket should be consumed once');
    assert.equal(bootstrapCalls[0].origin, expectedOrigin, 'the bridge should receive the exact HTTPS page origin');
    assert.equal(bootstrapCalls[0].request.ticket, 'fixture-ticket-1');
    assert.equal(bootstrapCalls[0].hasAgentToken, false, 'browser bootstrap must not send the long-lived bridge token');
    assert.equal(await hasPersistedBootstrapSecret(page), false, 'token and ticket must remain in memory and the transient request only');

    await page.getByRole('button', { name: '配置', exact: true }).click();
    await page.getByRole('tab', { name: '偏好设置' }).click();
    await page.locator('.ant-form-item').filter({ hasText: '画布默认生图张数' }).locator('input[type="number"]').fill('4');
    await page.waitForFunction(({ storageKey, rootKey, channelKey }) => {
        try {
            const value = JSON.parse(localStorage.getItem(storageKey) || 'null');
            const config = value?.state?.config;
            return config?.canvasImageCount === '4' && config?.apiKey === rootKey
                && config?.channels?.some((channel) => channel.id === 'fixture-image' && channel.apiKey === channelKey);
        } catch { return false; }
    }, { storageKey: modelConfigStorageKey, rootKey: modelConfigApiKeys.root, channelKey: modelConfigApiKeys.channel });
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await hasPersistedRemoteModelKeys(page), true, 'remote profile should persist the user’s own root and channel API keys after a config-store write');

    await waitForBridgeReport((report) => report.eventConnections.some((entry) => entry.projectId === testProject.id)
        && report.canvasStates.some((item) => item.projectId === testProject.id && item.title === testProject.title),
    'the initial Canvas project snapshot');
    const firstClientId = eventConnections.find((entry) => entry.projectId === testProject.id)?.clientId;
    assert.match(firstClientId || '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
        'project-only bootstrap should let the page generate its clientId');
    const importResult = await sendToolCall(firstClientId, 'fixture-import-image', 'canvas_import_image', {
        nodeId: importedNodeId,
        title: 'Synthetic persistence fixture',
        dataUrl: imageDataUrl,
    });
    assert.equal(importResult.error, undefined, `image import should succeed: ${importResult.error || ''}`);
    assert.equal(importResult.result?.operation, 'import');
    assert.equal(importResult.result?.sourceNodeId, importedNodeId);
    let importReport = await waitForBridgeReport((report) => Boolean(latestSnapshotWithImportedNode(report)),
        'the imported Canvas image node');
    const importedSnapshot = latestSnapshotWithImportedNode(importReport);
    const importedNode = importedSnapshot.nodes.find((node) => node.id === importedNodeId);
    const storageKey = importedNode?.metadata?.storageKey;
    assert.match(storageKey || '', /^image:/u, 'the imported image should have a real local storageKey');

    const beforeReloadRead = await sendToolCall(firstClientId, 'fixture-read-image-before-reload', 'canvas_read_image', {
        nodeId: importedNodeId,
    });
    assert.equal(beforeReloadRead.error, undefined, `pre-reload image read should succeed: ${beforeReloadRead.error || ''}`);
    assertOriginalImageDataUrl(beforeReloadRead.result?.dataUrl, 'Canvas read before reload');
    const beforeReloadState = await waitForPersistedCanvasNode(page, testProject.id, importedNodeId, storageKey);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText(testProject.title, { exact: true }).waitFor({ timeout: 45_000 });
    assert.equal(bootstrapCalls.length, 1, 'reload must not replay or persist a consumed ticket');
    const ordinaryReloadState = await readIndexedCanvasAndImage(page, storageKey);
    if (!ordinaryReloadState.projects.some((project) => project.id === testProject.id && project.nodeIds.includes(importedNodeId))) {
        console.error(JSON.stringify({
            ordinaryReloadUrl: page.url(),
            ordinaryReloadState,
            beforeReloadState,
            body: sanitizeDiagnostic(await page.locator('body').innerText().catch(() => '')).slice(0, 10_000),
        }, null, 2));
    }
    assert.ok(ordinaryReloadState.projects.some((project) => project.id === testProject.id
        && project.nodeIds.includes(importedNodeId)), `ordinary reload must retain the imported canvas node: ${JSON.stringify(ordinaryReloadState)}`);
    assert.deepEqual(ordinaryReloadState.imageBlob, { type: 'image/png', size: imageBytes.length },
        'ordinary reload must retain the original image blob in IndexedDB');

    const reopenUrl = new URL(`/canvas?mode=recent&projectId=${encodeURIComponent(testProject.id)}`, expectedOrigin);
    reopenUrl.hash = new URLSearchParams({ companyBridge: bridgeUrl, companyTicket: 'fixture-ticket-2' }).toString();
    // Match the manager URL so CanvasPage hydrates the existing task before entering it.
    await page.goto(reopenUrl.toString(), { waitUntil: 'domcontentloaded' });
    try {
        await page.getByText(/纯绘图工具已连接/u).waitFor({ timeout: 15_000 });
    } catch (error) {
        const body = await page.locator('body').innerText().catch(() => '');
        const bridgeReport = await fetch(`http://127.0.0.1:${bridgeServer.address().port}/__test-state`)
            .then((response) => response.json()).catch(() => null);
        const sanitizedBridgeReport = bridgeReport == null
            ? null
            : JSON.parse(sanitizeDiagnostic(JSON.stringify(bridgeReport)));
        console.error(JSON.stringify({
            url: page.url(),
            body: sanitizeDiagnostic(body).slice(0, 10_000),
            browserDiagnostics,
            bridgeReport: sanitizedBridgeReport,
        }, null, 2));
        throw error;
    }
    await page.waitForFunction(() => !location.hash.includes('companyTicket'));

    assert.equal(await hasPersistedRemoteModelKeys(page), true, 'remote user model configuration should still be present after reload');
    await page.getByRole('button', { name: '配置', exact: true }).click();
    await page.getByRole('tab', { name: '渠道' }).waitFor().catch(() => {});
    await page.getByRole('button', { name: '编辑', exact: true }).first().click();
    const channelApiKeyInput = page.locator('input[placeholder="sk-..."]');
    await channelApiKeyInput.waitFor({ state: 'visible' });
    assert.equal(await channelApiKeyInput.evaluate((input, expected) => input.value === expected, modelConfigApiKeys.channel), true,
        'the remote settings editor should hydrate the user’s saved channel key after reload');
    await page.keyboard.press('Escape');
    await page.locator('.ant-drawer-section').waitFor({ state: 'hidden' });

    let bridgeReport;
    try {
        bridgeReport = await waitForBridgeReport((report) => report.eventConnections.length >= 2
            && Boolean(latestSnapshotWithImportedNode(report, report.eventConnections.at(-1)?.clientId || '')),
        'the reopened Canvas project with its imported image');
    } catch (error) {
        const report = await fetch(`http://127.0.0.1:${bridgeServer.address().port}/__test-state`)
            .then((response) => response.json()).catch(() => null);
        const indexedCanvas = await page.evaluate(async () => {
            let database;
            try {
                database = await new Promise((resolveOpen, rejectOpen) => {
                    const request = indexedDB.open('infinite-canvas');
                    request.onsuccess = () => resolveOpen(request.result);
                    request.onerror = () => rejectOpen(request.error);
                });
                const stored = await new Promise((resolveGet, rejectGet) => {
                    const request = database.transaction('app_state', 'readonly')
                        .objectStore('app_state').get('infinite-canvas:canvas_store');
                    request.onsuccess = () => resolveGet(request.result);
                    request.onerror = () => rejectGet(request.error);
                });
                const value = typeof stored === 'string' ? JSON.parse(stored) : stored;
                return (value?.state?.projects || []).map((project) => ({
                    id: project.id,
                    title: project.title,
                    nodes: (project.nodes || []).map((node) => ({ id: node.id, storageKey: node.metadata?.storageKey || '' })),
                }));
            } catch (cause) { return { error: String(cause) }; }
            finally { database?.close(); }
        });
        console.error(JSON.stringify({
            url: page.url(),
            browserDiagnostics,
            indexedCanvas,
            bridgeReport: report && {
                bootstrapCount: report.bootstrapCalls.length,
                eventConnections: report.eventConnections,
                canvasStates: report.canvasStates.map((item) => ({
                    projectId: item.projectId,
                    title: item.title,
                    nodeIds: (item.nodes || []).map((node) => node.id),
                    storageKeys: (item.nodes || []).map((node) => node.metadata?.storageKey || ''),
                    query: item.query,
                })),
                toolResults: report.toolResults.map((item) => ({ requestId: item.requestId, error: item.error })),
            },
        }, null, 2));
        throw error;
    }
    assert.equal(bridgeReport.bootstrapCalls.length, 2, 'a manager reopen should supply a fresh one-use ticket');
    assert.ok(bridgeReport.eventConnections.length >= 2, 'initial and reopened pages should each connect');
    assert.ok(bridgeReport.eventConnections.every((entry) => entry.projectId === testProject.id
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(entry.clientId || '')));
    const reopenedClientId = bridgeReport.eventConnections.at(-1).clientId;
    assert.notEqual(reopenedClientId, firstClientId, 'a project-only reopen should generate a fresh in-memory clientId');
    const reopenedSnapshot = latestSnapshotWithImportedNode(bridgeReport, reopenedClientId);
    const reopenedNode = reopenedSnapshot.nodes.find((node) => node.id === importedNodeId);
    assert.equal(reopenedNode?.metadata?.storageKey, storageKey, 'reload should preserve the image node and storageKey in IndexedDB');
    assert.ok(bridgeReport.canvasStates.some((item) => item.projectId === testProject.id && item.title === testProject.title
        && item.query.clientId === reopenedClientId && item.query.tokenValid), 'the original IndexedDB canvas should be published to the bridge');

    const afterReloadRead = await sendToolCall(reopenedClientId, 'fixture-read-image-after-reload', 'canvas_read_image', {
        nodeId: importedNodeId,
    });
    assert.equal(afterReloadRead.error, undefined, `post-reload image read should succeed: ${afterReloadRead.error || ''}`);
    assertOriginalImageDataUrl(afterReloadRead.result?.dataUrl, 'Canvas read after fresh-ticket reload');
    assert.equal(await hasPersistedBootstrapSecret(page), false, 'fresh bootstrap must not persist its token or ticket');
    assert.deepEqual(forbiddenStudioRequests, [], 'remote profile must not call any P4 __studio endpoint');

    const evidenceDirectory = join(root, 'docs/evidence/company-canvas');
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(join(evidenceDirectory, 'remote-verification.json'), JSON.stringify({
        fixtureOnly: true, deployment: 'remote', https: true, indexedDb: true,
        ordinaryReloadPreserved: true, freshTicketReopenPreserved: true,
        imageSha256, originalStorageKeyPreserved: true, remoteModelConfigPreserved: true,
        bootstrapSecretsPersisted: false, studioEndpointRequests: 0,
    }, null, 2));

    console.log('Remote Canvas HTTPS fixture passed: imported image bytes were read back with the same SHA-256 before and after reload, with the original IndexedDB storageKey, a fresh ticket, and no __studio requests.');
} finally {
    await browser?.close();
    await Promise.all([bridgeServer, webServer].filter((server) => server.listening)
        .map((server) => new Promise((resolveClose) => server.close(() => resolveClose()))));
    await rm(tempRoot, { recursive: true, force: true });
}
