import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  approveFinal,
  confirmInputs,
  confirmSheet,
  createTask,
  exportTask,
  readTask,
  recordReview,
  setSheet,
  taskDirectory,
  withTask,
} from '../src/creative/tasks.mjs';
import { runCanvasOperation } from '../src/creative/canvas-operations.mjs';
import { adoptCanvasResult } from '../src/creative/mechanical-products.mjs';

const uuid = () => crypto.randomUUID();
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-mechanical-products-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root };
}

async function completedImageOperation(task, root, bytes, { operationId = uuid(), nodeId = 'mechanical-output' } = {}) {
  const imageHash = sha256(bytes);
  await runCanvasOperation({
    root,
    taskId: task.id,
    operationId,
    requestId: uuid(),
    callId: uuid(),
    userText: '机械处理并保留原图。',
    expectedRevision: task.revision,
    operation: 'compose',
    nodeId: 'mechanical-source',
    input: { layers: [] },
    run: async ({ imagesDirectory, markSubmitted }) => {
      await markSubmitted({ canvasInstanceId: 'fixture-instance', canvasClientId: 'fixture-client' });
      await fs.mkdir(imagesDirectory, { recursive: true });
      await fs.writeFile(path.join(imagesDirectory, 'image-001.png'), bytes, { flag: 'wx', mode: 0o600 });
      const image = {
        nodeId,
        width: 900,
        height: 1200,
        sha256: imageHash,
        name: 'canvas-compose-01.png',
        mimeType: 'image/png',
        size: bytes.length,
        relativePath: 'images/image-001.png',
      };
      return {
        result: { operation: 'compose', images: [{ nodeId, width: image.width, height: image.height, sha256: imageHash }] },
        attachments: [image],
      };
    },
  });
  return { operationId, imageHash, ledgerPath: path.join(taskDirectory(task.id, root), 'canvas-operations', operationId, 'images', 'image-001.png') };
}

async function reviewAndApprove(task, root) {
  for (const page of task.execution.pages) {
    task = await recordReview(task.id, {
      page: page.page,
      sha256: page.image.sha256,
      decision: 'pass',
      reviewer: '测试用户',
      notes: `实际查看第 ${page.page} 页，图像与页面文案对应。`,
    }, { root, expectedRevision: task.revision });
  }
  task = await approveFinal(task.id, {
    version: task.sheetVersion,
    images: task.execution.pages.map(({ page, image }) => ({ page, sha256: image.sha256 })),
    by: '测试用户',
    note: '逐页查看并确认当前整套成品。',
  }, { root, expectedRevision: task.revision });
  return task;
}

