import crypto from "node:crypto";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { dataRoot, root as projectRoot } from "../canvas/client.mjs";
import { cleanMaterial } from "./cleaner.mjs";

export { dataRoot };

const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENSITIVE_FIELD = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|authorization|bearer|\btoken\b)/i;
const SECRET_TEXT = /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/gi;
const SECRET_QUERY = /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^&#\s]+/gi;
const SECRET_ASSIGNMENT = /\b(?:OPENAI_API_KEY|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{20,}/gi;
const LIKELY_SECRET_FILE = /^(?:\.env(?:\..*)?|.*(?:credentials?|secrets?)\.(?:json|ya?ml)|.*\.(?:pem|key))$/i;
const CLEANABLE_STATUSES = new Set(["staged", "needs_review", "clean_failed", "clean_cancelled", "clean_config_missing"]);
const NOFOLLOW = fsConstants.O_NOFOLLOW || 0;
const MAX_FILES_PER_ASSET = 100;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const LOCK_WAIT_MS = 3000;

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class AssetLockError extends Error {
  constructor() {
    super("素材库正在由另一个进程写入，请稍后重试");
    this.name = "AssetLockError";
    this.code = "ERR_ASSET_LOCKED";
  }
}

export class AssetRevisionConflictError extends Error {
  constructor(expected, actual) {
    super(`素材版本冲突：期望 revision ${expected}，当前为 ${actual}`);
    this.name = "AssetRevisionConflictError";
    this.code = "ERR_ASSET_REVISION_CONFLICT";
    this.expectedRevision = expected;
    this.actualRevision = actual;
  }
}

export class AssetCleanStaleResultError extends Error {
  constructor() {
    super("清洗结果已过期，素材在清洗期间发生变化；旧结果已丢弃");
    this.name = "AssetCleanStaleResultError";
    this.code = "ERR_ASSET_CLEAN_STALE";
  }
}

function safeText(value) {
  return String(value)
    .replace(SECRET_TEXT, "[已隐藏凭据]")
    .replace(SECRET_QUERY, "$1[已隐藏]")
    .replace(SECRET_ASSIGNMENT, "[已隐藏凭据]");
}

function cloneJson(value, label = "素材数据") {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("没有 JSON 表示");
    return JSON.parse(encoded);
  } catch (error) {
    throw new Error(`${label}必须是可保存的 JSON 数据`, { cause: error });
  }
}

function sanitizeJson(value) {
  if (typeof value === "string") return safeText(value);
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SENSITIVE_FIELD.test(key) ? "[已隐藏]" : sanitizeJson(child);
  }
  return result;
}

function safeOutput(value) {
  return sanitizeJson(cloneJson(value));
}

function safeId(value) {
  const id = String(value ?? "").trim();
  if (!ASSET_ID.test(id)) throw errorWithCode("assetId 必须是 UUID", "ERR_ASSET_ID");
  return id;
}

function requiredRevision(options = {}) {
  const revision = options?.expectedRevision;
  if (!Number.isInteger(revision) || revision < 1) {
    throw errorWithCode("素材状态变更必须指定正整数 expectedRevision", "ERR_ASSET_REVISION_REQUIRED");
  }
  return revision;
}

function requiredText(value, label, maxLength = 10000, { allowEmpty = false } = {}) {
  if (typeof value !== "string") throw new Error(`${label}必须是文本`);
  const result = safeText(value.trim());
  if (!allowEmpty && !result) throw new Error(`${label}不能为空`);
  if (result.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return result;
}

function normalizeTag(value) {
  return requiredText(value, "标签", 100).replace(/\s+/gu, " ");
}

function foldTag(value) {
  return normalizeTag(value).toLocaleLowerCase("zh-CN");
}

function normalizeTags(values) {
  if (!Array.isArray(values)) throw new Error("tags 必须是自由标签数组");
  if (values.length > 200) throw new Error("单条素材最多包含 200 个标签");
  const seen = new Set();
  const result = [];
  for (const item of values) {
    const tag = normalizeTag(item);
    const key = foldTag(tag);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(tag);
    }
  }
  return result;
}

