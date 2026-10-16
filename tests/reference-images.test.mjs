import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  attachTaskFiles,
  confirmInputs,
  confirmSheet,
  createTask,
  readTask,
  setSheet,
  setSources,
} from '../src/creative/tasks.mjs';
import { executeTask } from '../src/creative/executor.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmZkAAAAASUVORK5CYII=', 'base64');
const config = { projectId: 'reference-fixture', webUrl: 'http://fixture', clientId: 'fixture' };
const getHealth = async () => ({ targets: [{ hasCanvas: true, projectId: config.projectId, clientId: config.clientId }] });

async function setup(t, { retained = true, fileCount = 2 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-reference-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uploadDirectory = path.join(root, 'uploads');
  await mkdir(uploadDirectory, { recursive: true });
  const paths = [];
  for (let index = 0; index < fileCount; index += 1) {
    const file = path.join(uploadDirectory, `reference-${index + 1}.png`);
    await writeFile(file, index === 0 ? PNG : Buffer.concat([PNG, Buffer.from([index])]));
    paths.push(file);
  }

  let task = await createTask({ title: '参考图片合同夹具', brief: { topic: '测试', requirements: '仅用于隔离测试' } }, root);
  task = await attachTaskFiles(task.id, {
    files: paths.map((file, index) => ({ path: file, name: `参考-${index + 1}.png`, mimeType: 'image/png' })),
    title: '用户上传的视觉参考',
    purpose: '测试原始图片引用',
    factBoundary: '仅隔离夹具，不用于真实创作',
  }, { root, expectedRevision: task.revision });
  const source = task.sources[0];
  task = await setSources(task.id, task.sources.map(item => ({ ...item, decision: retained ? 'retained' : 'excluded' })), { root, expectedRevision: task.revision });
  task = await confirmInputs(task.id, { revision: task.revision, by: '测试用户', note: '仅隔离夹具' }, { root });
  return { root, task, source, page: { page: 1, copy: '夹具文案', prompt: '按参考图生成测试图片', size: '3:4', sourceIds: [source.id], referenceImages: [{ sourceId: source.id, fileOrder: 1 }] } };
}

async function confirmSheetFor(task, root, page, { sheetSourceIds = [page.referenceImages?.[0]?.sourceId || page.sourceIds[0]] } = {}) {
  task = await setSheet(task.id, { title: '参考图片夹具制作单', sourceIds: sheetSourceIds, pages: [page] }, {
    root,
    expectedRevision: task.revision,
    inputRevision: task.inputConfirmation.revision,
  });
  return confirmSheet(task.id, { version: task.sheetVersion, by: '测试用户', note: '仅隔离夹具' }, { root, expectedRevision: task.revision });
}

function canvas({ onRun } = {}) {
  const nodes = [];
  const connections = [];
  const importedImages = new Map();
  let runs = 0;
  let imports = 0;
  let applyOpsCalls = 0;
  const tool = async (name, input) => {
    if (name === 'canvas_get_state') return { nodes, connections };
    if (name === 'canvas_apply_ops') {
      applyOpsCalls += 1;
      for (const op of input.ops) {
        if (op.type === 'add_node') nodes.push({ id: op.id, type: op.nodeType, position: op.position, metadata: op.metadata });
        if (op.type === 'update_node') {
          const node = nodes.find(item => item.id === op.id);
          if (node) Object.assign(node, op.patch);
        }
        if (op.type === 'connect_nodes') connections.push({ fromNodeId: op.fromNodeId, toNodeId: op.toNodeId });
      }
      return {};
    }
    if (name === 'canvas_import_image') {
      imports += 1;
      const bytes = Buffer.from(input.dataUrl.split(',')[1], 'base64');
      importedImages.set(input.nodeId, input.dataUrl);
      nodes.push({
        id: input.nodeId,
        type: 'image',
        title: input.title,
        position: { x: 1000, y: 0 },
        metadata: { content: `blob:fixture/${input.nodeId}`, storageKey: `image:fixture:${imports}`, status: 'success', naturalWidth: 1, naturalHeight: 1, bytes: bytes.length, mimeType: 'image/png' },
      });
      return { operation: 'import', sourceNodeId: input.nodeId, images: [{ nodeId: input.nodeId, width: 1, height: 1 }] };
    }
    if (name === 'canvas_read_image') {
      const dataUrl = importedImages.get(input.nodeId);
      if (!dataUrl) throw new Error('fixture image missing');
      return { dataUrl, width: 1, height: 1 };
    }
    if (name === 'canvas_run_generation') {
      runs += 1;
      if (onRun) return onRun(input, { nodes, connections, runs });
      nodes.push({ id: `output-${runs}`, type: 'image', metadata: { status: 'success' } });
      connections.push({ fromNodeId: input.nodeId, toNodeId: `output-${runs}` });
      return {};
    }
    if (name === 'generation_get_status') return { tasks: [{ id: input.nodeIds[0], status: 'running' }] };
    if (name === 'canvas_read_image') throw new Error('fixture should not need remote image read');
    throw new Error(`unexpected Canvas tool ${name}`);
  };
  return {
    nodes,
    connections,
    tool,
    runs: () => runs,
    imports: () => imports,
    importedDataUrl: nodeId => importedImages.get(nodeId),
    applyOpsCalls: () => applyOpsCalls,
    deliver(configNodeId) {
      const imageId = 'late-output';
      nodes.push({ id: imageId, type: 'image', metadata: { status: 'success' } });
      connections.push({ fromNodeId: configNodeId, toNodeId: imageId });
    },
  };
}

async function executeCurrent(id, options) {
  const task = await readTask(id, options.root);
  return executeTask(id, { ...options, expectedRevision: task.revision });
}

const recover = async (nodeId, file) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `fixture output from ${nodeId}`);
  return { path: file, nodeId };
};

