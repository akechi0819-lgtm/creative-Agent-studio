import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTask, readTask, withTask, attachTaskFiles, confirmInputs, setBrief, setSources, setSheet, confirmSheet, recordReview, approveFinal, exportTask, assertNoCredentials, isSheetAuthorized } from '../src/creative/tasks.mjs';
import { executeTask } from '../src/creative/executor.mjs';
import { editTaskPages, restorePageEdit } from '../src/creative/page-edits.mjs';

const config = { projectId: 'fixture', webUrl: 'http://fixture', clientId: 'fixture' };
const getHealth = async () => ({ targets: [{ hasCanvas: true, projectId: 'fixture', clientId: 'fixture' }] });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function setup(t, count = 3) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-page-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let task = await createTask({ title: '局部改图夹具', brief: { topic: '隔离测试', requirements: '仅使用模拟成品' } }, root);
  task = await confirmInputs(task.id, { revision: task.revision, by: 'test fixture', note: '隔离测试输入' }, { root });
  task = await setSheet(task.id, { title: '测试图文', pages: Array.from({ length: count }, (_, index) => ({
    page: index + 1,
    copy: `基线文案 ${index + 1}`,
    prompt: `基线绘图指令 ${index + 1}`,
    size: '3:4',
  })) }, { root, expectedRevision: task.revision, inputRevision: task.inputConfirmation.revision });
  task = await confirmSheet(task.id, { version: task.sheetVersion, by: 'test fixture', note: '隔离测试制作单' }, { root, expectedRevision: task.revision });
  return { root, id: task.id };
}

