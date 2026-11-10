import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  confirmInputs,
  confirmSheet,
  createTask,
  readTask,
  setSheet,
  taskDirectory,
  withTask,
} from '../src/creative/tasks.mjs';
import { runCanvasOperation } from '../src/creative/canvas-operations.mjs';
import { saveConfig } from '../src/web/config.mjs';

const cliPath = fileURLToPath(new URL('../scripts/studio.mjs', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'creative-studio-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function invoke(root, action, id, payload) {
  const args = [cliPath, action];
  if (id) args.push(id);
  if (payload !== undefined) {
    const inputPath = path.join(root, `cli-${randomUUID()}.json`);
    await writeFile(inputPath, JSON.stringify(payload), { mode: 0o600 });
    args.push(`@${inputPath}`);
  }
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, STUDIO_DATA_DIR: root },
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    value: result.status === 0 ? JSON.parse(result.stdout) : undefined,
  };
}

async function invokeOk(root, action, id, payload) {
  const result = await invoke(root, action, id, payload);
  assert.equal(result.status, 0, `${action} failed: ${result.stderr}`);
  return result.value;
}

function sheet() {
  return {
    title: '隔离 CLI 夹具',
    pages: [{ page: 1, copy: '测试文案', prompt: '测试图片', size: '3:4' }],
  };
}

async function prepareTask(root) {
  let task = await createTask({ title: '隔离 CLI 夹具', brief: { topic: '测试主题' } }, root);
  task = await confirmInputs(task.id, {
    revision: task.revision,
    by: '测试用户',
    note: '隔离测试确认输入',
  }, { root });
  task = await setSheet(task.id, sheet(), {
    root,
    expectedRevision: task.revision,
    inputRevision: task.inputConfirmation.revision,
  });
  task = await confirmSheet(task.id, {
    version: task.sheetVersion,
    by: '测试用户',
    note: '隔离测试确认制作单',
  }, { root, expectedRevision: task.revision });
  return task;
}

