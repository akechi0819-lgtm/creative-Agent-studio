import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  assertNoCredentials,
  isSheetAuthorized,
  readTask,
  taskDirectory,
  withTask,
} from './tasks.mjs';
import { readCanvasOperationImage } from './canvas-operations.mjs';
import { latestReviewForSnapshot } from './reviews.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const NON_HUMAN_ACTOR = /^(?:(?:codex|dsh)(?:[\s_-]+(?:agent|assistant|bot))?|(?:ai|agent|assistant|model)(?:[\s_-]+(?:agent|assistant|bot|model))?|(?:ai|agent|assistant|model)(?:模型|机器人|智能体)|模型|自动|机器人|智能体)$/iu;

function adoptionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredText(value, label, maxLength = 3000) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function normalizeRequest(taskId, input = {}) {
  if (!UUID.test(taskId || '') || !UUID.test(input.operationId || '') || !UUID.test(input.requestId || '')
    || !Number.isInteger(input.imageIndex) || input.imageIndex < 0
    || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1
    || input.workType !== 'mechanical'
    || (input.page !== undefined && (!Number.isInteger(input.page) || input.page < 1))
    || !input.authorization || typeof input.authorization !== 'object' || Array.isArray(input.authorization)) {
    throw adoptionError('ERR_MECHANICAL_ADOPTION_INPUT', '机械成品采用请求无效。');
  }
  const by = requiredText(input.authorization.by, '采用授权人', 300);
  if (NON_HUMAN_ACTOR.test(by)) throw new Error('采用授权人必须记录实际人工姓名或身份');
  const note = requiredText(input.authorization.note, '采用授权说明', 20_000);
  assertNoCredentials({ by, note }, '机械成品采用授权');
  return {
    taskId,
    operationId: input.operationId,
    imageIndex: input.imageIndex,
    requestId: input.requestId,
    page: input.page,
    expectedRevision: input.expectedRevision,
    workType: input.workType,
    authorization: { by, note },
  };
}

function requestFingerprint(request) {
  const value = {
    taskId: request.taskId,
    operationId: request.operationId,
    imageIndex: request.imageIndex,
    page: request.page ?? null,
    expectedRevision: request.expectedRevision,
    workType: request.workType,
    authorization: request.authorization,
  };
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function priorAdoption(task, requestId, fingerprint) {
  const prior = (task.mechanicalAdoptions || []).find((entry) => entry.requestId === requestId);
  if (!prior) return null;
  if (prior.fingerprint !== fingerprint) {
    throw adoptionError('ERR_MECHANICAL_ADOPTION_IDEMPOTENCY_CONFLICT', '该采用请求标识已用于不同内容。');
  }
  return prior;
}

function productVersion(task) {
  return Math.max(task.sheetVersion || 0, ...(task.sheets || []).map((sheet) => sheet.version || 0)) + 1;
}

async function readImageFile(record, page) {
  if (record?.page !== page || record.status !== 'succeeded' || typeof record.image?.path !== 'string'
    || !record.image.path.trim() || !SHA256.test(record.image.sha256 || '')) {
    throw new Error(`第 ${page} 页缺少有效的当前成功成品`);
  }
  const bytes = await fs.readFile(record.image.path);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== record.image.sha256.toLowerCase()) throw new Error(`第 ${page} 页成品 SHA-256 不一致`);
  return { ...record, image: { ...record.image, sha256 } };
}

async function copyProductBytes(directory, version, page, image, bytes) {
  const extension = image.mimeType === 'image/jpeg' ? '.jpg' : image.mimeType === 'image/webp' ? '.webp' : '.png';
  const imagesDirectory = path.join(directory, 'images');
  await fs.mkdir(imagesDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(imagesDirectory, 0o700);
  const filePath = path.join(imagesDirectory,
    `mechanical-v${String(version).padStart(3, '0')}-page-${String(page).padStart(2, '0')}-${image.sha256.slice(0, 12)}${extension}`);
  const handle = await fs.open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(filePath, { force: true }).catch(() => {});
    throw error;
  }
  return filePath;
}

/**
 * Adopt one completed task-local Canvas operation image into a reviewable product version.
 * The operation ledger and its checked output bytes are the only source of the adopted image.
 */
