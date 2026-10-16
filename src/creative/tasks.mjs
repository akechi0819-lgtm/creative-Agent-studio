import crypto from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { dataRoot } from "../canvas/client.mjs";
import { zipSync } from "fflate";
import { readDna, dnaSnapshot } from "../dna/profile.mjs";
import { assertTaskEntryAccess } from "./entry.mjs";
import { snapshotAsset } from "../assets/library.mjs";
import { latestReviewForSnapshot } from "./reviews.mjs";

const SECRET_FIELD = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|authorization|bearer)/i;
const CREDENTIAL_TEXT = /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}|\bsk-[A-Za-z0-9_-]{20,}/i;
const NON_HUMAN_ACTOR = /^(?:(?:codex|dsh)(?:[\s_-]+(?:agent|assistant|bot))?|(?:ai|agent|assistant|model)(?:[\s_-]+(?:agent|assistant|bot|model))?|(?:ai|agent|assistant|model)(?:模型|机器人|智能体)|模型|自动|机器人|智能体)$/iu;
const MAX_PAGE_REFERENCE_IMAGES = 12;

export { dataRoot };

export class TaskLockError extends Error {
  constructor(taskId, owner = null) {
    super(`任务 ${taskId} 正由另一个进程持有写锁`);
    this.name = "TaskLockError";
    this.code = "ERR_TASK_LOCKED";
    this.taskId = taskId;
    this.owner = owner;
  }
}

export class TaskRevisionConflictError extends Error {
  constructor(expected, actual) {
    super(`任务版本冲突：期望 revision ${expected}，当前为 ${actual}`);
    this.name = "TaskRevisionConflictError";
    this.code = "ERR_TASK_REVISION_CONFLICT";
    this.expectedRevision = expected;
    this.actualRevision = actual;
  }
}

export function requiredRevision(opts = {}) {
  const revision = opts?.expectedRevision;
  if (!Number.isInteger(revision) || revision < 1) {
    const error = new Error("状态变更必须指定正整数 expectedRevision");
    error.code = "ERR_TASK_REVISION_REQUIRED";
    throw error;
  }
  return revision;
}

/** Fingerprint user-controlled inputs for an uploaded-image-only edit authorization. */
export function taskInputFingerprint(task) {
  const value = JSON.stringify({ brief: task?.brief, sources: task?.sources || [], dna: task?.dna ?? null });
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requiredInputRevision(opts = {}) {
  const revision = opts?.inputRevision;
  if (!Number.isInteger(revision) || revision < 1) {
    const error = new Error("制作单写入必须指定准备时读取的 inputRevision");
    error.code = "ERR_TASK_INPUT_CONFLICT";
    throw error;
  }
  return revision;
}

function rootPath(root) {
  if (root == null) return dataRoot();
  if (typeof root !== "string" || !root.trim()) throw new Error("数据根目录必须是非空路径");
  return path.resolve(root);
}

function safeTaskId(value) {
  const id = String(value ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("taskId 必须是 UUID");
  }
  return id;
}

export function taskDirectory(id, root) {
  return path.join(rootPath(root), "tasks", safeTaskId(id));
}

function taskFile(id, root) {
  return path.join(taskDirectory(id, root), "task.json");
}

function requiredText(value, label, maxLength = 10000) {
  if (typeof value !== "string") throw new Error(`${label}必须是文本`);
  const result = value.trim();
  if (!result) throw new Error(`${label}不能为空`);
  if (result.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return result;
}

function cloneJson(value, label = "任务数据") {
  let encoded;
  try {
    encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("没有 JSON 表示");
    return JSON.parse(encoded);
  } catch (error) {
    throw new Error(`${label}必须是可保存的 JSON 数据`, { cause: error });
  }
}

function normalizeBrief(brief) {
  const value = cloneJson(brief, "制作需求");
  if (typeof value === "string") return requiredText(value, "制作需求", 20000);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new Error("制作需求必须是非空文本或对象");
  }
  return value;
}

function validateSources(sources) {
  if (!Array.isArray(sources)) throw new Error("来源必须是候选数组");
  const ids = new Set();
  const uploadIds = new Set();
  return sources.map((source, index) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error(`来源候选 ${index + 1} 必须是对象`);
    }
    const value = cloneJson(source, `来源候选 ${index + 1}`);
    const id = requiredText(String(value.id ?? value.sourceId ?? value.documentId ?? value.document_id ?? ""), `来源候选 ${index + 1} ID`, 300);
    if (ids.has(id)) throw new Error(`来源候选 ID 重复：${id}`);
    ids.add(id);
    const decision = value.decision ?? "pending";
    if (!new Set(["pending", "retained", "excluded"]).has(decision)) {
      throw new Error(`来源 ${id} 的 decision 必须是 pending、retained 或 excluded`);
    }
    if (value.uploadId !== undefined || value.uploadFingerprint !== undefined || value.uploadRevision !== undefined) {
      if (value.type !== "current_attachment"
        || typeof value.uploadId !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.uploadId)
        || typeof value.uploadFingerprint !== "string"
        || !/^[0-9a-f]{64}$/i.test(value.uploadFingerprint)
        || !Number.isInteger(value.uploadRevision)
        || value.uploadRevision < 1) {
        throw new Error(`来源 ${id} 的附件上传幂等记录无效`);
      }
      if (uploadIds.has(value.uploadId)) throw new Error(`附件上传 ID 重复：${value.uploadId}`);
      uploadIds.add(value.uploadId);
    }
    return { ...value, id, decision };
  });
}

function normalizeSheet(sheet) {
  if (!sheet || typeof sheet !== "object" || Array.isArray(sheet)) throw new Error("制作单必须是对象");
  const value = cloneJson(sheet, "制作单");
  const title = requiredText(value.title, "制作单标题", 500);
  if (!Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 5) {
    throw new Error("制作单必须包含 1 到 5 页");
  }
  const sourceIds = normalizeSourceIds(value.sourceIds, "制作单来源 ID");
  const pages = value.pages.map((page, index) => {
    if (!page || typeof page !== "object" || Array.isArray(page)) throw new Error(`制作单第 ${index + 1} 页必须是对象`);
    const number = page.page;
    if (!Number.isInteger(number) || number !== index + 1) throw new Error("制作单页码必须从 1 开始连续排列");
    return {
      page: number,
      copy: requiredText(page.copy, `第 ${number} 页准确文案`, 20000),
      prompt: requiredText(page.prompt, `第 ${number} 页绘图指令`, 20000),
      size: requiredText(page.size, `第 ${number} 页尺寸`, 40),
      sourceIds: normalizeSourceIds(page.sourceIds, `第 ${number} 页来源 ID`),
      referenceImages: normalizeReferenceImages(page.referenceImages, `第 ${number} 页参考图片`),
    };
  });
  return { ...value, title, sourceIds, pages };
}

