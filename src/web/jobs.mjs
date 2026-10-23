import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { clearTaskLock, taskDirectory } from '../creative/tasks.mjs';
import { acquireTaskEntry, clearTaskEntry, taskEntryStatus } from '../creative/entry.mjs';
import { readAsset, recoverClean } from '../assets/library.mjs';
import { validateModelId } from './model-id.mjs';
import { validateAnswers, validateQuestions } from './clarifications.mjs';

const SAFE_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_REQUEST_ID = SAFE_JOB_ID;
const SAFE_SOURCE_ID = SAFE_JOB_ID;
const SHA256 = /^[0-9a-f]{64}$/i;
const SAFE_CANVAS_OPERATION_ID = SAFE_JOB_ID;
const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|authorization|bearer|bridgeUrl|filePath|absolutePath|^path$)/i;
const SECRET_TEXT = /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/gi;
const SECRET_QUERY = /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|ticket)=)[^&#\s]+/gi;
const SECRET_ASSIGNMENT = /\b(?:OPENAI_API_KEY|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)\s*[:=]\s*["']?[^\s,"'}]{8,}/gi;
const USER_PATH = /(?:file:\/\/)?(?:\/Users\/[^\s,"']+|\/home\/[^\s,"']+|[A-Za-z]:\\[^\s,"']+)/g;
const SAFE_JOB_ERROR_MESSAGES = Object.freeze({
  ERR_MODEL_CONFIG: '请先在模型与服务中保存完整基础模型配置。',
  ERR_MODEL_ID_INVALID: '所选模型 ID 格式无效；请从模型列表重新选择。',
  ERR_JOB_RELEASE_FAILED: '任务锁释放未能确认；请查看清理状态后重试。',
  ERR_TASK_ENTRY_RELEASE_FAILED: '任务入口清理未能确认；请按入口记录检查后再恢复。',
  ERR_CANVAS_TOOL_FAILED: 'Canvas 工具请求失败，请核对画布状态。',
  ERR_CANVAS_RESULT_READ_FAILED: '图片已返回但读取失败；请查看画布错误并重试。',
  ERR_ATTACHMENT_EXTRACTION: '附件提取未完成；任务未更新。',
  ERR_JOB_EVENT_WRITE: '任务进度保存失败；请刷新状态后再重试。',
  ERR_JOB_PERSIST_FAILED: '任务结果保存失败；请刷新状态后再重试。',
});
const activeJobIds = new Set();

function failedCleanup(code, message, retryId = null) {
  return {
    status: 'failed',
    error: { code, message },
    ...(retryId ? { retryId } : {}),
  };
}

function attachCleanup(error, cleanup) {
  try { error.cleanup = cleanup; return error; }
  catch {
    const wrapped = Object.assign(new Error(error?.message || '操作未完成'), error);
    wrapped.cleanup = cleanup;
    return wrapped;
  }
}

function jobFailureMessage(error, code, cancelled) {
  if (cancelled) return '操作已停止；已提交的上游请求不保证撤销。';
  if (code === 'ERR_CANVAS_TOOL_FAILED') {
    const diagnosticId = SAFE_JOB_ID.test(String(error?.requestId || '')) ? error.requestId : null;
    return diagnosticId
      ? `Canvas 工具请求失败，请核对画布日志（诊断编号 ${diagnosticId}）`
      : SAFE_JOB_ERROR_MESSAGES.ERR_CANVAS_TOOL_FAILED;
  }
  if (typeof error?.safeMessage === 'string') return safeText(error.safeMessage);
  if (code.startsWith('ERR_IMAGE_REGIONS_')) return '图像区域检测未完成；请读取当前任务状态后重试。';
  return SAFE_JOB_ERROR_MESSAGES[code] || '操作未完成；请读取当前状态后重试。';
}

function jobError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fingerprintJobPayload(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function requestKey(taskId, kind, requestId) {
  return JSON.stringify([taskId, kind, requestId]);
}

function requestIdentity(taskId, kind, requestId, fingerprint) {
  if (requestId == null && fingerprint == null) return null;
  if (typeof taskId !== 'string' || !SAFE_JOB_ID.test(taskId)
    || typeof kind !== 'string' || !kind.trim()
    || typeof requestId !== 'string' || !SAFE_JOB_ID.test(requestId)
    || typeof fingerprint !== 'string' || !SHA256.test(fingerprint)) {
    throw jobError('ERR_JOB_REQUEST_IDENTITY', '请求幂等标识无效');
  }
  return { key: requestKey(taskId, kind, requestId), requestId, fingerprint: fingerprint.toLowerCase() };
}

function identityConflict() {
  return jobError('ERR_JOB_IDEMPOTENCY_CONFLICT', '该 requestId 已用于不同请求内容');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function safeText(value) {
  return String(value)
    .replace(SECRET_TEXT, '[已隐藏凭据]')
    .replace(SECRET_QUERY, '$1[已隐藏]')
    .replace(SECRET_ASSIGNMENT, '[已隐藏凭据]')
    .replace(USER_PATH, '[本地文件]');
}

function sanitize(value) {
  if (typeof value === 'string') return safeText(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    output[key] = sanitize(child);
  }
  return output;
}

function clone(value) { return structuredClone(value); }

function jobsDirectory(root) { return path.join(path.resolve(root), 'web', 'jobs'); }
function jobFile(root, id) { return path.join(jobsDirectory(root), `${id}.json`); }

async function persist(job, root) {
  const directory = jobsDirectory(root);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = jobFile(root, job.id);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
}

function publicJob(job) {
  if (!job) return null;
  const {
    ownerPid: _ownerPid,
    ownerServerId: _ownerServerId,
    cancelRequested: _cancelRequested,
    resourceKey: _resourceKey,
    requestId: _requestId,
    fingerprint: _fingerprint,
    ...visible
  } = job;
  return sanitize(clone(visible));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function isRunning(job) { return job.status === 'queued' || job.status === 'running'; }

export function createJobManager({ root, onOperation } = {}) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('Job manager 需要数据根目录');
  const dataRoot = path.resolve(root);
  const serverId = crypto.randomUUID();
  const jobs = new Map();
  const requestJobs = new Map();
  const activeByResource = new Map();
  const controllers = new Map();
  const operations = new Map();
  const eventQueues = new Map();
  const finalizingJobs = new Set();
  const pendingEntryReleases = new Map();
  const retryingEntryReleases = new Map();

  async function initialize() {
    requestJobs.clear();
    const tasksRoot = path.join(dataRoot, 'tasks');
    const taskEntries = await fs.readdir(tasksRoot, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const entry of taskEntries) {
      if (!entry.isDirectory() || !SAFE_JOB_ID.test(entry.name)) continue;
      try {
        const owner = await taskEntryStatus(entry.name, { root: dataRoot });
        if (owner && !owner.alive) {
          await clearTaskEntry(entry.name, { root: dataRoot, deadPid: owner.pid });
        }
      } catch { /* Invalid or changing entry records remain untouched for explicit recovery. */ }
    }

    const directory = jobsDirectory(dataRoot);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const loadedJobs = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      if (!SAFE_JOB_ID.test(id)) continue;
      let job;
      try { job = JSON.parse(await fs.readFile(path.join(directory, entry.name), 'utf8')); }
      catch { continue; }
      if (!job || job.id !== id || typeof job.status !== 'string'
        || (job.taskId != null && !SAFE_JOB_ID.test(job.taskId))
        || (job.assetId != null && !SAFE_JOB_ID.test(job.assetId))) continue;
      const ownerAlive = processIsAlive(job.ownerPid);
      if (job.taskId && !ownerAlive) {
        try { await clearTaskEntry(job.taskId, { root: dataRoot, deadPid: job.ownerPid }); }
        catch { /* Keep recovery explicit when the task entry cannot be safely cleared. */ }
      }
      if (isRunning(job) && !activeJobIds.has(job.id) && !ownerAlive) {
        if (job.taskId) {
          try { await clearTaskLock(job.taskId, { root: dataRoot }); }
          catch (error) {
            if (error.code === 'ERR_TASK_LOCKED') {
              // The core rechecks PID and lock ownership before clearing it.
            }
          }
        }
        if (job.assetId) {
          try {
            const asset = await readAsset(job.assetId, { root: dataRoot });
            if (asset.status === 'cleaning' && asset.cleaningJob?.pid === job.ownerPid) {
              await recoverClean(job.assetId, {
                root: dataRoot,
                expectedRevision: asset.revision,
                deadPid: job.ownerPid,
              });
            }
          } catch { /* Keep the job recovery record; the asset UI can report its checked state. */ }
        }
        job.status = 'failed';
        job.updatedAt = new Date().toISOString();
        job.error = { code: 'ERR_JOB_INTERRUPTED', message: '服务在任务执行中退出；已保存的核心检查点保留，请读取当前状态后显式恢复。' };
        job.events ||= [];
        job.events.push({
          seq: (job.events.at(-1)?.seq || 0) + 1,
          time: job.updatedAt,
          stage: 'recovery',
          level: 'warning',
          message: job.error.message,
        });
      }
      jobs.set(id, job);
      loadedJobs.push(job);
      if (isRunning(job)) activeByResource.set(job.resourceKey || resourceFor(job), job.id);
      if (job.status === 'failed' && job.error?.code === 'ERR_JOB_INTERRUPTED') await persist(job, dataRoot);
    }
    loadedJobs.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || left.id.localeCompare(right.id));
    for (const job of loadedJobs) {
      let identity;
      try { identity = requestIdentity(job.taskId, job.kind, job.requestId, job.fingerprint); }
      catch { continue; }
      if (!identity) continue;
      const existing = requestJobs.get(identity.key);
      if (!existing) requestJobs.set(identity.key, { fingerprint: identity.fingerprint, job, ready: null });
      else if (existing.conflict || existing.fingerprint !== identity.fingerprint) requestJobs.set(identity.key, { conflict: true });
    }
  }

  function existingRequest(identity) {
    if (!identity) return null;
    const entry = requestJobs.get(identity.key);
    if (!entry) return null;
    if (entry.conflict || entry.fingerprint !== identity.fingerprint) throw identityConflict();
    return entry;
  }

  async function findRequest(taskId, kind, requestId, fingerprint) {
    const identity = requestIdentity(taskId, kind, requestId, fingerprint);
    const entry = existingRequest(identity);
    if (!entry) return null;
    if (entry.ready) await entry.ready;
    return publicJob(entry.job);
  }

  function resourceFor(job) {
    if (job.assetId) return `asset:${job.assetId}`;
    if (job.taskId) return `task:${job.taskId}`;
    return `job:${job.id}`;
  }

  function reserve(resourceKey) {
    const current = activeByResource.get(resourceKey);
    if (current) throw jobError('ERR_TASK_BUSY', '同一任务或素材已有操作正在运行，请稍后查看结果');
    const token = crypto.randomUUID();
    activeByResource.set(resourceKey, token);
    return token;
  }

  function release(resourceKey, token) {
    if (activeByResource.get(resourceKey) !== token) return false;
    activeByResource.delete(resourceKey);
    return true;
  }

  async function withMutation(resourceKey, operation) {
    if (typeof resourceKey !== 'string' || !resourceKey) throw new Error('mutation 需要 resourceKey');
    const token = reserve(resourceKey);
    let releaseEntry = null;
    let mutationId = null;
    let value;
    let operationError = null;
    try {
      const taskMatch = /^task:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(resourceKey);
      if (taskMatch) {
        mutationId = crypto.randomUUID();
        releaseEntry = await acquireTaskEntry(taskMatch[1], dataRoot, { jobId: mutationId });
      }
      value = await operation();
    } catch (error) {
      operationError = error;
    }
    let cleanup = null;
    try { await releaseEntry?.(); }
    catch {
      cleanup = failedCleanup('ERR_TASK_ENTRY_RELEASE_FAILED', SAFE_JOB_ERROR_MESSAGES.ERR_TASK_ENTRY_RELEASE_FAILED, mutationId);
      if (mutationId) {
        pendingEntryReleases.set(mutationId, {
          release: releaseEntry,
          taskId: resourceKey.slice('task:'.length),
          cleanup,
          job: null,
        });
      }
    }
    try {
      if (!release(resourceKey, token)) {
        cleanup ||= failedCleanup('ERR_JOB_RELEASE_FAILED', SAFE_JOB_ERROR_MESSAGES.ERR_JOB_RELEASE_FAILED);
      }
    } catch {
      cleanup ||= failedCleanup('ERR_JOB_RELEASE_FAILED', SAFE_JOB_ERROR_MESSAGES.ERR_JOB_RELEASE_FAILED);
    }
    if (operationError) throw cleanup ? attachCleanup(operationError, cleanup) : operationError;
    if (cleanup && value && typeof value === 'object' && !Array.isArray(value)) return { ...value, cleanup };
    if (cleanup) return { result: value, cleanup };
    return value;
  }

  async function appendEvent(job, event) {
    const incoming = event && typeof event === 'object' ? event : { text: String(event ?? '') };
    if (incoming.type && !['status', 'tool'].includes(incoming.type)) return;
    const time = typeof incoming.at === 'string' && Number.isFinite(Date.parse(incoming.at))
      ? incoming.at
      : new Date().toISOString();
    const text = safeText(incoming.text ?? incoming.message ?? '操作已更新').slice(0, 4000);
    const stage = incoming.type === 'tool' ? 'tool' : (incoming.type === 'status' ? 'status' : (incoming.stage || 'operation'));
    const level = new Set(['info', 'warning', 'error']).has(incoming.level) ? incoming.level : 'info';
    job.events ||= [];
    job.events.push({ seq: (job.events.at(-1)?.seq || 0) + 1, time, stage: safeText(stage).slice(0, 100), level, message: text });
    if (job.events.length > 300) job.events.splice(0, job.events.length - 300);
    job.updatedAt = new Date().toISOString();
    await persist(job, dataRoot);
    if (typeof onOperation === 'function' && job.taskId) {
      await onOperation(job.taskId, { time, stage, level, message: text, jobId: job.id });
    }
  }

  function enqueueEvent(job, event) {
    const previous = eventQueues.get(job.id) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => appendEvent(job, event));
    eventQueues.set(job.id, next);
    next.finally(() => {
      if (eventQueues.get(job.id) === next) eventQueues.delete(job.id);
    }).catch(() => {});
    return next;
  }

  async function start({ taskId = null, assetId = null, kind, model, run, resourceKey = null, requestId = null, fingerprint = null, resultView = (value) => value } = {}) {
    if (typeof kind !== 'string' || !kind.trim() || typeof run !== 'function') throw new Error('Job kind 与 run 必须有效');
    const key = resourceKey || (assetId ? `asset:${assetId}` : taskId ? `task:${taskId}` : null);
    if (!key) throw new Error('Job 必须绑定任务或素材');
    const safeModel = model === undefined ? undefined : validateModelId(model);
    const identity = requestIdentity(taskId, kind, requestId, fingerprint);
    const priorRequest = existingRequest(identity);
    if (priorRequest) {
      if (priorRequest.ready) await priorRequest.ready;
      return publicJob(priorRequest.job);
    }
    const ownerToken = reserve(key);
    let releaseEntry = null;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const job = {
      id,
      taskId,
      ...(assetId ? { assetId } : {}),
      kind,
      ...(safeModel ? { model: safeModel } : {}),
      ...(identity ? { requestId: identity.requestId, fingerprint: identity.fingerprint } : {}),
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      events: [],
      result: null,
      error: null,
      cleanup: { status: 'pending' },
      cancelRequested: false,
      ownerPid: process.pid,
      ownerServerId: serverId,
      resourceKey: key,
    };
    jobs.set(id, job);
    activeJobIds.add(id);
    const controller = new AbortController();
    controllers.set(id, controller);
    const requestReady = identity ? deferred() : null;
    if (identity) requestJobs.set(identity.key, { fingerprint: identity.fingerprint, job, ready: requestReady.promise });
    try {
      await persist(job, dataRoot);
      if (taskId) releaseEntry = await acquireTaskEntry(taskId, dataRoot, { jobId: id });
      requestReady?.resolve();
    }
    catch (error) {
      if (identity && requestJobs.get(identity.key)?.job === job) requestJobs.delete(identity.key);
      requestReady?.reject(error);
      controllers.delete(id);
      activeJobIds.delete(id);
      jobs.delete(id);
      await fs.rm(jobFile(dataRoot, id), { force: true }).catch(() => {});
      try { await releaseEntry?.(); }
      finally { release(key, ownerToken); }
      throw error;
    }
    const emitEvent = (event) => enqueueEvent(job, event);
    const operation = (async () => {
      let terminal = null;
      try {
        job.status = 'running';
        job.updatedAt = new Date().toISOString();
        await persist(job, dataRoot);
        await emitEvent({ type: 'status', text: '操作已开始' });
        const value = await run({
          signal: controller.signal,
          onEvent: emitEvent,
          jobId: id,
        });
        controller.signal.throwIfAborted();
        terminal = { status: 'succeeded', result: sanitize(await resultView(value)), error: null };
        finalizingJobs.add(id);
        try { await emitEvent({ type: 'status', text: '操作已完成' }); }
        catch { job.progressError = { code: 'ERR_JOB_EVENT_WRITE', message: SAFE_JOB_ERROR_MESSAGES.ERR_JOB_EVENT_WRITE }; }
      } catch (error) {
        finalizingJobs.add(id);
        const cancelled = controller.signal.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
        const code = typeof error?.code === 'string' && /^ERR_[A-Z0-9_]+$/.test(error.code)
          ? error.code
          : cancelled ? 'ERR_JOB_CANCELLED' : 'ERR_JOB_FAILED';
        const message = jobFailureMessage(error, code, cancelled);
        terminal = { status: cancelled ? 'cancelled' : 'failed', result: null, error: { code, message } };
        try {
          await emitEvent({ type: 'status', level: cancelled ? 'warning' : 'error', text: message });
        } catch { job.progressError = { code: 'ERR_JOB_EVENT_WRITE', message: SAFE_JOB_ERROR_MESSAGES.ERR_JOB_EVENT_WRITE }; }
      } finally {
        finalizingJobs.add(id);
        try {
          const pendingEvents = eventQueues.get(id);
          if (pendingEvents) await pendingEvents;
        } catch { job.progressError = { code: 'ERR_JOB_EVENT_WRITE', message: SAFE_JOB_ERROR_MESSAGES.ERR_JOB_EVENT_WRITE }; }
        const terminalAt = new Date().toISOString();
        let cleanup = { status: 'succeeded' };
        try { await releaseEntry?.(); }
        catch {
          cleanup = failedCleanup('ERR_JOB_RELEASE_FAILED', SAFE_JOB_ERROR_MESSAGES.ERR_JOB_RELEASE_FAILED, id);
          pendingEntryReleases.set(id, { release: releaseEntry, taskId, cleanup, job });
        }
        try { if (!release(key, ownerToken)) cleanup = failedCleanup('ERR_JOB_RELEASE_FAILED', SAFE_JOB_ERROR_MESSAGES.ERR_JOB_RELEASE_FAILED, cleanup.retryId || null); }
        catch { cleanup = failedCleanup('ERR_JOB_RELEASE_FAILED', SAFE_JOB_ERROR_MESSAGES.ERR_JOB_RELEASE_FAILED, cleanup.retryId || null); }
        job.cleanup = cleanup;
        if (!terminal) {
          terminal = {
            status: 'failed',
            result: null,
            error: { code: 'ERR_JOB_PERSIST_FAILED', message: SAFE_JOB_ERROR_MESSAGES.ERR_JOB_PERSIST_FAILED },
          };
        }
        controllers.delete(id);
        activeJobIds.delete(id);
        const completed = { ...job, ...terminal, updatedAt: terminalAt };
        try {
          await persist(completed, dataRoot);
          Object.assign(job, completed);
        } catch {
          const persistenceFailure = {
            ...job,
            status: 'failed',
            result: null,
            error: { code: 'ERR_JOB_PERSIST_FAILED', message: SAFE_JOB_ERROR_MESSAGES.ERR_JOB_PERSIST_FAILED },
            updatedAt: terminalAt,
          };
          Object.assign(job, persistenceFailure);
          await persist(persistenceFailure, dataRoot).catch(() => {});
        }
        finalizingJobs.delete(id);
      }
    })();
    operations.set(id, operation);
    operation.finally(() => operations.delete(id)).catch(() => {});
    return publicJob(job);
  }

  function get(id) {
    if (!SAFE_JOB_ID.test(String(id))) return null;
    return publicJob(jobs.get(id));
  }

  function latestForTask(taskId) {
    const records = [...jobs.values()].filter((job) => job.taskId === taskId);
    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return publicJob(records[0] || null);
  }

  function latestForAsset(assetId) {
    const records = [...jobs.values()].filter((job) => job.assetId === assetId);
    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return publicJob(records[0] || null);
  }

  async function cancel(id) {
    const job = jobs.get(id);
    if (!job) return null;
    if ((job.status !== 'queued' && job.status !== 'running') || finalizingJobs.has(id)) return publicJob(job);
    job.cancelRequested = true;
    job.updatedAt = new Date().toISOString();
    controllers.get(id)?.abort();
    await enqueueEvent(job, { type: 'status', level: 'warning', text: '已请求停止；正在等待操作确认取消。' });
    return publicJob(job);
  }

  async function retryCleanup(id) {
    if (!SAFE_JOB_ID.test(String(id))) return null;
    const job = jobs.get(id) || null;
    const pending = pendingEntryReleases.get(id);
    if (!pending) {
      if (job?.cleanup?.status === 'failed') {
        throw jobError('ERR_JOB_CLEANUP_UNAVAILABLE', '当前服务进程没有可验证的入口释放记录，未解除占用。');
      }
      return null;
    }
    if (retryingEntryReleases.has(id)) {
      return retryingEntryReleases.get(id);
    }
    if ((job && (job.ownerServerId !== serverId || isRunning(job) || finalizingJobs.has(id) || operations.has(id) || activeJobIds.has(id)))
      || (pending.taskId && activeByResource.has(`task:${pending.taskId}`))) {
      throw jobError('ERR_JOB_CLEANUP_ACTIVE', '任务仍有活动操作，未尝试释放入口。');
    }
    const attempt = (async () => {
      try {
        await pending.release();
        pendingEntryReleases.delete(id);
        pending.cleanup = { status: 'succeeded' };
      } catch {
        pending.cleanup = failedCleanup('ERR_JOB_RELEASE_FAILED', SAFE_JOB_ERROR_MESSAGES.ERR_JOB_RELEASE_FAILED, id);
      }
      if (job) {
        job.cleanup = pending.cleanup;
        job.updatedAt = new Date().toISOString();
        await persist(job, dataRoot);
      }
      return { cleanup: pending.cleanup, ...(job ? { job: publicJob(job) } : {}) };
    })();
    retryingEntryReleases.set(id, attempt);
    try { return await attempt; }
    finally { retryingEntryReleases.delete(id); }
  }

  async function close({ timeoutMs = 5000 } = {}) {
    for (const controller of controllers.values()) controller.abort();
    const pending = [...operations.values()];
    if (pending.length) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    }
  }

  return {
    initialize,
    start,
    get,
    retryCleanup,
    latestForTask,
    latestForAsset,
    findRequest,
    cancel,
    withMutation,
    close,
  };
}

