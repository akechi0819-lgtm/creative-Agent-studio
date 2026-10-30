import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { callCanvasTool } from '../src/canvas/client.mjs';
import { createCompanyCanvasMcp } from '../src/canvas/mcp.mjs';

test('MCP returns actionable text only for the two fixed safe Canvas errors', async (t) => {
  const fixedErrors = [
    '图片服务尚未配置，请回到宿主智能体配置图片 API。',
    '该节点正在生成图片，请先查询 generation_get_status，完成后再生成。',
  ];
  let upstreamError = fixedErrors[0];
  const bridge = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health') {
      response.end(JSON.stringify({ instanceId: 'test-instance', targets: [{ projectId: 'test-project', clientId: 'test-client', hasCanvas: true }] }));
      return;
    }
    if (request.url === '/api/tools') {
      response.statusCode = 409;
      response.end(JSON.stringify({ ok: false, error: upstreamError }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'unknown route' }));
  });
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  const address = bridge.address();
  const config = {
    bridgeUrl: `http://127.0.0.1:${address.port}`,
    token: 'test-token',
    instanceId: 'test-instance',
    projectId: 'test-project',
    clientId: 'test-client',
  };
  const runtime = {
    status: async () => ({ running: true, targets: [] }),
    open: async () => ({ running: true }),
    call: (name, input) => callCanvasTool(name, input, config),
  };
  const server = createCompanyCanvasMcp({ root: process.cwd(), runtime });
  const client = new Client({ name: 'safe-error-fixture', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
    await new Promise((resolve) => bridge.close(resolve));
  });

  for (const message of fixedErrors) {
    upstreamError = message;
    const result = await client.callTool({ name: 'canvas_run_generation', arguments: { nodeId: 'image-1' } });
    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.text, message);
  }

  upstreamError = 'private prompt secret';
  const hidden = await client.callTool({ name: 'canvas_run_generation', arguments: { nodeId: 'image-1' } });
  assert.equal(hidden.isError, true);
  assert.doesNotMatch(hidden.content[0]?.text || '', /private|secret/);
});
