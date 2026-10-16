import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  cleanAsset,
  confirmAsset,
  deleteAsset,
  deleteTag,
  editAsset,
  importAsset,
  listAssets,
  listTags,
  queryAssets,
  recoverClean,
  readAsset,
  renameTag,
  replaceAssetFiles,
  snapshotAsset,
} from "../src/assets/library.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "creative-assets-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root };
}

async function sourceFile(root, name, text) {
  const filePath = path.join(root, name);
  await fs.writeFile(filePath, text);
  return filePath;
}

async function imported(t, fields = {}) {
  const { root } = await fixture(t);
  const file = await sourceFile(root, "source.md", "original source text");
  const asset = await importAsset({
    title: "来源标题",
    body: "",
    source: { kind: "user-provided", note: "用户提供" },
    files: [{ path: file, name: "source.md", mimeType: "text/markdown" }],
    ...fields,
  }, { root });
  return { root, file, asset };
}

function fakeCleaner(result = {}) {
  return async ({ title, body, files }, { signal } = {}) => {
    signal?.throwIfAborted();
    return {
      title,
      body: body || "清洗正文",
      fileResults: files.map((file, index) => ({ file, text: `OCR 可检索内容 ${index + 1}` })),
      summary: "清洗摘要",
      tags: ["自由标签", "自由标签"],
      promptVersion: "test-clean-v1",
      ...result,
    };
  };
}

async function clean(asset, root, cleaner = fakeCleaner()) {
  return cleanAsset(asset.id, { root, expectedRevision: asset.revision, cleaner });
}

async function sharedTagAssets(t) {
  const { root } = await fixture(t);
  const firstSource = await sourceFile(root, "idle-source.md", "idle asset source");
  const secondSource = await sourceFile(root, "cleaning-source.md", "cleaning asset source");
  const first = await importAsset({
    title: "共享标签素材一",
    tags: ["共享标签", "保留标签"],
    files: [{ path: firstSource, name: "idle-source.md" }],
  }, { root });
  const second = await importAsset({
    title: "共享标签素材二",
    tags: ["共享标签", "保留标签"],
    files: [{ path: secondSource, name: "cleaning-source.md" }],
  }, { root });
  const itemEntries = (await fs.readdir(path.join(root, "assets", "items"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/iu.test(entry.name));
  assert.equal(itemEntries.length, 2);
  const byId = new Map([[first.id, first], [second.id, second]]);
  const idle = byId.get(itemEntries[0].name);
  const cleaning = byId.get(itemEntries[1].name);
  assert.ok(idle && cleaning, "the test must use the actual readdir order so the idle record precedes the cleaning record");
  return { root, idle, cleaning };
}

async function captureLibraryMetadataBytes(root) {
  const itemDirectory = path.join(root, "assets", "items");
  const entries = await fs.readdir(itemDirectory, { withFileTypes: true });
  const metadata = {};
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/iu.test(entry.name)) continue;
    metadata[entry.name] = await fs.readFile(path.join(itemDirectory, entry.name, "metadata.json"));
  }
  return {
    metadata,
    catalog: await fs.readFile(path.join(root, "assets", "tags.json")),
  };
}

