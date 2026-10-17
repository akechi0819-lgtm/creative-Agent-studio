import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStudioAgent } from '../adapters/dsh/runtime.mjs';
import { createTask } from '../src/creative/tasks.mjs';
import { isReleasePathAllowed } from '../src/launcher/distribution.mjs';
import { readConfig, readConfigRecord, resolveBasicConfig, saveConfig } from '../src/web/config.mjs';
import { stopModelPlugin } from '../src/web/model-plugin.mjs';

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function sseResponse(response, { delta, finishReason }) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({
    id: 'fake-kilo-round', object: 'chat.completion.chunk', created: 1,
    model: 'mimo-v2.5-free', choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`);
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`);
}

test('company hosted Kilo config starts the local plugin and completes one real DSH text/tool round without personal or image API keys', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-company-hosted-chat-'));
  const priorKiloBase = process.env.OUR_FREE_MODEL_KILO_BASE;
  const upstreamRequests = [];
  const events = [];
  let upstream;

  t.after(async () => {
    await stopModelPlugin({ root }).catch(() => {});
    if (upstream) {
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
    }
    if (priorKiloBase === undefined) delete process.env.OUR_FREE_MODEL_KILO_BASE;
    else process.env.OUR_FREE_MODEL_KILO_BASE = priorKiloBase;
    await rm(root, { recursive: true, force: true });
  });

  upstream = createServer(async (request, response) => {
    const raw = await requestBody(request);
    const body = raw ? JSON.parse(raw) : undefined;
    upstreamRequests.push({ method: request.method, path: request.url, authorization: request.headers.authorization ?? null, body });

    if (request.method === 'GET' && request.url === '/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([{ id: 'mimo-v2.5-free', name: 'Fixture Free', isFree: true, architecture: { input_modalities: ['text'] } }]));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/chat/completions') {
      response.writeHead(404).end();
      return;
    }

    const hasToolResult = body?.messages?.some(message => message.role === 'tool');
    if (!hasToolResult) {
      const tool = body?.tools?.find(item => item.function?.name === 'studio_ask_questions');
      if (!tool) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'DSH did not send its registered tool list' } }));
        return;
      }
      const questions = { questions: [{ id: 'audience', question: '目标读者是谁？', options: [{ id: 'parents', label: '家长' }, { id: 'students', label: '学生' }] }] };
      sseResponse(response, {
        delta: { tool_calls: [{ index: 0, id: 'fixture-question-call', type: 'function', function: {
          name: tool.function.name,
          arguments: JSON.stringify({ payload: JSON.stringify(questions) }),
        } }] },
        finishReason: 'tool_calls',
      });
      return;
    }

    sseResponse(response, { delta: { role: 'assistant', content: '已通过托管 Kilo 完成 DSH 文本回复。' }, finishReason: 'stop' });
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  process.env.OUR_FREE_MODEL_KILO_BASE = `http://127.0.0.1:${upstream.address().port}`;

  const saved = await saveConfig({
    expectedRevision: 1,
    base: { source: 'kilo', model: 'kilo/mimo-v2.5-free' },
  }, { root });
  assert.equal(saved.base.apiKey, '', 'hosted source selection must not require a personal API key');
  assert.equal(saved.base.baseUrl, '', 'hosted source selection must not require a personal endpoint');
  assert.deepEqual(saved.image, { baseUrl: '', model: '', apiKey: '' }, 'text chat must work without image API settings');

  const record = await readConfigRecord({ root });
  assert.equal(record.base.source, 'kilo');
  assert.equal(record.base.model, 'kilo/mimo-v2.5-free');
  const basic = await resolveBasicConfig(record.base, { root });
  assert.equal(basic.source, 'kilo');
  assert.equal(basic.model, 'kilo/mimo-v2.5-free');
  assert.match(basic.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.match(basic.apiKey, /^[a-f0-9]{64}$/);

  const resolved = await readConfig({ root });
  assert.deepEqual(resolved.basic, basic, 'DSH receives the same resolved local plugin connection');
  assert.deepEqual(resolved.image, { baseUrl: '', model: '', apiKey: '' });
  const plugin = JSON.parse(await readFile(path.join(root, 'model-plugin', 'instance.json'), 'utf8'));
  assert.notEqual(plugin.pid, process.pid, 'the actual model plugin runs as its managed child process');
  assert.equal(plugin.baseUrl, basic.baseUrl.replace(/\/v1$/u, ''));

  const task = await createTask({ title: '托管聊天隔离任务', brief: '验证基础文本聊天' }, root);
  const agent = createStudioAgent({ root, readConfig: () => readConfig({ root }) });
  const result = await agent.chat({
    taskId: task.id,
    expectedRevision: task.revision,
    text: '请先询问目标读者，再告诉我本轮已完成。',
    onEvent: event => events.push(event),
  });
  assert.equal(result.text, '已通过托管 Kilo 完成 DSH 文本回复。');
  assert.ok(events.some(event => event.type === 'questions' && event.questions[0]?.id === 'audience'), 'the real DSH tool call is executed by the runtime');

  const listing = upstreamRequests.find(request => request.method === 'GET' && request.path === '/models');
  const turns = upstreamRequests.filter(request => request.method === 'POST' && request.path === '/chat/completions');
  assert.ok(listing, 'the local plugin fetched the Kilo model list from the fake free upstream');
  assert.equal(turns.length, 2, 'DSH made a tool-call turn and a final text turn through the local plugin');
  assert.deepEqual(upstreamRequests.map(request => `${request.method} ${request.path}`), [
    'GET /models', 'POST /chat/completions', 'POST /chat/completions',
  ], 'the chat path makes no image API request');
  assert.ok(turns[0].body.tools.some(item => item.function?.name === 'studio_ask_questions'));
  assert.ok(JSON.stringify(turns[0].body.messages).includes('请先询问目标读者'));
  assert.ok(turns[1].body.messages.some(message => message.role === 'tool'));
  assert.ok(upstreamRequests.every(request => request.authorization === null), 'the local plugin sent no personal authorization credential upstream');

  const packagePaths = [
    'scripts/web.mjs', 'scripts/model-plugin.mjs', 'src/web/config.mjs',
    'src/web/model-plugin.mjs', 'adapters/dsh/runtime.mjs', 'adapters/dsh/package.json',
    'adapters/dsh/package-lock.json', 'adapters/free-model/service.mjs',
    'third_party/our-free-model/src/kilo.js', 'third_party/our-free-model/src/core/completion.js',
  ];
  for (const relativePath of packagePaths) {
    assert.equal(isReleasePathAllowed(relativePath, { profile: 'company' }), true, `Company package must include ${relativePath}`);
  }
});
