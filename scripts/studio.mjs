import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  approveFinal,
  applyDna,
  clearTaskLock,
  confirmInputs,
  confirmSheet,
  createTask,
  dataRoot,
  exportTask,
  readTask,
  recordReview,
  setBrief,
  setSheet,
  setSources,
  setAssetSources,
  setReferences,
  attachTaskFiles,
  taskDirectory,
  isSheetAuthorized,
} from '../src/creative/tasks.mjs';
import { taskEntryStatus, clearTaskEntry } from '../src/creative/entry.mjs';
import { executeTask, selectImage } from '../src/creative/executor.mjs';
import { editTaskPages, restorePageEdit } from '../src/creative/page-edits.mjs';
import { createCanvasManager } from '../src/web/canvas.mjs';
import { readConfigRecord } from '../src/web/config.mjs';

const USAGE = `用法：
  node scripts/studio.mjs create @payload.json
  node scripts/studio.mjs list
  node scripts/studio.mjs show TASK_ID
  node scripts/studio.mjs lock-status TASK_ID
  node scripts/studio.mjs entry-status TASK_ID
  node scripts/studio.mjs release-entry TASK_ID @payload.json
  node scripts/studio.mjs apply-dna TASK_ID @payload.json
  node scripts/studio.mjs set-brief TASK_ID @payload.json
  node scripts/studio.mjs set-sources TASK_ID @payload.json
  node scripts/studio.mjs set-asset-sources TASK_ID @payload.json
  node scripts/studio.mjs set-references TASK_ID @payload.json
  node scripts/studio.mjs attach-files TASK_ID @payload.json
  node scripts/studio.mjs confirm-inputs TASK_ID @payload.json
  node scripts/studio.mjs set-sheet TASK_ID @payload.json
  node scripts/studio.mjs confirm-sheet TASK_ID @payload.json
  node scripts/studio.mjs execute TASK_ID @payload.json
  node scripts/studio.mjs resume TASK_ID @payload.json
  node scripts/studio.mjs edit-pages TASK_ID @payload.json
  node scripts/studio.mjs restore-page TASK_ID @payload.json
  node scripts/studio.mjs select-image TASK_ID @payload.json
  node scripts/studio.mjs canvas-open TASK_ID
  node scripts/studio.mjs canvas-state TASK_ID @payload.json
  node scripts/studio.mjs canvas-read-image TASK_ID @payload.json
  node scripts/studio.mjs canvas-detect-regions TASK_ID @payload.json
  node scripts/studio.mjs canvas-operation TASK_ID @payload.json
  node scripts/studio.mjs record-review TASK_ID @payload.json
  node scripts/studio.mjs approve-final TASK_ID @payload.json
  node scripts/studio.mjs export TASK_ID @payload.json
  node scripts/studio.mjs unlock TASK_ID @payload.json`;