async function verifyTagOperationDuringCleaning(t, { action, cleanerOutcome }) {
  const { root, idle, cleaning: cleaningAsset } = await sharedTagAssets(t);
  const tagState = await listTags({ root });
  const catalogPath = path.join(root, "assets", "tags.json");
  const staleCatalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
  staleCatalog.fingerprint = "0".repeat(64);
  await fs.writeFile(catalogPath, `${JSON.stringify(staleCatalog, null, 2)}\n`);
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let finish;
  const pending = new Promise((resolve, reject) => {
    finish = cleanerOutcome === "failure" ? () => reject(new Error("fake cleaner failure")) : resolve;
  });
  const cleaning = cleanAsset(cleaningAsset.id, {
    root,
    expectedRevision: cleaningAsset.revision,
    cleaner: async (input, options) => {
      markStarted();
      await pending;
      if (cleanerOutcome === "failure") throw new Error("unreachable");
      return fakeCleaner({ tags: ["共享标签", "模型初始标签"] })(input, options);
    },
  });
  await started;
  const during = await readAsset(cleaningAsset.id, { root });
  assert.equal(during.status, "cleaning");
  assert.ok(during.cleaningJob);

  const before = await captureLibraryMetadataBytes(root);
  const beforeCatalogRevision = JSON.parse(before.catalog.toString("utf8")).revision;
  const attempt = action === "rename"
    ? renameTag("共享标签", "改名标签", { root, expectedRevision: tagState.revision })
    : deleteTag("共享标签", { root, expectedRevision: tagState.revision });
  await assert.rejects(attempt, { code: "ERR_ASSET_TAG_CLEANING" });
  const after = await captureLibraryMetadataBytes(root);
  assert.deepEqual(after, before, "a rejected tag operation must not write any asset metadata or catalog bytes");
  assert.equal(JSON.parse(after.catalog.toString("utf8")).revision, beforeCatalogRevision);

  finish();
  let reviewed = await cleaning;
  if (cleanerOutcome === "failure") {
    assert.equal(reviewed.status, "clean_failed");
    assert.equal(reviewed.cleaningJob, null);
    reviewed = await cleanAsset(reviewed.id, {
      root,
      expectedRevision: reviewed.revision,
      cleaner: fakeCleaner({ tags: ["共享标签", "模型初始标签"] }),
    });
  }
  assert.equal(reviewed.status, "needs_review");
  assert.equal(reviewed.cleaningJob, null);

  const currentTags = await listTags({ root });
  assert.ok(currentTags.tags.includes("共享标签"));
  if (action === "rename") {
    await renameTag("共享标签", "改名标签", { root, expectedRevision: currentTags.revision });
  } else {
    await deleteTag("共享标签", { root, expectedRevision: currentTags.revision });
  }

  const expectedIdleTags = action === "rename" ? ["改名标签", "保留标签"] : ["保留标签"];
  const expectedCleaningTags = action === "rename" ? ["改名标签", "模型初始标签"] : ["模型初始标签"];
  const idleAfterTagChange = await readAsset(idle.id, { root });
  const cleaningAfterTagChange = await readAsset(reviewed.id, { root });
  assert.deepEqual(idleAfterTagChange.tags, expectedIdleTags);
  assert.deepEqual(cleaningAfterTagChange.tags, expectedCleaningTags);
  assert.ok(idleAfterTagChange.manualFields.includes("tags"));
  assert.ok(cleaningAfterTagChange.manualFields.includes("tags"));

  const reCleaner = fakeCleaner({ tags: ["共享标签", "AI重洗标签"] });
  for (const current of [idleAfterTagChange, cleaningAfterTagChange]) {
    const retried = await cleanAsset(current.id, {
      root,
      expectedRevision: current.revision,
      cleaner: reCleaner,
    });
    assert.equal(retried.status, "needs_review");
    assert.equal(retried.cleaningJob, null);
    assert.deepEqual(retried.tags, current.tags, "later cleaning must preserve the human tag decision");
  }
}

function waitForMarker(child, marker) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("清洗子进程未开始")), 5000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes(marker)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`清洗子进程提前退出：${code ?? signal}`));
    });
  });
}

test("imports ordered originals, deduplicates free tags, and exposes verified hashes", async (t) => {
  const { root } = await fixture(t);
  const first = await sourceFile(root, "first.png", "first bytes");
  const second = await sourceFile(root, "second.png", "second bytes");
  const asset = await importAsset({
    title: "双图素材",
    body: "人工输入正文",
    source: { kind: "user-provided", note: "两张参考图" },
    tags: [" 品牌 ", "品牌", "视觉"],
    files: [{ path: first, name: "一.png" }, { path: second, name: "二.png" }],
  }, { root });

  assert.equal(asset.status, "staged");
  assert.deepEqual(asset.tags, ["品牌", "视觉"]);
  assert.deepEqual(asset.files.map((file) => file.order), [0, 1]);
  const expected = ["first bytes", "second bytes"];
  for (const [index, file] of asset.files.entries()) {
    const originalPath = path.join(root, ...file.relativePath.split("/"));
    assert.equal(await fs.readFile(originalPath, "utf8"), expected[index]);
    assert.equal(file.sha256, crypto.createHash("sha256").update(expected[index]).digest("hex"));
  }
  assert.equal((await readAsset(asset.id, { root })).originalsVerified, true);
  assert.equal((await listAssets({ tags: ["品牌", "视觉"], tagMode: "all" }, { root })).length, 1);
  assert.equal((await listAssets({ tags: ["品牌", "缺失"], tagMode: "any" }, { root })).length, 1);
  assert.equal((await listAssets({ tags: ["品牌", "缺失"], tagMode: "all" }, { root })).length, 0);
  assert.equal((await queryAssets({}, { root })).length, 0, "默认检索只返回 confirmed 素材");
  await assert.rejects(snapshotAsset(asset.id, { root }), { code: "ERR_ASSET_SNAPSHOT_UNCONFIRMED" });
});