export async function readConversation(taskId, root) {
  const file = path.join(taskDirectory(taskId, root), 'web', 'conversation.json');
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(value)) return [];
    return sanitize(value).slice(-500);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    return [];
  }
}

export async function appendConversation(taskId, message, root) {
  const directory = path.join(taskDirectory(taskId, root), 'web');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'conversation.json');
  const messages = await readConversation(taskId, root);
  if (message.requestId !== undefined && (message.role !== 'user' || typeof message.requestId !== 'string' || !SAFE_REQUEST_ID.test(message.requestId))) {
    throw jobError('ERR_CONVERSATION_INVALID', '会话请求 ID 格式无效');
  }
  const answers = message.answers === undefined ? null : validateAnswers(messages, message.answers);
  let attachmentSourceIds;
  if (message.attachmentSourceIds !== undefined) {
    if (message.role !== 'user' || !Array.isArray(message.attachmentSourceIds) || message.attachmentSourceIds.length > 20
      || message.attachmentSourceIds.some((id) => typeof id !== 'string' || !SAFE_SOURCE_ID.test(id))
      || new Set(message.attachmentSourceIds).size !== message.attachmentSourceIds.length) {
      throw jobError('ERR_CONVERSATION_INVALID', '会话附件来源 ID 列表无效');
    }
    attachmentSourceIds = message.attachmentSourceIds;
  }
  let attachments;
  if (message.attachments !== undefined) {
    if (message.role !== 'assistant' || !Array.isArray(message.attachments) || message.attachments.length > 200) {
      throw jobError('ERR_CONVERSATION_INVALID', '机械图片附件列表无效');
    }
    attachments = message.attachments.map((attachment) => {
      if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
        throw jobError('ERR_CONVERSATION_INVALID', '机械图片附件记录无效');
      }
      const name = attachment.name;
      const mimeType = attachment.mimeType;
      const size = attachment.size;
      const hash = attachment.sha256;
      const fileUrl = attachment.fileUrl;
      const downloadUrl = attachment.downloadUrl;
      const allowedType = new Set(['image/png', 'image/jpeg', 'image/webp']).has(mimeType);
      const urlMatch = typeof fileUrl === 'string'
        ? new RegExp(`^/api/tasks/${taskId}/canvas-operations/(${SAFE_CANVAS_OPERATION_ID.source.slice(1, -1)})/images/(\\d+)$`).exec(fileUrl)
        : null;
      if (typeof name !== 'string' || !/^canvas-(?:crop|split|resample|stitch|compose)-\d{2,3}\.(?:png|jpg|webp)$/.test(name)
        || !allowedType || !Number.isInteger(size) || size < 1 || size > 20 * 1024 * 1024
        || typeof hash !== 'string' || !SHA256.test(hash) || !urlMatch || !SAFE_CANVAS_OPERATION_ID.test(urlMatch[1])
        || Number(urlMatch[2]) < 0 || Number(urlMatch[2]) > 24
        || downloadUrl !== `${fileUrl}?download=1`) {
        throw jobError('ERR_CONVERSATION_INVALID', '机械图片附件字段无效');
      }
      return { name, mimeType, size, sha256: hash.toLowerCase(), fileUrl, downloadUrl };
    });
  }
  const safeMessage = sanitize({
    id: message.id || crypto.randomUUID(),
    role: message.role,
    text: safeText(answers?.summary ?? message.text ?? ''),
    ...(message.requestId === undefined ? {} : { requestId: message.requestId }),
    ...(attachmentSourceIds === undefined ? {} : { attachmentSourceIds }),
    ...(attachments === undefined ? {} : { attachments }),
    ...(message.role === 'assistant' && Array.isArray(message.deliverables) ? {deliverables:message.deliverables} : {}),
    ...(answers ? { answers: answers.answers } : {}),
    ...(message.questions === undefined ? {} : { questions: validateQuestions(message.questions) }),
    ...(message.role === 'assistant' && message.referenceProposal ? {referenceProposal:message.referenceProposal} : {}),
    ...(message.model === undefined ? {} : { model: validateModelId(message.model) }),
    createdAt: message.createdAt || new Date().toISOString(),
  });
  if (!['user', 'assistant'].includes(safeMessage.role) || typeof safeMessage.text !== 'string') {
    throw jobError('ERR_CONVERSATION_INVALID', '会话消息格式无效');
  }
  messages.push(safeMessage);
  if (messages.length > 500) messages.splice(0, messages.length - 500);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(messages, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
  return safeMessage;
}

export async function appendOperation(taskId, event, root) {
  const directory = path.join(taskDirectory(taskId, root), 'web');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'operations.json');
  let events = [];
  try {
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Array.isArray(stored)) events = stored;
  } catch { /* Recover an unreadable operation view without exposing the file contents. */ }
  events.push(sanitize({
    id: crypto.randomUUID(),
    at: event.time || new Date().toISOString(),
    stage: event.stage,
    level: event.level,
    message: event.message,
    jobId: event.jobId,
  }));
  if (events.length > 1000) events.splice(0, events.length - 1000);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(events, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
  return events.at(-1);
}

export async function readOperations(taskId, root) {
  const file = path.join(taskDirectory(taskId, root), 'web', 'operations.json');
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(value) ? sanitize(value).slice(-1000) : [];
  } catch { return []; }
}
