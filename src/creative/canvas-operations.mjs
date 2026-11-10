import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { importAsset, listAssets, readAsset } from '../assets/library.mjs';
import { taskDirectory, withTask } from './tasks.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

function operationError(code, safeMessage) {
  const error = new Error(safeMessage);
  error.code = code;
  error.safeMessage = safeMessage;
  return error;
}

function directoryFor(taskId, root) {
  return path.join(taskDirectory(taskId, root), 'canvas-operations');
}

function operationPath(taskId, operationId, root) {
  return path.join(directoryFor(taskId, root), `${operationId}.json`);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function textHash(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

async function readRecord(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw operationError('ERR_CANVAS_OPERATION_LEDGER', '机械操作记录无法读取；请刷新任务状态后再检查。');
  }
}

async function writeNewRecord(file, record) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
}

async function compareAndSwapRecord(file, expectedStatus, record) {
  const current = await readRecord(file);
  if (!current || current.status !== expectedStatus || current.operationId !== record.operationId
    || current.taskId !== record.taskId || current.sequence !== record.sequence - 1) {
    throw operationError('ERR_CANVAS_OPERATION_LEDGER', '机械操作记录状态已变化；请刷新任务状态后再检查。');
  }
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function validateIdentity({ taskId, operationId, requestId, callId, userText, expectedRevision, operation, nodeId, root, run, sourceBinding }) {
  if (typeof root !== 'string' || !root.trim() || !UUID.test(taskId || '') || !UUID.test(operationId || '')
    || !UUID.test(requestId || '') || !UUID.test(callId || '') || typeof userText !== 'string'
    || !userText.trim() || userText.length > 20_000 || !Number.isInteger(expectedRevision) || expectedRevision < 1
    || typeof operation !== 'string' || !['import', 'stitch', 'compose', 'adapt-logo', 'crop', 'split', 'resample', 'move', 'resize'].includes(operation)
    || typeof nodeId !== 'string' || !nodeId.trim() || nodeId.length > 300 || typeof run !== 'function'
    || (sourceBinding != null && (!sourceBinding || typeof sourceBinding !== 'object' || Array.isArray(sourceBinding)
      || !['task-upload', 'task-reference'].includes(sourceBinding.type) || typeof sourceBinding.sourceId !== 'string' || !sourceBinding.sourceId.trim()
      || sourceBinding.sourceId.length > 300 || !Number.isInteger(sourceBinding.fileOrder) || sourceBinding.fileOrder < 1
      || (sourceBinding.sha256 !== undefined && !SHA256.test(sourceBinding.sha256 || ''))))
    || (operation === 'import' && (!sourceBinding || !SHA256.test(sourceBinding.sha256 || '')))) {
    throw operationError('ERR_CANVAS_OPERATION_INPUT', '机械操作的任务、请求或节点信息无效。');
  }
}

/**
 * Persist one operation identity before any bridge submission, then hold the
 * task CAS lock for its complete bridge/readback sequence. A submitted call
 * whose outcome cannot be proved is kept as unknown and can never be replayed.
 */
export async function runCanvasOperation({
  root,
  taskId,
  operationId,
  requestId,
  callId,
  userText,
  expectedRevision,
  operation,
  nodeId,
  input,
  sourceBinding,
  run,
}) {
  validateIdentity({ root, taskId, operationId, requestId, callId, userText, expectedRevision, operation, nodeId, sourceBinding, run });
  const file = operationPath(taskId, operationId, root);
  const ledgerDirectory = directoryFor(taskId, root);
  const imagesDirectory = path.join(ledgerDirectory, operationId, 'images');
  const requestFingerprint = fingerprint({
    taskId, operationId, requestId, callId, userText, expectedRevision, operation, nodeId, input, sourceBinding,
  });

  let outcome;
  const actualTask = await withTask(taskId, async (task) => {
    if (task.revision !== expectedRevision) {
      const error = operationError('ERR_TASK_REVISION_CONFLICT', '任务状态已变化，请读取最新任务状态后重试。');
      error.expectedRevision = expectedRevision;
      error.actualRevision = task.revision;
      throw error;
    }
    await privateDirectory(ledgerDirectory);
    let current = await readRecord(file);
    if (current) {
      if (current.taskId !== taskId || current.operationId !== operationId || current.fingerprint !== requestFingerprint) {
        throw operationError('ERR_CANVAS_OPERATION_IDEMPOTENCY_CONFLICT', '该机械操作标识已用于不同请求。');
      }
      if (current.status === 'completed') {
        outcome = { result: current.result, attachments: current.attachments, replayed: true };
        return;
      }
      if (current.status === 'failed') throw operationError(current.error?.code || 'ERR_CANVAS_OPERATION_FAILED', current.error?.message || '机械操作未完成；请先读取当前画布状态。');
      throw operationError('ERR_CANVAS_OPERATION_UNKNOWN', '机械操作结果尚未确认；请读取当前画布状态，不要自动重提。');
    }

    current = {
      schemaVersion: 1,
      taskId,
      operationId,
      requestId,
      callId,
      userTextSha256: textHash(userText),
      fingerprint: requestFingerprint,
      expectedRevision,
      operation,
      sourceNodeId: nodeId,
      ...(sourceBinding ? { sourceBinding: {
        type: sourceBinding.type, sourceId: sourceBinding.sourceId, fileOrder: sourceBinding.fileOrder,
        ...(sourceBinding.sha256 ? { sha256: sourceBinding.sha256.toLowerCase() } : {}),
      } } : {}),
      input,
      status: 'running',
      sequence: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try { await writeNewRecord(file, current); }
    catch (error) {
      if (error.code === 'EEXIST') {
        const existing = await readRecord(file);
        if (existing?.status === 'completed' && existing.fingerprint === requestFingerprint) {
          outcome = { result: existing.result, attachments: existing.attachments, replayed: true };
          return;
        }
        throw operationError('ERR_CANVAS_OPERATION_UNKNOWN', '机械操作结果尚未确认；请读取当前画布状态，不要自动重提。');
      }
      throw operationError('ERR_CANVAS_OPERATION_LEDGER', '机械操作记录未能保存，Canvas 未提交操作。');
    }

    let submitted = false;
    const markSubmitted = async (provenance = {}) => {
      if (submitted) return;
      const safeProvenance = {};
      if (typeof provenance.sourceSha256 === 'string' && SHA256.test(provenance.sourceSha256)) {
        safeProvenance.sourceSha256 = provenance.sourceSha256.toLowerCase();
      }
      if (Object.hasOwn(provenance, 'sourceBindings')) {
        const sources = provenance.sourceBindings;
        const valid = Array.isArray(sources) && sources.length >= 1 && sources.length <= 21
          && sources.every((source) => source && typeof source === 'object' && !Array.isArray(source)
            && Object.keys(source).length === 2 && Object.hasOwn(source, 'nodeId') && Object.hasOwn(source, 'sha256')
            && typeof source.nodeId === 'string' && source.nodeId.trim() && source.nodeId.length <= 300
            && SHA256.test(source.sha256 || ''))
          && new Set(sources.map((source) => source.nodeId)).size === sources.length;
        if (!valid) throw operationError('ERR_CANVAS_OPERATION_INPUT', '机械操作的源图片哈希清单无效或超过 21 个唯一来源。');
        safeProvenance.sourceBindings = sources.map((source) => ({ nodeId: source.nodeId, sha256: source.sha256.toLowerCase() }));
      }
      if (['task-upload', 'task-reference'].includes(provenance.sourceBinding?.type) && typeof provenance.sourceBinding.sourceId === 'string'
        && provenance.sourceBinding.sourceId.trim() && provenance.sourceBinding.sourceId.length <= 300
        && Number.isInteger(provenance.sourceBinding.fileOrder) && provenance.sourceBinding.fileOrder > 0
        && SHA256.test(provenance.sourceBinding.sha256 || '')) {
        safeProvenance.sourceBinding = {
          type: provenance.sourceBinding.type, sourceId: provenance.sourceBinding.sourceId,
          fileOrder: provenance.sourceBinding.fileOrder, sha256: provenance.sourceBinding.sha256.toLowerCase(),
        };
      }
      if (typeof provenance.canvasInstanceId === 'string' && provenance.canvasInstanceId.length <= 300) {
        safeProvenance.canvasInstanceId = provenance.canvasInstanceId;
      }
      if (typeof provenance.canvasClientId === 'string' && provenance.canvasClientId.length <= 300) {
        safeProvenance.canvasClientId = provenance.canvasClientId;
      }
      const next = { ...current, ...safeProvenance, status: 'submitted', sequence: current.sequence + 1, updatedAt: new Date().toISOString() };
      await compareAndSwapRecord(file, current.status, next);
      current = next;
      submitted = true;
    };

    try {
      const output = await run({ task, markSubmitted, imagesDirectory });
      const next = {
        ...current,
        status: 'completed',
        sequence: current.sequence + 1,
        result: output.result,
        attachments: output.attachments || [],
        updatedAt: new Date().toISOString(),
      };
      await compareAndSwapRecord(file, current.status, next);
      current = next;
      outcome = { result: next.result, attachments: next.attachments, replayed: false };
    } catch (cause) {
      const unknown = submitted || cause?.canvasOutcomeUnknown === true;
      const code = unknown
        ? (cause?.code === 'ERR_CANVAS_SOURCE_CHANGED' ? 'ERR_CANVAS_SOURCE_CHANGED' : 'ERR_CANVAS_OPERATION_UNKNOWN')
        : (cause?.code === 'ERR_CANVAS_OPERATION_INPUT' || cause?.code === 'ERR_TASK_REVISION_CONFLICT'
          || cause?.code === 'ERR_CANVAS_SOURCE_CHANGED'
          ? cause.code : 'ERR_CANVAS_OPERATION_FAILED');
      const message = unknown
        ? (cause?.safeMessage || '机械操作结果尚未确认；请读取当前画布状态，不要自动重提。')
        : (cause?.safeMessage || '机械操作未完成；请读取当前画布状态后检查。');
      const next = {
        ...current,
        status: unknown ? 'unknown' : 'failed',
        sequence: current.sequence + 1,
        error: { code, message },
        updatedAt: new Date().toISOString(),
      };
      await compareAndSwapRecord(file, current.status, next).catch(() => {});
      const error = operationError(code, message);
      error.cause = cause;
      throw error;
    }
  }, { root, expectedRevision });
  return { ...outcome, task: actualTask };
}

/** Read only completed, task-local artifacts from the operation ledger. */
export async function readCanvasOperationImage(taskId, operationId, index, { root } = {}) {
  if (!UUID.test(taskId || '') || !UUID.test(operationId || '') || !Number.isInteger(index) || index < 0) {
    throw operationError('ERR_CANVAS_OPERATION_IMAGE_NOT_FOUND', '机械图片附件不存在。');
  }
  const record = await readRecord(operationPath(taskId, operationId, root));
  if (!record || record.taskId !== taskId || record.operationId !== operationId || record.status !== 'completed'
    || !Array.isArray(record.attachments) || !record.attachments[index]) {
    throw operationError('ERR_CANVAS_OPERATION_IMAGE_NOT_FOUND', '机械图片附件不存在。');
  }
  const image = record.attachments[index];
  if (typeof image.relativePath !== 'string' || !/^images\/image-\d{3}\.(?:png|jpg|webp)$/.test(image.relativePath)
    || path.isAbsolute(image.relativePath) || !SHA256.test(image.sha256 || '')
    || typeof image.nodeId !== 'string' || !image.nodeId.trim()
    || record.result?.operation !== record.operation || !Array.isArray(record.result?.images)) {
    throw operationError('ERR_CANVAS_OPERATION_IMAGE_NOT_FOUND', '机械图片附件不存在。');
  }
  const resultImage = record.result.images[index];
  if (!resultImage || resultImage.nodeId !== image.nodeId || resultImage.sha256?.toLowerCase() !== image.sha256.toLowerCase()) {
    throw operationError('ERR_CANVAS_OPERATION_IMAGE_NOT_FOUND', '机械图片附件不存在。');
  }
  const base = path.resolve(directoryFor(taskId, root), operationId, 'images');
  const candidate = path.resolve(path.dirname(operationPath(taskId, operationId, root)), operationId, image.relativePath);
  if (candidate !== path.join(base, path.basename(candidate))) throw operationError('ERR_CANVAS_OPERATION_IMAGE_NOT_FOUND', '机械图片附件不存在。');
  let resolved;
  let realBase;
  try {
    [resolved, realBase] = await Promise.all([fs.realpath(candidate), fs.realpath(base)]);
  }
  catch { throw operationError('ERR_CANVAS_OPERATION_IMAGE_NOT_FOUND', '机械图片附件不存在。'); }
  if (path.dirname(resolved) !== realBase || !(await fs.stat(resolved)).isFile()) {
    throw operationError('ERR_CANVAS_OPERATION_IMAGE_NOT_FOUND', '机械图片附件不存在。');
  }
  const bytes = await fs.readFile(resolved);
  if (sha256(bytes) !== image.sha256) throw operationError('ERR_CANVAS_OPERATION_IMAGE_HASH', '机械图片附件校验失败。');
  return {
    ...image,
    operation: record.operation,
    taskId: record.taskId,
    operationId: record.operationId,
    imageIndex: index,
    input: record.input,
    sourceSha256: record.sourceSha256,
    sourceBindings: record.sourceBindings,
    canvasInstanceId: record.canvasInstanceId,
    canvasClientId: record.canvasClientId,
    filePath: resolved,
  };
}

/** Save one verified adapt-logo result to the existing library as a staged derived item. */
export async function saveLogoVariant(taskId, {
  operationId,
  imageIndex,
  expectedRevision,
  title,
} = {}, { root } = {}) {
  if (!UUID.test(taskId || '') || !UUID.test(operationId || '') || !Number.isInteger(imageIndex) || imageIndex < 0
    || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw operationError('ERR_LOGO_VARIANT_INPUT', 'Logo 变体保存请求无效。');
  }
  if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.trim().length > 500)) {
    throw operationError('ERR_LOGO_VARIANT_INPUT', '素材标题必须是 1–500 个字符。');
  }

  let asset;
  let replayed = false;
  await withTask(taskId, async () => {
    const image = await readCanvasOperationImage(taskId, operationId, imageIndex, { root });
    if (image.operation !== 'adapt-logo' || !SHA256.test(image.sourceSha256 || '') || !image.input || typeof image.input !== 'object') {
      throw operationError('ERR_LOGO_VARIANT_SOURCE', '只能保存具有原件 SHA 的已完成 adapt-logo 结果。');
    }
    const parameters = Object.fromEntries(['foreground', 'outline', 'plate']
      .filter((key) => Object.hasOwn(image.input, key))
      .map((key) => [key, image.input[key]]));
    const source = {
      kind: 'logo-variant',
      taskId,
      operationId,
      imageIndex,
      originalSha256: image.sourceSha256.toLowerCase(),
      parameters,
      outputSha256: image.sha256.toLowerCase(),
    };

    const matches = [];
    for (let offset = 0; ; offset += 500) {
      const page = await listAssets({ offset, limit: 500, includeDeleted: true }, { root });
      matches.push(...page.filter((candidate) => candidate.source?.kind === 'logo-variant'
        && candidate.source.taskId === taskId
        && candidate.source.operationId === operationId
        && candidate.source.imageIndex === imageIndex));
      if (page.length < 500) break;
    }
    if (matches.length > 1) throw operationError('ERR_LOGO_VARIANT_DUPLICATE', '同一机械 Logo 产物已存在多条素材记录，无法确定可复用项。');
    if (matches.length === 1) {
      const existing = matches[0];
      if (existing.source.outputSha256 !== source.outputSha256
        || existing.source.originalSha256 !== source.originalSha256
        || JSON.stringify(existing.source.parameters) !== JSON.stringify(source.parameters)) {
        throw operationError('ERR_LOGO_VARIANT_CONFLICT', '同一机械 Logo 产物已保存，但输出或参数与当前账本不一致。');
      }
      asset = await readAsset(existing.id, { root });
      if (!asset.files?.some((file) => file.sha256?.toLowerCase() === source.outputSha256)) {
        throw operationError('ERR_LOGO_VARIANT_CONFLICT', '已保存 Logo 变体的原件 SHA 与机械操作输出不一致。');
      }
      replayed = true;
      return;
    }

    const actualBytes = await fs.readFile(image.filePath);
    if (sha256(actualBytes) !== source.outputSha256) throw operationError('ERR_CANVAS_OPERATION_IMAGE_HASH', 'Logo 变体附件校验失败，未写入素材库。');
    asset = await importAsset({
      title: title?.trim() || `Logo 变体 ${source.outputSha256.slice(0, 12)}`,
      body: '',
      source,
      files: [{ path: image.filePath, name: image.name, mimeType: image.mimeType }],
    }, { root });
  }, { root, expectedRevision });
  return { asset, replayed };
}