test("records missing cleaner configuration, then retries and indexes OCR extraction text", async (t) => {
  const { root, asset: initial } = await imported(t);
  const missing = await cleanAsset(initial.id, { root, expectedRevision: initial.revision });
  assert.equal(missing.status, "clean_config_missing");
  assert.equal(missing.lastError.code, "MODEL_NOT_CONFIGURED");
  assert.ok(missing.revision > initial.revision);

  const cleaned = await clean(missing, root, fakeCleaner({
    body: "清洗后的正文",
    fileResults: [{ file: "source.md", text: "OCR 星河校区阅读活动" }],
    summary: "家长阅读活动素材",
    tags: ["阅读", "阅读", "家长"],
  }));
  assert.equal(cleaned.status, "needs_review");
  assert.equal(cleaned.title, "来源标题", "清洗结果不能覆盖人工标题");
  assert.deepEqual(cleaned.tags, ["阅读", "家长"]);
  assert.deepEqual(cleaned.extractions, [{ file: "source.md", text: "OCR 星河校区阅读活动" }]);
  assert.equal((await queryAssets({ query: "星河校区" }, { root })).length, 0);
  const reviewSearch = await queryAssets({ query: "星河校区", confirmedOnly: false }, { root });
  assert.equal(reviewSearch.length, 1, "正文检索包含 OCR/fileResults 文本");
});

test("human corrections survive re-cleaning and must be confirmed before agent search or task snapshot", async (t) => {
  const { root, asset } = await imported(t);
  let reviewed = await clean(asset, root);
  reviewed = await editAsset(reviewed.id, {
    body: "人工校正正文",
    summary: "人工校正摘要",
    tags: ["人工标签", "人工标签"],
  }, { root, expectedRevision: reviewed.revision });
  const rerun = await clean(reviewed, root, fakeCleaner({
    body: "旧清洗正文",
    summary: "旧清洗摘要",
    tags: ["旧标签"],
  }));
  assert.equal(rerun.status, "needs_review");
  assert.equal(rerun.body, "人工校正正文");
  assert.equal(rerun.summary, "人工校正摘要");
  assert.deepEqual(rerun.tags, ["人工标签"]);
  assert.equal((await queryAssets({}, { root })).length, 0);
  await assert.rejects(confirmAsset(rerun.id, { by: "Codex Agent", note: "自动确认" }, { root, expectedRevision: rerun.revision }), /实际人工/);

  const confirmed = await confirmAsset(rerun.id, { by: "张三（AI运营负责人）", note: "已查看原件并核对正文、摘要和标签" }, { root, expectedRevision: rerun.revision });
  assert.equal(confirmed.status, "confirmed");
  const found = await queryAssets({ tags: ["人工标签"], query: "人工校正正文" }, { root });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, confirmed.id);
  const snapshot = await snapshotAsset(confirmed.id, { root });
  assert.equal(snapshot.revision, confirmed.revision);
  assert.equal(snapshot.metadata.body, "人工校正正文");
  assert.equal(snapshot.files.length, 1);
  assert.equal(snapshot.files[0].path, await fs.realpath(path.join(root, ...snapshot.files[0].relativePath.split("/"))));
  assert.equal(snapshot.files[0].sha256, confirmed.files[0].sha256);
});

test("an asynchronous clean result cannot overwrite an edit made while the cleaner is running", async (t) => {
  const { root, asset } = await imported(t);
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const cleaning = cleanAsset(asset.id, {
    root,
    expectedRevision: asset.revision,
    cleaner: async () => {
      markStarted();
      await pending;
      return { body: "过期模型正文", summary: "过期摘要", tags: ["过期标签"], fileResults: [] };
    },
  });
  await started;
  const during = await readAsset(asset.id, { root });
  const edited = await editAsset(asset.id, { body: "并发人工正文", tags: ["人工标签"] }, { root, expectedRevision: during.revision });
  finish();
  await assert.rejects(cleaning, { code: "ERR_ASSET_CLEAN_STALE" });
  const current = await readAsset(asset.id, { root });
  assert.equal(current.revision, edited.revision);
  assert.equal(current.body, "并发人工正文");
  assert.deepEqual(current.tags, ["人工标签"]);
  assert.equal(current.status, "needs_review");
});

