import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '../adapters/dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
import Sessions from '../adapters/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { createToolResultMessage } from '../adapters/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';

import { compactLegacyAssetSearchResults, findAssetCandidates, taskSheetsForPrompt, taskSourcesForPrompt } from '../adapters/dsh/asset-search.mjs';

function asset(index, body = 'KET') {
  return {
    id: `asset-${index}`,
    revision: index + 1,
    title: `KET candidate ${index}`,
    body,
    summary: 's'.repeat(800),
    tags: Array.from({ length: 12 }, (_, tag) => `tag-${tag}`),
    source: { kind: 'user-provided', platform: '小红书', factBoundary: '仅供结构参考。', origin: '/private/source/path' },
    files: Array.from({ length: 5 }, (_, order) => ({ name: `preview-${order}.png`, mimeType: 'image/png', order, relativePath: '/private/source/path' })),
    extractions: [{ text: 'SECRET-OCR-SENTINEL' }],
    history: [{ note: 'SECRET-HISTORY-SENTINEL' }],
    confirmedSnapshot: { body: 'SECRET-SNAPSHOT-SENTINEL' },
  };
}

function mockQuery(records, calls = []) {
  return async ({ query, offset = 0, limit = 100 }) => {
    calls.push({ query, offset, limit });
    const matches = records.filter(record => `${record.title} ${record.body}`.toLocaleLowerCase('zh-CN').includes(query.toLocaleLowerCase('zh-CN')));
    return matches.slice(offset, offset + limit);
  };
}

test('asset search retries short terms, reports exact hits, and returns only bounded preview metadata', async () => {
  const records = Array.from({ length: 7 }, (_, index) => asset(index));
  const calls = [];
  const result = await findAssetCandidates('KET 学习 小红书', { queryAssets: mockQuery(records, calls), root: '/tmp/fixture' });

  assert.equal(result.query, 'KET');
  assert.equal(result.hitCount, 7);
  assert.equal(result.returnedCount, 5);
  assert.equal(result.items.length, 5);
  assert.equal(calls[0].query, 'KET 学习 小红书');
  assert.equal(calls[1].query, 'KET');
  const first = result.items[0];
  assert.equal(first.revision, 1);
  assert.equal(first.summary.length, 600);
  assert.equal(first.tags.length, 8);
  assert.equal(first.filesCount, 5);
  assert.deepEqual(first.previews[0], { name: 'preview-0.png', mediaType: 'image/png', order: 0 });
  assert.equal(first.source.factBoundary, '仅供结构参考。');
  const serialized = JSON.stringify(result);
  for (const forbidden of ['SECRET-OCR-SENTINEL', 'SECRET-HISTORY-SENTINEL', 'SECRET-SNAPSHOT-SENTINEL', 'relativePath', 'origin']) {
    assert.equal(serialized.includes(forbidden), false, `search output must not include ${forbidden}`);
  }
});

test('mixed-case English keyword remains searchable and a full hit count can cross library pages', async () => {
  const records = Array.from({ length: 501 }, (_, index) => asset(index));
  const calls = [];
  const result = await findAssetCandidates('KeT', { queryAssets: mockQuery(records, calls) });

  assert.equal(result.query, 'KeT');
  assert.equal(result.hitCount, 501);
  assert.equal(result.returnedCount, 5);
  assert.deepEqual(calls.map(call => call.offset), [0, 500]);
});