function normalizeReferenceImages(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  if (value.length > MAX_PAGE_REFERENCE_IMAGES) throw new Error(`${label}每页最多 ${MAX_PAGE_REFERENCE_IMAGES} 张`);
  const seen = new Set();
  return value.map((reference, index) => {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) throw new Error(`${label}第 ${index + 1} 项必须是对象`);
    const sourceId = requiredText(reference.sourceId, `${label}来源 ID`, 300);
    if (!Number.isInteger(reference.fileOrder) || reference.fileOrder < 1) throw new Error(`${label}附件顺序必须是正整数`);
    const key = `${sourceId}\u0000${reference.fileOrder}`;
    if (seen.has(key)) throw new Error(`${label}不能重复引用同一附件`);
    seen.add(key);
    return { sourceId, fileOrder: reference.fileOrder };
  });
}

function normalizeSourceIds(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  const ids = value.map((id) => requiredText(id, label, 300));
  if (new Set(ids).size !== ids.length) throw new Error(`${label}不能重复`);
  return ids;
}

function assertRetainedSourcesReferenced(ids, sources, label) {
  const byId = new Map(sources.map((source) => [source.id, source]));
  for (const id of ids) {
    const source = byId.get(id);
    if (!source) throw new Error(`${label}引用了未知来源：${id}`);
    if (source.decision !== "retained") throw new Error(`${label}引用了人工排除或尚未确认的来源：${id}`);
  }
}

function humanActor(value, label) {
  const actor = requiredText(value, label, 300);
  if (NON_HUMAN_ACTOR.test(actor)) throw new Error(`${label}必须记录实际人工姓名或身份`);
  return actor;
}

function normalizeConfirmationNote(value, label) {
  return requiredText(value, label, 3000);
}

function now() {
  return new Date().toISOString();
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      const missing = new Error(`${label}不存在`, { cause: error });
      missing.code = "ERR_TASK_NOT_FOUND";
      throw missing;
    }
    if (error instanceof SyntaxError) throw new Error(`${label}不是有效 JSON`, { cause: error });
    throw error;
  }
}

function lockDirectory(id, root) {
  return path.join(taskDirectory(id, root), ".lock");
}

async function readLockOwner(lockPath) {
  try {
    return await readJson(path.join(lockPath, "owner.json"), "任务锁所有者");
  } catch (error) {
    if (error.code === "ERR_TASK_NOT_FOUND") return null;
    throw error;
  }
}

