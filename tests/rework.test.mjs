import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { selectImage } from "../src/creative/executor.mjs";
import {
  approveFinal,
  confirmInputs,
  confirmSheet,
  createTask,
  exportTask,
  recordReview,
  setBrief,
  setSheet,
  setSources,
  taskDirectory,
  withTask,
} from "../src/creative/tasks.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "creative-rework-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root };
}

function onePageSheet(title = "制作单标题") {
  return {
    title,
    pages: [{ page: 1, copy: "准确文案", prompt: "完整绘图指令", size: "3:4" }],
  };
}

async function prepareTask(root) {
  let task = await createTask({ title: "版本绑定测试", brief: { topic: "初始主题" } }, root);
  task = await setSources(task.id, [], { root, expectedRevision: task.revision });
  task = await confirmInputs(task.id, {
    revision: task.revision,
    by: "用户",
    note: "确认当前需求与无来源输入",
  }, { root });
  task = await setSheet(task.id, onePageSheet(), {
    root,
    expectedRevision: task.revision,
    inputRevision: task.inputConfirmation.revision,
  });
  task = await confirmSheet(task.id, {
    version: task.sheetVersion,
    by: "用户",
    note: "确认准确文案与绘图指令",
  }, { root, expectedRevision: task.revision });
  return task;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function setExecution(task, root, imagePath) {
  const bytes = await fs.readFile(imagePath);
  return withTask(task.id, (draft) => {
    draft.execution = {
      version: draft.sheetVersion,
      status: "succeeded",
      pages: [{
        page: 1,
        status: "succeeded",
        nodeId: "node-1",
        imageNodeId: "image-1",
        image: { path: imagePath, sha256: sha256(bytes) },
      }],
    };
  }, { root, expectedRevision: task.revision });
}

async function reviewCurrent(task, root, reviewer = "用户") {
  const current = task.execution.pages[0];
  return recordReview(task.id, {
    page: 1,
    sha256: current.image.sha256,
    decision: "pass",
    reviewer,
    notes: "实际查看文案、清晰度和主题对应",
  }, { root, expectedRevision: task.revision });
}

async function approveCurrent(task, root) {
  const current = task.execution.pages[0];
  return approveFinal(task.id, {
    version: task.sheetVersion,
    images: [{ page: 1, sha256: current.image.sha256 }],
    by: "用户",
    note: "确认当前成品",
  }, { root, expectedRevision: task.revision });
}

async function readyForExport(root, name = "approved.png") {
  let task = await prepareTask(root);
  const imagePath = path.join(root, name);
  await fs.writeFile(imagePath, `${name} image bytes`);
  task = await setExecution(task, root, imagePath);
  task = await reviewCurrent(task, root);
  task = await approveCurrent(task, root);
  return { task, imagePath };
}

test("public status mutations require a positive expectedRevision", async (t) => {
  const { root } = await fixture(t);
  const task = await createTask({ title: "强制 revision", brief: "brief" }, root);
  const operations = [
    () => setBrief(task.id, "new brief", { root }),
    () => setSources(task.id, [], { root }),
    () => setSheet(task.id, onePageSheet(), { root, inputRevision: 1 }),
    () => confirmSheet(task.id, { version: 1, by: "用户", note: "确认" }, { root }),
    () => recordReview(task.id, {}, { root }),
    () => approveFinal(task.id, {}, { root }),
    () => exportTask(task.id, { root }),
  ];
  for (const operation of operations) {
    await assert.rejects(operation, (error) => error.code === "ERR_TASK_REVISION_REQUIRED");
  }
  await assert.rejects(setBrief(task.id, "new brief", { root, expectedRevision: 0 }),
    (error) => error.code === "ERR_TASK_REVISION_REQUIRED");
});

test("setSheet rejects an old payload after requirements are changed and reconfirmed", async (t) => {
  const { root } = await fixture(t);
  let task = await prepareTask(root);
  const oldCommand = {
    sheet: onePageSheet("基于旧需求准备的制作单"),
    expectedRevision: task.revision,
    inputRevision: task.inputConfirmation.revision,
  };

  task = await setBrief(task.id, { topic: "新主题" }, { root, expectedRevision: task.revision });
  task = await confirmInputs(task.id, {
    revision: task.revision,
    by: "用户",
    note: "重新确认更新后的需求",
  }, { root });

  await assert.rejects(setSheet(task.id, oldCommand.sheet, {
    root,
    expectedRevision: oldCommand.expectedRevision,
    inputRevision: oldCommand.inputRevision,
  }), (error) => error.code === "ERR_TASK_REVISION_CONFLICT");
  await assert.rejects(setSheet(task.id, oldCommand.sheet, {
    root,
    expectedRevision: task.revision,
    inputRevision: oldCommand.inputRevision,
  }), (error) => error.code === "ERR_TASK_INPUT_CONFLICT");
  await assert.rejects(setSheet(task.id, onePageSheet(), {
    root,
    expectedRevision: task.revision,
  }), (error) => error.code === "ERR_TASK_INPUT_CONFLICT");
});

test("an approval prepared for image A cannot approve image B after re-review", async (t) => {
  const { root } = await fixture(t);
  let task = await prepareTask(root);
  const imageA = path.join(root, "image-a.png");
  const imageB = path.join(root, "image-b.png");
  await fs.writeFile(imageA, "image A");
  await fs.writeFile(imageB, "image B");
  task = await setExecution(task, root, imageA);
  task = await reviewCurrent(task, root);

  await assert.rejects(approveFinal(task.id, {
    version: task.sheetVersion,
    by: "用户",
    note: "缺少逐页批准清单",
  }, { root, expectedRevision: task.revision }), /必须是逐页数组/);
  const imageAHash = task.execution.pages[0].image.sha256;
  await assert.rejects(approveFinal(task.id, {
    version: task.sheetVersion,
    images: [{ page: 1, sha256: imageAHash }, { page: 1, sha256: imageAHash }],
    by: "用户",
    note: "重复页码不能批准",
  }, { root, expectedRevision: task.revision }), /页码不能重复/);

  const oldApproval = {
    version: task.sheetVersion,
    images: [{ page: 1, sha256: imageAHash }],
    by: "用户",
    note: "只批准图片 A",
  };
  const oldRevision = task.revision;

  task = await selectImage(task.id, {
    version: task.sheetVersion,
    page: 1,
    nodeId: "replacement-b",
    expectedRevision: task.revision,
    root,
    config: { projectId: "isolated-test", webUrl: "http://isolated-test" },
    recover: async (nodeId, destination) => {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(imageB, destination);
      return { nodeId, path: destination };
    },
  });
  task = await reviewCurrent(task, root);

  await assert.rejects(approveFinal(task.id, oldApproval, { root, expectedRevision: oldRevision }),
    (error) => error.code === "ERR_TASK_REVISION_CONFLICT");
  await assert.rejects(approveFinal(task.id, oldApproval, { root, expectedRevision: task.revision }),
    /SHA-256 与当前文件不一致/);

  task = await approveCurrent(task, root);
  assert.deepEqual(task.finalApproval.images, [{ page: 1, sha256: task.execution.pages[0].image.sha256 }]);
  assert.equal(task.finalApproval.revision, task.revision - 1);
});

test("export rejects a current image whose hash is absent from the persisted approval", async (t) => {
  const { root } = await fixture(t);
  let { task } = await readyForExport(root);
  const imageB = path.join(root, "replacement.png");
  await fs.writeFile(imageB, "replacement image bytes");
  const replacementHash = sha256(await fs.readFile(imageB));

  task = await withTask(task.id, (draft) => {
    draft.execution.pages[0].image = { path: imageB, sha256: replacementHash };
    draft.reviews.push({
      version: draft.sheetVersion,
      page: 1,
      sha256: replacementHash,
      decision: "pass",
      reviewer: "用户",
      notes: "为当前替换图记录的实际复审",
      reviewedAt: new Date().toISOString(),
    });
  }, { root, expectedRevision: task.revision });

  await assert.rejects(exportTask(task.id, { root, expectedRevision: task.revision }),
    /当前文件与最终批准 SHA-256 不一致/);
});

test("export numbering accounts for a ZIP-only artifact and an export-record-only version", async (t) => {
  const { root } = await fixture(t);
  let { task } = await readyForExport(root, "zip-only.png");
  const first = await exportTask(task.id, { root, expectedRevision: task.revision });
  const taskDir = taskDirectory(task.id, root);
  const firstDirectory = path.join(taskDir, first.export.relativePath);
  const firstArchive = path.join(taskDir, first.export.archiveRelativePath);
  const firstHash = await fs.readFile(firstArchive).then(sha256);
  await fs.rm(firstDirectory, { recursive: true });
  task = await withTask(task.id, (draft) => { draft.exports = []; }, {
    root,
    expectedRevision: first.task.revision,
  });

  const second = await exportTask(task.id, { root, expectedRevision: task.revision });
  assert.equal(second.export.version, "export-002");
  assert.equal(await fs.readFile(firstArchive).then(sha256), firstHash);

  let recordOnly = await readyForExport(root, "record-only.png");
  recordOnly.task = await withTask(recordOnly.task.id, (draft) => {
    draft.exports.push({ version: "export-001", relativePath: "exports/export-001", generatedAt: "historical" });
  }, { root, expectedRevision: recordOnly.task.revision });
  const recordExport = await exportTask(recordOnly.task.id, {
    root,
    expectedRevision: recordOnly.task.revision,
  });
  assert.equal(recordExport.export.version, "export-002");
});

test("stale or missing selection revision is rejected before image recovery", async (t) => {
  const { root } = await fixture(t);
  let { task } = await readyForExport(root, "before-selection.png");
  const before = task.revision;
  task = await recordReview(task.id, {
    page: 1, sha256: task.execution.pages[0].image.sha256,
    decision: "pass", reviewer: "测试用户", notes: "本次夹具复审更新revision",
  }, { root, expectedRevision: task.revision });
  let recovered = 0;
  const command = {
    root, version: task.sheetVersion, page: 1, nodeId: "replacement",
    recover: async () => { recovered++; },
  };
  await assert.rejects(selectImage(task.id, command), error => error.code === "ERR_TASK_REVISION_REQUIRED");
  await assert.rejects(selectImage(task.id, { ...command, expectedRevision: before }), error => error.code === "ERR_TASK_REVISION_CONFLICT");
  assert.equal(recovered, 0);
});