test('adopts a verified ledger image for a no-sheet task and completes existing review, approval, and export flow', async (t) => {
  const { root } = await fixture(t);
  const task = await createTask({ title: '机械成品任务', brief: '采用当前画布中的机械合成结果' }, root);
  const outputBytes = await fs.readFile(new URL('./fixtures/image-regions/poster-mixed.png', import.meta.url));
  const operation = await completedImageOperation(task, root, outputBytes);
  const originalOutput = await fs.readFile(operation.ledgerPath);
  const authorizationNote = `明确采用此机械合成结果作为本次正式成品。${'用户已确认。'.repeat(400)}`;

  const adopted = await adoptCanvasResult(task.id, {
    operationId: operation.operationId,
    imageIndex: 0,
    requestId: uuid(),
    workType: 'mechanical',
    authorization: { by: '测试用户', note: authorizationNote },
    expectedRevision: task.revision,
    sha256: '0'.repeat(64), // Caller SHA is ignored; the ledger bytes are authoritative.
  }, { root });
  assert.equal(adopted.replayed, false);
  assert.equal(adopted.task.revision, task.revision + 1);
  assert.equal(adopted.task.sheetVersion, 1);
  assert.equal(adopted.task.inputConfirmation, null);
  assert.equal(adopted.task.sheetConfirmation, null);
  assert.equal(adopted.task.sheets[0].mechanicalAdoption.workType, 'mechanical');
  assert.equal(adopted.task.sheets[0].pages[0].copy, '');
  assert.equal(adopted.task.sheets[0].pages[0].prompt, '');
  assert.equal(adopted.task.sheets[0].pages[0].size, '900x1200');
  assert.equal(adopted.task.execution.pages[0].productOrigin.sha256, operation.imageHash);
  assert.equal(adopted.task.execution.pages[0].productOrigin.operationId, operation.operationId);
  assert.equal(adopted.task.execution.pages[0].image.sha256, operation.imageHash);
  assert.notEqual(adopted.task.execution.pages[0].image.path, operation.ledgerPath);
  assert.equal(sha256(await fs.readFile(adopted.task.execution.pages[0].image.path)), operation.imageHash);
  assert.deepEqual(await fs.readFile(operation.ledgerPath), originalOutput, 'adoption preserves the operation artifact');

  let taskAfterReview = await reviewAndApprove(adopted.task, root);
  assert.equal(taskAfterReview.finalApproval.version, 1);
  const exported = await exportTask(task.id, { root, expectedRevision: taskAfterReview.revision });
  const exportDirectory = path.join(taskDirectory(task.id, root), exported.export.relativePath);
  const manifest = JSON.parse(await fs.readFile(path.join(exportDirectory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.images[0].sha256, operation.imageHash);
  assert.equal(manifest.execution.pages[0].productOrigin.operationId, operation.operationId);
  assert.deepEqual(await fs.readFile(path.join(exportDirectory, manifest.images[0].path)), outputBytes);

  const replay = await adoptCanvasResult(task.id, {
    operationId: operation.operationId,
    imageIndex: 0,
    requestId: adopted.adoption.requestId,
    workType: 'mechanical',
    authorization: { by: '测试用户', note: authorizationNote },
    expectedRevision: task.revision,
  }, { root });
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.sheetVersion, 1);
  assert.equal(replay.task.exports.length, 1);
  await assert.rejects(adoptCanvasResult(task.id, {
    operationId: operation.operationId,
    imageIndex: 0,
    requestId: adopted.adoption.requestId,
    workType: 'mechanical',
    authorization: { by: '测试用户', note: '不同授权内容。' },
    expectedRevision: task.revision,
  }, { root }), { code: 'ERR_MECHANICAL_ADOPTION_IDEMPOTENCY_CONFLICT' });
});

test('adopts one page of an existing sheet, reuses untouched page hashes and reviews, and invalidates final approval', async (t) => {
  const { root } = await fixture(t);
  let task = await createTask({ title: '两页任务', brief: '按两页制作单导出' }, root);
  task = await confirmInputs(task.id, { revision: task.revision, by: '测试用户', note: '确认需求和来源。' }, { root });
  task = await setSheet(task.id, {
    title: '两页制作单',
    pages: [1, 2].map((page) => ({ page, copy: `第 ${page} 页准确文案`, prompt: `第 ${page} 页绘图指令`, size: '3:4' })),
  }, { root, expectedRevision: task.revision, inputRevision: task.inputConfirmation.revision });
  task = await confirmSheet(task.id, { version: task.sheetVersion, by: '测试用户', note: '确认制作单。' }, { root, expectedRevision: task.revision });

  const oldPaths = [1, 2].map((page) => path.join(root, `previous-page-${page}.png`));
  const oldBytes = [
    await fs.readFile(new URL('./fixtures/image-regions/negative-landscape.png', import.meta.url)),
    await fs.readFile(new URL('./fixtures/image-regions/negative-texture.png', import.meta.url)),
  ];
  for (const [index, file] of oldPaths.entries()) await fs.writeFile(file, oldBytes[index]);
  task = await withTask(task.id, (draft) => {
    draft.execution = {
      version: draft.sheetVersion,
      status: 'succeeded',
      pages: oldPaths.map((imagePath, index) => ({
        page: index + 1,
        status: 'succeeded',
        nodeId: `old-node-${index + 1}`,
        imageNodeId: `old-image-${index + 1}`,
        image: { path: imagePath, sha256: sha256(oldBytes[index]) },
      })),
    };
  }, { root, expectedRevision: task.revision });
  task = await reviewAndApprove(task, root);
  const oldReviewForPage2 = task.reviews.find((review) => review.page === 2);
  const oldFinalApproval = task.finalApproval;

  const outputBytes = await fs.readFile(new URL('./fixtures/image-regions/poster-mixed.png', import.meta.url));
  const operation = await completedImageOperation(task, root, outputBytes);
  const adopted = await adoptCanvasResult(task.id, {
    operationId: operation.operationId,
    imageIndex: 0,
    page: 1,
    requestId: uuid(),
    workType: 'mechanical',
    authorization: { by: '测试用户', note: '明确采用机械合成结果替换第 1 页。' },
    expectedRevision: task.revision,
  }, { root });

  assert.equal(adopted.task.sheetVersion, 2);
  assert.equal(adopted.task.sheets.find((sheet) => sheet.version === 2).pages[0].size, '900x1200');
  assert.equal(adopted.task.sheets.find((sheet) => sheet.version === 2).pages[1].size, '3:4');
  assert.equal(adopted.task.finalApproval, null);
  assert.deepEqual(adopted.task.execution.pages[1].image, task.execution.pages[1].image);
  assert.equal(adopted.task.reviews.length, 1);
  assert.deepEqual(adopted.task.reviews[0], { ...oldReviewForPage2, version: 2 });
  assert.equal(adopted.task.reviewHistory.some((review) => review.version === oldFinalApproval.version && review.page === 1), true);
  assert.equal(await fs.readFile(oldPaths[0]).then(sha256), sha256(oldBytes[0]));
  assert.equal(adopted.task.executionHistory.at(-1).version, 1);
});

test('rejects stale revisions, invalid authorization, and ledger bytes changed after operation completion', async (t) => {
  const { root } = await fixture(t);
  let task = await createTask({ title: '变更任务', brief: '采用机械结果' }, root);
  const outputBytes = await fs.readFile(new URL('./fixtures/image-regions/poster-mixed.png', import.meta.url));
  const operation = await completedImageOperation(task, root, outputBytes);
  const originalRevision = task.revision;
  await assert.rejects(adoptCanvasResult(task.id, {
    operationId: operation.operationId, imageIndex: 0, page: 2, requestId: uuid(),
    workType: 'mechanical', authorization: { by: '测试用户', note: '明确采用结果。' }, expectedRevision: task.revision,
  }, { root }), /只能建立第 1 页/);
  task = await withTask(task.id, (draft) => { draft.title = '变更后的标题'; }, { root, expectedRevision: task.revision });
  const requestId = uuid();
  const authorized = { by: '测试用户', note: '明确采用结果。' };
  await assert.rejects(adoptCanvasResult(task.id, {
    operationId: operation.operationId, imageIndex: 0, requestId,
    workType: 'mechanical', authorization: authorized, expectedRevision: originalRevision,
  }, { root }), { code: 'ERR_TASK_REVISION_CONFLICT' });
  await assert.rejects(adoptCanvasResult(task.id, {
    operationId: operation.operationId, imageIndex: 0, requestId: uuid(),
    workType: 'mechanical', authorization: { by: 'Codex Agent', note: '自动采用' }, expectedRevision: task.revision,
  }, { root }), /实际人工/);
  await assert.rejects(adoptCanvasResult(task.id, {
    operationId: operation.operationId, imageIndex: 0, requestId: uuid(),
    workType: 'mechanical', authorization: { by: '测试用户', note: `凭据 ${'sk-' + 'A'.repeat(24)}` }, expectedRevision: task.revision,
  }, { root }), /疑似包含凭据/);

  await fs.writeFile(operation.ledgerPath, Buffer.from('changed after ledger completion'));
  await assert.rejects(adoptCanvasResult(task.id, {
    operationId: operation.operationId, imageIndex: 0, requestId: uuid(),
    workType: 'mechanical', authorization: authorized, expectedRevision: task.revision,
  }, { root }), { code: 'ERR_CANVAS_OPERATION_IMAGE_HASH' });
  assert.equal((await readTask(task.id, root)).sheetVersion, 0);
});