test("cancellation and cleaner failure are visible, preserve retryability, and do not expose provider errors", async (t) => {
  const { root, asset } = await imported(t);
  const controller = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const cancelledWork = cleanAsset(asset.id, {
    root,
    expectedRevision: asset.revision,
    signal: controller.signal,
    cleaner: async () => {
      markStarted();
      await pending;
      return { body: "ignored", summary: "ignored", tags: [], fileResults: [] };
    },
  });
  await started;
  controller.abort();
  finish();
  const cancelled = await cancelledWork;
  assert.equal(cancelled.status, "clean_cancelled");
  assert.equal(cancelled.lastError.code, "ERR_ASSET_CLEAN_CANCELLED");
  assert.match(cancelled.lastError.message, /可重新清洗/u);

  const failed = await cleanAsset(asset.id, {
    root,
    expectedRevision: cancelled.revision,
    cleaner: async () => { throw new Error("provider secret=sk-proj-do-not-leak-at-all"); },
  });
  assert.equal(failed.status, "clean_failed");
  assert.equal(failed.lastError.code, "ERR_ASSET_CLEAN_FAILED");
  assert.doesNotMatch(JSON.stringify(failed), /do-not-leak/u);

  const retried = await cleanAsset(asset.id, {
    root,
    expectedRevision: failed.revision,
    cleaner: fakeCleaner(),
  });
  assert.equal(retried.status, "needs_review");
});