async function isLockDirectory(lockPath) {
  try {
    return (await fs.lstat(lockPath)).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function acquireTaskLock(id, root) {
  const directory = taskDirectory(id, root);
  const lockPath = path.join(directory, ".lock");
  const staging = path.join(directory, `.lock-pending-${crypto.randomUUID()}`);
  const owner = { pid: process.pid, token: crypto.randomUUID(), acquiredAt: now() };
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    await atomicWriteJson(path.join(staging, "owner.json"), owner);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  try {
    await fs.rename(staging, lockPath);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (["EEXIST", "ENOTEMPTY"].includes(error.code)) {
      throw new TaskLockError(id, await readLockOwner(lockPath));
    }
    if (error.code === "EPERM" && await isLockDirectory(lockPath)) {
      throw new TaskLockError(id, await readLockOwner(lockPath));
    }
    throw error;
  }
  return { lockPath, owner };
}

async function releaseTaskLock(id, lock) {
  const owner = await readLockOwner(lock.lockPath);
  if (!owner || owner.token !== lock.owner.token) return;
  const retired = path.join(path.dirname(lock.lockPath), `.lock-released-${lock.owner.token}`);
  await fs.rename(lock.lockPath, retired);
  await fs.rm(retired, { recursive: true, force: true });
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Explicitly remove a lock only after its recorded owner process has exited. */
export async function clearTaskLock(id, { root } = {}) {
  safeTaskId(id);
  const lockPath = lockDirectory(id, root);
  const owner = await readLockOwner(lockPath);
  if (!owner) {
    try {
      await fs.access(lockPath);
      throw new Error("任务锁缺少 owner.json，无法安全判断是否已死亡");
    } catch (error) {
      if (error.code === "ENOENT") return { cleared: false };
      throw error;
    }
  }
  if (isProcessAlive(owner.pid)) throw new TaskLockError(id, owner);
  const current = await readLockOwner(lockPath);
  if (!current || current.token !== owner.token || current.pid !== owner.pid) {
    throw new Error("任务锁所有者在清理期间发生变化；未删除");
  }
  const retired = path.join(path.dirname(lockPath), `.lock-cleared-${crypto.randomUUID()}`);
  await fs.rename(lockPath, retired);
  await fs.rm(retired, { recursive: true, force: true });
  return { cleared: true, owner };
}

export async function createTask({ title, brief }, root) {
  const taskTitle = requiredText(title, "任务标题", 500);
  const taskBrief = normalizeBrief(brief);
  const id = crypto.randomUUID();
  const directory = taskDirectory(id, root);
  await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  const timestamp = now();
  const task = {
    schemaVersion: 1,
    id,
    title: taskTitle,
    brief: taskBrief,
    sources: [],
    dna: dnaSnapshot(await readDna({root})),
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    inputConfirmation: null,
    sheetVersion: 0,
    sheetInputsRevision: null,
    sheets: [],
    sheetConfirmation: null,
    execution: { version: null, status: "pending", pages: [] },
    executionHistory: [],
    reviews: [],
    reviewHistory: [],
    finalApproval: null,
    exports: [],
  };
  await atomicWriteJson(path.join(directory, "task.json"), task);
  return cloneJson(task);
}

export async function readTask(id, root) {
  const task = await readJson(taskFile(id, root), `任务 ${id}`);
  if (task?.schemaVersion !== 1 || task?.id !== safeTaskId(id) || !Number.isInteger(task.revision)) {
    throw new Error(`任务 ${id} 的结构或版本无效`);
  }
  return cloneJson(task);
}

/**
 * Run a serialized task transaction. Call save() to persist checkpoints while
 * long-running work is in progress; successful callbacks also save their final
 * state. If the callback throws, only explicit checkpoints are retained.
 */
export async function withTask(id, fn, { root, expectedRevision } = {}) {
  safeTaskId(id);
  if (typeof fn !== "function") throw new Error("withTask 需要回调函数");
  const directory = taskDirectory(id, root);
  await assertTaskEntryAccess(id, root);
  const lock = await acquireTaskLock(id, root);
  const filePath = path.join(directory, "task.json");
  let task;
  let persisted;
  let saveQueue = Promise.resolve();
  let saveError = null;
  try {
    await assertTaskEntryAccess(id, root);
    task = await readTask(id, root);
    if (expectedRevision != null && task.revision !== expectedRevision) {
      throw new TaskRevisionConflictError(expectedRevision, task.revision);
    }
    persisted = cloneJson(task);

    const save = () => {
      const snapshot = cloneJson(task);
      const operation = saveQueue.then(async () => {
        if (snapshot.id !== id || snapshot.schemaVersion !== 1) throw new Error("任务 ID 或 schemaVersion 不可在事务中更改");
        if (snapshot.revision !== persisted.revision) {
          throw new TaskRevisionConflictError(persisted.revision, snapshot.revision);
        }
        const diskTask = await readTask(id, root);
        if (diskTask.revision !== persisted.revision) {
          throw new TaskRevisionConflictError(persisted.revision, diskTask.revision);
        }
        const comparable = cloneJson(snapshot);
        comparable.revision = persisted.revision;
        comparable.updatedAt = persisted.updatedAt;
        if (JSON.stringify(comparable) === JSON.stringify(persisted)) return cloneJson(persisted);
        const next = { ...snapshot, revision: persisted.revision + 1, updatedAt: now() };
        await atomicWriteJson(filePath, next);
        persisted = cloneJson(next);
        task.revision = next.revision;
        task.updatedAt = next.updatedAt;
        return cloneJson(next);
      });
      saveQueue = operation.then(() => { saveError = null; }, (error) => { saveError = error; });
      return operation;
    };

    try {
      await fn(task, save);
    } catch (error) {
      await saveQueue;
      throw error;
    }
    await saveQueue;
    if (saveError) throw saveError;
    await save();
    return cloneJson(task);
  } finally {
    await releaseTaskLock(id, lock);
  }
}

function checkInputsConfirmed(task) {
  if (!task.inputConfirmation) throw new Error("需求和来源尚未完成人工确认");
  if (task.sources.some((source) => !["retained", "excluded"].includes(source.decision))) {
    throw new Error("来源候选必须逐项人工保留或排除后，才能确认需求和来源");
  }
}

function invalidateForInputChange(task) {
  preserveExecution(task);
  preserveReviews(task);
  task.inputConfirmation = null;
  task.sheetConfirmation = null;
  task.execution = { version: null, status: "pending", pages: [] };
  task.reviews = [];
  task.finalApproval = null;
}

function preserveExecution(task) {
  if (task.execution.pages.length) task.executionHistory.push(cloneJson(task.execution));
}

function preserveReviews(task) {
  if (!Array.isArray(task.reviews) || task.reviews.length === 0) return;
  task.reviewHistory ||= [];
  task.reviewHistory.push(...task.reviews.map((review) => cloneJson(review)));
}

export async function setBrief(id, brief, opts = {}) {
  const expectedRevision = requiredRevision(opts);
  const value = normalizeBrief(brief);
  return withTask(id, (task) => {
    task.brief = value;
    invalidateForInputChange(task);
  }, { ...opts, expectedRevision });
}

export async function setSources(id, sources, opts = {}) {
  const expectedRevision = requiredRevision(opts);
  const value = validateSources(sources);
  return withTask(id, (task) => {
    task.sources = value;
    invalidateForInputChange(task);
  }, { ...opts, expectedRevision });
}

/** Freeze confirmed library files into this task before any input approval. */
async function freezeAssetSources(id, selections, root) {
  if (!Array.isArray(selections)) throw new Error("素材来源必须是数组");
    const snapshots = [];
    const seen = new Set();
    for (const selection of selections) {
      if (!selection || !Number.isInteger(selection.assetRevision) || selection.assetRevision < 1) throw new Error("必须指定查看过的素材版本");
      const asset = await snapshotAsset(selection.assetId, {root:root});
      if (asset.revision !== selection.assetRevision) throw new Error("素材版本已变化，请重新查看");
      if (seen.has(asset.id)) throw new Error("素材来源重复");
      seen.add(asset.id);
      const decision = selection.decision ?? "pending";
      if (!["pending", "retained", "excluded"].includes(decision)) throw new Error("素材选择状态无效");
      const purpose = requiredText(selection.purpose, "借鉴用途", 2000);
      const factBoundary = requiredText(selection.factBoundary, "事实边界", 4000);
      const files = [];
      for (const [index, file] of asset.files.entries()) {
        const extension = imageExtension(file.path);
        const relativePath = `sources/${asset.id}/r${asset.revision}/${index + 1}-${file.sha256}${extension}`;
        const destination = path.join(taskDirectory(id, root), relativePath);
        await fs.mkdir(path.dirname(destination), {recursive:true, mode:0o700});
        try { await fs.copyFile(file.path, destination, fsConstants.COPYFILE_EXCL); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
        if (await hashFile(destination) !== file.sha256) throw new Error("素材复制后哈希不一致");
        files.push({order:index + 1, name:file.name, relativePath, sha256:file.sha256});
      }
      snapshots.push({id:asset.id, title:asset.title, decision, purpose, factBoundary,
        asset:{id:asset.id, revision:asset.revision, confirmedAt:asset.confirmedAt},
        body:asset.body, summary:asset.summary, tags:asset.tags, source:asset.source,
        extractions:cloneJson(asset.metadata?.extractions ?? []), files});
    }
  return snapshots;
}

export async function setAssetSources(id, selections, opts = {}) {
  const expectedRevision = requiredRevision(opts);
  return withTask(id, async task => {
    task.sources = validateSources(await freezeAssetSources(id, selections, opts.root));
    invalidateForInputChange(task);
  }, {...opts, expectedRevision});
}

/** Atomic mixed reference decisions. Existing snapshots are resolved on the trusted side. */
export async function setReferences(id, items, opts = {}) {
  const expectedRevision = requiredRevision(opts);
  if (!Array.isArray(items)) throw new Error("参考清单必须为数组");
  return withTask(id, async task => {
    const result = [];
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("参考项无效");
      const decision = item.decision ?? "pending";
      if (!["pending","retained","excluded"].includes(decision)) throw new Error("参考决定无效");
      const purpose = requiredText(item.purpose, "借鉴用途", 2000);
      const factBoundary = requiredText(item.factBoundary, "事实边界", 4000);
      if (item.kind === "existing") {
        const current = task.sources.find(source => source.id === item.id);
        if (!current) throw new Error("当前任务不存在该参考，请重新查看");
        result.push({...cloneJson(current),decision,purpose,factBoundary});
      } else if (item.kind === "asset") {
        result.push(...await freezeAssetSources(id,[{assetId:item.assetId,assetRevision:item.assetRevision,decision,purpose,factBoundary}],opts.root));
      } else if (item.kind === "external") {
        if (item.files != null || item.path != null || item.relativePath != null) throw new Error("外部参考不能提供本地文件路径");
        const title = requiredText(item.title,"参考标题",500);
        const body = item.body == null ? "" : requiredText(item.body,"参考内容",20000);
        const url = item.url == null || item.url === "" ? "" : requiredText(item.url,"参考链接",2000);
        if (!body && !url) throw new Error("外部参考须提供正文或链接");
        if (url) { const parsed=new URL(url); if(!["http:","https:"].includes(parsed.protocol)||parsed.username||parsed.password)throw new Error("外部参考链接无效"); }
        result.push({id:item.id ?? crypto.randomUUID(),title,body,url,decision,purpose,factBoundary,type:"external",files:[]});
      } else throw new Error("参考类型无效");
    }
    assertNoCredentials(result);
    task.sources = validateSources(result);
    invalidateForInputChange(task);
  },{...opts,expectedRevision});
}

/** User uploads are task-owned current material, never automatically confirmed or added to the library. */
export async function attachTaskFiles(id, {files,title="当前资料",purpose="用户本次上传的当前资料",factBoundary="仅依照原件与用户确认使用，提取内容待人工核对",extractions=[],uploadId,uploadFingerprint}, opts={}) {
  const expectedRevision=requiredRevision(opts);
  if(!Array.isArray(files)||files.length<1||files.length>20)throw new Error("附件数量须为1—20");
  if ((uploadId !== undefined || uploadFingerprint !== undefined)
    && (typeof uploadId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uploadId)
      || typeof uploadFingerprint !== "string"
      || !/^[0-9a-f]{64}$/i.test(uploadFingerprint))) {
    throw new Error("附件上传幂等记录无效");
  }
  const sourceId=crypto.randomUUID();
  const destination=path.join(taskDirectory(id,opts.root),"sources",sourceId);
  try {
    return await withTask(id,async task=>{
      const saved=[];
      for(const [index,file] of files.entries()) {
        if(typeof file.path!=="string"||typeof file.name!=="string")throw new Error("附件文件无效");
        const extension=path.extname(file.name).toLowerCase();
        if(!new Set([".png",".jpg",".jpeg",".webp",".bmp",".pdf",".txt",".md"]).has(extension))throw new Error("附件格式不支持");
        const stat=await fs.lstat(file.path);
        if(!stat.isFile()||stat.size>100*1024*1024)throw new Error("附件须为100MB以内的普通文件");
        const bytes=await fs.readFile(file.path);
        if(CREDENTIAL_TEXT.test(bytes.toString("utf8")))throw new Error("附件疑似包含凭据，拒绝写入任务");
        const sha256=crypto.createHash("sha256").update(bytes).digest("hex");
        const relativePath=`sources/${sourceId}/${index+1}-${sha256}${extension}`;
        await fs.mkdir(destination,{recursive:true,mode:0o700});
        await fs.writeFile(path.join(taskDirectory(id,opts.root),relativePath),bytes,{flag:"wx",mode:0o600});
        saved.push({order:index+1,name:path.basename(file.name),relativePath,sha256,mimeType:file.mimeType??"application/octet-stream"});
      }
      const safeExtractions=cloneJson(extractions,"附件提取记录");
      assertNoCredentials(safeExtractions);
      task.sources=validateSources([...task.sources,{id:sourceId,title:requiredText(title,"附件标题",500),type:"current_attachment",purpose:requiredText(purpose,"资料用途",2000),factBoundary:requiredText(factBoundary,"事实边界",4000),decision:"pending",files:saved,extractions:safeExtractions,...(uploadId === undefined ? {} : {uploadId,uploadFingerprint,uploadRevision:task.revision+1})}]);
      invalidateForInputChange(task);
    },{...opts,expectedRevision});
  } catch(error) { await fs.rm(destination,{recursive:true,force:true});throw error; }
}

/** Explicit application of the current profile invalidates confirmed task inputs. */
export async function applyDna(id, {dnaRevision} = {}, opts = {}) {
  const expectedRevision = requiredRevision(opts);
  if (!Number.isInteger(dnaRevision) || dnaRevision < 1) throw new Error("必须指定查看过的 DNA 版本");
  return withTask(id, async task => {
    const profile = await readDna({root: opts.root});
    if (profile.revision !== dnaRevision) throw new Error("DNA 版本已变化，请重新查看");
    task.dna = dnaSnapshot(profile);
    invalidateForInputChange(task);
  }, {...opts, expectedRevision});
}

export async function confirmInputs(id, { revision, by, note = "" } = {}, opts = {}) {
  if (!Number.isInteger(revision) || revision < 1) throw new Error("需求与来源确认必须指定当前 revision");
  const confirmer = humanActor(by, "确认人");
  const confirmation = normalizeConfirmationNote(note, "需求与来源确认说明");
  return withTask(id, (task) => {
    if (task.revision !== revision) throw new TaskRevisionConflictError(revision, task.revision);
    if (opts.expectedRevision != null && opts.expectedRevision !== revision) {
      throw new TaskRevisionConflictError(opts.expectedRevision, revision);
    }
    if (!task.brief) throw new Error("任务缺少制作需求");
    if (task.sources.some((source) => !["retained", "excluded"].includes(source.decision))) {
      throw new Error("来源候选必须逐项人工保留或排除后，才能确认需求和来源");
    }
    task.inputConfirmation = { revision, by: confirmer, note: confirmation, confirmedAt: now() };
  }, { ...opts, expectedRevision: opts.expectedRevision ?? revision });
}

export async function setSheet(id, sheet, opts = {}) {
  const expectedRevision = requiredRevision(opts);
  const inputRevision = requiredInputRevision(opts);
  const value = normalizeSheet(sheet);
  return withTask(id, async (task) => {
    checkInputsConfirmed(task);
    if (task.inputConfirmation.revision !== inputRevision) {
      const error = new Error(`制作单准备时的需求确认 revision ${inputRevision} 已过期；当前为 ${task.inputConfirmation.revision}`);
      error.code = "ERR_TASK_INPUT_CONFLICT";
      error.expectedInputRevision = inputRevision;
      error.actualInputRevision = task.inputConfirmation.revision;
      throw error;
    }
    assertRetainedSourcesReferenced(value.sourceIds, task.sources, "制作单");
    for (const page of value.pages) {
      assertRetainedSourcesReferenced(page.sourceIds, task.sources, `第 ${page.page} 页`);
      for (const reference of page.referenceImages) {
        if (!value.sourceIds.includes(reference.sourceId)) throw new Error(`第 ${page.page} 页参考图片来源 ${reference.sourceId} 不在制作单来源范围内`);
        if (!page.sourceIds.includes(reference.sourceId)) throw new Error(`第 ${page.page} 页参考图片来源 ${reference.sourceId} 不在本页来源范围内`);
        await readTaskReferenceImageBytes(id, reference.sourceId, reference.fileOrder, {sources: task.sources, root: opts.root});
      }
    }
    const version = task.sheetVersion + 1;
    const record = {
      version,
      title: value.title,
      sourceIds: value.sourceIds,
      pages: value.pages,
      inputsRevision: task.inputConfirmation.revision,
      inputs: {
        brief: cloneJson(task.brief),
        sources: cloneJson(task.sources),
        confirmation: cloneJson(task.inputConfirmation),
        dna: cloneJson(task.dna ?? {revision: 1, enabled: false, content: "", savedAt: null}),
      },
      createdAt: now(),
    };
    task.sheetVersion = version;
    task.sheetInputsRevision = task.inputConfirmation.revision;
    task.sheets.push(record);
    task.sheetConfirmation = null;
    preserveExecution(task);
    preserveReviews(task);
    task.execution = { version, status: "pending", pages: [] };
    task.reviews = [];
    task.finalApproval = null;
  }, { ...opts, expectedRevision });
}

export async function confirmSheet(id, { version, by, note = "" } = {}, opts = {}) {
  const expectedRevision = requiredRevision(opts);
  if (!Number.isInteger(version) || version < 1) throw new Error("制作单确认必须指定版本号");
  const confirmer = humanActor(by, "确认人");
  const confirmation = normalizeConfirmationNote(note, "制作单确认说明");
  return withTask(id, (task) => {
    checkInputsConfirmed(task);
    if (version !== task.sheetVersion || !task.sheets.some((sheet) => sheet.version === version)) {
      throw new Error(`只能确认当前制作单版本 ${task.sheetVersion}`);
    }
    if (task.sheetInputsRevision !== task.inputConfirmation.revision) {
      throw new Error("制作单基于旧需求或来源，必须生成新版本后才能确认");
    }
    task.sheetConfirmation = { version, by: confirmer, note: confirmation, confirmedAt: now() };
  }, { ...opts, expectedRevision });
}

function currentSheet(task, version = task.sheetVersion) {
  if (!isSheetAuthorized(task, version)) throw new Error("当前制作单版本尚未获得有效执行授权");
  const sheet = task.sheets.find((entry) => entry.version === version);
  if (!sheet) throw new Error(`缺少制作单版本 ${version}`);
  if (sheet.pageEdit?.basis?.kind !== "uploaded-images") {
    checkInputsConfirmed(task);
    if (task.sheetInputsRevision !== task.inputConfirmation.revision) throw new Error("当前制作单不属于已确认的需求和来源版本");
  }
  return sheet;
}

function findExecution(task, version) {
  if (task.execution?.version === version) return task.execution;
  return [...(task.executionHistory || [])].reverse().find((entry) => entry.version === version) || null;
}

function isCompleteSuccessfulExecution(task, version) {
  const sheet = task.sheets.find((entry) => entry.version === version);
  const execution = findExecution(task, version);
  if (!sheet || !execution || execution.status !== "succeeded" || execution.version !== version) return false;
  if (!Array.isArray(execution.pages) || execution.pages.length !== sheet.pages.length) return false;
  return sheet.pages.every((expected) => {
    const actual = execution.pages.find((page) => page.page === expected.page);
    return actual?.status === "succeeded" && typeof actual.image?.path === "string" && /^[0-9a-f]{64}$/i.test(actual.image.sha256 || "");
  });
}

function hasSuccessfulPage(task, version) {
  const execution = findExecution(task, version);
  return execution?.pages?.some((page) => page.status === "succeeded"
    && typeof page.image?.path === "string" && /^[0-9a-f]{64}$/i.test(page.image.sha256 || "")) === true;
}

function isUploadedLineageSheet(task, version, fingerprint, expectedBasis = null, seen = new Set()) {
  if (!Number.isInteger(version) || version < 1 || seen.has(version)) return false;
  seen.add(version);
  const sheet = task.sheets?.find((entry) => entry.version === version);
  const edit = sheet?.pageEdit;
  const basis = edit?.basis;
  if (sheet?.kind !== "page-edit" || edit.version !== version || basis?.kind !== "uploaded-images"
    || basis.inputFingerprint !== fingerprint || !Array.isArray(basis.uploadedImages) || basis.uploadedImages.length < 1
    || !Number.isInteger(basis.originVersion) || basis.originVersion < 1 || basis.originVersion > version) return false;
  if (expectedBasis && (basis.originVersion !== expectedBasis.originVersion
    || JSON.stringify(basis.uploadedImages) !== JSON.stringify(expectedBasis.uploadedImages))) return false;
  const sources = new Map((task.sources || []).map((source) => [source.id, source]));
  for (const reference of basis.uploadedImages) {
    const source = sources.get(reference.sourceId);
    if (!source || source.type !== "current_attachment" || source.decision === "excluded") return false;
    const file = source.files?.find((entry) => entry.order === reference.fileOrder);
    if (!file || String(file.sha256).toLowerCase() !== reference.sha256) return false;
  }
  const sourceVersion = edit.baselineEvidence?.sourceVersion;
  if (sourceVersion == null) {
    return edit.baselineEvidence?.basis === "uploaded-image-input"
      && version === basis.originVersion
      && edit.mode === "uploaded-images";
  }
  return version > basis.originVersion && Number.isInteger(sourceVersion) && sourceVersion >= basis.originVersion && sourceVersion < version
    && edit.baselineEvidence?.basis === "successful-uploaded-image-edit"
    && isUploadedLineageSheet(task, sourceVersion, fingerprint, expectedBasis || basis, seen)
    && hasSuccessfulPage(task, sourceVersion);
}

/** A derived page edit has chat authorization, not a fabricated full-sheet human confirmation. */
export function isSheetAuthorized(task, version = task?.sheetVersion) {
  if (!task || !Number.isInteger(version) || version < 1 || task.sheetVersion !== version) return false;
  const sheet = task.sheets?.find((entry) => entry.version === version);
  if (!sheet) return false;
  if (task.sheetConfirmation?.version === version && sheet.kind !== "page-edit") return true;
  if (sheet.kind !== "page-edit" || sheet.pageEdit?.version !== version) return false;
  const edit = sheet.pageEdit;
  const chatEdit = edit.chatEdit;
  const restore = edit.restore;
  const validAuthorization = chatEdit?.kind === "chat-edit"
    ? typeof chatEdit.requestId === "string" && chatEdit.requestId.trim().length > 0
      && typeof chatEdit.text === "string" && chatEdit.text.trim().length > 0
      && typeof chatEdit.authorizedAt === "string"
    : restore?.kind === "restore"
      ? Number.isInteger(restore.sourceVersion) && restore.sourceVersion > 0
        && Number.isInteger(restore.page) && restore.page > 0
        && typeof restore.authorizedAt === "string"
      : false;
  if (!validAuthorization) return false;
  const basis = edit.basis;
  if (basis?.kind === "uploaded-images") {
    return basis.inputFingerprint === taskInputFingerprint(task)
      && isUploadedLineageSheet(task, version, basis.inputFingerprint, basis);
  }
  if (basis?.kind !== "confirmed-output") return false;
  const sourceVersion = edit.baselineEvidence?.sourceVersion;
  if (!Number.isInteger(sourceVersion) || sourceVersion < 1
    || edit.baselineEvidence?.basis !== "successful-execution-requires-confirmed-sheet") return false;
  if (!isCompleteSuccessfulExecution(task, sourceVersion)) return false;
  if (!task.inputConfirmation || task.sheetInputsRevision !== task.inputConfirmation.revision
    || sheet.inputsRevision !== task.inputConfirmation.revision) return false;
  try {
    checkInputsConfirmed(task);
  } catch {
    return false;
  }
  return true;
}

function normalizedSha(value, label = "SHA-256") {
  const sha = String(value ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`${label} 必须是 64 位 SHA-256`);
  return sha;
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function referenceImageMimeType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

async function readTaskSourceImageBytes(taskId, sourceId, fileOrder, { sources, root, uploadedImage = false } = {}) {
  if (!Array.isArray(sources)) throw new Error("制作单缺少来源快照，无法读取参考图片");
  const source = sources.find((item) => item.id === sourceId);
  if (!source) throw new Error(`参考图片引用了未知来源：${sourceId}`);
  if (uploadedImage) {
    if (source.type !== "current_attachment" || source.decision === "excluded") {
      throw new Error(`上传改图来源 ${sourceId} 必须是本任务未排除的当前附件`);
    }
  } else if (source.decision !== "retained") throw new Error(`参考图片来源 ${sourceId} 未经人工保留`);
  const matches = Array.isArray(source.files) ? source.files.filter((file) => file?.order === fileOrder) : [];
  if (matches.length !== 1) throw new Error(`来源 ${sourceId} 不存在唯一的第 ${fileOrder} 个附件`);
  const file = matches[0];
  if (sourceId.includes("/") || sourceId.includes("\\") || sourceId === "." || sourceId === ".."
    || typeof file.relativePath !== "string" || !file.relativePath.startsWith(`sources/${sourceId}/`)
    || file.relativePath.includes("\\") || path.isAbsolute(file.relativePath)) {
    throw new Error(`来源 ${sourceId} 的参考图片路径无效`);
  }
  const directory = taskDirectory(taskId, root);
  const filePath = path.resolve(directory, file.relativePath);
  const relative = path.relative(directory, filePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`来源 ${sourceId} 的参考图片路径越出任务目录`);
  }
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`来源 ${sourceId} 的参考图片必须是任务内普通文件`);
  const [taskRealPath, fileRealPath] = await Promise.all([fs.realpath(directory), fs.realpath(filePath)]);
  const realRelative = path.relative(taskRealPath, fileRealPath);
  if (!realRelative || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error(`来源 ${sourceId} 的参考图片真实路径越出任务目录`);
  }
  const bytes = await fs.readFile(fileRealPath);
  const declaredHash = String(file.sha256 ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(declaredHash)) throw new Error(`来源 ${sourceId} 的参考图片缺少有效 SHA-256`);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== declaredHash) throw new Error(`来源 ${sourceId} 第 ${fileOrder} 个参考图片哈希不一致`);
  const mimeType = referenceImageMimeType(bytes);
  if (!mimeType) throw new Error(`来源 ${sourceId} 第 ${fileOrder} 个附件不是有效的 PNG、JPEG 或 WebP 图片`);
  return { bytes, mimeType, sha256, name: String(file.name ?? `${fileOrder}.${mimeType.split("/")[1]}`) };
}