test('setSheet persists exact per-page image references and a new reference selection requires confirmation again', async t => {
  const { root, task: initial, source, page } = await setup(t);
  const first = await confirmSheetFor(initial, root, page);
  assert.deepEqual(first.sheets[0].pages[0].referenceImages, [{ sourceId: source.id, fileOrder: 1 }]);
  assert.deepEqual(first.sheets[0].inputs.sources[0].files.map(file => file.order), [1, 2]);

  const changedPage = { ...page, referenceImages: [{ sourceId: source.id, fileOrder: 2 }] };
  const second = await setSheet(first.id, { title: '参考图片夹具制作单', sourceIds: [source.id], pages: [changedPage] }, {
    root,
    expectedRevision: first.revision,
    inputRevision: first.inputConfirmation.revision,
  });
  assert.equal(second.sheetVersion, 2);
  assert.equal(second.sheetConfirmation, null);
  assert.deepEqual(second.sheets[1].pages[0].referenceImages, [{ sourceId: source.id, fileOrder: 2 }]);
});

test('setSheet rejects references outside either source scope, excluded sources, missing file orders, and more than twelve images', async t => {
  const { root, task: initial, source, page } = await setup(t);
  await assert.rejects(confirmSheetFor(initial, root, { ...page, sourceIds: [] }), /本页来源范围/);
  await assert.rejects(confirmSheetFor(initial, root, page, { sheetSourceIds: [] }), /制作单来源范围/);
  await assert.rejects(confirmSheetFor(initial, root, { ...page, referenceImages: [{ sourceId: source.id, fileOrder: 3 }] }), /不存在唯一的第 3 个附件/);
  await assert.rejects(confirmSheetFor(initial, root, { ...page, referenceImages: Array.from({ length: 13 }, (_, index) => ({ sourceId: source.id, fileOrder: index + 1 })) }), /最多 12 张/);

  const excluded = await setup(t, { retained: false });
  await assert.rejects(confirmSheetFor(excluded.task, excluded.root, excluded.page), /人工排除/);
});

test('setSheet rejects a source image whose saved hash no longer matches its bytes', async t => {
  const { root, task, page } = await setup(t, { fileCount: 1 });
  const filePath = path.join(root, 'tasks', task.id, task.sources[0].files[0].relativePath);
  await writeFile(filePath, Buffer.concat([PNG, Buffer.from('changed')]));
  await assert.rejects(confirmSheetFor(task, root, page), /哈希不一致/);
});

test('setSheet rejects a retained non-image attachment even when its path and saved hash are valid', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-reference-non-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upload = path.join(root, 'notes.txt');
  await writeFile(upload, 'plain text is not a Canvas image reference');
  let task = await createTask({ title: '非图片夹具', brief: '仅隔离测试' }, root);
  task = await attachTaskFiles(task.id, {
    files: [{ path: upload, name: 'notes.txt', mimeType: 'text/plain' }],
    title: '文本附件',
    purpose: '测试错误类型',
    factBoundary: '不用于真实创作',
  }, { root, expectedRevision: task.revision });
  const source = task.sources[0];
  task = await setSources(task.id, task.sources.map(item => ({ ...item, decision: 'retained' })), { root, expectedRevision: task.revision });
  task = await confirmInputs(task.id, { revision: task.revision, by: '测试用户', note: '仅隔离夹具' }, { root });
  const page = { page: 1, copy: '测试', prompt: '测试', size: '3:4', sourceIds: [source.id], referenceImages: [{ sourceId: source.id, fileOrder: 1 }] };
  await assert.rejects(confirmSheetFor(task, root, page), /不是有效的 PNG、JPEG 或 WebP/);
});

