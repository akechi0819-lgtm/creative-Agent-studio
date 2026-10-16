import fs from "node:fs/promises";
import path from "node:path";

import {
  cleanAsset,
  confirmAsset,
  dataRoot,
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
import { readConfig } from "../src/web/config.mjs";

const ROOT = dataRoot();
const USAGE = `用法：
  node scripts/assets.mjs import @payload.json
  node scripts/assets.mjs list [@filters.json]
  node scripts/assets.mjs query @payload.json
  node scripts/assets.mjs show ASSET_ID
  node scripts/assets.mjs clean ASSET_ID @payload.json
  node scripts/assets.mjs recover-clean @payload.json
  node scripts/assets.mjs edit ASSET_ID @payload.json
  node scripts/assets.mjs replace-files ASSET_ID @payload.json
  node scripts/assets.mjs confirm ASSET_ID @payload.json
  node scripts/assets.mjs delete ASSET_ID @payload.json
  node scripts/assets.mjs snapshot ASSET_ID
  node scripts/assets.mjs tags
  node scripts/assets.mjs tag-rename @payload.json
  node scripts/assets.mjs tag-delete @payload.json`;

const SECRET_FIELD = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|authorization|bearer|\btoken\b)/i;
const SECRET_TEXT = /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/gi;
const SECRET_QUERY = /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^&#\s]+/gi;

function usageError() {
  const error = new Error("命令格式无效");
  error.code = "ERR_ASSET_USAGE";
  return error;
}

function payloadPath(value) {
  if (typeof value !== "string" || !value.startsWith("@") || value.length < 2) throw usageError();
  return value.slice(1);
}

async function readPayload(argument) {
  const filePath = path.resolve(process.cwd(), payloadPath(argument));
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    const error = new Error("无法读取素材库输入文件");
    error.code = "ERR_ASSET_INPUT";
    throw error;
  }
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    const error = new Error("素材库输入文件不是有效 JSON");
    error.code = "ERR_ASSET_INPUT";
    throw error;
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw usageError();
  return result;
}

function requiredRevision(value) {
  if (!Number.isInteger(value) || value < 1) throw usageError();
}

