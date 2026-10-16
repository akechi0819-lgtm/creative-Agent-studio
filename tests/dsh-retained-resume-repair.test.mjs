import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { canonicalHeader } from '../adapters/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { createAssistantMessage, createDeveloperMessage, createSystemMessage, createToolResultMessage, createUserMessage } from '../adapters/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
import { compactLegacyAssetSearchResults } from '../adapters/dsh/asset-search.mjs';
import { createDshContext, createStudioAgent } from '../adapters/dsh/runtime.mjs';
import { repairLegacySearchSessionFile } from '../adapters/dsh/repair-legacy-search-session.mjs';
import { createTask } from '../src/creative/tasks.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function findSessionLog(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findSessionLog(target);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === 'session.v4.jsonl') return target;
  }
  return undefined;
}

test('offline repair removes only the exact turn-external legacy search replacements and preserves resumable history', async t => {
  const root = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.tmpdir(), 'studio-session-repair-')));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })));
  const task = await createTask({ title: '离线恢复夹具', brief: '只验证 session 可继续恢复' }, root);
  const sessionId = `studio-task-${task.id}`;
  const config = { baseUrl: 'http://127.0.0.1:1/v1', model: 'mock', apiKey: 'isolated-local-mock-key' };
  const ctx = await createDshContext({ root, config });
  let handle;
  let badSeq;
  let originalUserSeq;
  let laterHeaderSeq;
  let laterUserSeq;
  let originalToolText;
  try {
    handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: root },
      agentOptions: { provider: 'studio-basic', model: 'mock', maxTokens: 8000 },
      setup: () => {},
    });
    const session = handle.agent.session;
    const searchTool = {
      name: 'studio_search_assets',
      description: 'fixture search',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    };
    const readTool = {
      name: 'studio_read_task',
      description: 'fixture read',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    };

    session.append('turn/start', { turn: 1 });
    session.append('step/start', { turn: 1, step: 1 });
    session.append('system/message', {
      turn: 1,
      step: 1,
      message: createSystemMessage('离线恢复测试系统提示。'),
    }, { surfaceOp: 'append' });
    session.append('request/header', {
      header: canonicalHeader({ config: { provider: 'studio-basic', model: 'mock' }, tools: [searchTool] }),
      reason: 'initial',
    });
    const firstUser = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '原始用户消息必须保留。' }] }), { surfaceOp: 'append' });
    originalUserSeq = firstUser.seq;
    const callId = 'offline-legacy-search-call';
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ source: { provider: 'studio-basic', model: 'mock' }, content: [{ type: 'tool-call', id: callId, name: 'studio_search_assets', arguments: JSON.stringify({ query: 'KET' }) }] }),
      stream: [],
    }, { surfaceOp: 'append' });
    const toolCall = session.append('tool/call', { turn: 1, step: 1, callId, name: 'studio_search_assets', arguments: JSON.stringify({ query: 'KET' }) });
    const rawPayload = JSON.stringify({ assets: [{ id: 'legacy-asset', revision: 1, title: '保留的历史候选', body: 'PRIVATE-HISTORY-SENTINEL '.repeat(2000), summary: '摘要', tags: ['KET'], source: { kind: 'user-provided' }, files: [] }] });
    originalToolText = rawPayload;
    const toolResult = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: rawPayload }], isError: false }),
    }, { surfaceOp: 'append' });
    session.append('step/end', { turn: 1, step: 1 });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

    const compaction = compactLegacyAssetSearchResults(session, session.snapshotEvents());
    assert.equal(compaction.replacedCount, 1);
    badSeq = session.seq - 1;

    session.append('turn/start', { turn: 2 });
    session.append('step/start', { turn: 2, step: 1 });
    const secondHeader = session.append('request/header', {
      header: canonicalHeader({ config: { provider: 'studio-basic', model: 'mock' }, tools: [searchTool, readTool] }),
      reason: 'change',
    });
    laterHeaderSeq = secondHeader.seq;
    session.append('developer/message', {
      turn: 2,
      step: 1,
      message: createDeveloperMessage({ source: { kind: 'tool-registry' }, content: [{ type: 'tool-addition', toolName: 'studio_read_task' }] }),
      headerSeq: secondHeader.seq,
    }, { surfaceOp: 'append' });
    const secondUser = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '后续用户消息也必须保留。' }] }), {
      surfaceOp: 'append',
      sourceEventSeqs: [firstUser.seq],
    });
    laterUserSeq = secondUser.seq;
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '对后续输入的来源引用也要重映射。' }] }), {
      surfaceOp: 'append',
      sourceEventSeqs: [secondUser.seq],
    });
    session.append('assistant/message', {
      turn: 2,
      step: 1,
      message: createAssistantMessage({ source: { provider: 'studio-basic', model: 'mock' }, content: [{ type: 'text', text: '第二轮记录。' }] }),
      stream: [],
    }, { surfaceOp: 'append' });
    session.append('step/end', { turn: 2, step: 1 });
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
    await ctx.sessions.flush(session);
    assert.ok(toolCall.seq < toolResult.seq && toolResult.seq < badSeq);
  } finally {
    await handle?.dispose();
    await ctx.fiber.dispose();
  }

  const sessionFile = await findSessionLog(path.join(root, 'web', 'dsh', 'sessions'));
  assert.ok(sessionFile, 'fixture has a persisted plaintext JSONL session');
  const originalBytes = await readFile(sessionFile);
  const originalHash = hash(originalBytes);
  const dryRun = await repairLegacySearchSessionFile(sessionFile);
  assert.equal(dryRun.changed, true);
  assert.deepEqual(dryRun.removedSeqs, [badSeq]);
  assert.equal(dryRun.originalSha256, originalHash);
  assert.equal(hash(await readFile(sessionFile)), originalHash, 'dry-run leaves the source untouched');

  const written = await repairLegacySearchSessionFile(sessionFile, { write: true });
  assert.equal(written.changed, true);
  assert.equal(written.removedSeqs.length, 1);
  assert.equal(written.backupSha256, originalHash);
  assert.equal(hash(await readFile(written.backupPath)), originalHash, 'backup is a byte-identical copy');

  const verifyContext = await createDshContext({ root, config });
  try {
    const reader = await verifyContext.sessionPersistence.open(sessionId, 'read');
    let restored;
    try { restored = await reader.read(); } finally { await reader.close(); }
    assert.ok(restored.events.every((event, index) => event.seq === index));
    assert.equal(restored.events.filter(event => event.type === 'tool/result' && event.surfaceOp?.op === 'replace').length, 0, 'the invalid replacement operation is removed; its old seq is reused by a retained event');
    assert.equal(restored.events.find(event => event.type === 'tool/result' && event.data?.message?.toolCallId === 'offline-legacy-search-call')?.data.message.content[0].text, originalToolText);
    const remappedHeader = restored.events.find(event => event.type === 'developer/message');
    assert.equal(remappedHeader.data.headerSeq, laterHeaderSeq - 1);
    const remappedUser = restored.events.find(event => event.type === 'user/message' && event.data.content[0]?.text === '后续用户消息也必须保留。');
    assert.equal(remappedUser.seq, laterUserSeq - 1);
    assert.deepEqual(remappedUser.sourceEventSeqs, [originalUserSeq]);
    const remappedSource = restored.events.find(event => event.type === 'user/message' && event.data.content[0]?.text === '对后续输入的来源引用也要重映射。');
    assert.deepEqual(remappedSource.sourceEventSeqs, [laterUserSeq - 1]);
    assert.equal(restored.events.filter(event => event.type === 'user/message').length, 3);
    assert.equal(restored.events.filter(event => event.type === 'tool/call').length, 1);
    assert.equal(restored.events.filter(event => event.type === 'tool/result').length, 1, 'only the invalid replacement copy is removed');
  } finally { await verifyContext.fiber.dispose(); }

  const requests = [];
  const server = createServer(async (request, response) => {
    let bodyText = '';
    for await (const chunk of request) bodyText += chunk;
    requests.push(JSON.parse(bodyText));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'offline-repair-mock', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: '离线恢复后的 mock 回复。' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'offline-repair-mock', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const readConfig = async () => ({ basic: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock', apiKey: 'offline-repair-mock-key' } });
  const agent = createStudioAgent({ root, readConfig });
  await agent.chat({ taskId: task.id, text: '恢复后第一轮继续。', expectedRevision: task.revision });
  const postResumeContext = await createDshContext({ root, config: (await readConfig()).basic });
  try {
    const reader = await postResumeContext.sessionPersistence.open(sessionId, 'read');
    try { await reader.read(); } finally { await reader.close(); }
  } finally { await postResumeContext.fiber.dispose(); }
  await agent.chat({ taskId: task.id, text: '恢复后第二轮继续。', expectedRevision: task.revision });
  assert.equal(requests.length, 2, 'the repaired official session completes two model-backed resumes');
  assert.ok(requests.every(request => request.model === 'mock'));

  const repairedBytes = await readFile(sessionFile);
  const repairedHash = hash(repairedBytes);
  const idempotent = await repairLegacySearchSessionFile(sessionFile, { write: true });
  assert.deepEqual(idempotent, { changed: false, removedSeqs: [], originalSha256: repairedHash });
  assert.equal(hash(await readFile(sessionFile)), repairedHash, 're-running does not rewrite or create another backup');
});