test('executor imports task references into Canvas image storage before connecting and generating', async t => {
  const { root, task: initial, source, page } = await setup(t, { fileCount: 1 });
  const task = await confirmSheetFor(initial, root, page);
  const c = canvas();
  const done = await executeCurrent(task.id, { root, version: 1, config, getHealth, tool: c.tool, recover, timeoutMs: 100, pollMs: 1 });

  const referenceNode = c.nodes.find(node => node.id === done.execution.pages[0].referenceNodes[0].nodeId);
  const configNode = c.nodes.find(node => node.id === done.execution.pages[0].nodeId);
  assert.equal(referenceNode.type, 'image');
  assert.match(referenceNode.metadata.content, /^blob:/);
  assert.match(referenceNode.metadata.storageKey, /^image:/);
  assert.equal(referenceNode.metadata.status, 'success');
  assert.equal(c.importedDataUrl(referenceNode.id), `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(c.imports(), 1);
  assert.equal(c.nodes.some(node => node.metadata?.content?.startsWith('data:image/')), false, 'base64 data is not retained in Canvas node metadata');
  assert.ok(c.connections.some(edge => edge.fromNodeId === referenceNode.id && edge.toNodeId === configNode.id));
  assert.ok(configNode.metadata.composerContent.includes(`@[node:${referenceNode.id}]`));
  assert.equal(done.execution.pages[0].referenceNodes[0].sourceId, source.id);
  assert.deepEqual(referenceNode.position, { x: 220, y: 0 });
  assert.equal(c.runs(), 1);
});

test('executor rejects a changed source hash before any Canvas call or generation submission', async t => {
  const { root, task: initial, page } = await setup(t, { fileCount: 1 });
  const task = await confirmSheetFor(initial, root, page);
  const filePath = path.join(root, 'tasks', task.id, task.sources[0].files[0].relativePath);
  await writeFile(filePath, Buffer.concat([PNG, Buffer.from('tampered')]));
  let calls = 0;
  const c = canvas();
  await assert.rejects(executeCurrent(task.id, {
    root,
    version: 1,
    config,
    getHealth: async () => { calls += 1; return getHealth(); },
    tool: async (...args) => { calls += 1; return c.tool(...args); },
    recover,
  }), /哈希不一致/);
  assert.equal(calls, 0);
  assert.equal(c.runs(), 0);
});

test('recovery reuses the persisted reference node and does not resubmit a charged generation', async t => {
  const { root, task: initial, page } = await setup(t, { fileCount: 1 });
  const task = await confirmSheetFor(initial, root, page);
  const controller = new AbortController();
  const c = canvas({ onRun: async (input) => {
    controller.abort();
    throw new DOMException('controlled stop', 'AbortError');
  } });
  await assert.rejects(executeCurrent(task.id, { root, version: 1, config, getHealth, tool: c.tool, recover, signal: controller.signal }), /已停止等待/);
  const paused = await readTask(task.id, root);
  const record = paused.execution.pages[0];
  assert.equal(record.submitted, true);
  const referenceNodeId = record.referenceNodes[0].nodeId;
  c.deliver(record.nodeId);

  const resumed = await executeCurrent(task.id, { root, version: 1, config, getHealth, tool: c.tool, recover, timeoutMs: 100, pollMs: 1 });
  assert.equal(resumed.execution.status, 'succeeded');
  assert.equal(c.runs(), 1);
  assert.equal(c.nodes.filter(node => node.id === referenceNodeId).length, 1);
});

test('explicit retry validates truncated reference images and long text against actual bytes and digest', async t => {
  const { root, task: initial, page } = await setup(t, { fileCount: 1 });
  page.prompt = '需要逐项保留的长篇画面说明。'.repeat(60);
  const task = await confirmSheetFor(initial, root, page);
  let failed = true;
  let imageReads = 0;
  const imageReadNodeIds = [];
  const c = canvas({ onRun: async (input, state) => {
    if (failed) { failed = false; return {}; }
    state.nodes.push({ id: 'retried-output', type: 'image', metadata: { status: 'success' } });
    state.connections.push({ fromNodeId: input.nodeId, toNodeId: 'retried-output' });
    return {};
  } });
  const tool = async (name, input) => {
    if (name === 'generation_get_status') return { tasks: [{ id: input.nodeIds[0], status: 'failed' }] };
    if (name === 'canvas_read_image') { imageReads++; imageReadNodeIds.push(input.nodeId); return c.tool(name, input); }
    const result = await c.tool(name, input);
    if (name !== 'canvas_get_state') return result;
    return { ...result, nodes: result.nodes.map(node => ({ ...node, metadata: {
      ...node.metadata,
      ...(node.metadata.content ? { contentSha256: createHash('sha256').update(node.metadata.content).digest('hex'), content: node.metadata.content.slice(0, 15) + '...' } : {}),
    } })) };
  };
  await assert.rejects(executeCurrent(task.id, { root, version: 1, config, getHealth, tool, recover, pollMs: 1 }), /执行失败/);
  const done = await executeCurrent(task.id, { root, version: 1, config, getHealth, tool, recover, retryPage: 1, pollMs: 1 });
  assert.equal(done.execution.status, 'succeeded');
  assert.equal(done.execution.pages[0].attempt, 2);
  assert.equal(c.runs(), 2);
  assert.equal(c.imports(), 1, 'explicit retry reuses the single persistent reference node');
  assert.equal(imageReads, 2, 'the stored image bytes are verified on import and explicit retry');
  assert.deepEqual(imageReadNodeIds, [done.execution.pages[0].referenceNodes[0].nodeId, done.execution.pages[0].referenceNodes[0].nodeId]);
});