async function setImage(task, root, name, bytes) {
  const imagePath = path.join(root, name);
  await writeFile(imagePath, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const updated = await withTask(task.id, (draft) => {
    draft.execution = {
      version: draft.sheetVersion,
      status: 'succeeded',
      pages: [{
        page: 1,
        status: 'succeeded',
        image: { path: imagePath, sha256 },
      }],
    };
  }, { root, expectedRevision: task.revision });
  return { task: updated, image: { page: 1, sha256 }, imagePath };
}

async function recordPass(root, task) {
  return invokeOk(root, 'record-review', task.id, {
    page: 1,
    sha256: task.execution.pages[0].image.sha256,
    decision: 'pass',
    reviewer: '测试用户',
    notes: '隔离夹具中核对当前文件',
    expectedRevision: task.revision,
  });
}

async function completedImageOperation(root, task, bytes) {
  const operationId = randomUUID();
  const imageHash = createHash('sha256').update(bytes).digest('hex');
  await runCanvasOperation({
    root,
    taskId: task.id,
    operationId,
    requestId: randomUUID(),
    callId: randomUUID(),
    userText: '将合成结果作为本次候选成品。',
    expectedRevision: task.revision,
    operation: 'compose',
    nodeId: 'canvas-source',
    input: { layers: [] },
    run: async ({ imagesDirectory, markSubmitted }) => {
      await markSubmitted();
      await mkdir(imagesDirectory, { recursive: true });
      await writeFile(path.join(imagesDirectory, 'image-001.png'), bytes, { mode: 0o600 });
      const image = {
        nodeId: 'canvas-mechanical-output',
        width: 1,
        height: 1,
        sha256: imageHash,
        name: 'canvas-compose-01.png',
        mimeType: 'image/png',
        size: bytes.length,
        relativePath: 'images/image-001.png',
      };
      return {
        result: { operation: 'compose', images: [{ nodeId: image.nodeId, width: 1, height: 1, sha256: imageHash }] },
        attachments: [image],
      };
    },
  });
  return operationId;
}

test('状态变更 CLI 拒绝缺少 expectedRevision 的旧 payload', async (t) => {
  const root = await fixture(t);
  const created = await invokeOk(root, 'create', null, { title: '版本确认', brief: '旧需求' });

  const result = await invoke(root, 'set-brief', created.id, { brief: '新需求' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /用法/);
  assert.equal((await readTask(created.id, root)).brief, '旧需求');
});

test('execute/resume 在启动任务 Canvas 前拒绝过期或未授权的 payload', async (t) => {
  const root = await fixture(t);
  const task = await createTask({ title: 'Canvas 启动前检查', brief: '隔离用例' }, root);

  for (const action of ['execute', 'resume']) {
    const stale = await invoke(root, action, task.id, { version: 1, expectedRevision: task.revision + 1 });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /任务已更新/);
  }
  const unauthorized = await invoke(root, 'execute', task.id, { version: 1, expectedRevision: task.revision });
  assert.notEqual(unauthorized.status, 0);
  assert.match(unauthorized.stderr, /已授权执行版本不匹配/);
  await assert.rejects(readFile(path.join(root, 'canvas', task.id, 'canvas-instance.json')), { code: 'ENOENT' });
});

test('Canvas CLI 命令拒绝缺版本、无效区域类型及缺请求身份的 payload', async (t) => {
  const root = await fixture(t);
  const task = await createTask({ title: 'Canvas CLI 合同', brief: '隔离用例' }, root);
  const invalid = [
    ['canvas-state', {}],
    ['canvas-read-image', { nodeId: 'image-fixture' }],
    ['canvas-detect-regions', { nodeId: 'image-fixture', expectedRevision: task.revision, kinds: ['text', 'text'] }],
    ['canvas-operation', { operation: 'move', nodeId: 'text-fixture', x: 1, y: 2, expectedRevision: task.revision, userText: '把文字移动到右边' }],
    ['canvas-adopt', { expectedRevision: task.revision, requestId: randomUUID(), userText: '采用机械结果。' }],
  ];
  for (const [action, payload] of invalid) {
    const result = await invoke(root, action, task.id, payload);
    assert.notEqual(result.status, 0, `${action} must reject malformed input`);
    assert.match(result.stderr, /用法/);
  }
  await assert.rejects(readFile(path.join(root, 'canvas', task.id, 'canvas-instance.json')), { code: 'ENOENT' });
});

test('canvas-adopt binds mechanical authorization to user text and rejects model-supplied actor fields', async (t) => {
  const root = await fixture(t);
  const task = await createTask({ title: '机械成品 CLI', brief: '将机械结果采用为正式候选' }, root);
  const bytes = Buffer.from('cli mechanical image bytes');
  const operationId = await completedImageOperation(root, task, bytes);
  const requestId = randomUUID();
  const adopted = await invokeOk(root, 'canvas-adopt', task.id, {
    expectedRevision: task.revision,
    requestId,
    userText: '请采用刚才的机械合成图作为第1页候选成品。',
    operationId,
    imageIndex: 0,
    page: 1,
  });
  assert.equal(adopted.task.sheetVersion, 1);
  assert.equal(adopted.adoption.requestId, requestId);
  assert.equal(adopted.task.sheets[0].mechanicalAdoption.adoptionApproval.by, '用户');
  assert.equal(adopted.task.sheets[0].mechanicalAdoption.adoptionApproval.note, '请采用刚才的机械合成图作为第1页候选成品。');
  assert.equal(adopted.task.inputConfirmation, null);

  const rejected = await invoke(root, 'canvas-adopt', task.id, {
    expectedRevision: adopted.task.revision,
    requestId: randomUUID(),
    userText: '请采用第1页。',
    operationId,
    imageIndex: 0,
    page: 1,
    by: 'Codex Agent',
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /用法/);
  assert.equal((await readTask(task.id, root)).sheetVersion, 1);
});

test('video-plan and video-confirm use independent CAS; CLI blocks execute before confirmation without starting Canvas', async (t) => {
  const root = await fixture(t);
  await saveConfig({ expectedRevision: 1, video: { baseUrl: 'https://api.osodm.com', model: 'minimax_h3', apiKey: 'isolated-video-key', apiFormat: 'openai' } }, { root });
  const task = await createTask({ title: '隔离视频 CLI', brief: '只检查镜头方案确认合同' }, root);
  const planned = await invokeOk(root, 'video-plan', task.id, {
    expectedRevision: task.revision,
    prompt: '镜头从窗边缓慢推近桌面，角色翻开书页',
    seconds: 6,
    ratio: '16:9',
    resolution: '1080p',
  });
  assert.equal(planned.video.version, 1);
  assert.equal(planned.video.plans[0].confirmedAt, null);
  assert.equal(JSON.stringify(planned).includes('isolated-video-key'), false);
  await assert.rejects(readFile(path.join(root, 'canvas', task.id, 'canvas-instance.json')), { code: 'ENOENT' });

  const blocked = await invoke(root, 'video-execute', task.id, { expectedRevision: planned.revision, version: 1 });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /视频镜头尚未确认；未启动 Canvas/);
  await assert.rejects(readFile(path.join(root, 'canvas', task.id, 'canvas-instance.json')), { code: 'ENOENT' });

  const confirmed = await invokeOk(root, 'video-confirm', task.id, {
    expectedRevision: planned.revision,
    version: 1,
    by: '测试用户',
    note: '测试用户确认当前视频镜头',
  });
  assert.equal(confirmed.video.plans[0].confirmedBy, '测试用户');
  assert.ok(confirmed.video.plans[0].confirmedAt);
  const stale = await invoke(root, 'video-confirm', task.id, {
    expectedRevision: planned.revision,
    version: 1,
    by: '测试用户',
    note: '过期版本不能写入',
  });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /任务已更新/);
});