/** Read a retained source image only from its task-owned, hash-checked snapshot. */
export async function readTaskReferenceImageBytes(taskId, sourceId, fileOrder, options = {}) {
  return readTaskSourceImageBytes(taskId, sourceId, fileOrder, options);
}

/** Read a current attachment as a one-off image edit input without changing its decision. */
export async function readTaskUploadedImageBytes(taskId, sourceId, fileOrder, options = {}) {
  return readTaskSourceImageBytes(taskId, sourceId, fileOrder, { ...options, uploadedImage: true });
}

/** Read a task-owned generated image through a relative, hash-checked output reference. */
export async function readTaskOutputImageBytes(taskId, reference, { root } = {}) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) throw new Error("成品引用无效");
  const relativePath = reference.relativePath;
  const expectedSha = normalizedSha(reference.sha256, "成品引用 SHA-256");
  if (typeof relativePath !== "string" || !relativePath.startsWith("images/")
    || relativePath.includes("\\") || path.isAbsolute(relativePath)) throw new Error("成品引用路径无效");
  const directory = taskDirectory(taskId, root);
  const filePath = path.resolve(directory, relativePath);
  const relative = path.relative(directory, filePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("成品引用路径越出任务目录");
  }
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("成品引用必须指向任务内普通文件");
  const [taskRealPath, fileRealPath] = await Promise.all([fs.realpath(directory), fs.realpath(filePath)]);
  const realRelative = path.relative(taskRealPath, fileRealPath);
  if (!realRelative || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error("成品引用真实路径越出任务目录");
  }
  const bytes = await fs.readFile(fileRealPath);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expectedSha) throw new Error("成品引用 SHA-256 不一致，拒绝改图");
  const mimeType = referenceImageMimeType(bytes);
  if (!mimeType) throw new Error("成品引用不是有效的 PNG、JPEG 或 WebP 图片");
  return { bytes, mimeType, sha256, name: path.basename(relativePath) };
}