function safeOutput(value) {
  if (typeof value === "string") return value.replace(SECRET_TEXT, "[已隐藏凭据]").replace(SECRET_QUERY, "$1[已隐藏]");
  if (Array.isArray(value)) return value.map(safeOutput);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = SECRET_FIELD.test(key) ? "[已隐藏]" : safeOutput(child);
  }
  return output;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(safeOutput(value), null, 2)}\n`);
}

function runWithCancellation(operation) {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return operation(controller.signal).finally(() => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  });
}

async function dispatch(action, args) {
  if (action === "import" && args.length === 1) return importAsset(await readPayload(args[0]), { root: ROOT });
  if (action === "list" && args.length <= 1) {
    const options = args.length ? await readPayload(args[0]) : {};
    return listAssets(options, { root: ROOT });
  }
  if (action === "query" && args.length === 1) return queryAssets(await readPayload(args[0]), { root: ROOT });
  if (action === "show" && args.length === 1) return readAsset(args[0], { root: ROOT });
  if (action === "snapshot" && args.length === 1) return snapshotAsset(args[0], { root: ROOT });
  if (action === "tags" && args.length === 0) return listTags({ root: ROOT });
  if (action === "recover-clean" && args.length === 1) {
    const payload = await readPayload(args[0]);
    requiredRevision(payload.expectedRevision);
    if (typeof payload.id !== "string" || !Number.isInteger(payload.deadPid) || payload.deadPid < 1) throw usageError();
    return recoverClean(payload.id, {
      deadPid: payload.deadPid,
      expectedRevision: payload.expectedRevision,
      root: ROOT,
    });
  }

  if (action === "tag-rename" && args.length === 1) {
    const payload = await readPayload(args[0]);
    requiredRevision(payload.expectedRevision);
    if (typeof payload.tag !== "string" || typeof payload.newTag !== "string") throw usageError();
    return renameTag(payload.tag, payload.newTag, { root: ROOT, expectedRevision: payload.expectedRevision });
  }
  if (action === "tag-delete" && args.length === 1) {
    const payload = await readPayload(args[0]);
    requiredRevision(payload.expectedRevision);
    if (typeof payload.tag !== "string") throw usageError();
    return deleteTag(payload.tag, { root: ROOT, expectedRevision: payload.expectedRevision });
  }

  if (!["clean", "edit", "replace-files", "confirm", "delete"].includes(action) || args.length !== 2) throw usageError();
  const [id, payloadArgument] = args;
  const payload = await readPayload(payloadArgument);
  requiredRevision(payload.expectedRevision);

  if (action === "clean") {
    const { expectedRevision, config: _payloadConfig, ...options } = payload;
    const config = (await readConfig({ root: ROOT })).basic;
    return runWithCancellation((signal) => cleanAsset(id, {
      ...options,
      config,
      expectedRevision,
      root: ROOT,
      signal,
    }));
  }
  if (action === "edit") {
    const { expectedRevision, ...fields } = payload;
    return editAsset(id, fields, { root: ROOT, expectedRevision });
  }
  if (action === "replace-files") {
    if (!Array.isArray(payload.files)) throw usageError();
    return replaceAssetFiles(id, payload.files, { root: ROOT, expectedRevision: payload.expectedRevision });
  }
  if (action === "confirm") {
    if (typeof payload.by !== "string" || typeof payload.note !== "string") throw usageError();
    return confirmAsset(id, payload, { root: ROOT, expectedRevision: payload.expectedRevision });
  }
  return deleteAsset(id, { root: ROOT, expectedRevision: payload.expectedRevision });
}

function errorMessage(error) {
  switch (error?.code) {
    case "ERR_ASSET_USAGE": return USAGE;
    case "ERR_ASSET_INPUT": return "输入文件不可用；请检查 JSON 文件后重试。";
    case "ERR_ASSET_NOT_FOUND": return "未找到指定素材。";
    case "ERR_ASSET_LOCKED": return "素材库正在写入；请稍后重新读取并重试。";
    case "ERR_ASSET_REVISION_REQUIRED": return "写入 payload 必须包含从 show/tags 读取的正整数 expectedRevision。";
    case "ERR_ASSET_REVISION_CONFLICT": return "素材或标签目录已更新；本次写入已停止，请重新读取后再操作。";
    case "ERR_ASSET_CLEAN_STALE": return "素材在清洗期间发生变化，旧清洗结果已丢弃；请读取当前状态。";
    case "ERR_ASSET_CLEAN_CONFIG": return "清洗服务尚未配置；未调用模型，稍后配置后可重试。";
    case "ERR_ASSET_CLEAN_CANCELLED": return "清洗已取消；可以读取最新版本后重试。";
    case "ERR_ASSET_CLEAN_STATE":
    case "ERR_ASSET_CLEAN_CONFIRMED": return "当前素材状态不能清洗；请读取状态后按流程操作。";
    case "ERR_ASSET_CLEAN_FAILED": return "清洗失败；错误详情未写入命令输出，可检查配置或原件后重试。";
    case "ERR_ASSET_TAG_CLEANING": return "关联素材正在清洗；请等待清洗结束后重新读取标签和素材，再操作。";
    case "ERR_ASSET_CLEAN_OWNER_ALIVE": return "清洗所属进程仍在运行；未恢复任务或重放请求。";
    case "ERR_ASSET_CLEAN_OWNER_MISMATCH": return "当前清洗任务与 deadPid 不匹配；请重新读取素材状态。";
    case "ERR_ASSET_CONFIRM_STATE": return "只有 needs_review 素材可以确认入库。";
    case "ERR_ASSET_FILE_HASH": return "原件校验失败；请恢复正确原件后重试。";
    case "ERR_ASSET_FILE_MISSING": return "原件缺失或不可读取；请检查原件路径。";
    case "ERR_ASSET_FILE_PATH": return "原件路径元数据无效；请检查素材记录。";
    case "ERR_ASSET_SOURCE_PATH":
    case "ERR_ASSET_SOURCE_CHANGED": return "原件必须是未变化的普通文件；请检查后重试。";
    case "ERR_ASSET_FILE_TOO_LARGE": return "单个原件超过 100 MB 限制。";
    case "ERR_ASSET_CREDENTIAL_FILE":
    case "ERR_ASSET_CREDENTIAL_DETECTED": return "检测到疑似凭据内容；原件未导入。";
    case "ERR_ASSET_DATA_IN_PROJECT": return "素材库数据目录不能放在项目源码目录中。";
    case "ERR_ASSET_ID": return "assetId 格式无效。";
    case "ERR_ASSET_TAG_NOT_FOUND": return "标签不存在；请重新读取标签列表。";
    case "ERR_ASSET_DELETED": return "素材已移入回收状态，不能继续修改或引用。";
    case "ERR_ASSET_SNAPSHOT_UNCONFIRMED": return "只有人工确认入库的素材可以作为任务来源。";
    default: return "素材库操作未完成；敏感错误详情不会输出，请读取当前状态并检查输入后重试。";
  }
}

const [action, ...args] = process.argv.slice(2);
if (!action) {
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 2;
} else {
  dispatch(action, args).then(print).catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