test("interrupted cleaning can recover only after its matching owner process exits", async (t) => {
  const { root, asset } = await imported(t);
  const libraryUrl = new URL("../src/assets/library.mjs", import.meta.url).href;
  const program = `
    import { cleanAsset } from ${JSON.stringify(libraryUrl)};
    setInterval(() => {}, 1000);
    const [root, id, expectedRevision] = process.argv.slice(1);
    await cleanAsset(id, {
      root,
      expectedRevision: Number(expectedRevision),
      cleaner: async () => {
        console.log("CLEANER_STARTED");
        await new Promise(() => {});
      },
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program, root, asset.id, String(asset.revision)], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }
  });
  await waitForMarker(child, "CLEANER_STARTED");
  const cleaning = await readAsset(asset.id, { root });
  assert.equal(cleaning.status, "cleaning");
  assert.equal(cleaning.cleaningJob.pid, child.pid);
  await assert.rejects(recoverClean(asset.id, {
    root,
    expectedRevision: cleaning.revision,
    deadPid: child.pid,
  }), { code: "ERR_ASSET_CLEAN_OWNER_ALIVE" });

  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  const recovered = await recoverClean(asset.id, {
    root,
    expectedRevision: cleaning.revision,
    deadPid: child.pid,
  });
  assert.equal(recovered.status, "clean_failed");
  assert.equal(recovered.lastError.code, "ERR_ASSET_CLEAN_INTERRUPTED");
  assert.ok(recovered.history.some((entry) => entry.action === "clean_interrupted"));

  const retried = await cleanAsset(asset.id, {
    root,
    expectedRevision: recovered.revision,
    cleaner: fakeCleaner(),
  });
  assert.equal(retried.status, "needs_review");
});

test("CLI cleaner ignores payload and legacy environment config when shared config is empty", async (t) => {
  const { root, asset } = await imported(t);
  const payloadPath = path.join(root, "clean-payload.json");
  await fs.writeFile(payloadPath, JSON.stringify({
    expectedRevision: asset.revision,
    config: { baseUrl: "https://example.invalid", model: "payload-model", apiKey: "payload-only-test-key" },
  }));
  const cliPath = fileURLToPath(new URL("../scripts/assets.mjs", import.meta.url));
  const env = {
    ...process.env,
    STUDIO_DATA_DIR: root,
    STUDIO_TEXT_BASE_URL: "http://127.0.0.1:1/v1",
    STUDIO_TEXT_MODEL: "legacy-environment-model",
    STUDIO_TEXT_API_KEY: "legacy-environment-test-key",
  };
  const result = spawnSync(process.execPath, [cliPath, "clean", asset.id, `@${payloadPath}`], {
    cwd: path.dirname(cliPath),
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "clean_config_missing");
  assert.doesNotMatch(result.stdout + result.stderr, /payload-only-test-key/u);
});

test("tag rename and deletion update asset history and confirmed snapshots without deleting materials", async (t) => {
  const { root, asset } = await imported(t);
  let reviewed = await clean(asset, root, fakeCleaner({ tags: ["旧标签"] }));
  reviewed = await editAsset(reviewed.id, { tags: ["旧标签"] }, { root, expectedRevision: reviewed.revision });
  const confirmed = await confirmAsset(reviewed.id, { by: "王老师", note: "人工确认素材内容" }, { root, expectedRevision: reviewed.revision });
  const before = await snapshotAsset(confirmed.id, { root });
  const tagState = await listTags({ root });
  const renamed = await renameTag("旧标签", "新标签", { root, expectedRevision: tagState.revision });
  assert.deepEqual(renamed.tags, ["新标签"]);
  let after = await snapshotAsset(confirmed.id, { root });
  assert.deepEqual(after.tags, ["新标签"]);
  assert.ok(after.revision > before.revision);
  let current = await readAsset(confirmed.id, { root });
  assert.ok(current.history.some((entry) => entry.action === "tag_renamed"));

  const removed = await deleteTag("新标签", { root, expectedRevision: renamed.revision });
  assert.deepEqual(removed.tags, []);
  current = await readAsset(confirmed.id, { root });
  after = await snapshotAsset(confirmed.id, { root });
  assert.equal(current.status, "confirmed");
  assert.deepEqual(after.tags, []);
  assert.ok(current.history.some((entry) => entry.action === "tag_deleted"));
  assert.equal((await queryAssets({ tags: ["新标签"] }, { root })).length, 0);
});

test("tag rename rejects pending cleaning as a whole and preserves manual tags after successful cleaning", async (t) => {
  await verifyTagOperationDuringCleaning(t, { action: "rename", cleanerOutcome: "success" });
});

test("tag rename rejects pending cleaning as a whole and permits retry after cleaner failure", async (t) => {
  await verifyTagOperationDuringCleaning(t, { action: "rename", cleanerOutcome: "failure" });
});

test("tag deletion rejects pending cleaning as a whole and preserves manual tags after successful cleaning", async (t) => {
  await verifyTagOperationDuringCleaning(t, { action: "delete", cleanerOutcome: "success" });
});

test("tag deletion rejects pending cleaning as a whole and permits retry after cleaner failure", async (t) => {
  await verifyTagOperationDuringCleaning(t, { action: "delete", cleanerOutcome: "failure" });
});

test("replacing ordered originals keeps old files and returns the asset to staging", async (t) => {
  const { root, asset } = await imported(t);
  const reviewed = await clean(asset, root);
  const confirmed = await confirmAsset(reviewed.id, { by: "周老师", note: "确认初始版本" }, { root, expectedRevision: reviewed.revision });
  const oldPath = path.join(root, ...confirmed.files[0].relativePath.split("/"));
  const first = await sourceFile(root, "new-1.png", "new one");
  const second = await sourceFile(root, "new-2.png", "new two");
  const replaced = await replaceAssetFiles(confirmed.id, [{ path: first, name: "新一.png" }, { path: second, name: "新二.png" }], {
    root,
    expectedRevision: confirmed.revision,
  });

  assert.equal(replaced.status, "staged");
  assert.equal(replaced.confirmation, null);
  assert.deepEqual(replaced.files.map((file) => file.order), [0, 1]);
  assert.deepEqual(await Promise.all(replaced.files.map((file) => fs.readFile(path.join(root, ...file.relativePath.split("/")), "utf8"))), ["new one", "new two"]);
  assert.equal(await fs.readFile(oldPath, "utf8"), "original source text");
  assert.ok(replaced.history.some((entry) => entry.action === "original_files_replaced"));
  assert.equal(replaced.extractions.length, 0);
});

test("soft deletion hides the asset from default lists while preserving its originals", async (t) => {
  const { root, asset } = await imported(t);
  const filePath = path.join(root, ...asset.files[0].relativePath.split("/"));
  const deleted = await deleteAsset(asset.id, { root, expectedRevision: asset.revision });
  assert.equal(deleted.status, "deleted");
  assert.equal((await listAssets({}, { root })).length, 0);
  assert.equal((await listAssets({ includeDeleted: true }, { root })).length, 1);
  assert.equal((await readAsset(asset.id, { root })).status, "deleted");
  assert.equal(await fs.readFile(filePath, "utf8"), "original source text");
  await assert.rejects(snapshotAsset(asset.id, { root }), { code: "ERR_ASSET_DELETED" });
});

test("rejects stale revisions and detects changed original bytes", async (t) => {
  const { root, asset } = await imported(t);
  const edited = await editAsset(asset.id, { body: "更新正文" }, { root, expectedRevision: asset.revision });
  await assert.rejects(editAsset(asset.id, { body: "stale" }, { root, expectedRevision: asset.revision }), { code: "ERR_ASSET_REVISION_CONFLICT" });
  const original = path.join(root, ...edited.files[0].relativePath.split("/"));
  await fs.writeFile(original, "modified bytes");
  await assert.rejects(readAsset(asset.id, { root }), { code: "ERR_ASSET_FILE_HASH" });
});

test("refuses credential-bearing source files without echoing their value", async (t) => {
  const { root } = await fixture(t);
  const file = await sourceFile(root, "notes.txt", "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx");
  await assert.rejects(importAsset({ title: "凭据", files: [{ path: file }] }, { root }), { code: "ERR_ASSET_CREDENTIAL_DETECTED" });
});