async function currentExecutionPage(task, pageNumber) {
  const sheet = currentSheet(task);
  if (!sheet.pages.some((entry) => entry.page === pageNumber)) throw new Error(`第 ${pageNumber} 页不在当前制作单中`);
  if (task.execution?.version !== task.sheetVersion) throw new Error("画布执行结果不属于当前制作单版本");
  const page = task.execution.pages?.find((item) => item.page === pageNumber);
  if (!page) throw new Error(`当前执行结果缺少第 ${pageNumber} 页`);
  if (page.status !== "succeeded") throw new Error(`第 ${pageNumber} 页尚未生成成功`);
  if (!page.image || typeof page.image.path !== "string" || !page.image.path.trim()) {
    throw new Error(`第 ${pageNumber} 页缺少成品文件`);
  }
  const recordedSha = normalizedSha(page.image.sha256, `第 ${pageNumber} 页成品 SHA-256`);
  const actualSha = await hashFile(path.resolve(page.image.path));
  if (actualSha !== recordedSha) throw new Error(`第 ${pageNumber} 页文件已变化；需更新执行结果并重新审核`);
  return { page, image: page.image, sha256: actualSha };
}

export async function recordReview(id, { page, sha256, decision, reviewer, notes } = {}, opts = {}) {
  const expectedRevision = requiredRevision(opts);
  if (!Number.isInteger(page) || page < 1) throw new Error("复审页码必须是正整数");
  if (!new Set(["pass", "revise"]).has(decision)) throw new Error("复审结论必须是 pass 或 revise");
  const reviewerName = requiredText(reviewer, "实际读图者", 300);
  const reviewNotes = normalizeReviewNotes(notes);
  const suppliedSha = normalizedSha(sha256);
  return withTask(id, async (draft) => {
    const current = await currentExecutionPage(draft, page);
    if (current.sha256 !== suppliedSha) throw new Error(`第 ${page} 页复审 SHA-256 与当前文件不一致`);
    const review = {
      version: draft.sheetVersion,
      page,
      sha256: suppliedSha,
      decision,
      reviewer: reviewerName,
      notes: reviewNotes,
      reviewedAt: now(),
    };
    draft.finalApproval = null;
    draft.reviews.push(review);
  }, { ...opts, expectedRevision });
}

