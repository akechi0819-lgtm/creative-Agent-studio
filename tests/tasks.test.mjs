import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  approveFinal,
  clearTaskLock,
  confirmInputs,
  confirmSheet,
  createTask,
  exportTask,
  readTask,
  recordReview,
  setBrief,
  setSheet,
  setSources,
  taskDirectory,
  withTask,
} from "../src/creative/tasks.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "creative-tasks-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root };
}

function sourceCandidates(decisions = ["retained", "excluded"]) {
  return decisions.map((decision, index) => ({
    id: `source-${index + 1}`,
    title: `Source ${index + 1}`,
    sourceKind: "user-provided",
    licenseEvidence: { status: "user-provided", note: "用户提供；未复制原件" },
    decision,
  }));
}

function sheet(pageCount = 1) {
  return {
    title: "制作单标题",
    pages: Array.from({ length: pageCount }, (_, index) => ({
      page: index + 1,
      copy: `第 ${index + 1} 页准确文案`,
      prompt: `第 ${index + 1} 页完整绘图指令`,
      size: "3:4",
    })),
  };
}

function sheetWriteOptions(task, root) {
  return { root, expectedRevision: task.revision, inputRevision: task.inputConfirmation.revision };
}

function approvalImages(task) {
  return task.execution.pages.map(({ page, image }) => ({ page, sha256: image.sha256 }));
}

async function prepareTask(root, pageCount = 1) {
  let task = await createTask({ title: "单页海报任务", brief: { topic: "测试主题", audience: "家长" } }, root);
  task = await setSources(task.id, sourceCandidates(), { root, expectedRevision: task.revision });
  task = await confirmInputs(task.id, { revision: task.revision, by: "用户", note: "需求和来源逐项核对" }, { root });
  task = await setSheet(task.id, sheet(pageCount), sheetWriteOptions(task, root));
  task = await confirmSheet(task.id, { version: task.sheetVersion, by: "用户", note: "确认本版准确文案与绘图指令" }, { root, expectedRevision: task.revision });
  return task;
}

async function setSuccessfulExecution(task, root, imagePaths) {
  const pages = await Promise.all(imagePaths.map(async (imagePath, index) => ({
    page: index + 1,
    status: "succeeded",
    nodeId: `node-${index + 1}`,
    imageNodeId: `image-${index + 1}`,
    image: {
      path: imagePath,
      sha256: crypto.createHash("sha256").update(await fs.readFile(imagePath)).digest("hex"),
    },
  })));
  return withTask(task.id, (draft) => {
    draft.execution = { version: draft.sheetVersion, status: "succeeded", pages };
  }, { root, expectedRevision: task.revision });
}

test("persists UUID task JSON atomically and exposes the task directory", async (t) => {
  const { root } = await fixture(t);
  const task = await createTask({ title: "新任务", brief: "海报需求" }, root);
  assert.match(task.id, /^[0-9a-f-]{36}$/i);
  assert.equal(task.revision, 1);
  assert.equal(taskDirectory(task.id, root), path.join(root, "tasks", task.id));
  assert.deepEqual(await readTask(task.id, root), task);
  await assert.rejects(readTask("../../outside", root), /UUID/);
});