test('CLI 制作单写入拒绝准备后已过期的输入与任务 revision', async (t) => {
  const root = await fixture(t);
  let task = await invokeOk(root, 'create', null, { title: '过期制作单', brief: '旧需求' });
  task = await invokeOk(root, 'confirm-inputs', task.id, {
    revision: task.revision,
    by: '测试用户',
    note: '确认旧需求',
  });
  const oldSheetPayload = {
    sheet: sheet(),
    expectedRevision: task.revision,
    inputRevision: task.inputConfirmation.revision,
  };

  task = await invokeOk(root, 'set-brief', task.id, {
    brief: '更新后的需求',
    expectedRevision: task.revision,
  });
  task = await invokeOk(root, 'confirm-inputs', task.id, {
    revision: task.revision,
    by: '测试用户',
    note: '确认更新后的需求',
  });

  const result = await invoke(root, 'set-sheet', task.id, oldSheetPayload);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /任务已更新/);
  const persisted = await readTask(task.id, root);
  assert.equal(persisted.sheetVersion, 0);
  assert.equal(persisted.inputConfirmation.revision, task.inputConfirmation.revision);
});

test('CLI 拒绝换图并复审后到达的旧最终批准 payload', async (t) => {
  const root = await fixture(t);
  let task = await prepareTask(root);
  let current = await setImage(task, root, 'page-a.png', Buffer.from('image A'));
  task = await recordPass(root, current.task);
  const oldApprovalPayload = {
    version: task.sheetVersion,
    images: [current.image],
    by: '测试用户',
    note: '只批准图片 A',
    expectedRevision: task.revision,
  };

  current = await setImage(task, root, 'page-b.png', Buffer.from('image B'));
  task = await recordPass(root, current.task);
  const result = await invoke(root, 'approve-final', task.id, oldApprovalPayload);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /任务已更新/);
  const persisted = await readTask(task.id, root);
  assert.equal(persisted.finalApproval, null);
  assert.equal(persisted.execution.pages[0].image.sha256, current.image.sha256);
});

test('list 只把逐页批准哈希与当前文件哈希一致的任务显示为已批准', async (t) => {
  const root = await fixture(t);
  let task = await prepareTask(root);
  let current = await setImage(task, root, 'page-current.png', Buffer.from('current image'));
  task = await recordPass(root, current.task);

  task = await withTask(task.id, (draft) => {
    draft.finalApproval = {
      version: draft.sheetVersion,
      revision: task.revision,
      images: [{ page: 1, sha256: 'a'.repeat(64) }],
      by: '历史记录',
      note: '批准的是另一张图片',
      approvedAt: new Date().toISOString(),
    };
  }, { root, expectedRevision: task.revision });
  const listed = await invokeOk(root, 'list');
  assert.equal(listed.tasks.find((entry) => entry.id === task.id).finalApproved, false);

  task = await withTask(task.id, (draft) => {
    draft.finalApproval = { version: draft.sheetVersion, by: '历史记录', note: '旧合同无图片哈希' };
  }, { root, expectedRevision: task.revision });
  const legacyListed = await invokeOk(root, 'list');
  assert.equal(legacyListed.tasks.find((entry) => entry.id === task.id).finalApproved, false);
});

test('只剩历史 ZIP 时 CLI 仍可导出下一个版本', async (t) => {
  const root = await fixture(t);
  let task = await prepareTask(root);
  const current = await setImage(task, root, 'page-final.png', Buffer.from('approved image'));
  task = await recordPass(root, current.task);
  task = await invokeOk(root, 'approve-final', task.id, {
    version: task.sheetVersion,
    images: [current.image],
    by: '测试用户',
    note: '批准隔离夹具图片',
    expectedRevision: task.revision,
  });

  const first = await invokeOk(root, 'export', task.id, { expectedRevision: task.revision });
  assert.equal(first.export.version, 'export-001');
  await rm(path.join(taskDirectory(task.id, root), first.export.relativePath), { recursive: true, force: true });
  await mkdir(path.dirname(path.join(taskDirectory(task.id, root), first.export.archiveRelativePath)), { recursive: true });
  await readFile(path.join(taskDirectory(task.id, root), first.export.archiveRelativePath));

  const second = await invokeOk(root, 'export', task.id, { expectedRevision: first.task.revision });
  assert.equal(second.export.version, 'export-002');
  await readFile(path.join(taskDirectory(task.id, root), second.export.archiveRelativePath));
});