export async function adoptCanvasResult(taskId, input = {}, { root } = {}) {
  const request = normalizeRequest(taskId, input);
  const fingerprint = requestFingerprint(request);

  const before = await readTask(taskId, root);
  const replay = priorAdoption(before, request.requestId, fingerprint);
  if (replay) return { task: before, adoption: replay, replayed: true };

  let adoption;
  let replayed = false;
  let copiedPath = null;
  const task = await withTask(taskId, async (draft, save) => {
    const concurrentReplay = priorAdoption(draft, request.requestId, fingerprint);
    if (concurrentReplay) {
      adoption = concurrentReplay;
      replayed = true;
      return;
    }
    if (draft.revision !== request.expectedRevision) {
      const conflict = adoptionError('ERR_TASK_REVISION_CONFLICT', `任务版本冲突：期望 revision ${request.expectedRevision}，当前为 ${draft.revision}`);
      conflict.expectedRevision = request.expectedRevision;
      conflict.actualRevision = draft.revision;
      throw conflict;
    }

    const hasSheet = draft.sheetVersion > 0;
    const previousSheet = hasSheet ? draft.sheets?.find((sheet) => sheet.version === draft.sheetVersion) : null;
    if (hasSheet && !previousSheet) throw new Error('当前制作单版本不存在，不能采用机械成品');
    if (!hasSheet && (draft.sheets?.length || draft.execution?.pages?.length)) {
      throw new Error('任务制作单与执行状态不一致，不能采用机械成品');
    }
    if (hasSheet && request.page === undefined) throw new Error('已有制作单采用必须指定目标页');
    if (!hasSheet && request.page !== undefined && request.page !== 1) throw new Error('无制作单任务只能建立第 1 页机械成品');
    const page = hasSheet ? request.page : 1;

    let previousPages = [];
    if (hasSheet) {
      if (!isSheetAuthorized(draft, draft.sheetVersion)) throw new Error('当前制作单没有有效执行或机械采用授权');
      const execution = draft.execution;
      if (execution?.version !== draft.sheetVersion || execution.status !== 'succeeded'
        || !Array.isArray(execution.pages) || execution.pages.length !== previousSheet.pages.length) {
        throw new Error('已有制作单必须有完整成功的当前成品，才能采用机械结果');
      }
      previousPages = await Promise.all(previousSheet.pages.map(async ({ page: pageNumber }) => {
        const matches = execution.pages.filter((entry) => entry.page === pageNumber);
        if (matches.length !== 1) throw new Error(`当前执行结果缺少唯一的第 ${pageNumber} 页`);
        return readImageFile(matches[0], pageNumber);
      }));
      if (!previousSheet.pages.some((entry) => entry.page === page)) throw new Error(`第 ${page} 页不在当前制作单中`);
    }

    const image = await readCanvasOperationImage(taskId, request.operationId, request.imageIndex, { root });
    if (!IMAGE_TYPES.has(image.mimeType)) throw adoptionError('ERR_MECHANICAL_ADOPTION_IMAGE_TYPE', '机械操作产物不是受支持的图片。');
    const bytes = await fs.readFile(image.filePath);
    const actualSha = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actualSha !== image.sha256.toLowerCase()) {
      throw adoptionError('ERR_CANVAS_OPERATION_IMAGE_HASH', '机械操作产物在采用期间发生变化，已拒绝。');
    }

    const version = productVersion(draft);
    const targetPage = page;
    const timestamp = new Date().toISOString();
    const adoptionApproval = { ...request.authorization, authorizedAt: timestamp };
    const source = {
      type: 'canvas-operation',
      operationId: request.operationId,
      imageIndex: request.imageIndex,
      nodeId: image.nodeId,
      sha256: actualSha,
      operation: image.operation,
    };
    const productOrigin = {
      type: 'canvas-operation',
      operationId: request.operationId,
      imageIndex: request.imageIndex,
      nodeId: image.nodeId,
      sha256: actualSha,
      operation: image.operation,
    };
    const adoptionMetadata = {
      version,
      page: targetPage,
      requestId: request.requestId,
      fingerprint,
      workType: request.workType,
      adoptionApproval,
      source,
      adoptedAt: timestamp,
    };

    const taskPath = taskDirectory(taskId, root);
    copiedPath = await copyProductBytes(taskPath, version, targetPage, image, bytes);
    const sheet = hasSheet
      ? structuredClone(previousSheet)
      : {
        title: draft.title,
        sourceIds: [],
        pages: [{ page: 1, copy: '', prompt: '', size: `${image.width}x${image.height}`, quality: 'auto', sourceIds: [], referenceImages: [] }],
      };
    sheet.pages = sheet.pages.map((entry) => entry.page === targetPage
      ? { ...entry, size: `${image.width}x${image.height}` }
      : entry);
    sheet.version = version;
    sheet.createdAt = timestamp;
    sheet.mechanicalAdoption = adoptionMetadata;
    if (sheet.pageEdit) sheet.pageEdit.version = version;
    const pages = (hasSheet ? previousSheet.pages : [{ page: 1 }]).map(({ page: pageNumber }) => {
      if (pageNumber === targetPage) {
        return {
          page: pageNumber,
          status: 'succeeded',
          nodeId: image.nodeId,
          imageNodeId: image.nodeId,
          completedAt: timestamp,
          image: {
            path: copiedPath,
            sha256: actualSha,
            mimeType: image.mimeType,
            width: image.width,
            height: image.height,
            size: image.size,
          },
          productOrigin,
        };
      }
      const existing = previousPages.find((entry) => entry.page === pageNumber);
      return structuredClone(existing);
    });

    const inheritedReviews = [];
    if (hasSheet) {
      for (const previous of previousPages) {
        if (previous.page === targetPage) continue;
        const review = latestReviewForSnapshot(draft, {
          version: draft.sheetVersion,
          page: previous.page,
          sha256: previous.image.sha256,
        });
        if (review) inheritedReviews.push({ ...structuredClone(review), version });
      }
    }

    draft.executionHistory ||= [];
    if (draft.execution?.pages?.length) draft.executionHistory.push(structuredClone(draft.execution));
    if (Array.isArray(draft.reviews) && draft.reviews.length) {
      draft.reviewHistory ||= [];
      draft.reviewHistory.push(...draft.reviews.map((review) => structuredClone(review)));
    }
    draft.sheets ||= [];
    draft.sheets.push(sheet);
    draft.sheetVersion = version;
    draft.sheetInputsRevision = hasSheet ? previousSheet.inputsRevision ?? draft.sheetInputsRevision : null;
    draft.sheetConfirmation = null;
    draft.execution = { version, status: 'succeeded', pages, workType: request.workType, completedAt: timestamp };
    draft.reviews = inheritedReviews;
    draft.finalApproval = null;
    draft.mechanicalAdoptions ||= [];
    adoption = adoptionMetadata;
    draft.mechanicalAdoptions.push(adoptionMetadata);

    try {
      await save();
    } catch (error) {
      await fs.rm(copiedPath, { force: true }).catch(() => {});
      copiedPath = null;
      throw error;
    }
  }, { root });

  return { task, adoption, replayed };
}
