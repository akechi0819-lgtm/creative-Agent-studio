import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createCompanyCanvasMcp } from '../src/canvas/mcp.mjs';
import { canvasImportErrorCodes } from '../src/canvas/import-errors.mjs';

test('canvas_import_file gives safe next steps for local file failures', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-lite-import-errors-'));
  let calls = 0;
  const runtime = {
    status: async () => ({ running: true, targets: [] }),
    open: async () => ({ running: true }),
    call: async () => { calls += 1; return { ok: true }; },
  };
  const { client, server } = await connectMcp(root, runtime);
  t.after(async () => {
    await client.close();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const unsupportedPath = path.join(root, 'private-source.txt');
  await fs.writeFile(unsupportedPath, 'private data');
  const unsupported = await client.callTool({ name: 'canvas_import_file', arguments: { path: unsupportedPath, title: 'Reference' } });
  assert.equal(unsupported.isError, true);
  assert.match(toolText(unsupported), /格式不支持/);
  assert.match(toolText(unsupported), /PNG、JPEG 或 WebP/);
  assert.equal(toolText(unsupported).includes(unsupportedPath), false);

  const missingPath = path.join(root, 'missing-private-source.png');
  const missing = await client.callTool({ name: 'canvas_import_file', arguments: { path: missingPath, title: 'Reference' } });
  assert.equal(missing.isError, true);
  assert.match(toolText(missing), /找不到指定本机文件/);
  assert.equal(toolText(missing).includes(missingPath), false);

  const directoryPath = path.join(root, 'folder.png');
  await fs.mkdir(directoryPath);
  const directory = await client.callTool({ name: 'canvas_import_file', arguments: { path: directoryPath, title: 'Reference' } });
  assert.match(toolText(directory), /指定路径不是文件/);

  const largePath = path.join(root, 'large.png');
  const largeFile = await fs.open(largePath, 'w');
  await largeFile.truncate(20 * 1024 * 1024 + 1);
  await largeFile.close();
  const large = await client.callTool({ name: 'canvas_import_file', arguments: { path: largePath, title: 'Reference' } });
  assert.match(toolText(large), /文件超过 20 MiB/);

  const emptyPath = path.join(root, 'empty.png');
  await fs.writeFile(emptyPath, '');
  const empty = await client.callTool({ name: 'canvas_import_file', arguments: { path: emptyPath, title: 'Reference' } });
  assert.match(toolText(empty), /图片无法解码/);
  assert.equal(calls, 0, 'local validation errors do not reach the Canvas bridge');
});

test('MCP import errors hide untrusted detail while preserving a trusted bridge request ID', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-lite-import-errors-'));
  const requestId = 'e8ee0961-a2a3-4d21-a770-9f1d54a0af17';
  const runtime = {
    status: async () => ({ running: true, targets: [] }),
    open: async () => ({ running: true }),
    call: async () => { throw Object.assign(new Error('private prompt and API key'), { code: canvasImportErrorCodes.invalidImage, requestId, status: 422 }); },
  };
  const { client, server } = await connectMcp(root, runtime);
  t.after(async () => {
    await client.close();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const sourcePath = path.join(root, 'source.png');
  await fs.writeFile(sourcePath, 'fixture bytes');
  const result = await client.callTool({ name: 'canvas_import_file', arguments: { path: sourcePath, title: 'private-title' } });
  assert.equal(result.isError, true);
  const text = toolText(result);
  assert.match(text, /图片无法解码/);
  assert.match(text, /用图片查看器确认原件可正常打开/);
  assert.match(text, new RegExp(requestId));
  assert.doesNotMatch(text, /private prompt|API key|private-title|source\.png/);
});

test('unknown MCP import failures include a diagnostic ID only when the bridge supplied one', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-lite-import-errors-'));
  let runtimeError = new Error('private path /Users/employee/secret.png API key');
  const runtime = {
    status: async () => ({ running: true, targets: [] }),
    open: async () => ({ running: true }),
    call: async () => { throw runtimeError; },
  };
  const { client, server } = await connectMcp(root, runtime);
  t.after(async () => {
    await client.close();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const sourcePath = path.join(root, 'source.png');
  await fs.writeFile(sourcePath, 'fixture bytes');
  const withoutId = await client.callTool({ name: 'canvas_import_file', arguments: { path: sourcePath, title: 'Reference' } });
  assert.match(toolText(withoutId), /canvas_get_state/);
  assert.match(toolText(withoutId), /发生时间附近的本机脱敏 Canvas 日志/);
  assert.doesNotMatch(toolText(withoutId), /private path|employee|secret\.png|API key|诊断编号/);

  runtimeError = Object.assign(new Error('private path and API key'), { requestId: 'e8ee0961-a2a3-4d21-a770-9f1d54a0af17', status: 500 });
  const withId = await client.callTool({ name: 'canvas_import_file', arguments: { path: sourcePath, title: 'Reference' } });
  assert.match(toolText(withId), /canvas_get_state/);
  assert.doesNotMatch(toolText(withId), /诊断编号/);
  runtimeError = Object.assign(new Error('private path and API key'), {
    code: canvasImportErrorCodes.resultUnknown,
    requestId: 'e8ee0961-a2a3-4d21-a770-9f1d54a0af17',
    status: 500,
  });
  const trustedId = await client.callTool({ name: 'canvas_import_file', arguments: { path: sourcePath, title: 'Reference' } });
  assert.match(toolText(trustedId), /canvas_get_state/);
  assert.match(toolText(trustedId), /诊断编号 e8ee0961-a2a3-4d21-a770-9f1d54a0af17/);
  assert.doesNotMatch(toolText(trustedId), /private path|API key/);
});

async function connectMcp(root, runtime) {
  const server = createCompanyCanvasMcp({ root, runtime });
  const client = new Client({ name: 'canvas-import-error-fixture', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function toolText(result) {
  return result.content.find((item) => item.type === 'text')?.text || '';
}