function rootCandidate(root) {
  if (root == null) return path.resolve(dataRoot());
  if (typeof root !== "string" || !root.trim()) throw new Error("数据根目录必须是非空路径");
  return path.resolve(root);
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertOutsideProject(candidate) {
  if (isInside(path.resolve(projectRoot), path.resolve(candidate))) {
    throw errorWithCode("素材库数据根目录不能位于项目源码目录内", "ERR_ASSET_DATA_IN_PROJECT");
  }
}

async function nearestExistingAncestor(candidate) {
  let current = candidate;
  const suffix = [];
  while (true) {
    try {
      await fs.access(current);
      return { existing: current, suffix };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function ensureDataRoot(root) {
  const candidate = rootCandidate(root);
  assertOutsideProject(candidate);
  const { existing, suffix } = await nearestExistingAncestor(candidate);
  const projected = path.resolve(await fs.realpath(existing), ...suffix);
  assertOutsideProject(projected);
  await fs.mkdir(candidate, { recursive: true, mode: 0o700 });
  const realRoot = await fs.realpath(candidate);
  assertOutsideProject(realRoot);
  const assets = path.join(realRoot, "assets");
  await fs.mkdir(path.join(assets, "items"), { recursive: true, mode: 0o700 });
  return realRoot;
}

function assetsDirectory(root) {
  return path.join(root, "assets");
}

function itemsDirectory(root) {
  return path.join(assetsDirectory(root), "items");
}

function assetDirectory(id, root) {
  return path.join(itemsDirectory(root), safeId(id));
}

function metadataPath(id, root) {
  return path.join(assetDirectory(id, root), "metadata.json");
}

function tagCatalogPath(root) {
  return path.join(assetsDirectory(root), "tags.json");
}

function libraryLockPath(root) {
  return path.join(assetsDirectory(root), ".lock");
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
    const directory = await fs.open(path.dirname(filePath), "r").catch(() => null);
    if (directory) {
      await directory.sync().catch(() => {});
      await directory.close().catch(() => {});
    }
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
      missing.code = "ERR_ASSET_NOT_FOUND";
      throw missing;
    }
    if (error instanceof SyntaxError) throw new Error(`${label}不是有效 JSON`, { cause: error });
    throw error;
  }
}

async function lockOwner(lockPath) {
  try {
    return await readJson(path.join(lockPath, "owner.json"), "素材库锁记录");
  } catch (error) {
    if (error.code === "ERR_ASSET_NOT_FOUND") return null;
    throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function retireStaleLock(lockPath, owner) {
  if (owner && processIsAlive(owner.pid)) return false;
  if (!owner) {
    try {
      const info = await fs.stat(lockPath);
      if (Date.now() - info.mtimeMs < 10000) return false;
    } catch (error) {
      if (error.code === "ENOENT") return true;
      throw error;
    }
  }
  const current = await lockOwner(lockPath);
  if (owner && (!current || current.token !== owner.token || current.pid !== owner.pid)) return false;
  const retired = `${lockPath}.stale-${crypto.randomUUID()}`;
  try {
    await fs.rename(lockPath, retired);
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code)) return true;
    throw error;
  }
  await fs.rm(retired, { recursive: true, force: true });
  return true;
}

async function acquireLibraryLock(root, { signal, waitMs = LOCK_WAIT_MS } = {}) {
  const lockPath = libraryLockPath(root);
  const startedAt = Date.now();
  while (true) {
    signal?.throwIfAborted();
    const staging = `${lockPath}.pending-${crypto.randomUUID()}`;
    const owner = { pid: process.pid, token: crypto.randomUUID(), acquiredAt: now() };
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      await atomicWriteJson(path.join(lockPath, "owner.json"), owner);
      return { lockPath, owner };
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY"].includes(error.code)) {
        const current = await lockOwner(lockPath).catch(() => null);
        if (await retireStaleLock(lockPath, current)) continue;
        if (Date.now() - startedAt >= waitMs) throw new AssetLockError();
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      if (await fs.access(lockPath).then(() => true).catch(() => false)) {
        const current = await lockOwner(lockPath).catch(() => null);
        if (current?.token === owner.token) {
          await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
        }
      }
      throw error;
    }
  }
}

async function releaseLibraryLock(lock) {
  const current = await lockOwner(lock.lockPath).catch(() => null);
  if (!current || current.token !== lock.owner.token) return;
  const retired = `${lock.lockPath}.released-${lock.owner.token}`;
  await fs.rename(lock.lockPath, retired).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await fs.rm(retired, { recursive: true, force: true });
}

async function withLibraryLock(root, callback, options = {}) {
  const lock = await acquireLibraryLock(root, options);
  try {
    return await callback();
  } finally {
    await releaseLibraryLock(lock);
  }
}

function relativeOriginalPath(id, order, fileName) {
  return path.posix.join("assets", "items", id, "originals", `${String(order + 1).padStart(4, "0")}-${fileName}`);
}

function safeFileName(input, fallback) {
  const base = path.basename(String(input || fallback)).normalize("NFKC").trim();
  if (LIKELY_SECRET_FILE.test(base)) {
    throw errorWithCode("凭据文件不能导入素材库", "ERR_ASSET_CREDENTIAL_FILE");
  }
  const cleaned = base
    .replace(/[\\/\0]/gu, "_")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/\s+/gu, " ")
    .replace(/^\.+/u, "")
    .slice(0, 150)
    .trim();
  return cleaned || fallback;
}

function credentialScannerAndHash() {
  const hash = crypto.createHash("sha256");
  let tail = "";
  const credentialPattern = /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\b(?:OPENAI_API_KEY|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{20,}/i;
  let size = 0;
  const transform = new Transform({
    transform(chunk, encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      const combined = tail + buffer.toString("latin1");
      if (credentialPattern.test(combined)) {
        callback(errorWithCode("原件疑似包含凭据，未导入", "ERR_ASSET_CREDENTIAL_DETECTED"));
        return;
      }
      tail = combined.slice(-512);
      size += buffer.length;
      hash.update(buffer);
      callback(null, buffer);
    },
  });
  return { hash, transform, size: () => size };
}

async function copyOriginal(source, destination) {
  if (typeof source !== "string" || !source.trim()) throw new Error("每个原件都必须提供本地 path");
  const sourcePath = path.resolve(source);
  const info = await fs.lstat(sourcePath);
  if (info.isSymbolicLink() || !info.isFile()) throw errorWithCode("原件必须是普通文件，不能是符号链接或目录", "ERR_ASSET_SOURCE_PATH");
  if (info.size > MAX_FILE_BYTES) throw errorWithCode("单个原件不能超过 100 MB", "ERR_ASSET_FILE_TOO_LARGE");
  const destinationHandle = await fs.open(destination, "wx", 0o600);
  const scanned = credentialScannerAndHash();
  try {
    const input = createReadStream(sourcePath, { flags: fsConstants.O_RDONLY | NOFOLLOW });
    const output = createWriteStream(destination, { fd: destinationHandle.fd, autoClose: false });
    await pipeline(input, scanned.transform, output);
    await destinationHandle.sync();
  } catch (error) {
    await destinationHandle.close().catch(() => {});
    await fs.rm(destination, { force: true }).catch(() => {});
    throw error;
  }
  await destinationHandle.close();
  const after = await fs.stat(sourcePath);
  if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || scanned.size() !== info.size) {
    await fs.rm(destination, { force: true }).catch(() => {});
    throw errorWithCode("原件在复制期间发生变化，已取消导入", "ERR_ASSET_SOURCE_CHANGED");
  }
  return { size: scanned.size(), sha256: scanned.hash.digest("hex") };
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  const input = createReadStream(filePath, { flags: fsConstants.O_RDONLY | NOFOLLOW });
  for await (const chunk of input) hash.update(chunk);
  return hash.digest("hex");
}