test('pending library candidates omit OCR and file data from the task prompt projection', () => {
  const sources = taskSourcesForPrompt([
    { id: 'asset-1', title: '候选', decision: 'pending', purpose: '结构', factBoundary: '仅参考', asset: { id: 'asset-1', revision: 2 }, body: 'SECRET-OCR-SENTINEL', summary: '摘要', tags: ['KET'], extractions: ['SECRET'], files: [{ relativePath: '/private/path' }], history: [{ body: 'SECRET' }] },
    { id: 'asset-2', title: '已保留', decision: 'retained', purpose: '结构', factBoundary: '仅参考', asset: { id: 'asset-2', revision: 3 }, body: 'b'.repeat(5000), summary: '摘要', tags: [] },
    { id: 'external-1', title: '外部候选', type: 'external', decision: 'pending', body: 'SECRET-PENDING-BODY', url: 'https://example.test', files: [], history: ['SECRET'] },
    { id: 'upload-1', title: '保留附件', type: 'current_attachment', decision: 'retained', extractions: [{ name: 'scan.pdf', kind: 'pdf', text: 'RETAINED-PDF-SENTINEL-' + 'x'.repeat(5000) }], files: [{ relativePath: '/private/upload.pdf', sha256: 'SECRET-HASH' }], history: [{ text: 'SECRET' }] },
    { id: 'upload-2', title: '待选附件', type: 'current_attachment', decision: 'pending', extractions: [{ name: 'notes.pdf', kind: 'pdf', text: 'PENDING-PDF-SENTINEL-' + 'y'.repeat(5000) }], files: [{ relativePath: '/private/notes.pdf' }], history: [{ text: 'SECRET-PENDING-HISTORY' }] },
    { id: 'upload-3', title: '排除附件', type: 'current_attachment', decision: 'excluded', extractions: [{ name: 'excluded.pdf', kind: 'pdf', text: 'EXCLUDED-PDF-SENTINEL' }], files: [] },
  ]);

  assert.equal('body' in sources[0], false);
  assert.equal('extractions' in sources[0], false);
  assert.equal('files' in sources[0], false);
  assert.equal('history' in sources[0], false);
  assert.equal(sources[1].body.length, 4000);
  assert.equal('body' in sources[2], false);
  assert.equal('url' in sources[2], false);
  assert.equal(sources[3].extractions[0].text.length, 4000);
  assert.equal(sources[3].extractions[0].truncated, true);
  assert.equal(sources[4].extractions[0].text.slice(0, 'PENDING-PDF-SENTINEL'.length), 'PENDING-PDF-SENTINEL');
  assert.equal(sources[4].extractions[0].text.length, 4000);
  assert.equal(sources[4].extractions[0].truncated, true);
  assert.match(sources[4].extractionNote, /未经用户确认不得作为已核实事实/);
  assert.equal('extractions' in sources[5], false);
  const serialized = JSON.stringify(sources);
  for (const included of ['RETAINED-PDF-SENTINEL', 'PENDING-PDF-SENTINEL']) assert.ok(serialized.includes(included));
  for (const forbidden of ['SECRET-OCR-SENTINEL', 'SECRET-PENDING-BODY', 'SECRET-PENDING-HISTORY', 'EXCLUDED-PDF-SENTINEL', 'relativePath', 'sha256', 'history', 'SECRET-HASH']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('current attachment excerpts stay within four files and a shared sixteen-thousand-character budget', () => {
  const promptSources = taskSourcesForPrompt(Array.from({ length: 5 }, (_, index) => ({
    id: `upload-${index}`,
    title: `第 ${index} 份资料`,
    type: 'current_attachment',
    decision: 'pending',
    extractions: [{ name: `${index}.pdf`, kind: 'pdf', text: `PDF-${index}-SENTINEL-` + 'z'.repeat(6000) }],
    history: [{ text: 'SECRET-HISTORY-SENTINEL' }],
    files: [{ relativePath: `/private/${index}.pdf` }],
  })));
  const excerpts = promptSources.flatMap(source => source.extractions ?? []);
  assert.equal(excerpts.length, 4);
  assert.ok(excerpts.every(excerpt => excerpt.text.length <= 4000 && excerpt.truncated));
  assert.ok(excerpts.reduce((sum, excerpt) => sum + excerpt.text.length, 0) <= 16_000);
  assert.equal(JSON.stringify(promptSources).includes('SECRET-HISTORY-SENTINEL'), false);
  assert.equal(JSON.stringify(promptSources).includes('/private/'), false);
});

test('sheet prompt projection keeps only the latest bounded editable pages, not source history snapshots', () => {
  const sheets = taskSheetsForPrompt([
    { version: 1, title: '旧版本', inputs: { sources: [{ extractions: [{ text: 'SECRET-OLD-OCR' }] }] }, pages: [] },
    {
      version: 2,
      title: '当前制作单',
      sourceIds: ['retained-1'],
      inputsRevision: 9,
      inputs: { sources: [{ body: 'SECRET-SNAPSHOT-BODY', extractions: [{ text: 'SECRET-SHEET-OCR' }], files: [{ relativePath: '/private/path' }] }] },
      pages: [{ page: 1, copy: 'c'.repeat(5000), prompt: 'p'.repeat(5000), size: '3:4', sourceIds: ['retained-1'] }],
    },
  ]);

  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].version, 2);
  assert.equal(sheets[0].pages[0].copy.length, 4000);
  assert.equal(sheets[0].pages[0].prompt.length, 4000);
  const serialized = JSON.stringify(sheets);
  for (const forbidden of ['"inputs":', 'SECRET-OLD-OCR', 'SECRET-SNAPSHOT-BODY', 'SECRET-SHEET-OCR', 'relativePath']) {
    assert.equal(serialized.includes(forbidden), false, `sheet prompt must not include ${forbidden}`);
  }
});

test('legacy oversized search result is replaced on the official DSH surface without changing tool identity', async t => {
  const ctx = new Context();
  await ctx.plugin(Sessions, {}).await();
  t.after(() => ctx.fiber.dispose());
  const session = ctx.sessions.create('asset-search-repair-fixture');
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  const call = session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: 'search-call-1',
    name: 'studio_search_assets',
    arguments: JSON.stringify({ query: 'KeT' }),
  });
  const rawText = JSON.stringify({ assets: Array.from({ length: 7 }, (_, index) => asset(index, 'x'.repeat(10000))) });
  const original = session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: 'search-call-1', content: [{ type: 'text', text: rawText }], isError: false }),
  }, { surfaceOp: 'append' });

  const repaired = compactLegacyAssetSearchResults(session, [call, original]);
  const visibleToolMessage = session.deriveMessages().find(message => message.role === 'tool');

  assert.deepEqual(repaired, { replacedCount: 1, charactersRemoved: rawText.length - visibleToolMessage.content[0].text.length });
  assert.equal(session.surface.nodes.includes(original.seq), false);
  assert.equal(visibleToolMessage.id, original.data.message.id);
  assert.equal(visibleToolMessage.role, 'tool');
  assert.equal(visibleToolMessage.toolCallId, 'search-call-1');
  assert.equal(visibleToolMessage.source.callId, 'search-call-1');
  const summary = JSON.parse(visibleToolMessage.content[0].text);
  assert.equal(summary.query, 'KeT');
  assert.equal(summary.hitCount, 7);
  assert.equal(summary.hitCountExact, true);
  assert.equal(summary.returnedCount, 7);
  assert.equal(summary.items.length, 5);
  assert.equal(summary.items[0].title, 'KET candidate 0');
  assert.equal(original.data.message.content[0].text, rawText, 'the original durable event value remains unchanged');
  for (const forbidden of ['SECRET-OCR-SENTINEL', 'SECRET-HISTORY-SENTINEL', 'relativePath', 'origin']) {
    assert.equal(JSON.stringify(session.deriveMessages()).includes(forbidden), false);
  }
});