function normalizeReviewNotes(notes) {
  if (typeof notes === "string") return requiredText(notes, "读图复审记录", 10000);
  if (Array.isArray(notes)) {
    const values = notes.map((note, index) => requiredText(note, `读图复审记录 ${index + 1}`, 3000));
    if (values.length === 0) throw new Error("读图复审记录不能为空");
    return values;
  }
  if (notes && typeof notes === "object") {
    const value = cloneJson(notes, "读图复审记录");
    if (Object.keys(value).length === 0 || !hasReviewText(value)) throw new Error("读图复审记录必须包含实际文字观察");
    return value;
  }
  throw new Error("读图复审记录必须包含实际观察内容");
}

function hasReviewText(value) {
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.some(hasReviewText);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(hasReviewText);
}

function normalizeApprovalImages(images, label = "最终成品确认图片") {
  if (!Array.isArray(images)) throw new Error(`${label}必须是逐页数组`);
  const seen = new Set();
  return images.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label}第 ${index + 1} 项必须是对象`);
    }
    if (!Number.isInteger(entry.page) || entry.page < 1) throw new Error(`${label}页码必须是正整数`);
    if (seen.has(entry.page)) throw new Error(`${label}页码不能重复`);
    seen.add(entry.page);
    return { page: entry.page, sha256: normalizedSha(entry.sha256, `${label} SHA-256`) };
  });
}

function orderApprovalImages(images, sheet, label = "最终成品确认图片") {
  const normalized = normalizeApprovalImages(images, label);
  if (normalized.length !== sheet.pages.length) throw new Error(`${label}必须精确覆盖当前制作单的每一页`);
  const byPage = new Map(normalized.map((image) => [image.page, image]));
  return sheet.pages.map(({ page }) => {
    const image = byPage.get(page);
    if (!image) throw new Error(`${label}缺少第 ${page} 页`);
    return image;
  });
}

export async function approveFinal(id, { version, images, by, note = "" } = {}, opts = {}) {
  const expectedRevision = requiredRevision(opts);
  if (!Number.isInteger(version) || version < 1) throw new Error("最终成品确认必须指定制作单版本");
  const confirmer = humanActor(by, "确认人");
  const approvalNote = normalizeConfirmationNote(note, "最终成品确认说明");
  return withTask(id, async (task) => {
    const sheet = currentSheet(task, version);
    const approvalImages = orderApprovalImages(images, sheet);
    if (task.execution?.version !== version) throw new Error("画布执行结果不属于待确认的制作单版本");
    const pages = task.execution.pages || [];
    if (pages.length !== sheet.pages.length) throw new Error("最终确认要求当前制作单的每一页都有执行结果");
    for (const expected of sheet.pages) {
      const current = await currentExecutionPage(task, expected.page);
      const supplied = approvalImages.find((image) => image.page === expected.page);
      if (supplied.sha256 !== current.sha256) throw new Error(`最终确认第 ${expected.page} 页 SHA-256 与当前文件不一致`);
      const review = latestReviewForSnapshot(task, { version, page: expected.page, sha256: current.sha256 });
      if (!review || review.decision !== "pass") {
        throw new Error(`第 ${expected.page} 页没有针对当前文件哈希的 pass 复审`);
      }
    }
    task.finalApproval = {
      version,
      revision: expectedRevision,
      images: approvalImages,
      by: confirmer,
      note: approvalNote,
      approvedAt: now(),
    };
  }, { ...opts, expectedRevision });
}

export function assertNoCredentials(value, where = "任务内容") {
  if (typeof value === "string") {
    if (CREDENTIAL_TEXT.test(value)) throw new Error(`${where}疑似包含凭据，拒绝写入或导出`);
    for (const match of value.matchAll(/https?:\/\/[^\s<>()"']+/g)) {
      let url; try { url = new URL(match[0]); } catch { continue; }
      if (url.username || url.password || [...url.searchParams.keys(), ...new URLSearchParams(url.hash.replace(/^#/, "")).keys()].some(key => SECRET_FIELD.test(key) || /^(token|auth|signature|sig|key)$/i.test(key))) {
        throw new Error(`${where}链接含敏感认证参数，请提供无凭据链接或上传原件`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentials(item, `${where}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) throw new Error(`${where}包含敏感字段 ${key}，拒绝导出`);
    assertNoCredentials(child, `${where}.${key}`);
  }
}