function originalAbsolutePath(id, file, root) {
  const relativePath = file?.relativePath;
  const expected = `assets/items/${id}/originals/`;
  if (typeof relativePath !== "string" || !relativePath.startsWith(expected)) {
    throw errorWithCode("素材原件路径元数据无效", "ERR_ASSET_FILE_PATH");
  }
  const suffix = relativePath.slice(expected.length);
  if (!suffix || suffix.includes("/") || suffix.includes("\\") || suffix === "." || suffix === "..") {
    throw errorWithCode("素材原件路径元数据无效", "ERR_ASSET_FILE_PATH");
  }
  const candidate = path.resolve(root, ...relativePath.split("/"));
  if (!isInside(assetDirectory(id, root), candidate)) {
    throw errorWithCode("素材原件路径越界", "ERR_ASSET_FILE_PATH");
  }
  return candidate;
}

async function loadRecord(id, root) {
  const record = await readJson(metadataPath(id, root), "素材记录");
  if (!record || record.id !== id || !Number.isInteger(record.revision) || record.revision < 1) {
    throw new Error("素材记录结构无效");
  }
  return record;
}

async function verifyOriginalFiles(record, root) {
  const verified = [];
  for (const file of record.files || []) {
    const filePath = originalAbsolutePath(record.id, file, root);
    let actual;
    try {
      actual = await hashFile(filePath);
    } catch (error) {
      throw errorWithCode("素材原件缺失或不可读取", "ERR_ASSET_FILE_MISSING");
    }
    if (actual !== file.sha256) throw errorWithCode("素材原件 SHA-256 不匹配，已拒绝读取", "ERR_ASSET_FILE_HASH");
    verified.push({ ...file, path: filePath });
  }
  return verified;
}

function stateSnapshot(record) {
  return cloneJson({
    status: record.status,
    title: record.title,
    body: record.body,
    summary: record.summary,
    tags: record.tags,
    source: record.source,
    extractions: record.extractions,
    promptVersion: record.promptVersion,
    manualFields: record.manualFields,
    confirmation: record.confirmation,
    confirmedSnapshot: record.confirmedSnapshot,
    cleaningJob: record.cleaningJob,
    lastError: record.lastError,
    deletedAt: record.deletedAt,
    files: record.files,
  });
}

function bumpRecord(record, action) {
  record.history ||= [];
  record.history.push({
    revision: record.revision,
    action,
    at: now(),
    state: stateSnapshot(record),
  });
  record.revision += 1;
  record.updatedAt = now();
}

function checkRevision(record, expected) {
  if (record.revision !== expected) throw new AssetRevisionConflictError(expected, record.revision);
}

function assertNotDeleted(record) {
  if (record.deletedAt || record.status === "deleted") throw errorWithCode("素材已移入回收状态", "ERR_ASSET_DELETED");
}

async function saveRecord(record, root) {
  await atomicWriteJson(metadataPath(record.id, root), sanitizeJson(record));
}