test("requires explicit review of every source and binds confirmations to input and sheet versions", async (t) => {
  const { root } = await fixture(t);
  let task = await createTask({ title: "来源确认", brief: { topic: "主题" } }, root);
  task = await setSources(task.id, sourceCandidates(["pending", "excluded"]), { root, expectedRevision: task.revision });
  await assert.rejects(
    confirmInputs(task.id, { revision: task.revision, by: "用户", note: "用户复核来源候选" }, { root }),
    /必须逐项人工保留或排除/,
  );
  await assert.rejects(
    confirmInputs(task.id, { revision: task.revision, by: "Codex Agent", note: "不应自动批准" }, { root }),
    /实际人工姓名或身份/,
  );

  task = await setSources(task.id, sourceCandidates(["retained", "excluded"]), { root, expectedRevision: task.revision });
  task = await confirmInputs(task.id, { revision: task.revision, by: "用户", note: "需求和来源均由用户逐项确认" }, { root });
  await assert.rejects(setSheet(task.id, { ...sheet(3), sourceIds: ["source-2"] }, sheetWriteOptions(task, root)), /人工排除/);
  await assert.rejects(setSheet(task.id, { ...sheet(3), sourceIds: ["unknown"] }, sheetWriteOptions(task, root)), /未知来源/);
  const sourcedSheet = sheet(3);
  sourcedSheet.sourceIds = ["source-1"];
  sourcedSheet.pages[0].sourceIds = ["source-1"];
  task = await setSheet(task.id, sourcedSheet, sheetWriteOptions(task, root));
  task = await confirmSheet(task.id, { version: 1, by: "用户", note: "确认第一版三页文案与绘图指令" }, { root, expectedRevision: task.revision });
  assert.equal(task.sheetConfirmation.version, 1);
  assert.equal(task.sheets[0].inputs.brief.topic, "主题");
  assert.equal(task.sheets[0].inputs.sources[0].licenseEvidence.status, "user-provided");

  task = await setBrief(task.id, { topic: "更新后的主题" }, { root, expectedRevision: task.revision });
  assert.equal(task.inputConfirmation, null);
  assert.equal(task.sheetConfirmation, null);
  assert.equal(task.sheets.length, 1, "旧制作单作为历史保留");
  task = await confirmInputs(task.id, { revision: task.revision, by: "用户", note: "重新确认更新后的需求和来源" }, { root });
  await assert.rejects(confirmSheet(task.id, { version: 1, by: "用户", note: "尝试重确认旧版" }, { root, expectedRevision: task.revision }), /旧需求或来源/);
  task = await setSheet(task.id, sheet(3), sheetWriteOptions(task, root));
  assert.equal(task.sheetVersion, 2);
  task = await confirmSheet(task.id, { version: 2, by: "用户", note: "确认更新后的三页制作单" }, { root, expectedRevision: task.revision });
  assert.equal(task.sheets[0].version, 1);
  assert.equal(task.sheets[1].inputsRevision, task.inputConfirmation.revision);
});

test("human confirmation accepts a person whose job title contains AI", async (t) => {
  const { root } = await fixture(t);
  let task = await createTask({ title: "岗位名称确认", brief: { topic: "测试主题" } }, root);
  task = await setSources(task.id, sourceCandidates(["retained", "excluded"]), { root, expectedRevision: task.revision });
  task = await confirmInputs(task.id, {
    revision: task.revision,
    by: "张三（AI运营负责人）",
    note: "由任务参与人明确确认需求与来源",
  }, { root, expectedRevision: task.revision });
  assert.equal(task.inputConfirmation.by, "张三（AI运营负责人）");
});

test("accepts one-to-five-page sheets and rejects counts outside the supported range", async (t) => {
  const { root } = await fixture(t);
  for (const count of [1, 2, 3, 4, 5]) {
    const task = await prepareTask(root, count);
    assert.equal(task.sheets.at(-1).pages.length, count);
  }
  let task = await createTask({ title: "两页任务", brief: "brief" }, root);
  task = await setSources(task.id, [], { root, expectedRevision: task.revision });
  task = await confirmInputs(task.id, { revision: task.revision, by: "用户", note: "用户确认无来源的输入" }, { root });
  for (const count of [0, 6]) {
    await assert.rejects(setSheet(task.id, sheet(count), sheetWriteOptions(task, root)), /制作单必须包含 1 到 5 页/);
  }
});