async function nextExportDirectory(taskDir, records = []) {
  const parent = path.join(taskDir, "exports");
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(parent, { withFileTypes: true });
  const used = new Set(entries
    .map((entry) => /^export-(\d{3,})(?:\.zip)?$/.exec(entry.name))
    .filter(Boolean)
    .map((match) => Number(match[1])));
  for (const record of records) {
    const match = /^export-(\d{3,})$/.exec(String(record?.version ?? ""));
    if (match) used.add(Number(match[1]));
  }
  let sequence = 1;
  while (used.has(sequence)) sequence += 1;
  return { parent, version: `export-${String(sequence).padStart(3, "0")}` };
}

async function writeExclusiveJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function imageExtension(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".png";
}

export async function exportTask(id, opts = {}) {
  const expectedRevision = requiredRevision(opts);
  let exportRecord;
  const task = await withTask(id, async (draft) => {
    const sheet = currentSheet(draft);
    if (draft.finalApproval?.version !== draft.sheetVersion) throw new Error("当前制作单版本尚未完成人工最终确认");
    if (draft.execution?.version !== draft.sheetVersion) throw new Error("画布执行结果不属于已批准版本");
    const executionPages = draft.execution.pages || [];
    if (executionPages.length !== sheet.pages.length) throw new Error("导出要求制作单的每一页都有成品");
    const prepared = [];
    for (const expected of sheet.pages) {
      const current = await currentExecutionPage(draft, expected.page);
      const review = latestReviewForSnapshot(draft, {
        version: draft.sheetVersion,
        page: expected.page,
        sha256: current.sha256,
      });
      if (!review || review.decision !== "pass") throw new Error(`第 ${expected.page} 页缺少针对当前文件哈希的 pass 复审`);
      prepared.push({ ...current, review });
    }
    const approvedImages = orderApprovalImages(draft.finalApproval.images, sheet, "已批准成品图片");
    for (const entry of prepared) {
      const approved = approvedImages.find((image) => image.page === entry.page.page);
      if (approved.sha256 !== entry.sha256) {
        throw new Error(`第 ${entry.page.page} 页当前文件与最终批准 SHA-256 不一致`);
      }
    }

    const exportSources = cloneJson(draft.sources);
    const copy = {
      title: draft.title,
      pages: sheet.pages.map(({ page, copy: exactCopy }) => ({ page, copy: exactCopy })),
    };
    assertNoCredentials({ title: draft.title, brief: draft.brief, sources: exportSources, sheet, copy, reviews: draft.reviews, confirmations: {
      input: draft.inputConfirmation,
      sheet: draft.sheetConfirmation,
      final: draft.finalApproval,
    } });

    const { parent, version } = await nextExportDirectory(taskDirectory(id, opts.root), draft.exports);
    const destination = path.join(parent, version);
    const archivePath = `${destination}.zip`;
    let archiveOwned = false;
    try {
      await fs.mkdir(destination, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST") throw new Error(`导出目录已存在，拒绝覆盖：${version}`);
      throw error;
    }
    try {
      const files = [];
      const addJson = async (relativePath, value) => {
        const file = path.join(destination, ...relativePath.split("/"));
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeExclusiveJson(file, value);
        files.push({ path: relativePath, sha256: await hashFile(file) });
      };
      await addJson("copy.json", copy);
      await addJson("sources.json", exportSources);
      await addJson("production-sheet.json", sheet);
      // Export task-owned source bytes, never the library's mutable latest files.
      for (const source of exportSources) {
        for (const file of source.files ?? []) {
          if (typeof file.relativePath !== "string" || !file.relativePath.startsWith("sources/")) throw new Error("来源文件路径无效");
          const taskRoot = taskDirectory(id, opts.root);
          const inputPath = path.resolve(taskRoot, file.relativePath);
          if (!inputPath.startsWith(`${taskRoot}${path.sep}`)) throw new Error("来源文件路径越界");
          const outputPath = path.resolve(destination, file.relativePath);
          if (!outputPath.startsWith(`${destination}${path.sep}`)) throw new Error("导出来源文件路径越界");
          if (await hashFile(inputPath) !== file.sha256) throw new Error("任务来源原件已变化");
          await fs.mkdir(path.dirname(outputPath), {recursive:true, mode:0o700});
          await fs.copyFile(inputPath, outputPath, fsConstants.COPYFILE_EXCL);
          if (await hashFile(outputPath) !== file.sha256) throw new Error("导出来源原件哈希不一致");
          files.push({path:file.relativePath, sha256:file.sha256});
        }
      }
      const exportedImages = [];
      for (const entry of prepared) {
        const relativePath = `images/page-${String(entry.page.page).padStart(2, "0")}${imageExtension(entry.image.path)}`;
        const outputPath = path.join(destination, ...relativePath.split("/"));
        await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
        await fs.copyFile(path.resolve(entry.image.path), outputPath, fsConstants.COPYFILE_EXCL);
        const copiedSha = await hashFile(outputPath);
        if (copiedSha !== entry.sha256) throw new Error(`第 ${entry.page.page} 页复制后哈希变化，取消导出`);
        const record = { page: entry.page.page, path: relativePath, sha256: copiedSha };
        exportedImages.push(record);
        files.push(record);
      }
      const generatedAt = now();
      const manifest = {
        schemaVersion: 1,
        taskId: id,
        taskTitle: draft.title,
        exportVersion: version,
        generatedAt,
        brief: cloneJson(draft.brief),
        inputConfirmation: cloneJson(draft.inputConfirmation),
        sheetVersion: draft.sheetVersion,
        sheetConfirmation: cloneJson(draft.sheetConfirmation),
        finalApproval: cloneJson(draft.finalApproval),
        execution: {
          version: draft.execution.version,
          pages: draft.execution.pages.map(({ page, status, nodeId, imageNodeId, attempt, submissionIntentAt, history }) => ({ page, status, nodeId, imageNodeId, attempt, submissionIntentAt, history })),
        },
        reviews: cloneJson(draft.reviews),
        sources: "sources.json",
        productionSheet: "production-sheet.json",
        exactCopy: "copy.json",
        images: exportedImages,
        files,
      };
      await writeExclusiveJson(path.join(destination, "manifest.json"), manifest);
      const archiveFiles = {};
      for (const relative of [...files.map(file => file.path), "manifest.json"]) {
        archiveFiles[relative] = await fs.readFile(path.join(destination, relative));
      }
      const archive = zipSync(archiveFiles, { level: 0 });
      const handle = await fs.open(archivePath, "wx", 0o600);
      archiveOwned = true;
      try { await handle.writeFile(archive); await handle.sync(); }
      finally { await handle.close(); }
      const relativePath = path.relative(taskDirectory(id, opts.root), destination).split(path.sep).join("/");
      exportRecord = { version, relativePath, archiveRelativePath: `${relativePath}.zip`, archiveSha256: await hashFile(archivePath), generatedAt, files: cloneJson(files) };
      draft.exports.push(exportRecord);
    } catch (error) {
      await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
      if (archiveOwned) await fs.rm(archivePath, { force: true }).catch(() => {});
      throw error;
    }
  }, { ...opts, expectedRevision });
  return { task, export: cloneJson(exportRecord) };
}