async function readRecordIds(root) {
  let entries;
  try {
    entries = await fs.readdir(itemsDirectory(root), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory() && ASSET_ID.test(entry.name)).map((entry) => entry.name);
}

async function readRecords(root) {
  const ids = await readRecordIds(root);
  const records = [];
  for (const id of ids) {
    try {
      records.push(await loadRecord(id, root));
    } catch (error) {
      if (error.code !== "ERR_ASSET_NOT_FOUND") throw error;
    }
  }
  return records;
}

function emptyTagCatalog() {
  return { revision: 1, fingerprint: null, history: [] };
}

async function readTagCatalog(root) {
  try {
    const catalog = await readJson(tagCatalogPath(root), "标签目录");
    if (!Number.isInteger(catalog.revision) || catalog.revision < 1) {
      throw new Error("标签目录结构无效");
    }
    return catalog;
  } catch (error) {
    if (error.code === "ERR_ASSET_NOT_FOUND") return emptyTagCatalog();
    throw error;
  }
}

function tagsForRecord(record) {
  return normalizeTags(record.tags || []);
}

async function tagFingerprint(root) {
  const tags = new Set();
  for (const record of await readRecords(root)) {
    if (record.deletedAt || record.status === "deleted") continue;
    for (const tag of record.tags || []) tags.add(`${foldTag(tag)}\u0000${normalizeTag(tag)}`);
  }
  const value = [...tags].sort().join("\n");
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function refreshTagCatalogLocked(root) {
  const catalog = await readTagCatalog(root);
  const fingerprint = await tagFingerprint(root);
  if (catalog.fingerprint === null) {
    catalog.fingerprint = fingerprint;
    await atomicWriteJson(tagCatalogPath(root), catalog);
  } else if (catalog.fingerprint !== fingerprint) {
    catalog.history ||= [];
    catalog.history.push({ revision: catalog.revision, at: now(), fingerprint: catalog.fingerprint });
    catalog.revision += 1;
    catalog.fingerprint = fingerprint;
    await atomicWriteJson(tagCatalogPath(root), catalog);
  }
  return catalog;
}

async function getTagCatalogSnapshot(root) {
  return withLibraryLock(root, () => refreshTagCatalogLocked(root));
}

function normalizeSource(value) {
  if (value == null) return { kind: "user-provided" };
  if (typeof value === "string") return safeText(requiredText(value, "source", 5000));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("source 必须是文本或对象");
  return sanitizeJson(cloneJson(value, "source"));
}

function normalizeImportFiles(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("files 必须是有序文件数组");
  if (value.length > MAX_FILES_PER_ASSET) throw new Error(`单条素材最多包含 ${MAX_FILES_PER_ASSET} 个原件`);
  return value.map((file, index) => {
    const item = typeof file === "string" ? { path: file } : file;
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`第 ${index + 1} 个原件格式无效`);
    const sourcePath = requiredText(item.path, `第 ${index + 1} 个原件 path`, 4000);
    const fallback = path.basename(sourcePath);
    const name = safeFileName(item.name || fallback, `file-${index + 1}`);
    const mimeType = item.mimeType == null ? null : requiredText(item.mimeType, `第 ${index + 1} 个原件 mimeType`, 200);
    return { path: sourcePath, name, mimeType, order: index };
  });
}

function normalizeCleanResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("清洗器返回结构无效");
  const title = value.title == null ? null : requiredText(value.title, "清洗标题", 500);
  const body = requiredText(value.body ?? "", "清洗正文", 200000, { allowEmpty: true });
  const summary = requiredText(value.summary ?? "", "素材摘要", 10000, { allowEmpty: true });
  const tags = normalizeTags(value.tags ?? []);
  const extractions = sanitizeJson(cloneJson(value.extractions ?? value.fileResults ?? [], "extractions"));
  const promptVersion = value.promptVersion == null ? null : requiredText(value.promptVersion, "promptVersion", 300);
  return { title, body, summary, tags, extractions, promptVersion };
}

function mapCleanFailure(error, signal) {
  if (signal?.aborted || error?.name === "AbortError" || error?.code === "ABORTED") {
    return { status: "clean_cancelled", lastError: { code: "ERR_ASSET_CLEAN_CANCELLED", message: "清洗已取消，可重新清洗。" } };
  }
  if (["ERR_ASSET_CLEAN_CONFIG", "MODEL_NOT_CONFIGURED", "ERR_ASSET_MODEL_NOT_CONFIGURED"].includes(error?.code)) {
    return { status: "clean_config_missing", lastError: { code: error.code, message: "清洗服务尚未配置；未调用模型，可在配置提供商后重试。" } };
  }
  if (error?.code === "ERR_ASSET_FILE_HASH" || error?.code === "ERR_ASSET_FILE_MISSING" || error?.code === "ERR_ASSET_FILE_PATH") {
    return { status: "clean_failed", lastError: { code: error.code, message: "原件校验失败；请检查原件后重试。" } };
  }
  return { status: "clean_failed", lastError: { code: "ERR_ASSET_CLEAN_FAILED", message: "清洗失败；检查配置或原件后可重试。" } };
}

function actorName(value) {
  const actor = requiredText(value, "by", 300);
  if (/^(?:(?:codex|dsh)(?:[\s_-]+(?:agent|assistant|bot))?|(?:ai|agent|assistant|model)(?:[\s_-]+(?:agent|assistant|bot|model))?|(?:ai|agent|assistant|model)(?:模型|机器人|智能体)|模型|自动|机器人|智能体)$/iu.test(actor)) {
    throw new Error("by 必须记录实际人工姓名或身份");
  }
  return actor;
}

function confirmationNote(value) {
  return requiredText(value, "note", 3000);
}

function normalizeEditedTags(values) {
  return normalizeTags(values);
}

function paginate(records, options = {}) {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 100;
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset 必须是非负整数");
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit 必须是 1 到 500 的整数");
  return records.slice(offset, offset + limit).map((record) => safeOutput(record));
}

function searchableText(record) {
  return JSON.stringify({ title: record.title, body: record.body, summary: record.summary, source: record.source, extractions: record.extractions }).toLocaleLowerCase("zh-CN");
}

function activeRecord(record, options) {
  if (!options.includeDeleted && (record.deletedAt || record.status === "deleted")) return false;
  if (options.status && record.status !== options.status) return false;
  if (options.confirmedOnly && record.status !== "confirmed") return false;
  return true;
}

function recordMatchesTags(record, tags, tagMode) {
  if (!tags.length) return true;
  const itemTags = new Set(tagsForRecord(record).map(foldTag));
  const wanted = tags.map(foldTag);
  return tagMode === "any"
    ? wanted.some((tag) => itemTags.has(tag))
    : wanted.every((tag) => itemTags.has(tag));
}