function canvas({ failAt } = {}) {
  const nodes = [];
  const connections = [];
  const generated = new Map();
  const importedImages = new Map();
  let runs = 0;
  return {
    nodes,
    tool: async (name, input) => {
      if (name === 'canvas_get_state') return { nodes, connections };
      if (name === 'canvas_apply_ops') {
        for (const operation of input.ops) {
          if (operation.type === 'add_node') nodes.push({ id: operation.id, type: operation.nodeType, title: operation.title, metadata: operation.metadata });
          else if (operation.type === 'update_node') {
            const node = nodes.find(item => item.id === operation.id);
            if (node) Object.assign(node, operation.patch);
          }
          else if (operation.type === 'connect_nodes') connections.push({ fromNodeId: operation.fromNodeId, toNodeId: operation.toNodeId });
        }
        return {};
      }
      if (name === 'canvas_import_image') {
        const bytes = Buffer.from(input.dataUrl.split(',')[1], 'base64');
        importedImages.set(input.nodeId, input.dataUrl);
        nodes.push({
          id: input.nodeId,
          type: 'image',
          title: input.title,
          position: { x: 1000, y: 0 },
          metadata: { content: `blob:fixture/${input.nodeId}`, storageKey: `image:${input.nodeId}`, status: 'success', naturalWidth: 1, naturalHeight: 1, bytes: bytes.length, mimeType: 'image/png' },
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
        if (runs !== failAt) {
          const imageId = `generated-${runs}`;
          nodes.push({ id: imageId, type: 'image', metadata: { status: 'success' } });
          connections.push({ fromNodeId: input.nodeId, toNodeId: imageId });
          generated.set(imageId, Buffer.concat([png, Buffer.from(`fixture-${runs}`)]));
        }
        return {};
      }
      if (name === 'generation_get_status') {
        const id = input.nodeIds[0];
        return { tasks: [{ id, status: runs === failAt ? 'failed' : 'succeeded' }] };
      }
      throw new Error(`unexpected fixture tool: ${name}`);
    },
    recover: async (nodeId, destination) => {
      await mkdir(path.dirname(destination), { recursive: true });
      const bytes = generated.get(nodeId) || Buffer.concat([png, Buffer.from(nodeId)]);
      await writeFile(destination, bytes);
      return { nodeId, path: destination, bytes: bytes.length };
    },
    importedDataUrl: nodeId => importedImages.get(nodeId),
    runs: () => runs,
  };
}

async function executeCurrent(id, options) {
  const task = await readTask(id, options.root);
  return executeTask(id, { ...options, expectedRevision: task.revision });
}

async function createReviewedBaseline(id, root, fixture, count = 3) {
  let task = await executeCurrent(id, { root, version: 1, config, getHealth, ...fixture });
  for (const page of task.execution.pages) {
    task = await recordReview(id, {
      page: page.page,
      sha256: page.image.sha256,
      decision: 'pass',
      reviewer: 'test reviewer',
      notes: `逐页模拟读图记录 ${page.page}`,
    }, { root, expectedRevision: task.revision });
  }
  task = await approveFinal(id, {
    version: 1,
    images: task.execution.pages.map(page => ({ page: page.page, sha256: page.image.sha256 })),
    by: 'test reviewer',
    note: '隔离测试最终确认',
  }, { root, expectedRevision: task.revision });
  assert.equal(task.execution.pages.length, count);
  return task;
}

test('输入变更后归档完整审核顺序，旧成功基线局部编辑与恢复遵守最新决定', async t => {
  for (const { name, addedDecisions, expectedDecisions, latestDecision } of [
    {
      name: '重复 pass 保留为最新决定',
      addedDecisions: ['revise', 'pass'],
      expectedDecisions: ['pass', 'revise', 'pass'],
      latestDecision: 'pass',
    },
    {
      name: '最新 revise 继续阻止批准',
      addedDecisions: ['revise'],
      expectedDecisions: ['pass', 'revise'],
      latestDecision: 'revise',
    },
  ]) {
    await t.test(name, async t => {
      const { root, id } = await setup(t, 2);
      const fixture = canvas();
      let task = await createReviewedBaseline(id, root, fixture, 2);
      const originalPages = new Map();
      for (const page of task.execution.pages) {
        originalPages.set(page.page, {
          path: page.image.path,
          sha256: page.image.sha256,
          bytes: await readFile(page.image.path),
        });
      }

      for (const decision of addedDecisions) {
        task = await recordReview(id, {
          page: 1,
          sha256: originalPages.get(1).sha256,
          decision,
          reviewer: 'test reviewer',
          notes: decision === 'pass' ? '逐页模拟读图记录 1' : '同一图片复核后需要修改',
        }, { root, expectedRevision: task.revision });
      }
      if (latestDecision === 'pass' && expectedDecisions.length === 3) {
        const firstPass = task.reviews.find(review => review.version === 1 && review.page === 1);
        task = await withTask(id, draft => {
          const repeatedPass = draft.reviews.filter(review => review.version === 1 && review.page === 1).at(-1);
          repeatedPass.reviewedAt = firstPass.reviewedAt;
        }, { root, expectedRevision: task.revision });
      }
      const beforeInputChange = task.reviews
        .filter(review => review.version === 1 && review.page === 1 && review.sha256 === originalPages.get(1).sha256)
        .map(review => review.decision);
      assert.deepEqual(beforeInputChange, expectedDecisions, '公共 recordReview 应按调用顺序追加审核');

      const changed = await setBrief(id, { topic: '更新后的主题', requirements: '沿用既有成功成品作为视觉基线' }, {
        root,
        expectedRevision: task.revision,
      });
      assert.equal(changed.inputConfirmation, null);
      const archivedAfterInputChange = changed.reviewHistory
        .filter(review => review.version === 1 && review.page === 1 && review.sha256 === originalPages.get(1).sha256)
        .map(review => review.decision);
      assert.deepEqual(archivedAfterInputChange, expectedDecisions, '输入变更归档必须保留末条及完整顺序');

      task = await confirmInputs(id, {
        revision: changed.revision,
        by: 'test reviewer',
        note: '确认更新后的需求和来源',
      }, { root, expectedRevision: changed.revision });
      task = await setSheet(id, {
        title: '新输入制作单',
        pages: [1, 2].map(page => ({ page, copy: `新方案第${page}页`, prompt: `新需求图${page}`, size: '3:4' })),
      }, { root, expectedRevision: task.revision, inputRevision: task.inputConfirmation.revision });
      task = await confirmSheet(id, {
        version: task.sheetVersion,
        by: 'test reviewer',
        note: '确认新输入制作单',
      }, { root, expectedRevision: task.revision });

      const edited = await editTaskPages(id, {
        edits: [{ page: 1, instruction: '只调整第1页' }],
        authorization: { requestId: `input-archive-${name}`, text: '请只调整第1页。' },
        expectedRevision: task.revision,
        root,
        config,
        getHealth,
        ...fixture,
      });
      assert.equal(edited.sheets.at(-1).pageEdit.baselineEvidence.sourceVersion, 1,
        '新确认的制作单应能合法复用旧成功基线');
      const pageEditRuns = fixture.runs();
      const restored = await restorePageEdit(id, { page: 1, expectedRevision: edited.revision, root });
      assert.equal(fixture.runs(), pageEditRuns, '恢复旧图不应再次生成');
      assert.equal(restored.finalApproval, null, '恢复后仍需新的人工最终确认');
      assert.deepEqual(restored.reviewHistory
        .filter(review => review.version === 1 && review.page === 1 && review.sha256 === originalPages.get(1).sha256)
        .map(review => review.decision), expectedDecisions, '历史审核记录和顺序不能被重写');
      assert.deepEqual(restored.reviews.map(review => [review.version, review.page, review.sha256, review.decision]), [
        [restored.sheetVersion, 1, originalPages.get(1).sha256, latestDecision],
        [restored.sheetVersion, 2, originalPages.get(2).sha256, 'pass'],
      ], '恢复审核必须精确匹配来源版本、页码与图片哈希');
      for (const pageNumber of [1, 2]) {
        const original = originalPages.get(pageNumber);
        const current = restored.execution.pages.find(page => page.page === pageNumber);
        assert.equal(current.image.path, original.path);
        assert.equal(current.image.sha256, original.sha256);
        assert.deepEqual(await readFile(current.image.path), original.bytes, '历史原图字节不变');
      }
      assert.equal(fixture.runs(), 3, '两页基线加单页编辑，恢复不调用生图');

      if (latestDecision === 'pass') {
        const approved = await approveFinal(id, {
          version: restored.sheetVersion,
          images: restored.execution.pages.map(page => ({ page: page.page, sha256: page.image.sha256 })),
          by: 'test reviewer',
          note: '恢复图最新审核为 pass',
        }, { root, expectedRevision: restored.revision });
        const exported = await exportTask(id, { root, expectedRevision: approved.revision });
        assert.ok(exported.export.archiveRelativePath, '最新 pass 应可批准并导出');
      } else {
        await assert.rejects(approveFinal(id, {
          version: restored.sheetVersion,
          images: restored.execution.pages.map(page => ({ page: page.page, sha256: page.image.sha256 })),
          by: 'test reviewer',
          note: '最新 revise 不能批准',
        }, { root, expectedRevision: restored.revision }), /第 1 页没有针对当前文件哈希的 pass 复审/);
        await assert.rejects(exportTask(id, { root, expectedRevision: restored.revision }), /尚未完成人工最终确认/);
        assert.deepEqual((await readTask(id, root)).exports, [], '最新 revise 时不生成导出');
      }
    });
  }
});

test('三页中局部改两项输入只生成目标页，旧成品和未改页审核按新版本保留', async t => {
  const { root, id } = await setup(t, 3);
  const fixture = canvas();
  const baseline = await createReviewedBaseline(id, root, fixture);
  const original = new Map(baseline.execution.pages.map(page => [page.page, { path: page.image.path, sha256: page.image.sha256 }]));

  const edited = await editTaskPages(id, {
    edits: [{ page: 2, instruction: '改用暖色调并保留原版式', copy: '修改后的准确文案', stylePages: [1] }],
    authorization: { requestId: 'chat-edit-001', text: '请只重做第2页，改成暖色，并把标题换成修改后的准确文案。' },
    expectedRevision: baseline.revision,
    root,
    config,
    getHealth,
    ...fixture,
  });

  assert.equal(fixture.runs(), 4, '三张基线图之后只应新增一次生图调用');
  assert.equal(edited.sheetVersion, 2);
  assert.equal(edited.sheetConfirmation, null, '聊天修改不能伪造整份制作单的人审确认');
  assert.equal(edited.sheets.at(-1).kind, 'page-edit');
  assert.equal(edited.sheets.at(-1).parentVersion, 1);
  assert.equal(edited.sheets.at(-1).pageEdit.chatEdit.kind, 'chat-edit');
  assert.equal(edited.sheets.at(-1).pageEdit.chatEdit.requestId, 'chat-edit-001');
  assert.equal(edited.sheets.at(-1).pageEdit.baselineEvidence.sourceVersion, 1);
  assert.doesNotThrow(() => assertNoCredentials(edited.sheets.at(-1)));
  assert.equal(edited.sheets.at(-1).pages[1].copy, '修改后的准确文案');
  assert.match(edited.sheets.at(-1).pages[1].prompt, /改用暖色调/);
  assert.equal(edited.finalApproval, null);
  for (const pageNumber of [1, 3]) {
    const page = edited.execution.pages.find(item => item.page === pageNumber);
    assert.equal(page.image.path, original.get(pageNumber).path);
    assert.equal(page.image.sha256, original.get(pageNumber).sha256);
    assert.ok(edited.reviews.some(review => review.page === pageNumber && review.version === 2 && review.sha256 === page.image.sha256));
  }
  assert.ok(!edited.reviews.some(review => review.page === 2));

  const outputReferences = edited.sheets.at(-1).outputReferences;
  assert.deepEqual(outputReferences.map(reference => [reference.page, reference.role]), [[2, 'edit-base'], [1, 'style']]);
  const changedRecord = edited.execution.pages.find(item => item.page === 2);
  const changedPrompt = fixture.nodes.find(item => item.id === changedRecord.textNodeId).metadata.content;
  assert.match(changedPrompt, /图片1：待修改原图（任务第2页）/);
  assert.match(changedPrompt, /图片2：仅供画风参考.*任务第1页/);
  assert.deepEqual(changedRecord.referenceNodes.map(reference => reference.kind), ['output', 'output']);
  for (const reference of changedRecord.referenceNodes) {
    const node = fixture.nodes.find(item => item.id === reference.nodeId);
    assert.match(node.metadata.storageKey, /^image:/);
    const bytes = Buffer.from(fixture.importedDataUrl(reference.nodeId).split(',')[1], 'base64');
    const sourcePage = reference.page;
    assert.equal(digest(bytes), baseline.execution.pages.find(item => item.page === sourcePage).image.sha256);
  }

  const replay = await editTaskPages(id, {
    edits: [{ page: 2, instruction: '改用暖色调并保留原版式', copy: '修改后的准确文案', stylePages: [1] }],
    authorization: { requestId: 'chat-edit-001', text: '请只重做第2页，改成暖色，并把标题换成修改后的准确文案。' },
    expectedRevision: baseline.revision,
    root,
    config,
    getHealth,
    ...fixture,
  });
  assert.equal(replay.sheetVersion, 2);
  assert.equal(fixture.runs(), 4, '重复 requestId 不得再次生图');
});

test('生成失败保留原成品；重复同一请求只查询失败节点，不会再次收费', async t => {
  const { root, id } = await setup(t, 2);
  const fixture = canvas({ failAt: 3 });
  const baseline = await createReviewedBaseline(id, root, fixture, 2);
  const original = baseline.execution.pages.find(page => page.page === 1).image;
  const request = {
    edits: [{ page: 1, instruction: '把背景变成浅蓝色' }],
    authorization: { requestId: 'chat-edit-fails', text: '请把第1页背景改成浅蓝色。' },
    expectedRevision: baseline.revision,
    root,
    config,
    getHealth,
    ...fixture,
  };
  await assert.rejects(editTaskPages(id, request));
  const failed = await readTask(id, root);
  assert.equal(failed.sheetVersion, 2);
  assert.equal(failed.execution.pages.find(page => page.page === 1).status, 'failed');
  assert.equal(digest(await readFile(original.path)), original.sha256);
  assert.ok(await stat(original.path));
  await assert.rejects(editTaskPages(id, request));
  assert.equal(fixture.runs(), 3, '重复失败请求不得自动重发生成');
  assert.equal(digest(await readFile(original.path)), original.sha256);
});

test('基线成品 SHA 过期时拒绝建版，当前草稿不被覆盖', async t => {
  const { root, id } = await setup(t, 2);
  const fixture = canvas();
  const baseline = await executeCurrent(id, { root, version: 1, config, getHealth, ...fixture });
  const image = baseline.execution.pages[0].image;
  await writeFile(image.path, Buffer.concat([png, Buffer.from('mutated')]));
  await assert.rejects(editTaskPages(id, {
    edits: [{ page: 1, instruction: '改颜色' }],
    authorization: { requestId: 'stale-image', text: '请改第1页颜色。' },
    expectedRevision: baseline.revision,
    root,
    config,
    getHealth,
    ...fixture,
  }), /SHA-256/);
  const after = await readTask(id, root);
  assert.equal(after.sheetVersion, 1);
  assert.equal(after.sheets.length, 1);
  assert.equal(fixture.runs(), 2);
});

test('v5 未执行草稿自动选取 executionHistory 中最近成功的 v1 作为基线', async t => {
  const { root, id } = await setup(t, 3);
  const fixture = canvas();
  const versionOne = await executeCurrent(id, { root, version: 1, config, getHealth, ...fixture });
  let task = await setBrief(id, { topic: '新需求', requirements: '新一轮输入确认，但沿用旧版成功成品作视觉基线' }, { root, expectedRevision: versionOne.revision });
  task = await confirmInputs(task.id, { revision: task.revision, by: 'test fixture', note: '确认新输入' }, { root, expectedRevision: task.revision });
  for (let version = 2; version <= 5; version += 1) {
    task = await setSheet(id, {
      title: `草稿 v${version}`,
      pages: Array.from({ length: 3 }, (_, index) => ({ page: index + 1, copy: `v${version} 文案 ${index + 1}`, prompt: `v${version} 指令 ${index + 1}`, size: '3:4' })),
    }, { root, expectedRevision: task.revision, inputRevision: task.inputConfirmation.revision });
  }
  assert.equal(task.sheetVersion, 5);
  assert.equal(task.execution.pages.length, 0);
  assert.notEqual(task.sheets.find(sheet => sheet.version === 1).inputsRevision, task.inputConfirmation.revision);
  const edited = await editTaskPages(id, {
    edits: [{ page: 3, instruction: '保持原主题，改成夜景' }],
    authorization: { requestId: 'auto-v1-baseline', text: '請只修改第3頁为夜景。' },
    expectedRevision: task.revision,
    root,
    config,
    getHealth,
    ...fixture,
  });
  assert.equal(edited.sheetVersion, 6);
  assert.equal(edited.sheets.at(-1).parentVersion, 5);
  assert.equal(edited.sheets.at(-1).pageEdit.baseVersion, 1);
  assert.equal(edited.sheets.at(-1).inputsRevision, edited.inputConfirmation.revision);
  assert.equal(fixture.runs(), 4, '只为第3页新生成，v1页1和页2沿用原路径');
  assert.equal(edited.execution.pages.find(page => page.page === 1).image.path, versionOne.execution.pages.find(page => page.page === 1).image.path);
});

test('恢复单页生成一个派生版本，回退该页图与文案并保留其他页', async t => {
  const { root, id } = await setup(t, 3);
  const fixture = canvas();
  const baseline = await createReviewedBaseline(id, root, fixture);
  const originalPage = baseline.execution.pages.find(page => page.page === 2);
  const originalPrompt = baseline.sheets.at(-1).pages[1].prompt;
  const originalCopy = baseline.sheets.at(-1).pages[1].copy;
  const edited = await editTaskPages(id, {
    edits: [{ page: 2, instruction: '让整体变成海边日落', copy: '日落版本文案' }],
    authorization: { requestId: 'restore-fixture', text: '请把第2页改成海边日落并更新文案。' },
    expectedRevision: baseline.revision,
    root,
    config,
    getHealth,
    ...fixture,
  });
  const editRuns = fixture.runs();
  const restored = await restorePageEdit(id, { page: 2, expectedRevision: edited.revision, root });
  assert.equal(fixture.runs(), editRuns, '恢复成品不调用生图');
  assert.equal(restored.sheetVersion, 3);
  assert.equal(restored.sheets.at(-1).kind, 'page-edit');
  assert.equal(restored.sheets.at(-1).pageEdit.action, 'restore');
  assert.equal(restored.sheets.at(-1).pageEdit.restoredFromVersion, 1);
  assert.equal(restored.sheetConfirmation, null);
  assert.equal(restored.finalApproval, null);
  assert.equal(restored.sheets.at(-1).pages[1].prompt, originalPrompt);
  assert.equal(restored.sheets.at(-1).pages[1].copy, originalCopy);
  assert.equal(restored.execution.pages.find(page => page.page === 2).image.path, originalPage.image.path);
  assert.equal(restored.execution.pages.find(page => page.page === 2).nodeId, originalPage.nodeId);
  for (const pageNumber of [1, 3]) {
    const page = restored.execution.pages.find(item => item.page === pageNumber);
    assert.equal(page.image.path, baseline.execution.pages.find(item => item.page === pageNumber).image.path);
  }
  assert.ok(restored.reviews.some(review => review.page === 2 && review.version === 3 && review.sha256 === originalPage.image.sha256));
});

test('恢复按页码、版本和哈希继承最后一条审核，审批与导出沿用同一决定', async t => {
  for (const { name, decisions, expectedDecision, untouchedDecisions, expectedUntouchedDecision } of [
    {
      name: 'pass 后 revise',
      decisions: ['pass', 'revise'],
      expectedDecision: 'revise',
      untouchedDecisions: ['revise', 'pass'],
      expectedUntouchedDecision: 'pass',
    },
    {
      name: 'revise 后 pass',
      decisions: ['revise', 'pass'],
      expectedDecision: 'pass',
      untouchedDecisions: ['revise', 'pass'],
      expectedUntouchedDecision: 'pass',
    },
    {
      name: '恢复目标 pass、未改页 pass 后 revise',
      decisions: ['revise', 'pass'],
      expectedDecision: 'pass',
      untouchedDecisions: ['revise'],
      expectedUntouchedDecision: 'revise',
    },
  ]) {
    await t.test(name, async t => {
      const { root, id } = await setup(t, 2);
      const fixture = canvas();
      const baseline = await createReviewedBaseline(id, root, fixture, 2);
      const originalPages = new Map();
      for (const page of baseline.execution.pages) {
        originalPages.set(page.page, {
          path: page.image.path,
          sha256: page.image.sha256,
          bytes: await readFile(page.image.path),
        });
      }

      let task = await withTask(id, draft => {
        draft.reviews = draft.reviews.filter(review => review.page !== 1);
        draft.finalApproval = null;
      }, { root, expectedRevision: baseline.revision });
      for (const decision of decisions) {
        const page = originalPages.get(1);
        task = await recordReview(id, {
          page: 1,
          sha256: page.sha256,
          decision,
          reviewer: 'test reviewer',
          notes: `恢复顺序夹具第1页 ${decision}`,
        }, { root, expectedRevision: task.revision });
      }
      const untouched = originalPages.get(2);
      for (const decision of untouchedDecisions) {
        task = await recordReview(id, {
          page: 2,
          sha256: untouched.sha256,
          decision,
          reviewer: 'test reviewer',
          notes: `恢复顺序夹具第2页 ${decision}`,
        }, { root, expectedRevision: task.revision });
      }
      const sourceDecisions = task.reviews
        .filter(review => review.version === 1 && review.page === 1 && review.sha256 === originalPages.get(1).sha256)
        .map(review => review.decision);
      const untouchedLatest = [...task.reviews].reverse().find(review => review.version === 1 && review.page === 2);

      const edited = await editTaskPages(id, {
        edits: [{ page: 1, instruction: '只修改第1页' }],
        authorization: { requestId: `restore-review-${name}`, text: '请只修改第1页。' },
        expectedRevision: task.revision,
        root,
        config,
        getHealth,
        ...fixture,
      });
      const historicalPageOneReviews = edited.reviewHistory.filter(review => review.version === 1
        && review.page === 1 && review.sha256 === originalPages.get(1).sha256);
      const editPageTwoReviews = edited.reviews.filter(review => review.version === edited.sheetVersion
        && review.page === 2 && review.sha256 === untouched.sha256);
      assert.deepEqual(editPageTwoReviews.map(review => review.decision), ['pass', ...untouchedDecisions]);

      const runsBeforeRestore = fixture.runs();
      const priorExecutionHistory = structuredClone(edited.executionHistory || []);
      const restored = await restorePageEdit(id, { page: 1, expectedRevision: edited.revision, root });
      assert.equal(fixture.runs(), runsBeforeRestore, '恢复不得调用生图');
      assert.equal(restored.finalApproval, null, '恢复后必须等待人工重新最终确认');
      assert.deepEqual(restored.executionHistory.slice(0, priorExecutionHistory.length), priorExecutionHistory,
        '恢复不得改写已有执行历史');
      assert.deepEqual(restored.reviewHistory.filter(review => review.version === 1
        && review.page === 1 && review.sha256 === originalPages.get(1).sha256), historicalPageOneReviews,
      '历史审核顺序和原记录保持不变');
      assert.deepEqual(restored.reviews.map(review => [review.page, review.version, review.sha256, review.decision]), [
        [1, restored.sheetVersion, originalPages.get(1).sha256, expectedDecision],
        [2, restored.sheetVersion, untouched.sha256, expectedUntouchedDecision],
      ], '恢复页和未改继承页只带入其精确快照的最新审核');
      assert.equal(restored.reviews[0].reviewedAt,
        task.reviews.filter(review => review.version === 1 && review.page === 1).at(-1).reviewedAt,
      '继承审核必须是既有人工记录，不生成新审核');
      assert.deepEqual(restored.reviewHistory.filter(review => review.version === 1
        && review.page === 1 && review.sha256 === originalPages.get(1).sha256).map(review => review.decision), sourceDecisions);
      assert.equal(restored.reviews[1].reviewedAt, untouchedLatest.reviewedAt,
        '未修改页继承其最新审核记录');

      for (const pageNumber of [1, 2]) {
        const restoredPage = restored.execution.pages.find(page => page.page === pageNumber);
        const original = originalPages.get(pageNumber);
        assert.equal(restoredPage.image.path, original.path);
        assert.equal(restoredPage.image.sha256, original.sha256);
        assert.deepEqual(await readFile(restoredPage.image.path), original.bytes, '原图字节保持不变');
      }

      if (expectedDecision === 'revise') {
        await assert.rejects(approveFinal(id, {
          version: restored.sheetVersion,
          images: restored.execution.pages.map(page => ({ page: page.page, sha256: page.image.sha256 })),
          by: 'test reviewer',
          note: '最新 revise 不得获批',
        }, { root, expectedRevision: restored.revision }), /第 1 页没有针对当前文件哈希的 pass 复审/);
        await assert.rejects(exportTask(id, { root, expectedRevision: restored.revision }), /尚未完成人工最终确认/);
        assert.deepEqual((await readTask(id, root)).exports, [], '被 revise 阻断时不生成导出');
      } else if (expectedUntouchedDecision === 'revise') {
        await assert.rejects(approveFinal(id, {
          version: restored.sheetVersion,
          images: restored.execution.pages.map(page => ({ page: page.page, sha256: page.image.sha256 })),
          by: 'test reviewer',
          note: '未改页最新 revise 不得放行整单',
        }, { root, expectedRevision: restored.revision }), /第 2 页没有针对当前文件哈希的 pass 复审/);
        await assert.rejects(exportTask(id, { root, expectedRevision: restored.revision }), /尚未完成人工最终确认/);
        assert.deepEqual((await readTask(id, root)).exports, [], '未改页 revise 时不生成导出');
      } else {
        const approved = await approveFinal(id, {
          version: restored.sheetVersion,
          images: restored.execution.pages.map(page => ({ page: page.page, sha256: page.image.sha256 })),
          by: 'test reviewer',
          note: '最新 pass 可按现有合同批准',
        }, { root, expectedRevision: restored.revision });
        assert.equal(approved.finalApproval.version, restored.sheetVersion);
        const exported = await exportTask(id, { root, expectedRevision: approved.revision });
        assert.ok(exported.export.archiveRelativePath);
        const pageOne = restored.execution.pages.find(page => page.page === 1);
        const invalidated = await recordReview(id, {
          page: 1,
          sha256: pageOne.image.sha256,
          decision: 'revise',
          reviewer: 'test reviewer',
          notes: '批准后发现仍需修改',
        }, { root, expectedRevision: exported.task.revision });
        assert.equal(invalidated.finalApproval, null, '新增 revise 必须撤销旧最终批准');
        await assert.rejects(approveFinal(id, {
          version: invalidated.sheetVersion,
          images: invalidated.execution.pages.map(page => ({ page: page.page, sha256: page.image.sha256 })),
          by: 'test reviewer',
          note: '旧批准不能覆盖最新 revise',
        }, { root, expectedRevision: invalidated.revision }), /第 1 页没有针对当前文件哈希的 pass 复审/);
        await assert.rejects(exportTask(id, { root, expectedRevision: invalidated.revision }), /尚未完成人工最终确认/);
        assert.deepEqual((await readTask(id, root)).exports.map(record => record.version), [exported.export.version]);
      }
    });
  }
});

test('恢复不会把旧版本或不同哈希的审核伪装成当前图审核', async t => {
  const { root, id } = await setup(t, 2);
  const fixture = canvas();
  const baseline = await createReviewedBaseline(id, root, fixture, 2);
  const originalPage = baseline.execution.pages.find(page => page.page === 1);
  const originalBytes = await readFile(originalPage.image.path);
  const differentHash = 'f'.repeat(64);
  let task = await withTask(id, draft => {
    const prior = draft.reviews.find(review => review.page === 1);
    draft.reviews = draft.reviews.filter(review => review.page !== 1);
    draft.reviewHistory.push({ ...prior, version: 2 });
    draft.reviews.push({ ...prior, sha256: differentHash, decision: 'pass', notes: '不同哈希的旧审核' });
    draft.finalApproval = null;
  }, { root, expectedRevision: baseline.revision });
  const edited = await editTaskPages(id, {
    edits: [{ page: 1, instruction: '只修改第1页' }],
    authorization: { requestId: 'restore-stale-review', text: '请只修改第1页。' },
    expectedRevision: task.revision,
    root,
    config,
    getHealth,
    ...fixture,
  });
  const restored = await restorePageEdit(id, { page: 1, expectedRevision: edited.revision, root });
  assert.equal(restored.reviews.some(review => review.page === 1 && review.version === restored.sheetVersion
    && review.sha256 === originalPage.image.sha256), false, '没有精确匹配审核时不得生成恢复审核');
  assert.deepEqual(restored.reviewHistory.filter(review => review.page === 1).map(review => [review.version, review.sha256]), [
    [2, originalPage.image.sha256],
    [1, differentHash],
  ], '其他版本和不同哈希审核应留在历史中，不能改写成当前审核');
  assert.deepEqual(restored.reviews.map(review => review.page), [2], '只继承有精确审核的未改页');
  assert.equal(restored.finalApproval, null);
  assert.equal(restored.execution.pages.find(page => page.page === 1).image.sha256, originalPage.image.sha256);
  assert.deepEqual(await readFile(originalPage.image.path), originalBytes, '原图内容必须保持不变');
  await assert.rejects(approveFinal(id, {
    version: restored.sheetVersion,
    images: restored.execution.pages.map(page => ({ page: page.page, sha256: page.image.sha256 })),
    by: 'test reviewer',
    note: '旧审核不能批准当前恢复图',
  }, { root, expectedRevision: restored.revision }), /没有针对当前文件哈希的 pass 复审/);
});

test('归档保留同毫秒重复审核的顺序，恢复取最后一次相同 pass', async t => {
  const { root, id } = await setup(t, 2);
  const fixture = canvas();
  const baseline = await createReviewedBaseline(id, root, fixture, 2);
  const originalPage = baseline.execution.pages.find(page => page.page === 1);
  const timestamp = '2026-10-15T12:00:00.000Z';
  const pass = {
    ...baseline.reviews.find(review => review.page === 1),
    reviewer: 'same reviewer',
    notes: 'same observation',
    reviewedAt: timestamp,
  };
  const revise = { ...pass, decision: 'revise' };
  let task = await withTask(id, draft => {
    draft.reviews = draft.reviews.filter(review => review.page !== 1);
    draft.reviews.push(pass, revise, pass);
    draft.finalApproval = null;
  }, { root, expectedRevision: baseline.revision });
  const edited = await editTaskPages(id, {
    edits: [{ page: 1, instruction: '只修改第1页' }],
    authorization: { requestId: 'restore-identical-review-order', text: '请只修改第1页。' },
    expectedRevision: task.revision,
    root,
    config,
    getHealth,
    ...fixture,
  });
  assert.deepEqual(edited.reviewHistory.filter(review => review.version === 1 && review.page === 1)
    .map(review => [review.decision, review.reviewedAt, review.reviewer, review.notes]), [
    ['pass', timestamp, 'same reviewer', 'same observation'],
    ['revise', timestamp, 'same reviewer', 'same observation'],
    ['pass', timestamp, 'same reviewer', 'same observation'],
  ], '归档不得按完整 JSON 去重而丢失末条审核');

  const restored = await restorePageEdit(id, { page: 1, expectedRevision: edited.revision, root });
  const inherited = restored.reviews.find(review => review.page === 1);
  assert.equal(inherited.decision, 'pass');
  assert.equal(inherited.reviewedAt, timestamp);
  assert.equal(restored.finalApproval, null);
  assert.equal(restored.execution.pages.find(page => page.page === 1).image.sha256, originalPage.image.sha256);
  const approved = await approveFinal(id, {
    version: restored.sheetVersion,
    images: restored.execution.pages.map(page => ({ page: page.page, sha256: page.image.sha256 })),
    by: 'same reviewer',
    note: '最新同毫秒 pass 允许确认',
  }, { root, expectedRevision: restored.revision });
  const exported = await exportTask(id, { root, expectedRevision: approved.revision });
  assert.ok(exported.export.archiveRelativePath);
});

test('单页改图失败后可恢复原图，失败节点不重发且派生版本授权有效', async t => {
  const { root, id } = await setup(t, 2);
  const fixture = canvas({ failAt: 3 });
  const baseline = await createReviewedBaseline(id, root, fixture, 2);
  const prior = baseline.execution.pages.find(page => page.page === 1);
  await assert.rejects(editTaskPages(id, {
    edits: [{ page: 1, instruction: '替换成雨天背景' }],
    authorization: { requestId: 'restore-after-failure', text: '请把第1页换成雨天背景。' },
    expectedRevision: baseline.revision,
    root,
    config,
    getHealth,
    ...fixture,
  }));
  const failed = await readTask(id, root);
  assert.equal(failed.execution.pages.find(page => page.page === 1).status, 'failed');
  const restored = await restorePageEdit(id, { page: 1, expectedRevision: failed.revision, root });
  assert.equal(fixture.runs(), 3);
  assert.equal(restored.sheetVersion, 3);
  assert.equal(restored.execution.status, 'succeeded');
  assert.equal(restored.execution.pages.find(page => page.page === 1).image.sha256, prior.image.sha256);
  assert.equal(restored.execution.pages.find(page => page.page === 1).nodeId, prior.nodeId);
  assert.equal(isSheetAuthorized(restored, restored.sheetVersion), true);
  assert.equal(restored.executionHistory.find(execution => execution.version === 2).pages.find(page => page.page === 1).status, 'failed');
});

test('新的局部修改继承之前不完整版本里已成功的新页，不回退到完整旧版', async t => {
  const { root, id } = await setup(t, 3);
  const fixture = canvas({ failAt: 5 });
  const baseline = await createReviewedBaseline(id, root, fixture, 3);
  await assert.rejects(editTaskPages(id, {
    edits: [
      { page: 2, instruction: '第2页完成局部更新' },
      { page: 3, instruction: '第3页暂时失败' },
    ],
    authorization: { requestId: 'partial-two-pages', text: '修改第2和第3页。' },
    expectedRevision: baseline.revision,
    root,
    config,
    getHealth,
    ...fixture,
  }));
  const partial = await readTask(id, root);
  assert.equal(partial.execution.pages.find(page => page.page === 2).status, 'succeeded');
  assert.equal(partial.execution.pages.find(page => page.page === 3).status, 'failed');
  const partialPageTwo = partial.execution.pages.find(page => page.page === 2);
  const next = await editTaskPages(id, {
    edits: [{ page: 3, instruction: '第3页重新做成晴天' }],
    authorization: { requestId: 'retry-page-three-new-request', text: '现在把第3页做成晴天。' },
    expectedRevision: partial.revision,
    root,
    config,
    getHealth,
    ...fixture,
  });
  assert.equal(fixture.runs(), 6, '只对第3页进行一次新调用');
  assert.equal(next.execution.pages.find(page => page.page === 2).image.path, partialPageTwo.image.path);
  assert.equal(next.execution.pages.find(page => page.page === 2).image.sha256, partialPageTwo.image.sha256);
  assert.notEqual(next.execution.pages.find(page => page.page === 2).image.path, baseline.execution.pages.find(page => page.page === 2).image.path);
});

test('旧五页历史不混入最近三页成功基线的派生版本', async t => {
  const { root, id } = await setup(t, 5);
  const fixture = canvas();
  let task = await createReviewedBaseline(id, root, fixture, 5);
  task = await setSheet(id, {
    title: '重组后的三页方案',
    pages: Array.from({ length: 3 }, (_, index) => ({ page: index + 1, copy: `新方案文案 ${index + 1}`, prompt: `新方案指令 ${index + 1}`, size: '3:4' })),
  }, { root, expectedRevision: task.revision, inputRevision: task.inputConfirmation.revision });
  task = await confirmSheet(id, { version: task.sheetVersion, by: 'test fixture', note: '确认三页方案' }, { root, expectedRevision: task.revision });
  const threePageBaseline = await executeCurrent(id, { root, version: task.sheetVersion, config, getHealth, ...fixture });
  assert.equal(threePageBaseline.execution.pages.length, 3);

  const edited = await editTaskPages(id, {
    edits: [{ page: 2, instruction: '新方案第2页换成暖色' }],
    authorization: { requestId: 'three-page-plan-only', text: '只改新三页方案的第2页。' },
    expectedRevision: threePageBaseline.revision,
    root,
    config,
    getHealth,
    ...fixture,
  });
  assert.equal(edited.sheets.at(-1).pages.length, 3);
  assert.deepEqual(edited.sheets.at(-1).pages.map(page => page.page), [1, 2, 3]);
  assert.equal(edited.execution.pages.length, 3);
  assert.equal(fixture.runs(), 9, '5页旧版、3页新基线与1页局部修改各自独立');
  const restored = await restorePageEdit(id, { page: 2, expectedRevision: edited.revision, root });
  assert.equal(restored.sheets.at(-1).pages.length, 3, '恢复也只在当前三页方案范围内操作');
  assert.deepEqual(restored.sheets.at(-1).pages.map(page => page.page), [1, 2, 3]);
  assert.equal(restored.execution.pages.length, 3);
  assert.equal(fixture.runs(), 9, '局部恢复不触发生图');
});

test('相同页码的其他普通制作单历史不混入已选成功基线分支', async t => {
  const { root, id } = await setup(t, 2);
  const fixture = canvas({ failAt: 4 });
  const first = await createReviewedBaseline(id, root, fixture, 2);
  const firstImages = new Map(first.execution.pages.map(page => [page.page, page.image]));
  let task = await setSheet(id, {
    title: '不相关的另一版布局',
    pages: [1, 2].map(page => ({ page, copy: `另一版文案 ${page}`, prompt: `另一版指令 ${page}`, size: '3:4' })),
  }, { root, expectedRevision: first.revision, inputRevision: first.inputConfirmation.revision });
  task = await confirmSheet(id, { version: task.sheetVersion, by: 'test fixture', note: '另一版方案' }, { root, expectedRevision: task.revision });
  await assert.rejects(executeCurrent(id, { root, version: task.sheetVersion, config, getHealth, ...fixture }));
  const partial = await readTask(id, root);
  assert.equal(partial.execution.pages.find(page => page.page === 1).status, 'succeeded');
  assert.equal(partial.execution.pages.find(page => page.page === 2).status, 'failed');

  const edited = await editTaskPages(id, {
    edits: [{ page: 2, instruction: '只调整成功基线的第2页' }],
    authorization: { requestId: 'branch-isolation', text: '按原成功方案只改第2页。' },
    expectedRevision: partial.revision,
    root,
    config,
    getHealth,
    ...fixture,
  });
  assert.equal(fixture.runs(), 5);
  assert.deepEqual(edited.sheets.at(-1).outputReferences.map(reference => reference.baseVersion), [1]);
  assert.equal(edited.execution.pages.find(page => page.page === 1).image.path, firstImages.get(1).path);
  assert.equal(edited.execution.pages.find(page => page.page === 1).image.sha256, firstImages.get(1).sha256);
});

test('上传图片局部改图使用真实附件字节，不确认整单并保留原图文字；可继续编辑成功结果', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-upload-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const aPath = path.join(root, 'uploaded-a.png');
  const bPath = path.join(root, 'uploaded-b.png');
  const imageA = Buffer.concat([png, Buffer.from('existing-ai-image-A')]);
  const imageB = Buffer.concat([png, Buffer.from('existing-ai-image-B')]);
  await writeFile(aPath, imageA);
  await writeFile(bPath, imageB);
  let task = await createTask({ title: '仅图片改图', brief: { topic: '上传图统一画风' } }, root);
  task = await attachTaskFiles(task.id, {
    files: [{ path: aPath, name: 'a.png', mimeType: 'image/png' }, { path: bPath, name: 'b.png', mimeType: 'image/png' }],
    title: '待改图片',
  }, { root, expectedRevision: task.revision });
  const sourceId = task.sources[0].id;
  assert.equal(task.sources[0].decision, 'pending');
  assert.equal(task.inputConfirmation, null);
  const fixture = canvas();
  const edited = await editTaskPages(task.id, {
    mode: 'uploaded-images',
    edits: [{ page: 1, image: { sourceId, fileOrder: 1 }, styleImages: [{ sourceId, fileOrder: 2 }], instruction: '统一成木刻版画风格' }],
    authorization: { requestId: 'uploaded-edit-001', text: '请用第二张的风格重画第一张。' },
    expectedRevision: task.revision,
    root,
    config,
    getHealth,
    ...fixture,
  });
  const sheet = edited.sheets.at(-1);
  assert.equal(fixture.runs(), 1);
  assert.equal(edited.inputConfirmation, null);
  assert.equal(edited.sheetConfirmation, null);
  assert.equal(sheet.pageEdit.basis.kind, 'uploaded-images');
  assert.equal(sheet.pageEdit.mode, 'uploaded-images');
  assert.equal(sheet.pageEdit.basis.originVersion, sheet.version);
  assert.equal(sheet.pageEdit.basis.uploadedImages.length, 2);
  assert.deepEqual(sheet.pageEdit.basis.uploadedImages.map(item => item.sha256).sort(), [digest(imageA), digest(imageB)].sort());
  assert.equal(sheet.pages[0].copyMode, 'preserve-source-text');
  assert.equal(edited.execution.pages[0].referenceNodes.length, 2);
  assert.deepEqual(edited.execution.pages[0].referenceNodes.map(item => item.kind), ['upload', 'upload']);
  assert.equal(isSheetAuthorized(edited, edited.sheetVersion), true);
  for (const reference of edited.execution.pages[0].referenceNodes) {
    const node = fixture.nodes.find(item => item.id === reference.nodeId);
    assert.match(node.metadata.storageKey, /^image:/);
    assert.equal(digest(Buffer.from(fixture.importedDataUrl(reference.nodeId).split(',')[1], 'base64')), reference.sha256);
  }

  const second = await editTaskPages(task.id, {
    edits: [{ page: 1, instruction: '色调更暖，保留图中文字' }],
    authorization: { requestId: 'uploaded-output-edit-002', text: '把刚才的成品调暖，文字不动。' },
    expectedRevision: edited.revision,
    root,
    config,
    getHealth,
    ...fixture,
  });
  assert.equal(fixture.runs(), 2);
  assert.equal(second.inputConfirmation, null);
  assert.equal(second.sheets.at(-1).pageEdit.basis.kind, 'uploaded-images');
  assert.equal(second.sheets.at(-1).pageEdit.basis.inputFingerprint, sheet.pageEdit.basis.inputFingerprint);
  assert.equal(second.sheets.at(-1).pageEdit.basis.originVersion, sheet.pageEdit.basis.originVersion);
  let reviewed = await recordReview(task.id, {
    page: 1,
    sha256: second.execution.pages[0].image.sha256,
    decision: 'pass',
    reviewer: 'test reviewer',
    notes: '核对实际生成图片与保留原图文字要求一致',
  }, { root, expectedRevision: second.revision });
  reviewed = await approveFinal(task.id, {
    version: second.sheetVersion,
    images: [{ page: 1, sha256: second.execution.pages[0].image.sha256 }],
    by: 'test reviewer',
    note: '确认上传图片改图成品',
  }, { root, expectedRevision: reviewed.revision });
  assert.ok(reviewed.finalApproval);
  const exported = await exportTask(task.id, { root, expectedRevision: reviewed.revision });
  assert.ok(exported.export.archiveRelativePath, '上传改图的逐页审核和最终确认可直接导出，无需伪造整单确认');
});

test('上传新两页分支失败页不回收旧普通版同页图，也不缩成一页或收费重试', async t => {
  const { root, id } = await setup(t, 3);
  const fixture = canvas({ failAt: 5 });
  const baseline = await createReviewedBaseline(id, root, fixture, 3);
  const oldPageTwo = baseline.execution.pages.find(page => page.page === 2).image;
  const firstPath = path.join(root, 'upload-page-one.png');
  const secondPath = path.join(root, 'upload-page-two.png');
  await writeFile(firstPath, Buffer.concat([png, Buffer.from('new-upload-one')]));
  await writeFile(secondPath, Buffer.concat([png, Buffer.from('new-upload-two')]));
  const attached = await attachTaskFiles(id, {
    files: [
      { path: firstPath, name: 'one.png', mimeType: 'image/png' },
      { path: secondPath, name: 'two.png', mimeType: 'image/png' },
    ],
    title: '另一组待改图片',
  }, { root, expectedRevision: baseline.revision });
  const sourceId = attached.sources.at(-1).id;
  await assert.rejects(editTaskPages(id, {
    mode: 'uploaded-images',
    edits: [
      { page: 1, image: { sourceId, fileOrder: 1 }, instruction: '统一成新批次风格' },
      { page: 2, image: { sourceId, fileOrder: 2 }, instruction: '统一成新批次风格' },
    ],
    authorization: { requestId: 'uploaded-partial-batch', text: '用这两张新图统一画风。' },
    expectedRevision: attached.revision,
    root,
    config,
    getHealth,
    ...fixture,
  }));
  const partial = await readTask(id, root);
  assert.deepEqual(partial.sheets.at(-1).pages.map(page => page.page), [1, 2]);
  assert.equal(partial.execution.pages.find(page => page.page === 1).status, 'succeeded');
  assert.equal(partial.execution.pages.find(page => page.page === 2).status, 'failed');
  assert.equal(fixture.runs(), 5);

  await assert.rejects(restorePageEdit(id, { page: 2, expectedRevision: partial.revision, root }), /没有可恢复的旧成品/);
  assert.equal(fixture.runs(), 5, '上传分支恢复不能从旧普通版取图，也不触发生图');

  await assert.rejects(editTaskPages(id, {
    edits: [{ page: 1, instruction: '只把新批次第1页改成冷色' }],
    authorization: { requestId: 'uploaded-follow-up', text: '请单独调整新批次第1页。' },
    expectedRevision: partial.revision,
    root,
    config,
    getHealth,
    ...fixture,
  }), /第 2 页没有同一谱系内的成功成品/);
  const unchanged = await readTask(id, root);
  assert.equal(unchanged.sheetVersion, partial.sheetVersion);
  assert.deepEqual(unchanged.sheets.at(-1).pages.map(page => page.page), [1, 2], '失败页不能因缺少成功图片而从整单定义里消失');
  assert.equal(unchanged.execution.pages.find(page => page.page === 2).status, 'failed');
  assert.equal(unchanged.execution.pages.some(page => page.page === 2 && page.image?.path === oldPageTwo.path), false,
    '上传谱系不得回收旧普通基线的同页图片');
  assert.equal(fixture.runs(), 5, '拒绝不完整谱系派生不能重发生成');
});

test('上传改图拒绝被排除附件，且输入变化会使已授权上传结果失效', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-upload-edit-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imagePath = path.join(root, 'uploaded.png');
  await writeFile(imagePath, png);
  let task = await createTask({ title: '上传图授权夹具', brief: { topic: '原始主题' } }, root);
  task = await attachTaskFiles(task.id, { files: [{ path: imagePath, name: 'uploaded.png', mimeType: 'image/png' }] }, { root, expectedRevision: task.revision });
  const source = task.sources[0];
  const excluded = await setSources(task.id, [{ ...source, decision: 'excluded' }], { root, expectedRevision: task.revision });
  const fixture = canvas();
  await assert.rejects(editTaskPages(task.id, {
    mode: 'uploaded-images',
    edits: [{ page: 1, image: { sourceId: source.id, fileOrder: 1 }, instruction: '换成铅笔风' }],
    authorization: { requestId: 'excluded-upload', text: '请使用附件改图。' },
    expectedRevision: excluded.revision,
    root,
    config,
    getHealth,
    ...fixture,
  }), /未排除|已排除/);
  assert.equal(fixture.runs(), 0);

  const retained = await setSources(task.id, [{ ...source, decision: 'pending' }], { root, expectedRevision: excluded.revision });
  const edited = await editTaskPages(task.id, {
    mode: 'uploaded-images',
    edits: [{ page: 1, image: { sourceId: source.id, fileOrder: 1 }, instruction: '换成铅笔风' }],
    authorization: { requestId: 'stale-upload-input', text: '请使用附件改图。' },
    expectedRevision: retained.revision,
    root,
    config,
    getHealth,
    ...fixture,
  });
  const changed = await setBrief(task.id, { topic: '修改后的不同主题' }, { root, expectedRevision: edited.revision });
  assert.equal(isSheetAuthorized(changed, changed.sheetVersion), false);
  const replay = await editTaskPages(task.id, {
    mode: 'uploaded-images',
    edits: [{ page: 1, image: { sourceId: source.id, fileOrder: 1 }, instruction: '换成铅笔风' }],
    authorization: { requestId: 'stale-upload-input', text: '请使用附件改图。' },
    expectedRevision: changed.revision,
    root,
    config,
    getHealth,
    ...fixture,
  });
  assert.equal(replay.revision, changed.revision, '旧 requestId 只返回当前状态，不执行失效授权');
  assert.equal(isSheetAuthorized(replay, replay.sheetVersion), false);
  assert.equal(fixture.runs(), 1, '输入变化不能让旧 requestId 重复生图');
});