test("withTask serializes writers and persists only explicit checkpoints after a callback fails", async (t) => {
  const { root } = await fixture(t);
  const initial = await createTask({ title: "并发锁", brief: "brief" }, root);
  let signalEntered;
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  let releaseCallback;
  const hold = new Promise((resolve) => { releaseCallback = resolve; });

  const first = withTask(initial.id, async (task, save) => {
    task.title = "已保存检查点";
    await save();
    signalEntered();
    await hold;
    task.title = "未保存变更";
    throw new Error("executor failed after checkpoint");
  }, { root, expectedRevision: initial.revision });
  await entered;
  await assert.rejects(withTask(initial.id, () => {}, { root }), (error) => error.code === "ERR_TASK_LOCKED");
  const moduleUrl = new URL("../src/creative/tasks.mjs", import.meta.url).href;
  const childCode = `import(${JSON.stringify(moduleUrl)}).then(async ({withTask}) => { try { await withTask(process.env.TASK_ID, () => {}, {root: process.env.TASK_ROOT}); process.stdout.write('ACQUIRED'); } catch (error) { process.stdout.write(error.code || 'ERROR'); } });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], {
    env: { TASK_ID: initial.id, TASK_ROOT: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { childOutput += chunk; });
  const [childExitCode] = await once(child, "close");
  assert.equal(childExitCode, 0);
  assert.equal(childOutput, "ERR_TASK_LOCKED");
  releaseCallback();
  await assert.rejects(first, /executor failed after checkpoint/);

  const saved = await readTask(initial.id, root);
  assert.equal(saved.title, "已保存检查点");
  assert.equal(saved.revision, initial.revision + 1);
  await withTask(initial.id, (task) => { task.title = "lock released"; }, { root, expectedRevision: saved.revision });
  await assert.rejects(setBrief(initial.id, "stale", { root, expectedRevision: initial.revision }), (error) => error.code === "ERR_TASK_REVISION_CONFLICT");
});

test("clears a dead lock only explicitly and refuses to clear a live owner", async (t) => {
  const { root } = await fixture(t);
  const task = await createTask({ title: "锁恢复", brief: "brief" }, root);
  const lockPath = path.join(taskDirectory(task.id, root), ".lock");
  await fs.mkdir(lockPath);
  await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: 2_000_000_000, token: "dead" }));
  assert.equal((await clearTaskLock(task.id, { root })).cleared, true);

  let signalEntered;
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  let releaseCallback;
  const hold = new Promise((resolve) => { releaseCallback = resolve; });
  const active = withTask(task.id, async () => { signalEntered(); await hold; }, { root });
  await entered;
  await assert.rejects(clearTaskLock(task.id, { root }), (error) => error.code === "ERR_TASK_LOCKED");
  releaseCallback();
  await active;
});

test("reviews must match the current image hash and final approval covers every succeeded page", async (t) => {
  const { root } = await fixture(t);
  let task = await prepareTask(root, 3);
  const imagePaths = [];
  for (let page = 1; page <= 3; page += 1) {
    const imagePath = path.join(root, `page-${page}.png`);
    await fs.writeFile(imagePath, `rendered page ${page}`);
    imagePaths.push(imagePath);
  }
  task = await setSuccessfulExecution(task, root, imagePaths);
  const firstHash = task.execution.pages[0].image.sha256;
  await fs.writeFile(imagePaths[0], "changed after rendering");
  await assert.rejects(recordReview(task.id, {
    page: 1,
    sha256: firstHash,
    decision: "pass",
    reviewer: "用户",
    notes: "核对标题、正文和小屏可读性",
  }, { root, expectedRevision: task.revision }), /文件已变化/);
  task = await setSuccessfulExecution(task, root, imagePaths);
  for (const page of task.execution.pages) {
    task = await recordReview(task.id, {
      page: page.page,
      sha256: page.image.sha256,
      decision: "pass",
      reviewer: "用户",
      notes: `实际查看第 ${page.page} 页文案、清晰度和主题对应`,
    }, { root, expectedRevision: task.revision });
  }
  task = await approveFinal(task.id, { version: task.sheetVersion, images: approvalImages(task), by: "用户", note: "所有页面已读图" }, { root, expectedRevision: task.revision });
  assert.equal(task.finalApproval.version, 1);
  assert.equal(task.finalApproval.by, "用户");
  task = await recordReview(task.id, {
    page: 1,
    sha256: task.execution.pages[0].image.sha256,
    decision: "pass",
    reviewer: "用户",
    notes: "再次实际查看当前图像并记录核对结果",
  }, { root, expectedRevision: task.revision });
  assert.equal(task.finalApproval, null, "新审核必须要求重新批准");
  task = await approveFinal(task.id, { version: 1, images: approvalImages(task), by: "用户", note: "复核后重新批准当前成品" }, { root, expectedRevision: task.revision });
  assert.equal(task.finalApproval.by, "用户");
});

test("exports verified images, exact copy, source-license evidence and a hash manifest to new directories", async (t) => {
  const { root } = await fixture(t);
  let task = await prepareTask(root, 1);
  const imagePath = path.join(root, "final.png");
  await fs.writeFile(imagePath, Buffer.from("final image bytes"));
  task = await setSuccessfulExecution(task, root, [imagePath]);
  const imageHash = task.execution.pages[0].image.sha256;
  task = await recordReview(task.id, {
    page: 1,
    sha256: imageHash,
    decision: "pass",
    reviewer: "用户",
    notes: "已实际查看，标题无错字，字号清楚，画面与主题一致",
  }, { root, expectedRevision: task.revision });
  task = await approveFinal(task.id, { version: 1, images: approvalImages(task), by: "用户", note: "确认导出版本" }, { root, expectedRevision: task.revision });

  const first = await exportTask(task.id, { root, expectedRevision: task.revision });
  const firstPath = path.join(taskDirectory(task.id, root), first.export.relativePath);
  assert.equal(first.export.version, "export-001");
  assert.equal(await fs.readFile(path.join(firstPath, "images/page-01.png"), "utf8"), "final image bytes");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(firstPath, "copy.json"), "utf8")).pages, [
    { page: 1, copy: "第 1 页准确文案" },
  ]);
  const exportedSources = JSON.parse(await fs.readFile(path.join(firstPath, "sources.json"), "utf8"));
  assert.equal(exportedSources[0].licenseEvidence.note, "用户提供；未复制原件");
  const manifest = JSON.parse(await fs.readFile(path.join(firstPath, "manifest.json"), "utf8"));
  assert.equal(manifest.images[0].sha256, imageHash);
  assert.equal(manifest.images[0].path, "images/page-01.png");
  for (const file of manifest.files) {
    const bytes = await fs.readFile(path.join(firstPath, file.path));
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }

  const { unzipSync } = await import('fflate');
  const archivePath = path.join(taskDirectory(task.id, root), first.export.archiveRelativePath);
  const archiveBytes = await fs.readFile(archivePath);
  assert.equal(crypto.createHash('sha256').update(archiveBytes).digest('hex'), first.export.archiveSha256);
  const unpacked = unzipSync(archiveBytes);
  assert.equal(Buffer.from(unpacked['images/page-01.png']).toString(), 'final image bytes');
  assert.deepEqual(JSON.parse(Buffer.from(unpacked['manifest.json']).toString()).files, manifest.files);
  const second = await exportTask(task.id, { root, expectedRevision: first.task.revision });
  assert.equal(second.export.version, "export-002");
  assert.equal(await fs.readFile(path.join(firstPath, "images/page-01.png"), "utf8"), "final image bytes");
  assert.equal((await readTask(task.id, root)).exports.length, 2);
});

test("refuses export when task content contains credential fields", async (t) => {
  const { root } = await fixture(t);
  let task = await prepareTask(root);
  await withTask(task.id, (draft) => { draft.sources[0].apiKey = "should never be exported"; }, { root, expectedRevision: task.revision });
  task = await readTask(task.id, root);
  const imagePath = path.join(root, "final.png");
  await fs.writeFile(imagePath, "final");
  task = await setSuccessfulExecution(task, root, [imagePath]);
  const page = task.execution.pages[0];
  task = await recordReview(task.id, {
    page: 1,
    sha256: page.image.sha256,
    decision: "pass",
    reviewer: "用户",
    notes: "已实际查看图片文字与构图",
  }, { root, expectedRevision: task.revision });
  task = await approveFinal(task.id, { version: 1, images: approvalImages(task), by: "用户", note: "确认导出版本" }, { root, expectedRevision: task.revision });
  await assert.rejects(exportTask(task.id, { root, expectedRevision: task.revision }), /敏感字段 apiKey/);
});