/** Import original files in order and create a staged asset. */
export async function importAsset(payload, { root } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("素材导入 payload 必须是对象");
  const baseRoot = await ensureDataRoot(root);
  const id = crypto.randomUUID();
  const itemStage = path.join(itemsDirectory(baseRoot), `.pending-${id}-${crypto.randomUUID()}`);
  const itemFinal = assetDirectory(id, baseRoot);
  const filesInput = normalizeImportFiles(payload.files);
  const title = requiredText(payload.title, "title", 500);
  const body = requiredText(payload.body ?? "", "body", 200000, { allowEmpty: true });
  const tags = normalizeTags(payload.tags ?? []);
  const source = normalizeSource(payload.source);
  await fs.mkdir(path.join(itemStage, "originals"), { recursive: true, mode: 0o700 });
  let committed = false;
  try {
    const files = [];
    for (const file of filesInput) {
      const fileName = safeFileName(file.name, `file-${file.order + 1}`);
      const relativePath = relativeOriginalPath(id, file.order, fileName);
      const absolute = path.join(itemStage, "originals", path.posix.basename(relativePath));
      const copied = await copyOriginal(file.path, absolute);
      files.push({
        order: file.order,
        name: fileName,
        mimeType: file.mimeType,
        size: copied.size,
        sha256: copied.sha256,
        relativePath,
      });
    }
    const createdAt = now();
    const record = {
      id,
      revision: 1,
      status: "staged",
      createdAt,
      updatedAt: createdAt,
      title,
      body,
      summary: "",
      tags,
      source,
      files,
      extractions: [],
      promptVersion: null,
      manualFields: [],
      cleaningJob: null,
      lastError: null,
      confirmation: null,
      confirmedSnapshot: null,
      deletedAt: null,
      statusBeforeDelete: null,
      history: [],
    };
    await atomicWriteJson(path.join(itemStage, "metadata.json"), sanitizeJson(record));
    await withLibraryLock(baseRoot, async () => {
      await fs.rename(itemStage, itemFinal);
      committed = true;
      await refreshTagCatalogLocked(baseRoot);
    });
    return safeOutput(record);
  } catch (error) {
    if (!committed) await fs.rm(itemStage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Read an asset and verify every original file against its stored SHA-256. */
export async function readAsset(id, { root } = {}) {
  const safeAssetId = safeId(id);
  const baseRoot = await ensureDataRoot(root);
  const record = await loadRecord(safeAssetId, baseRoot);
  await verifyOriginalFiles(record, baseRoot);
  return safeOutput({ ...record, originalsVerified: true });
}

/** List library records for management; staging and review items remain visible. */
export async function listAssets(options = {}, { root } = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("list options 必须是对象");
  const tagMode = options.tagMode ?? "all";
  if (!new Set(["all", "any"]).has(tagMode)) throw new Error("tagMode 必须是 all 或 any");
  const tags = options.tags == null ? [] : Array.isArray(options.tags) ? options.tags.map(normalizeTag) : [normalizeTag(options.tags)];
  const baseRoot = await ensureDataRoot(root);
  await getTagCatalogSnapshot(baseRoot);
  const records = (await readRecords(baseRoot))
    .filter((record) => activeRecord(record, options))
    .filter((record) => recordMatchesTags(record, tags, tagMode))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    .map((record) => ({ ...record, tags: tagsForRecord(record) }));
  return paginate(records, options);
}

/** Agent-facing search defaults to confirmed assets only. */
export async function queryAssets(options = {}, { root } = {}) {
  const tagMode = options.tagMode ?? "all";
  if (!new Set(["all", "any"]).has(tagMode)) throw new Error("tagMode 必须是 all 或 any");
  const tags = options.tags == null ? [] : Array.isArray(options.tags) ? options.tags.map(normalizeTag) : [normalizeTag(options.tags)];
  const query = options.query == null ? "" : requiredText(options.query, "query", 2000, { allowEmpty: true }).toLocaleLowerCase("zh-CN");
  const baseRoot = await ensureDataRoot(root);
  await getTagCatalogSnapshot(baseRoot);
  const confirmedOnly = options.confirmedOnly !== false;
  const records = (await readRecords(baseRoot))
    .filter((record) => activeRecord(record, { ...options, confirmedOnly }))
    .filter((record) => recordMatchesTags(record, tags, tagMode))
    .filter((record) => !query || searchableText(record).includes(query))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    .map((record) => ({ ...record, tags: tagsForRecord(record) }));
  return paginate(records, options);
}

/** Run an injected/provider-neutral cleaner without holding the metadata lock. */
export async function cleanAsset(id, options = {}) {
  const safeAssetId = safeId(id);
  const expected = requiredRevision(options);
  const baseRoot = await ensureDataRoot(options.root);
  const signal = options.signal;
  signal?.throwIfAborted();
  const jobId = crypto.randomUUID();
  const started = await withLibraryLock(baseRoot, async () => {
    const record = await loadRecord(safeAssetId, baseRoot);
    checkRevision(record, expected);
    assertNotDeleted(record);
    if (record.status === "confirmed") throw errorWithCode("已确认素材必须先由人工编辑并重新进入复核，不能直接重洗", "ERR_ASSET_CLEAN_CONFIRMED");
    if (!CLEANABLE_STATUSES.has(record.status)) throw errorWithCode(`当前状态 ${record.status} 不能开始清洗`, "ERR_ASSET_CLEAN_STATE");
    bumpRecord(record, "clean_started");
    record.status = "cleaning";
    record.cleaningJob = { id: jobId, pid: process.pid, startedAt: now() };
    record.lastError = null;
    await saveRecord(record, baseRoot);
    return record;
  }, { signal });

  let cleanResult;
  try {
    signal?.throwIfAborted();
    const files = await verifyOriginalFiles(started, baseRoot);
    const cleaner = options.cleaner ?? cleanMaterial;
    const clean = typeof cleaner === "function" ? cleaner : cleaner?.cleanMaterial;
    if (typeof clean !== "function") throw new Error("cleaner 必须是函数或包含 cleanMaterial 的对象");
    const raw = await clean({
      title: started.title,
      body: started.body,
      files: files.map((file) => file.path),
    }, { config: options.config, signal });
    signal?.throwIfAborted();
    cleanResult = normalizeCleanResult(raw);
  } catch (error) {
    const failure = mapCleanFailure(error, signal);
    const failed = await withLibraryLock(baseRoot, async () => {
      const current = await loadRecord(safeAssetId, baseRoot);
      if (current.revision !== started.revision || current.cleaningJob?.id !== jobId || current.deletedAt) {
        throw new AssetCleanStaleResultError();
      }
      bumpRecord(current, "clean_finished_error");
      current.status = failure.status;
      current.cleaningJob = null;
      current.lastError = failure.lastError;
      await saveRecord(current, baseRoot);
      return current;
    });
    return safeOutput(failed);
  }

  const completed = await withLibraryLock(baseRoot, async () => {
    const current = await loadRecord(safeAssetId, baseRoot);
    if (current.revision !== started.revision || current.cleaningJob?.id !== jobId || current.deletedAt) {
      throw new AssetCleanStaleResultError();
    }
    bumpRecord(current, "clean_finished");
    if (!current.manualFields.includes("body")) current.body = cleanResult.body;
    if (!current.manualFields.includes("summary")) current.summary = cleanResult.summary;
    if (!current.manualFields.includes("tags")) {
      current.tags = normalizeEditedTags(cleanResult.tags);
    }
    current.extractions = cleanResult.extractions;
    current.promptVersion = cleanResult.promptVersion;
    current.status = "needs_review";
    current.cleaningJob = null;
    current.lastError = null;
    await saveRecord(current, baseRoot);
    await refreshTagCatalogLocked(baseRoot);
    return current;
  });
  return safeOutput(completed);
}

/** Mark a cleaner job interrupted only after its recorded owner process has exited. */
export async function recoverClean(id, options = {}) {
  const safeAssetId = safeId(id);
  const expected = requiredRevision(options);
  const deadPid = options.deadPid;
  if (!Number.isInteger(deadPid) || deadPid < 1) {
    throw errorWithCode("恢复清洗必须提供正整数 deadPid", "ERR_ASSET_CLEAN_OWNER_MISMATCH");
  }
  const baseRoot = await ensureDataRoot(options.root);
  return safeOutput(await withLibraryLock(baseRoot, async () => {
    const record = await loadRecord(safeAssetId, baseRoot);
    checkRevision(record, expected);
    assertNotDeleted(record);
    if (record.status !== "cleaning" || record.cleaningJob?.pid !== deadPid) {
      throw errorWithCode("deadPid 与当前清洗任务不匹配", "ERR_ASSET_CLEAN_OWNER_MISMATCH");
    }
    if (processIsAlive(deadPid)) {
      throw errorWithCode("清洗任务所属进程仍在运行，不能恢复或重放", "ERR_ASSET_CLEAN_OWNER_ALIVE");
    }
    bumpRecord(record, "clean_interrupted");
    record.status = "clean_failed";
    record.cleaningJob = null;
    record.lastError = {
      code: "ERR_ASSET_CLEAN_INTERRUPTED",
      message: "清洗进程已中断；未重放请求，可检查状态后显式重试。",
    };
    await saveRecord(record, baseRoot);
    return record;
  }));
}

/** Human-editable fields move a record back to review and invalidate confirmation. */
export async function editAsset(id, payload, options = {}) {
  const safeAssetId = safeId(id);
  const expected = requiredRevision(options);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("edit payload 必须是对象");
  const allowed = new Set(["title", "body", "summary", "tags", "source"]);
  const keys = Object.keys(payload);
  if (!keys.length || keys.some((key) => !allowed.has(key))) throw new Error("edit payload 只能包含 title、body、summary、tags、source");
  const baseRoot = await ensureDataRoot(options.root);
  return safeOutput(await withLibraryLock(baseRoot, async () => {
    const record = await loadRecord(safeAssetId, baseRoot);
    checkRevision(record, expected);
    assertNotDeleted(record);
    bumpRecord(record, "human_edit");
    const manualFields = new Set(record.manualFields || []);
    for (const key of keys) {
      if (key === "title") {
        record.title = requiredText(payload.title, "title", 500);
        manualFields.add("title");
      } else if (key === "body") {
        record.body = requiredText(payload.body, "body", 200000, { allowEmpty: true });
        manualFields.add("body");
      } else if (key === "summary") {
        record.summary = requiredText(payload.summary, "summary", 10000, { allowEmpty: true });
        manualFields.add("summary");
      } else if (key === "tags") {
        record.tags = normalizeEditedTags(payload.tags);
        manualFields.add("tags");
      } else if (key === "source") {
        record.source = normalizeSource(payload.source);
      }
    }
    record.manualFields = [...manualFields];
    if (!["staged", "clean_failed", "clean_cancelled", "clean_config_missing"].includes(record.status)) {
      // Editing a staged or failed record does not substitute for a successful clean.
      record.status = "needs_review";
    }
    record.cleaningJob = null;
    if (record.status === "needs_review") record.lastError = null;
    record.confirmation = null;
    record.confirmedSnapshot = null;
    await saveRecord(record, baseRoot);
    await refreshTagCatalogLocked(baseRoot);
    return record;
  }));
}

/** Replace the current ordered source files while retaining every prior original. */
export async function replaceAssetFiles(id, files, options = {}) {
  const safeAssetId = safeId(id);
  const expected = requiredRevision(options);
  const inputs = normalizeImportFiles(files);
  const baseRoot = await ensureDataRoot(options.root);
  const stage = path.join(assetDirectory(safeAssetId, baseRoot), `.pending-files-${crypto.randomUUID()}`);
  await fs.mkdir(stage, { recursive: true, mode: 0o700 });
  let committed = false;
  const installed = [];
  try {
    const copied = [];
    for (const file of inputs) {
      const tempPath = path.join(stage, `file-${String(file.order + 1).padStart(4, "0")}`);
      const digest = await copyOriginal(file.path, tempPath);
      copied.push({ ...file, ...digest, tempPath });
    }
    const result = await withLibraryLock(baseRoot, async () => {
      const record = await loadRecord(safeAssetId, baseRoot);
      checkRevision(record, expected);
      assertNotDeleted(record);
      const nextFiles = [];
      for (const file of copied) {
        const fileName = `${String(file.order + 1).padStart(4, "0")}-${file.sha256.slice(0, 20)}-${file.name}`;
        const relativePath = path.posix.join("assets", "items", safeAssetId, "originals", fileName);
        const destination = path.resolve(baseRoot, ...relativePath.split("/"));
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        let alreadyPresent = false;
        try {
          const existingHash = await hashFile(destination);
          if (existingHash !== file.sha256) throw errorWithCode("内容地址原件 SHA-256 不匹配", "ERR_ASSET_FILE_HASH");
          alreadyPresent = true;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (alreadyPresent) {
          await fs.rm(file.tempPath, { force: true });
        } else {
          await fs.rename(file.tempPath, destination);
          installed.push(destination);
        }
        nextFiles.push({
          order: file.order,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          sha256: file.sha256,
          relativePath,
        });
      }

      bumpRecord(record, "original_files_replaced");
      record.files = nextFiles;
      record.status = "staged";
      record.cleaningJob = null;
      record.lastError = null;
      record.extractions = [];
      record.promptVersion = null;
      record.confirmation = null;
      record.confirmedSnapshot = null;
      if (!record.manualFields.includes("body")) record.body = "";
      if (!record.manualFields.includes("summary")) record.summary = "";
      if (!record.manualFields.includes("tags")) record.tags = [];
      await saveRecord(record, baseRoot);
      committed = true;
      await refreshTagCatalogLocked(baseRoot);
      return record;
    });
    return safeOutput(result);
  } catch (error) {
    if (!committed) {
      await Promise.all(installed.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
    }
    throw error;
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

/** Confirm the current reviewed version with a recorded human identity. */
export async function confirmAsset(id, input, options = {}) {
  const safeAssetId = safeId(id);
  const expected = requiredRevision(options);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("confirmation 必须是对象");
  const by = actorName(input.by);
  const note = confirmationNote(input.note);
  const baseRoot = await ensureDataRoot(options.root);
  return safeOutput(await withLibraryLock(baseRoot, async () => {
    const record = await loadRecord(safeAssetId, baseRoot);
    checkRevision(record, expected);
    assertNotDeleted(record);
    if (record.status !== "needs_review") throw errorWithCode("只有 needs_review 素材可以确认入库", "ERR_ASSET_CONFIRM_STATE");
    const verifiedFiles = await verifyOriginalFiles(record, baseRoot);
    bumpRecord(record, "human_confirmed");
    record.status = "confirmed";
    record.cleaningJob = null;
    record.lastError = null;
    record.confirmation = { by, note, at: now(), revision: record.revision };
    record.confirmedSnapshot = {
      revision: record.revision,
      title: record.title,
      body: record.body,
      summary: record.summary,
      tags: record.tags,
      source: record.source,
      extractions: record.extractions,
      promptVersion: record.promptVersion,
      files: verifiedFiles.map(({ path: _path, ...file }) => file),
      confirmedAt: record.confirmation.at,
    };
    await saveRecord(record, baseRoot);
    return record;
  }));
}

/** Soft-delete the asset. Original files and version history remain available for recovery. */
export async function deleteAsset(id, options = {}) {
  const safeAssetId = safeId(id);
  const expected = requiredRevision(options);
  const baseRoot = await ensureDataRoot(options.root);
  return safeOutput(await withLibraryLock(baseRoot, async () => {
    const record = await loadRecord(safeAssetId, baseRoot);
    checkRevision(record, expected);
    assertNotDeleted(record);
    bumpRecord(record, "soft_deleted");
    record.statusBeforeDelete = record.status;
    record.status = "deleted";
    record.deletedAt = now();
    record.cleaningJob = null;
    await saveRecord(record, baseRoot);
    await refreshTagCatalogLocked(baseRoot);
    return record;
  }));
}

/** List deduplicated free tags; the returned revision is required for tag mutations. */
export async function listTags({ root } = {}) {
  const baseRoot = await ensureDataRoot(root);
  const catalog = await getTagCatalogSnapshot(baseRoot);
  const tags = new Map();
  for (const record of await readRecords(baseRoot)) {
    if (record.deletedAt || record.status === "deleted") continue;
    for (const tag of tagsForRecord(record)) tags.set(foldTag(tag), tag);
  }
  return { revision: catalog.revision, tags: [...tags.values()].sort((left, right) => left.localeCompare(right, "zh-CN")) };
}

/** Rename a free tag on every asset and preserve each affected record revision. */
export async function renameTag(tagValue, newTagValue, options = {}) {
  const expected = requiredRevision(options);
  const oldTag = normalizeTag(tagValue);
  const newTag = normalizeTag(newTagValue);
  if (foldTag(oldTag) === foldTag(newTag)) throw new Error("新旧标签不能相同");
  const baseRoot = await ensureDataRoot(options.root);
  return withLibraryLock(baseRoot, async () => {
    const records = await readRecords(baseRoot);
    const affected = records.filter((record) => (record.tags || []).some((tag) => foldTag(tag) === foldTag(oldTag)));
    if (affected.some((record) => record.status === "cleaning" || record.cleaningJob != null)) {
      throw errorWithCode("关联素材正在清洗", "ERR_ASSET_TAG_CLEANING");
    }
    const catalog = await refreshTagCatalogLocked(baseRoot);
    if (catalog.revision !== expected) throw new AssetRevisionConflictError(expected, catalog.revision);
    if (!affected.length) {
      throw errorWithCode("标签不存在", "ERR_ASSET_TAG_NOT_FOUND");
    }
    for (const record of affected) {
      bumpRecord(record, "tag_renamed");
      record.tags = normalizeTags(record.tags.map((tag) => foldTag(tag) === foldTag(oldTag) ? newTag : tag));
      record.manualFields = [...new Set([...(record.manualFields || []), "tags"] )];
      updateConfirmedSnapshotTags(record);
      await saveRecord(record, baseRoot);
    }
    const updated = await refreshTagCatalogLocked(baseRoot);
    return { revision: updated.revision, tags: await listTagsFromCatalogLocked(baseRoot) };
  });
}

/** Delete a free tag from assets while preserving the assets and their version histories. */
export async function deleteTag(tagValue, options = {}) {
  const expected = requiredRevision(options);
  const tag = normalizeTag(tagValue);
  const baseRoot = await ensureDataRoot(options.root);
  return withLibraryLock(baseRoot, async () => {
    const records = await readRecords(baseRoot);
    const affected = records.filter((record) => (record.tags || []).some((item) => foldTag(item) === foldTag(tag)));
    if (affected.some((record) => record.status === "cleaning" || record.cleaningJob != null)) {
      throw errorWithCode("关联素材正在清洗", "ERR_ASSET_TAG_CLEANING");
    }
    const catalog = await refreshTagCatalogLocked(baseRoot);
    if (catalog.revision !== expected) throw new AssetRevisionConflictError(expected, catalog.revision);
    if (!affected.length) {
      throw errorWithCode("标签不存在", "ERR_ASSET_TAG_NOT_FOUND");
    }
    for (const record of affected) {
      bumpRecord(record, "tag_deleted");
      record.tags = record.tags.filter((item) => foldTag(item) !== foldTag(tag));
      record.manualFields = [...new Set([...(record.manualFields || []), "tags"] )];
      updateConfirmedSnapshotTags(record);
      await saveRecord(record, baseRoot);
    }
    const updated = await refreshTagCatalogLocked(baseRoot);
    return { revision: updated.revision, tags: await listTagsFromCatalogLocked(baseRoot) };
  });
}

function updateConfirmedSnapshotTags(record) {
  if (!record.confirmedSnapshot) return;
  record.confirmedSnapshot.tags = [...record.tags];
  record.confirmedSnapshot.revision = record.revision;
}

async function listTagsFromCatalogLocked(root) {
  const tags = new Map();
  for (const record of await readRecords(root)) {
    if (record.deletedAt || record.status === "deleted") continue;
    for (const tag of tagsForRecord(record)) tags.set(foldTag(tag), tag);
  }
  return [...tags.values()].sort((left, right) => left.localeCompare(right, "zh-CN"));
}

/** Capture a self-contained, confirmed metadata version plus verified original-file paths. */
export async function snapshotAsset(id, { root } = {}) {
  const safeAssetId = safeId(id);
  const baseRoot = await ensureDataRoot(root);
  const record = await loadRecord(safeAssetId, baseRoot);
  assertNotDeleted(record);
  if (record.status !== "confirmed" || !record.confirmedSnapshot) {
    throw errorWithCode("只有已确认入库的素材可以作为任务来源快照", "ERR_ASSET_SNAPSHOT_UNCONFIRMED");
  }
  const files = await verifyOriginalFiles(record, baseRoot);
  const current = await loadRecord(safeAssetId, baseRoot);
  if (current.revision !== record.revision || current.status !== "confirmed" || current.deletedAt) {
    throw new AssetRevisionConflictError(record.revision, current.revision);
  }
  const metadata = safeOutput(record.confirmedSnapshot);
  return safeOutput({
    id: record.id,
    revision: record.confirmedSnapshot.revision,
    status: "confirmed",
    title: metadata.title,
    body: metadata.body,
    summary: metadata.summary,
    tags: metadata.tags,
    source: metadata.source,
    confirmedAt: metadata.confirmedAt,
    confirmation: record.confirmation,
    metadata,
    files: files.map(({ path: filePath, ...file }) => ({ ...file, path: filePath })),
  });
}