const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|authorization|bearer|\btoken\b)/i;
const SECRET_TEXT = /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}|\bsk-[A-Za-z0-9_-]{16,}/gi;
const SECRET_QUERY = /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^&#\s]+/gi;
const TASK_ROOT = dataRoot();
const canvasManager = createCanvasManager({
  detachedSupervisor: true,
  root: TASK_ROOT,
  readConfig: ({ root }) => readConfigRecord({ root }),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANVAS_OPERATION_FIELDS = Object.freeze({
  import: ['image'],
  stitch: ['nodeIds', 'direction', 'gap', 'background'],
  compose: ['nodeId', 'layers'],
  crop: ['nodeId', 'crop'],
  split: ['nodeId', 'rows', 'columns'],
  resample: ['nodeId', 'targetLongEdge', 'algorithm'],
  move: ['nodeId', 'x', 'y'],
  resize: ['nodeId', 'width', 'height'],
});
const CANVAS_OPERATION_IDENTITY_FIELDS = ['operation', 'expectedRevision', 'operationId', 'requestId', 'callId', 'userText', 'expectedSourceHashes'];

function usageError() {
  const error = new Error('命令格式无效');
  error.code = 'ERR_STUDIO_USAGE';
  return error;
}

function requiredPayloadArgument(value) {
  if (typeof value !== 'string' || !value.startsWith('@') || value.length < 2) throw usageError();
  return value.slice(1);
}

async function readPayload(argument) {
  const filePath = path.resolve(process.cwd(), requiredPayloadArgument(argument));
  let contents;
  try {
    contents = await fs.readFile(filePath, 'utf8');
  } catch {
    const error = new Error('无法读取输入文件');
    error.code = 'ERR_STUDIO_INPUT';
    throw error;
  }
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    const error = new Error('输入文件不是有效 JSON');
    error.code = 'ERR_STUDIO_INPUT';
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw usageError();
  return value;
}

function hasFields(value, fields) {
  if (fields.some((field) => !Object.hasOwn(value, field))) throw usageError();
}

function hasOnlyFields(value, fields) {
  const allowed = new Set(fields);
  if (Object.keys(value).some((field) => !allowed.has(field))) throw usageError();
}

function requireExpectedRevision(value) {
  if (!Number.isInteger(value) || value < 1) throw usageError();
}

async function requireCurrentTask(id, expectedRevision) {
  const task = await readTask(id, TASK_ROOT);
  if (task.revision !== expectedRevision) {
    const error = new Error('任务已更新');
    error.code = 'ERR_TASK_REVISION_CONFLICT';
    throw error;
  }
  return task;
}

async function requireExecutionTask(id, payload) {
  const task = await requireCurrentTask(id, payload.expectedRevision);
  if (!isSheetAuthorized(task, payload.version) || task.execution?.version !== payload.version) {
    const error = new Error('制作单未确认或执行版本已变化');
    error.code = 'ERR_STUDIO_EXECUTION_NOT_AUTHORIZED';
    throw error;
  }
  if (payload.retryPage != null) {
    const page = task.execution?.pages?.find((item) => item.page === payload.retryPage);
    if (page?.status !== 'failed') {
      const error = new Error('仅可显式重试已确认失败的页面');
      error.code = 'ERR_STUDIO_RETRY_NOT_CONFIRMED';
      throw error;
    }
  }
  return task;
}

function requireHumanConfirmation(value, fields) {
  hasFields(value, fields);
  if (typeof value.by !== 'string' || !value.by.trim() || typeof value.note !== 'string') throw usageError();
}

function requireReviewPayload(value) {
  hasFields(value, ['page', 'sha256', 'decision', 'reviewer', 'notes']);
  for (const key of ['sha256', 'decision', 'reviewer']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) throw usageError();
  }
}

function safeString(value) {
  return value
    .replace(SECRET_TEXT, '[已隐藏凭据]')
    .replace(SECRET_QUERY, '$1[已隐藏]');
}

function safeOutput(value) {
  if (typeof value === 'string') return safeString(value);
  if (Array.isArray(value)) return value.map(safeOutput);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) result[key] = '[已隐藏]';
    else result[key] = safeOutput(child);
  }
  return result;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(safeOutput(value), null, 2)}\n`);
}

async function openSystemBrowser(url) {
  let command;
  let args;
  if (process.platform === 'darwin') {
    command = 'open'; args = [url];
  } else if (process.platform === 'win32') {
    command = process.env.ComSpec || 'cmd.exe'; args = ['/d', '/s', '/c', `start "" "${url}"`];
  } else {
    command = 'xdg-open'; args = [url];
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
  } catch {
    const error = new Error('无法打开系统浏览器');
    error.code = 'ERR_CANVAS_OPEN_BROWSER';
    throw error;
  }
  child.unref();
}

async function readCanvasImageToFile(taskId, payload) {
  const image = await runWithCancellation((signal) => canvasManager.agentImage(taskId, {
    nodeId: payload.nodeId, expectedRevision: payload.expectedRevision, signal,
  }));
  const extension = image.mimeType === 'image/jpeg' ? '.jpg' : image.mimeType === 'image/webp' ? '.webp' : '.png';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-canvas-read-'));
  try {
    await fs.chmod(directory, 0o700);
    const filePath = path.join(directory, `${randomUUID()}${extension}`);
    await fs.writeFile(filePath, image.bytes, { flag: 'wx', mode: 0o600 });
    return {
      projectId: taskId, nodeId: payload.nodeId, filePath,
      mimeType: image.mimeType, width: image.width, height: image.height, sha256: image.sha256,
    };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function taskSummary(task) {
  const sheet = task.sheets?.find((entry) => entry.version === task.sheetVersion);
  const pages = task.execution?.pages || [];
  const passedPages = new Set();
  const currentImageHashes = new Map();
  for (const page of pages) {
    if (task.execution?.version !== task.sheetVersion || page.status !== 'succeeded') continue;
    if (!page.image?.path || !page.image?.sha256) continue;
    let currentSha;
    try {
      const image = await fs.readFile(page.image.path);
      currentSha = createHash('sha256').update(image).digest('hex');
    } catch {
      continue;
    }
    if (currentSha !== page.image.sha256) continue;
    currentImageHashes.set(page.page, currentSha);
    const latest = [...(task.reviews || [])].reverse().find((review) =>
      review.version === task.sheetVersion && review.page === page.page && review.sha256 === currentSha,
    );
    if (latest?.decision === 'pass') passedPages.add(page.page);
  }
  const approvedImages = task.finalApproval?.images;
  const approvedByPage = new Map();
  let approvalImagesValid = Array.isArray(approvedImages);
  if (approvalImagesValid) {
    for (const image of approvedImages) {
      if (!Number.isInteger(image?.page) || typeof image.sha256 !== 'string' || approvedByPage.has(image.page)) {
        approvalImagesValid = false;
        break;
      }
      approvedByPage.set(image.page, image.sha256);
    }
  }
  const finalApproved = isSheetAuthorized(task)
    && task.finalApproval?.version === task.sheetVersion
    && Boolean(sheet?.pages?.length)
    && sheet.pages.every((page) => passedPages.has(page.page))
    && approvalImagesValid
    && approvedByPage.size === sheet.pages.length
    && sheet.pages.every((page) => approvedByPage.get(page.page) === currentImageHashes.get(page.page));
  return {
    id: task.id,
    title: task.title,
    revision: task.revision,
    updatedAt: task.updatedAt,
    inputConfirmed: Boolean(task.inputConfirmation),
    sheetVersion: task.sheetVersion,
    sheetConfirmed: isSheetAuthorized(task),
    executionStatus: task.execution?.status || 'pending',
    completedPages: pages.filter((page) => page.status === 'succeeded').length,
    totalPages: sheet?.pages?.length || 0,
    reviewedPages: passedPages.size,
    finalApproved,
    exports: task.exports?.length || 0,
  };
}

async function listTasks() {
  const root = TASK_ROOT;
  let entries;
  try {
    entries = await fs.readdir(path.join(root, 'tasks'), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const tasks = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      tasks.push(await taskSummary(await readTask(entry.name, root)));
    } catch {
      // A malformed task must not make the rest of the task list unavailable.
      if (/^[0-9a-f-]{36}$/i.test(entry.name)) tasks.push({ id: entry.name, status: 'unreadable' });
    }
  }
  tasks.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return tasks;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function unlockTask(id, payload) {
  hasFields(payload, ['deadPid', 'expectedRevision']);
  requireExpectedRevision(payload.expectedRevision);
  if (!Number.isInteger(payload.deadPid) || payload.deadPid < 1) throw usageError();
  const task = await readTask(id, TASK_ROOT);
  if (task.revision !== payload.expectedRevision) {
    const error = new Error(`任务版本冲突：期望 revision ${payload.expectedRevision}，当前为 ${task.revision}`);
    error.code = 'ERR_TASK_REVISION_CONFLICT';
    throw error;
  }
  const ownerPath = path.join(taskDirectory(id, TASK_ROOT), '.lock', 'owner.json');
  let owner;
  try {
    owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
  } catch {
    const error = new Error('无法核对任务锁所有者');
    error.code = 'ERR_STUDIO_UNLOCK';
    throw error;
  }
  if (owner?.pid !== payload.deadPid || isProcessAlive(payload.deadPid)) {
    const error = new Error('任务锁进程仍运行或 PID 与记录不符');
    error.code = 'ERR_STUDIO_UNLOCK';
    throw error;
  }
  const result = await clearTaskLock(id, { root: TASK_ROOT });
  return { cleared: result.cleared };
}

async function taskLockStatus(id) {
  const task = await readTask(id, TASK_ROOT);
  const ownerPath = path.join(taskDirectory(task.id, TASK_ROOT), '.lock', 'owner.json');
  let owner;
  try {
    owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') return { id: task.id, locked: true, status: 'unknown' };
    try {
      await fs.access(path.dirname(ownerPath));
      return { id: task.id, locked: true, status: 'unknown' };
    } catch (directoryError) {
      if (directoryError.code === 'ENOENT') return { id: task.id, locked: false };
      return { id: task.id, locked: true, status: 'unknown' };
    }
  }
  const alive = isProcessAlive(owner?.pid);
  return {
    id: task.id,
    locked: true,
    pid: Number.isInteger(owner?.pid) ? owner.pid : null,
    processAlive: alive,
    status: Number.isInteger(owner?.pid) ? (alive ? 'running' : 'exited') : 'unknown',
  };
}

function runWithCancellation(operation) {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return operation(controller.signal).catch((error) => {
    if (controller.signal.aborted) {
      const stopped = new Error('执行已停止');
      stopped.code = 'ERR_STUDIO_ABORTED';
      throw stopped;
    }
    throw error;
  }).finally(() => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  });
}

function assertExecutionPayload(payload) {
  hasFields(payload, ['version', 'expectedRevision']);
  if (!Number.isInteger(payload.version) || payload.version < 1) throw usageError();
  requireExpectedRevision(payload.expectedRevision);
  if (payload.model != null && typeof payload.model !== 'string') throw usageError();
  if (payload.retryPage != null && (!Number.isInteger(payload.retryPage) || payload.retryPage < 1)) throw usageError();
}

async function dispatch(action, args) {
  if (action === 'create') {
    if (args.length !== 1) throw usageError();
    return createTask(await readPayload(args[0]), TASK_ROOT);
  }
  if (action === 'list') {
    if (args.length !== 0) throw usageError();
    return { tasks: await listTasks() };
  }
  if (action === 'show') {
    if (args.length !== 1) throw usageError();
    return readTask(args[0], TASK_ROOT);
  }
  if (action === 'entry-status') {
    if (args.length !== 1) throw usageError();
    return taskEntryStatus(args[0], {root:TASK_ROOT});
  }
  if (action === 'lock-status') {
    if (args.length !== 1) throw usageError();
    return taskLockStatus(args[0]);
  }
  if (action === 'canvas-open') {
    if (args.length !== 1) throw usageError();
    const [id] = args;
    const before = await canvasManager.state(id);
    if (before.connectionError === 'ERR_CANVAS_AMBIGUOUS') {
      const error = new Error('当前任务连接了多个 Canvas 页面，请先关闭多余页面');
      error.code = 'ERR_CANVAS_AMBIGUOUS';
      throw error;
    }
    const prepared = await canvasManager.ensure(id);
    if (!prepared.clientConnected) await openSystemBrowser(prepared.openUrl);
    return { projectId: prepared.projectId, webUrl: prepared.webUrl, clientConnected: prepared.clientConnected, opened: !prepared.clientConnected };
  }
  if (args.length !== 2) throw usageError();

  const [id, payloadArgument] = args;
  const payload = await readPayload(payloadArgument);
  switch (action) {
    case 'release-entry':
      hasFields(payload, ['deadPid']);
      return clearTaskEntry(id, {root:TASK_ROOT,deadPid:payload.deadPid});
    case 'apply-dna':
      hasFields(payload, ['dnaRevision', 'expectedRevision']);
      requireExpectedRevision(payload.expectedRevision);
      return applyDna(id, payload, {root: TASK_ROOT, expectedRevision: payload.expectedRevision});
    case 'set-brief':
      hasFields(payload, ['brief', 'expectedRevision']);
      requireExpectedRevision(payload.expectedRevision);
      return setBrief(id, payload.brief, { root: TASK_ROOT, expectedRevision: payload.expectedRevision });
    case 'set-asset-sources':
      hasFields(payload, ['selections', 'expectedRevision']);
      requireExpectedRevision(payload.expectedRevision);
      return setAssetSources(id, payload.selections, {root:TASK_ROOT,expectedRevision:payload.expectedRevision});
    case 'set-sources':
      hasFields(payload, ['sources', 'expectedRevision']);
      requireExpectedRevision(payload.expectedRevision);
      return setSources(id, payload.sources, { root: TASK_ROOT, expectedRevision: payload.expectedRevision });
    case 'set-references':
      hasFields(payload, ['items', 'expectedRevision']);
      requireExpectedRevision(payload.expectedRevision);
      return setReferences(id, payload.items, { root: TASK_ROOT, expectedRevision: payload.expectedRevision });
    case 'attach-files':
      hasFields(payload, ['files', 'expectedRevision']);
      requireExpectedRevision(payload.expectedRevision);
      return attachTaskFiles(id, payload, { root: TASK_ROOT, expectedRevision: payload.expectedRevision });
    case 'confirm-inputs':
      requireHumanConfirmation(payload, ['revision', 'by', 'note']);
      requireExpectedRevision(payload.revision);
      return confirmInputs(id, payload, { root: TASK_ROOT, expectedRevision: payload.revision });
    case 'set-sheet':
      hasFields(payload, ['sheet', 'expectedRevision', 'inputRevision']);
      requireExpectedRevision(payload.expectedRevision);
      requireExpectedRevision(payload.inputRevision);
      return setSheet(id, payload.sheet, { root: TASK_ROOT, expectedRevision: payload.expectedRevision, inputRevision: payload.inputRevision });
    case 'confirm-sheet':
      requireHumanConfirmation(payload, ['version', 'by', 'note', 'expectedRevision']);
      if (!Number.isInteger(payload.version) || payload.version < 1) throw usageError();
      requireExpectedRevision(payload.expectedRevision);
      return confirmSheet(id, payload, { root: TASK_ROOT, expectedRevision: payload.expectedRevision });
    case 'execute':
    case 'resume':
      assertExecutionPayload(payload);
      if (action === 'execute' && payload.retryPage != null) throw usageError();
      return runWithCancellation(async (signal) => {
        await requireExecutionTask(id, payload);
        const executionOptions = await canvasManager.executionOptions(id);
        return executeTask(id, {
          ...executionOptions,
          version: payload.version,
          expectedRevision: payload.expectedRevision,
          root: TASK_ROOT,
          ...(payload.model ? { model: payload.model } : {}),
          ...(action === 'resume' && payload.retryPage ? { retryPage: payload.retryPage } : {}),
          signal,
        });
      });
    case 'edit-pages':
      hasFields(payload, ['expectedRevision', 'requestId', 'instruction', 'edits']);
      requireExpectedRevision(payload.expectedRevision);
      return runWithCancellation(async (signal) => {
        await requireCurrentTask(id, payload.expectedRevision);
        const executionOptions = await canvasManager.executionOptions(id);
        return editTaskPages(id, {
          ...executionOptions,
          root: TASK_ROOT, expectedRevision: payload.expectedRevision, signal,
          mode: payload.mode, edits: payload.edits,
          authorization: { requestId: payload.requestId, text: payload.instruction },
        });
      });
    case 'restore-page':
      hasFields(payload, ['expectedRevision', 'page']);
      requireExpectedRevision(payload.expectedRevision);
      return restorePageEdit(id, { root: TASK_ROOT, expectedRevision: payload.expectedRevision, page: payload.page });
    case 'select-image':
      hasFields(payload, ['version', 'page', 'nodeId', 'expectedRevision']);
      if (!Number.isInteger(payload.version) || payload.version < 1 || !Number.isInteger(payload.page) || payload.page < 1 || typeof payload.nodeId !== 'string' || !payload.nodeId.trim()) throw usageError();
      requireExpectedRevision(payload.expectedRevision);
      return runWithCancellation(async (signal) => {
        const task = await requireCurrentTask(id, payload.expectedRevision);
        if (!isSheetAuthorized(task, payload.version) || task.execution?.version !== payload.version
          || !task.execution.pages?.some((page) => page.page === payload.page)) {
          const error = new Error('选图目标不是当前已授权执行页');
          error.code = 'ERR_STUDIO_EXECUTION_NOT_AUTHORIZED';
          throw error;
        }
        const executionOptions = await canvasManager.executionOptions(id);
        return selectImage(id, {
          ...executionOptions,
          version: payload.version,
          page: payload.page,
          nodeId: payload.nodeId,
          expectedRevision: payload.expectedRevision,
          root: TASK_ROOT,
          signal,
        });
      });
    case 'canvas-state':
      hasFields(payload, ['expectedRevision']);
      hasOnlyFields(payload, ['expectedRevision']);
      requireExpectedRevision(payload.expectedRevision);
      return runWithCancellation((signal) => canvasManager.agentState(id, { expectedRevision: payload.expectedRevision, signal }));
    case 'canvas-read-image':
      hasFields(payload, ['nodeId', 'expectedRevision']);
      hasOnlyFields(payload, ['nodeId', 'expectedRevision']);
      if (typeof payload.nodeId !== 'string' || !payload.nodeId.trim()) throw usageError();
      requireExpectedRevision(payload.expectedRevision);
      return readCanvasImageToFile(id, payload);
    case 'canvas-detect-regions':
      hasFields(payload, ['nodeId', 'expectedRevision']);
      hasOnlyFields(payload, ['nodeId', 'expectedRevision', 'kinds']);
      if (typeof payload.nodeId !== 'string' || !payload.nodeId.trim()) throw usageError();
      if (payload.kinds !== undefined && (!Array.isArray(payload.kinds)
        || payload.kinds.length < 1 || payload.kinds.length > 3
        || payload.kinds.some((kind) => !['barcode', 'text', 'rectangle'].includes(kind))
        || new Set(payload.kinds).size !== payload.kinds.length)) throw usageError();
      requireExpectedRevision(payload.expectedRevision);
      return runWithCancellation((signal) => canvasManager.agentRegions(id, {
        nodeId: payload.nodeId, kinds: payload.kinds, expectedRevision: payload.expectedRevision, signal,
      }));
    case 'canvas-operation': {
      const operationFields = CANVAS_OPERATION_FIELDS[payload.operation];
      if (!operationFields) throw usageError();
      hasFields(payload, CANVAS_OPERATION_IDENTITY_FIELDS.filter((field) => field !== 'expectedSourceHashes'));
      hasOnlyFields(payload, [...CANVAS_OPERATION_IDENTITY_FIELDS, ...operationFields]);
      requireExpectedRevision(payload.expectedRevision);
      for (const key of ['operationId', 'requestId', 'callId']) {
        if (typeof payload[key] !== 'string' || !UUID.test(payload[key])) throw usageError();
      }
      if (typeof payload.userText !== 'string' || !payload.userText.trim()) throw usageError();
      return runWithCancellation((signal) => canvasManager.mechanicalOperation(id, { ...payload, signal }));
    }
    case 'record-review':
      requireReviewPayload(payload);
      if (!Number.isInteger(payload.page) || payload.page < 1) throw usageError();
      requireExpectedRevision(payload.expectedRevision);
      return recordReview(id, payload, { root: TASK_ROOT, expectedRevision: payload.expectedRevision });
    case 'approve-final':
      requireHumanConfirmation(payload, ['version', 'images', 'by', 'note', 'expectedRevision']);
      if (!Number.isInteger(payload.version) || payload.version < 1 || !Array.isArray(payload.images)) throw usageError();
      requireExpectedRevision(payload.expectedRevision);
      for (const image of payload.images) {
        if (!image || typeof image !== 'object' || Array.isArray(image) || !Number.isInteger(image.page) || image.page < 1 || typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(image.sha256)) throw usageError();
      }
      return approveFinal(id, payload, { root: TASK_ROOT, expectedRevision: payload.expectedRevision });
    case 'export':
      hasFields(payload, ['expectedRevision']);
      requireExpectedRevision(payload.expectedRevision);
      return exportTask(id, { root: TASK_ROOT, expectedRevision: payload.expectedRevision });
    case 'unlock':
      return unlockTask(id, payload);
    default:
      throw usageError();
  }
}

function errorMessage(error) {
  switch (error?.code) {
    case 'ERR_STUDIO_USAGE': return USAGE;
    case 'ERR_STUDIO_INPUT': return '输入文件不可用；请检查 JSON 文件后重试。';
    case 'ERR_TASK_NOT_FOUND': return '未找到指定任务。';
    case 'ERR_TASK_ENTRY_BUSY': return '任务正由其他入口推进或上次入口异常退出；请先查看 entry-status，结束原操作或核对已死亡PID后 release-entry。';
    case 'ERR_TASK_LOCKED': return '任务正被其他进程占用；请核对锁进程状态。';
    case 'ERR_TASK_REVISION_CONFLICT': return '任务已更新，本次写入已停止；请重新读取任务。';
    case 'ERR_STUDIO_EXECUTION_NOT_AUTHORIZED': return '当前 revision 或已授权执行版本不匹配；请重新 show 并核对制作单授权。';
    case 'ERR_STUDIO_RETRY_NOT_CONFIRMED': return '该页未被核实为失败，未启动 Canvas；请先读取任务与 Canvas 状态。';
    case 'ERR_STUDIO_UNLOCK': return '未清理任务锁；请核实锁文件中的 PID 与进程状态。';
    case 'ERR_STUDIO_ABORTED': return '已停止等待；已提交到 Canvas 的生成不保证撤销。';
    case 'ERR_CANVAS_OPERATION_UNKNOWN': return 'Canvas 操作结果未知；请先运行 canvas-state 核对，不要重试。';
    case 'ERR_CANVAS_TOOL_FAILED': return /^[0-9a-f-]{36}$/i.test(error.requestId || '')
      ? `Canvas 工具调用失败；诊断编号 ${error.requestId}，请核对画布日志，不要重复生成。`
      : 'Canvas 工具调用失败，请核对画布状态，不要重复生成。';
    case 'ERR_CANVAS_DISCONNECTED': return '当前任务 Canvas 未连接；先运行 canvas-open TASK_ID，再重试当前步骤。';
    case 'ERR_CANVAS_AMBIGUOUS': return '当前任务连接了多个 Canvas 页面；请只保留一个任务画布后重试。';
    case 'ERR_CANVAS_OPEN_BROWSER': return '任务 Canvas 已准备，但系统浏览器未能打开；请在本机浏览器打开公开 webUrl。';
    default: return '操作未完成；请检查输入、任务确认状态或 Canvas 连接。';
  }
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!action) throw usageError();
  const result = await dispatch(action, args);
  print(result);
}

main().catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
});
