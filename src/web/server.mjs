import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
  approveFinal,
  confirmInputs,
  confirmSheet,
  createTask,
  exportTask,
  readTask,
  recordReview,
  setAssetSources,
  setBrief,
  setSheet,
  setSources,
  applyDna,
  attachTaskFiles,
  taskDirectory,
  setReferences,
  withTask,
  isSheetAuthorized,
} from '../creative/tasks.mjs';
import { executeTask } from '../creative/executor.mjs';
import { readCanvasOperationImage } from '../creative/canvas-operations.mjs';
import { editTaskPages, restorePageEdit } from '../creative/page-edits.mjs';
import {
  confirmAsset,
  deleteAsset,
  deleteTag,
  editAsset,
  importAsset,
  listAssets,
  listTags,
  queryAssets,
  readAsset,
  renameTag,
  replaceAssetFiles,
  cleanAsset,
} from '../assets/library.mjs';
import { readDna, saveDna } from '../dna/profile.mjs';
import { extractFile } from '../assets/cleaner.mjs';
import { importFolder } from '../assets/folders.mjs';
import { dataRoot } from '../canvas/client.mjs';
import {
  appendConversation,
  appendOperation,
  createJobManager,
  fingerprintJobPayload,
  readConversation,
  readOperations,
} from './jobs.mjs';
import { callModelPlugin, MODEL_SOURCES } from './model-plugin.mjs';
import { publicConfig, resolveBasicConfig, readConfig as defaultReadConfig, readConfigRecord, saveConfig } from './config.mjs';
import { validateModelId } from './model-id.mjs';
import { validateAnswers, validateQuestions } from './clarifications.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const MAX_UPLOAD_FILES = 20;
const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TASK_EXTRACTION_CHARS = 200_000;
const MAX_MODEL_LIST_BYTES = 2 * 1024 * 1024;
const MODEL_CHECK_TIMEOUT_MS = 8_000;
const MAX_PAGE_LIMIT = 200;
const PRIVATE_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|authorization|bearer|bridgeUrl|filePath|absolutePath|relativePath|^path$)/i;
const PRIVATE_TEXT = /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/gi;
const PRIVATE_QUERY = /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|ticket)=)[^&#\s]+/gi;
const PRIVATE_ASSIGNMENT = /\b(?:OPENAI_API_KEY|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)\s*[:=]\s*["']?[^\s,"'}]{8,}/gi;
const ABSOLUTE_PATH = /(?:file:\/\/)?(?:\/Users\/[^\s,"']+|\/home\/[^\s,"']+|[A-Za-z]:\\[^\s,"']+)/g;
const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/bmp',
  'application/pdf', 'text/plain', 'text/markdown', 'application/octet-stream',
]);
const MIME_BY_EXTENSION = new Map([
  ['.ico', 'image/x-icon'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.bmp', 'image/bmp'],
  ['.pdf', 'application/pdf'], ['.txt', 'text/plain'], ['.md', 'text/markdown'], ['.zip', 'application/zip'],
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.svg', 'image/svg+xml'], ['.json', 'application/json; charset=utf-8'],
  ['.woff2', 'font/woff2'],
]);

function error(code, message, status = 400, details) {
  const value = new Error(message);
  value.code = code;
  value.statusCode = status;
  value.details = details;
  return value;
}

function sanitizeText(value) {
  return String(value ?? '')
    .replace(PRIVATE_TEXT, '[已隐藏凭据]')
    .replace(PRIVATE_QUERY, '$1[已隐藏]')
    .replace(PRIVATE_ASSIGNMENT, '[已隐藏凭据]')
    .replace(ABSOLUTE_PATH, '[本地文件]');
}

function sanitizeValue(value) {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEY.test(key)) continue;
    result[key] = sanitizeValue(child);
  }
  return result;
}

function providerModelsEndpoint(baseUrl) {
  const endpoint = new URL(baseUrl);
  const pathname = endpoint.pathname.replace(/\/+$/, '');
  endpoint.pathname = /\/v1$/i.test(pathname) ? `${pathname}/models` : `${pathname}/v1/models`;
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint;
}

function defaultBaseModel(config) {
  if (!config?.model) throw error('ERR_MODEL_NOT_CONFIGURED', '请先配置基础模型，或为本轮选择模型');
  return validateModelId(config.model);
}

function modelListChannel(body, saved) {
  if (Object.keys(body).some((key) => !['kind', 'source', 'baseUrl', 'apiKey'].includes(key))) {
    throw error('ERR_MODEL_LIST_INPUT', '模型列表请求包含不支持的字段');
  }
  if (body.baseUrl !== undefined && typeof body.baseUrl !== 'string') {
    throw error('ERR_MODEL_LIST_INPUT', '服务地址必须是文本');
  }
  if (body.apiKey !== undefined && typeof body.apiKey !== 'string') {
    throw error('ERR_MODEL_LIST_INPUT', '密钥必须是文本');
  }
  if ((typeof body.baseUrl === 'string' && body.baseUrl.length > 2000)
    || (typeof body.apiKey === 'string' && body.apiKey.length > 5000)) {
    throw error('ERR_MODEL_LIST_INPUT', '模型服务地址或密钥长度超出限制');
  }
  const suppliedUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
  const baseUrl = suppliedUrl || saved.baseUrl;
  if (!baseUrl || baseUrl.length > 2000) throw error('ERR_MODEL_LIST_CONFIG', '请提供有效的模型服务地址');
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw error('ERR_MODEL_LIST_CONFIG', '模型服务地址无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw error('ERR_MODEL_LIST_CONFIG', '模型服务地址仅支持不含凭据或查询参数的 HTTP(S) 地址');
  }
  const suppliedKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (/[\u0000-\u001f\u007f]/.test(suppliedKey)) throw error('ERR_MODEL_LIST_INPUT', '密钥格式无效');
  const sameUrl = baseUrl === saved.baseUrl;
  const apiKey = suppliedKey || (sameUrl ? saved.apiKey : '');
  if (!apiKey) {
    if (!sameUrl) throw error('ERR_MODEL_KEY_REQUIRED', '服务地址已变化，请提供对应密钥后重试');
    throw error('ERR_MODEL_LIST_CONFIG', '请先配置模型服务密钥');
  }
  return { baseUrl, apiKey };
}

async function listProviderModels(channel, { fetchImpl = globalThis.fetch, signal } = {}) {
  let response;
  try {
    const endpoint = providerModelsEndpoint(channel.baseUrl);
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(MODEL_CHECK_TIMEOUT_MS)])
      : AbortSignal.timeout(MODEL_CHECK_TIMEOUT_MS);
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${channel.apiKey}` },
      redirect: 'manual',
      signal: requestSignal,
    });
  } catch {
    throw error('ERR_MODEL_LIST_UNAVAILABLE', '模型服务连接失败；请检查服务地址和本机网络。', 502);
  }
  if (response.status >= 300 && response.status < 400) {
    throw error('ERR_MODEL_LIST_REDIRECT', '模型服务要求重定向；为避免转发凭据，已停止请求。', 502);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw error('ERR_MODEL_LIST_AUTH', '模型服务认证失败；请核对密钥和访问权限。', 502);
    }
    if (response.status === 404 || response.status === 405) {
      throw error('ERR_MODEL_LIST_UNSUPPORTED', '模型服务未提供标准只读模型列表端点。', 502);
    }
    throw error('ERR_MODEL_LIST_UNAVAILABLE', '模型服务未能返回模型列表。', 502);
  }
  let bytes;
  try { bytes = await readLimitedBody(response, MAX_MODEL_LIST_BYTES); }
  catch { throw error('ERR_MODEL_LIST_INVALID', '模型服务未返回可读取的标准模型列表。', 502); }
  if (!bytes) throw error('ERR_MODEL_LIST_TOO_LARGE', '模型服务列表超过读取上限。', 502);
  let payload;
  try { payload = JSON.parse(bytes.toString('utf8')); }
  catch { throw error('ERR_MODEL_LIST_INVALID', '模型服务未返回可读取的标准模型列表。', 502); }
  if (!Array.isArray(payload?.data)) throw error('ERR_MODEL_LIST_INVALID', '模型服务未返回标准模型列表。', 502);

  const models = [];
  const seen = new Set();
  for (const entry of payload.data) {
    if (!entry || typeof entry.id !== 'string') continue;
    let id;
    try { id = validateModelId(entry.id); } catch { continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    const model = { id };
    if (typeof entry.name === 'string' && entry.name.trim()) {
      model.name = sanitizeText(entry.name).slice(0, 300);
    }
    models.push(model);
  }
  return models;
}

async function readLimitedBody(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

async function checkImageProvider(channel, { fetchImpl = globalThis.fetch, signal } = {}) {
  const checkedAt = new Date().toISOString();
  const capabilities = {
    provider: 'openai-compatible',
    model: sanitizeText(channel.model),
    connectionTested: false,
    modelsEndpointAvailable: false,
    modelListed: null,
  };
  let response;
  try {
    const endpoint = providerModelsEndpoint(channel.baseUrl);
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(MODEL_CHECK_TIMEOUT_MS)])
      : AbortSignal.timeout(MODEL_CHECK_TIMEOUT_MS);
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${channel.apiKey}`,
      },
      redirect: 'manual',
      signal: requestSignal,
    });
  } catch {
    return {
      status: 'failed', checkedAt, capabilities,
      message: '图片服务连接检查失败；请检查服务地址、密钥和本机网络。',
    };
  }

  capabilities.connectionTested = true;
  if (response.status >= 300 && response.status < 400) {
    return {
      status: 'unverified', checkedAt, capabilities,
      message: '图片服务要求重定向；为避免转发凭据，检查已停止，模型待核。',
    };
  }
  if (response.status === 404 || response.status === 405) {
    return {
      status: 'unverified', checkedAt, capabilities,
      message: '图片服务未提供标准只读模型列表端点；服务已响应，但模型待核。',
    };
  }
  if (!response.ok) {
    return {
      status: 'failed', checkedAt, capabilities,
      message: response.status === 401 || response.status === 403
        ? '图片服务认证失败；请核对密钥和访问权限。'
        : `图片服务返回 HTTP ${response.status}；未确认模型可用。`,
    };
  }

  const body = await readLimitedBody(response, MAX_MODEL_LIST_BYTES);
  if (!body) {
    return {
      status: 'unverified', checkedAt, capabilities,
      message: '图片服务模型列表超过检查上限；连接已响应，但模型待核。',
    };
  }
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch {
    return {
      status: 'unverified', checkedAt, capabilities,
      message: '图片服务未返回标准模型列表；连接已响应，但模型待核。',
    };
  }
  if (!Array.isArray(payload?.data)) {
    return {
      status: 'unverified', checkedAt, capabilities,
      message: '图片服务未提供标准模型列表；连接已响应，但模型待核。',
    };
  }
  capabilities.modelsEndpointAvailable = true;
  capabilities.modelListed = payload.data.some((model) => model?.id === channel.model || model?.name === channel.model);
  if (!capabilities.modelListed) {
    return {
      status: 'failed', checkedAt, capabilities,
      message: '图片服务可访问，但配置的模型未出现在模型列表中。',
    };
  }
  return {
    status: 'connected', checkedAt, capabilities,
    message: '图片服务连接及只读模型列表检查通过；未发起生图请求。',
  };
}

function assertUuid(id, label = '任务 ID') {
  const value = decodeURIComponent(String(id ?? ''));
  if (!UUID.test(value)) throw error('ERR_ID_INVALID', `${label}无效`);
  return value;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function requiredRevision(value) {
  if (!Number.isInteger(value) || value < 1) throw error('ERR_TASK_REVISION_REQUIRED', '必须指定正整数 expectedRevision');
  return value;
}

function isLoopback(value) {
  const host = String(value ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
}

function hostNameFromHeader(value) {
  if (typeof value !== 'string' || !value || /[\s/@\\]/.test(value)) return null;
  try { return new URL(`http://${value}`).hostname.toLowerCase().replace(/^\[|\]$/g, ''); }
  catch { return null; }
}

function remoteIsLoopback(value) {
  if (!value) return true;
  const address = String(value).toLowerCase().split('%')[0];
  return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.');
}

function assertRequestOrigin(request, mutating) {
  const host = request.headers.host;
  const hostName = hostNameFromHeader(host);
  if (!hostName || !isLoopback(hostName) || !remoteIsLoopback(request.socket.remoteAddress)) {
    throw error('ERR_LOCAL_ONLY', '此服务只接受本机请求', 403);
  }
  if (!mutating) return;
  const originHeader = request.headers.origin;
  if (typeof originHeader !== 'string' || !originHeader || originHeader === 'null') {
    throw error('ERR_ORIGIN_REQUIRED', '写入请求必须来自本地同源页面', 403);
  }
  let origin;
  try { origin = new URL(originHeader); } catch {
    throw error('ERR_ORIGIN_INVALID', '写入请求来源无效', 403);
  }
  if (!['http:', 'https:'].includes(origin.protocol)
    || !isLoopback(origin.hostname)
    || origin.host.toLowerCase() !== host.toLowerCase()
    || request.headers['sec-fetch-site'] === 'cross-site') {
    throw error('ERR_CSRF_REJECTED', '写入请求来源与本地工作台不一致', 403);
  }
}

function contentType(request) { return String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase(); }

async function readBody(request, limit) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw error('ERR_BODY_TOO_LARGE', '请求内容超过大小限制', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw error('ERR_BODY_TOO_LARGE', '请求内容超过大小限制', 413);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

async function readJson(request, { optional = false, limit = MAX_JSON_BYTES } = {}) {
  const type = contentType(request);
  if (optional && (!type || Number(request.headers['content-length'] || 0) === 0)) return {};
  if (type !== 'application/json') throw error('ERR_CONTENT_TYPE', '请求必须使用 application/json');
  const bytes = await readBody(request, limit);
  if (!bytes.length && optional) return {};
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid object');
    return value;
  } catch {
    throw error('ERR_JSON_INVALID', '请求 JSON 格式无效');
  }
}

function parseJsonField(form, field, fallback) {
  const value = form.get(field);
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') throw error('ERR_MULTIPART_FIELD', `${field} 必须是文本`);
  try { return JSON.parse(value); }
  catch { throw error('ERR_MULTIPART_FIELD', `${field} 的 JSON 格式无效`); }
}

async function parseMultipart(request, { root, maxBytes, allowedFileCount = MAX_UPLOAD_FILES } = {}) {
  const header = String(request.headers['content-type'] ?? '');
  if (!/^multipart\/form-data\s*;/i.test(header)) throw error('ERR_CONTENT_TYPE', '文件导入必须使用 multipart/form-data');
  const bytes = await readBody(request, maxBytes);
  let form;
  try {
    const webRequest = new Request('http://127.0.0.1/upload', {
      method: 'POST',
      headers: { 'content-type': header },
      body: bytes,
    });
    form = await webRequest.formData();
  } catch {
    throw error('ERR_MULTIPART_INVALID', 'multipart 文件内容无效');
  }
  const files = form.getAll('files').filter((value) => typeof value !== 'string');
  if (files.length < 1 || files.length > allowedFileCount) throw error('ERR_FILE_COUNT', `文件数必须为 1 到 ${allowedFileCount}`);
  const directory = path.join(path.resolve(root), 'web', 'uploads', crypto.randomUUID());
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const installed = [];
  try {
    const normalizedFiles = [];
    for (const [index, file] of files.entries()) {
      if (file.size > MAX_UPLOAD_FILE_BYTES) throw error('ERR_FILE_TOO_LARGE', '单个文件不能超过 100 MiB', 413);
      const name = path.basename(file.name || `file-${index + 1}`)
        .replace(/[\u0000-\u001f\u007f]/g, '_')
        .slice(0, 255);
      if (!name) throw error('ERR_FILE_NAME', '文件名无效');
      const extension = path.extname(name).toLowerCase();
      const buffer = Buffer.from(await file.arrayBuffer());
      if (!buffer.length) throw error('ERR_FILE_EMPTY', '不能导入空文件');
      const destination = path.join(directory, `${String(index + 1).padStart(3, '0')}${extension || '.upload'}`);
      await fs.writeFile(destination, buffer, { flag: 'wx', mode: 0o600 });
      installed.push(destination);
      normalizedFiles.push({
        order: index,
        name: name || `file-${index + 1}`,
        mimeType: mimeForFile(name, file.type || 'application/octet-stream'),
        path: destination,
      });
    }
    return {
      form,
      files: normalizedFiles,
      cleanup: () => fs.rm(directory, { recursive: true, force: true }),
    };
  } catch (errorValue) {
    await Promise.all(installed.map((file) => fs.rm(file, { force: true }).catch(() => {})));
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw errorValue;
  }
}

function taskExtraction(result, originalName) {
  const pages = Array.isArray(result?.pages) ? result.pages.map((page) => ({
    page: page.page,
    ...(typeof page.nativeText === 'string' ? { nativeText: sanitizeText(page.nativeText) } : {}),
    ...(typeof page.ocrText === 'string' ? { ocrText: sanitizeText(page.ocrText) } : {}),
    ...(typeof page.text === 'string' ? { text: sanitizeText(page.text) } : {}),
    warnings: Array.isArray(page.warnings) ? page.warnings.map(sanitizeText) : [],
  })) : [];
  return {
    name: sanitizeText(originalName),
    kind: typeof result?.kind === 'string' ? sanitizeText(result.kind) : 'unknown',
    extractor: typeof result?.extractor === 'string' ? sanitizeText(result.extractor) : 'unknown',
    status: typeof result?.status === 'string' ? sanitizeText(result.status) : 'unavailable',
    text: typeof result?.text === 'string' ? sanitizeText(result.text) : '',
    pages,
    warnings: Array.isArray(result?.warnings) ? result.warnings.map(sanitizeText) : [],
  };
}

async function extractTaskUploads(files, signal) {
  const extractions = [];
  let totalLength = 0;
  const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.pdf', '.txt', '.md']);
  for (const file of files) {
    const extension = path.extname(file.name).toLowerCase();
    if (!allowed.has(extension)) throw error('ERR_ATTACHMENT_TYPE', `暂不支持附件格式：${extension || '无扩展名'}`, 415);
    signal?.throwIfAborted();
    let extracted;
    try { extracted = taskExtraction(await extractFile(file.path, { signal }), file.name); }
    catch (cause) {
      const message = sanitizeText(cause?.safeMessage || cause?.message || '本地提取失败；任务未更新。');
      const failure = error('ERR_ATTACHMENT_EXTRACTION', message, 422);
      failure.safeMessage = message;
      throw failure;
    }
    totalLength += JSON.stringify(extracted).length;
    if (totalLength > MAX_TASK_EXTRACTION_CHARS) {
      throw error('ERR_ATTACHMENT_TEXT_TOO_LARGE', '附件提取文本总量超过 200000 字符；任务未更新。', 413);
    }
    extractions.push(extracted);
  }
  return extractions;
}

function json(response, status, body) {
  if (response.destroyed) return;
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': encoded.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
  });
  response.end(encoded);
}

function apiError(errorValue) {
  const code = typeof errorValue?.code === 'string' && /^ERR_[A-Z0-9_]+$/.test(errorValue.code)
    ? errorValue.code
    : 'ERR_REQUEST_FAILED';
  let status = errorValue?.statusCode || 400;
  if (!errorValue?.statusCode) {
    if (/NOT_FOUND|NO_TASK|NO_ASSET/.test(code)) status = 404;
    else if (/CONFLICT|BUSY|LOCKED|STALE|REVISION|IMAGE_CHANGED|SYNC_REQUIRED|TARGET_CHANGED|SELECTION_CHANGED|PROJECT_MISMATCH/.test(code)) status = 409;
    else if (/INTERNAL|FAILED$/.test(code) && code !== 'ERR_ASSET_CLEAN_FAILED') status = 500;
  }
  const raw = typeof errorValue?.safeMessage === 'string'
    ? errorValue.safeMessage
    : (typeof errorValue?.message === 'string' ? errorValue.message : '请求未完成');
  const message = sanitizeText(raw).slice(0, 500);
  const details = {};
  for (const key of ['expectedRevision', 'actualRevision', 'expectedInputRevision', 'actualInputRevision']) {
    if (Number.isInteger(errorValue?.[key])) details[key] = errorValue[key];
  }
  return { status, body: { error: { code, message, ...(Object.keys(details).length ? { details } : {}) } } };
}

function publicAsset(record) {
  const result = sanitizeValue(structuredClone(record));
  if (Array.isArray(record.files)) {
    result.files = record.files.map((file) => ({
      order: file.order,
      name: sanitizeText(file.name),
      mimeType: ALLOWED_MIME.has(file.mimeType) ? file.mimeType : 'application/octet-stream',
      size: file.size,
      sha256: file.sha256,
      fileUrl: `/api/assets/${encodeURIComponent(record.id)}/files/${file.order}`,
    }));
  }
  return result;
}

function publicTask(task) {
  const result = sanitizeValue(structuredClone(task));
  result.sheetAuthorized = isSheetAuthorized(task);
  const rootTaskId = encodeURIComponent(task.id);
  const rewritePages = (pages, version) => {
    for (const page of pages || []) {
      if (!page.image) continue;
      delete page.image.path;
      page.image.imageUrl = `/api/tasks/${rootTaskId}/images/${page.page}?version=${version}`;
    }
  };
  rewritePages(result.execution?.pages, result.execution?.version ?? result.sheetVersion);
  for (const execution of result.executionHistory || []) rewritePages(execution.pages, execution.version);
  for (const source of result.sources || []) {
    delete source.uploadId;
    delete source.uploadFingerprint;
    delete source.uploadRevision;
    source.files = (source.files || []).map((file, index) => ({
      order: file.order ?? index,
      name: sanitizeText(file.name || `原件 ${index + 1}`),
      mimeType: ALLOWED_MIME.has(file.mimeType) ? file.mimeType : 'application/octet-stream',
      sha256: file.sha256,
      fileUrl: `/api/tasks/${rootTaskId}/source-files/${encodeURIComponent(source.id)}/${file.order ?? index}`,
    }));
  }
  result.exports = (result.exports || []).map((record) => ({
    version: record.version,
    generatedAt: record.generatedAt,
    archiveSha256: record.archiveSha256,
    downloadUrl: `/api/tasks/${rootTaskId}/exports/${encodeURIComponent(record.version)}`,
    files: (record.files || []).map(({ path: _path, ...file }) => file),
  }));
  return result;
}

async function finalApprovalIsCurrent(task, root) {
  if (!isSheetAuthorized(task)) return false;
  if (!task.finalApproval || task.finalApproval.version !== task.sheetVersion) return false;
  const pages = task.execution?.pages || [];
  const approved = new Map((task.finalApproval.images || []).map((image) => [image.page, image.sha256]));
  if (!pages.length) return false;
  for (const page of pages) {
    if (page.status !== 'succeeded' || !page.image?.sha256 || approved.get(page.page) !== page.image.sha256) return false;
    try {
      const id = assertUuid(task.id);
      const base = taskDirectory(id, root);
      const absolute = path.resolve(page.image.path || '');
      const relative = path.relative(base, absolute);
      if (!page.image.path || !isInside(base, absolute)) return false;
      const resolved = await safeFilePath(root, path.join('tasks', id, relative), path.join('tasks', id));
      if (await hashFile(resolved.filePath) !== page.image.sha256) return false;
    } catch { return false; }
  }
  return true;
}

async function taskSummary(task, root) {
  const sheet = task.sheets?.find((item) => item.version === task.sheetVersion);
  const pages = task.execution?.pages || [];
  const finalApproved = await finalApprovalIsCurrent(task, root);
  let status = '待补充需求';
  if (finalApproved) status = '已完成';
  else if (task.execution?.status === 'failed') status = '执行失败';
  else if (task.execution?.status === 'cancelled') status = '已暂停';
  else if (task.execution?.status === 'running') status = '执行中';
  else if (task.execution?.status === 'succeeded') status = '待审核';
  else if (isSheetAuthorized(task)) status = '待执行';
  else if (task.inputConfirmation) status = '待确认制作单';
  return {
    id: task.id,
    title: sanitizeText(task.title),
    revision: task.revision,
    updatedAt: task.updatedAt,
    status,
    executionStatus: task.execution?.status || 'pending',
    completedPages: pages.filter((page) => page.status === 'succeeded').length,
    totalPages: sheet?.pages?.length || 0,
    finalApproved,
  };
}

async function listTasks(root) {
  const directory = path.join(path.resolve(root), 'tasks');
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (errorValue) { if (errorValue.code === 'ENOENT') return []; throw errorValue; }
  const tasks = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    try { tasks.push(await taskSummary(await readTask(entry.name, root), root)); }
    catch { /* Ignore incomplete directories; task core remains the source of truth. */ }
  }
  return tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function queryNumber(value, fallback, minimum, maximum) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw error('ERR_QUERY_INVALID', '分页参数无效');
  return number;
}

function mimeForFile(name, storedMime) {
  const extension = path.extname(name).toLowerCase();
  const guessed = MIME_BY_EXTENSION.get(extension);
  if (guessed && ALLOWED_MIME.has(guessed)) return guessed;
  return ALLOWED_MIME.has(storedMime) ? storedMime : 'application/octet-stream';
}

function contentDisposition(name, inline = false) {
  const fallback = String(name || 'download').replace(/[^\x20-\x7E]|["\\;]/g, '_').slice(0, 120) || 'download';
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name || fallback)}`;
}

async function safeFilePath(root, relativePath, allowedDirectory) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw error('ERR_FILE_NOT_FOUND', '文件不存在', 404);
  }
  const rootReal = await fs.realpath(path.resolve(root));
  const allowed = path.resolve(rootReal, allowedDirectory);
  const candidate = path.resolve(rootReal, relativePath);
  if (!isInside(allowed, candidate)) throw error('ERR_FILE_NOT_FOUND', '文件不存在', 404);
  let resolved;
  try { resolved = await fs.realpath(candidate); }
  catch { throw error('ERR_FILE_NOT_FOUND', '文件不存在', 404); }
  if (!isInside(allowed, resolved)) throw error('ERR_FILE_NOT_FOUND', '文件不存在', 404);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw error('ERR_FILE_NOT_FOUND', '文件不存在', 404);
  return { filePath: resolved, stat };
}

async function sendFile(response, filePath, { name, type, inline = false, expectedSha } = {}) {
  const stat = await fs.stat(filePath);
  const headers = {
    'content-type': type || mimeForFile(name, ''),
    'content-length': stat.size,
    'content-disposition': contentDisposition(name, inline),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
  };
  if (expectedSha) headers.etag = `"${expectedSha}"`;
  response.writeHead(200, headers);
  await pipeline(createReadStream(filePath), response);
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function staticFile(response, staticRoot, pathname) {
  let root;
  try { root = await fs.realpath(staticRoot); }
  catch { return false; }
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  if (decoded.includes('\0') || decoded.includes('\\')) return false;
  let relative = decoded.replace(/^\/+/, '');
  if (!relative || relative.endsWith('/')) relative += 'index.html';
  let candidate = path.resolve(root, relative);
  if (!isInside(root, candidate)) return false;
  try { candidate = await fs.realpath(candidate); }
  catch {
    // The workbench is a single-page app; navigation routes load index.html.
    if (!path.extname(relative)) candidate = path.join(root, 'index.html');
    else return false;
  }
  if (!isInside(root, candidate)) return false;
  let stat;
  try { stat = await fs.stat(candidate); } catch { return false; }
  if (!stat.isFile() || stat.size > 30 * 1024 * 1024) return false;
  const type = MIME_BY_EXTENSION.get(path.extname(candidate).toLowerCase());
  if (!type) return false;
  response.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': path.basename(candidate).includes('.') && /-[\da-f]{8,}\./i.test(candidate) ? 'public, max-age=31536000, immutable' : 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'",
  });
  await pipeline(createReadStream(candidate), response);
  return true;
}

function makePublicCanvasState(state) {
  if (!state || typeof state !== 'object') return { state: 'unavailable', projectId: null, webUrl: null, clientConnected: false, images: [] };
  return {
    state: state.clientConnected ? 'connected' : 'disconnected',
    projectId: state.projectId ?? null,
    webUrl: state.webUrl ?? null,
    clientConnected: Boolean(state.clientConnected),
    selectedNodeIds: Array.isArray(state.selectedNodeIds) ? state.selectedNodeIds : [],
    images: Array.isArray(state.images) ? state.images.map((image) => ({
      nodeId: image.nodeId,
      title: sanitizeText(image.title),
      width: image.width,
      height: image.height,
      status: image.status,
    })) : [],
    task: state.task ? sanitizeValue(state.task) : null,
  };
}

function validateMimeFromCandidate(value) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(value)) throw error('ERR_CANVAS_IMAGE_TYPE', 'Canvas 返回了不支持的图片格式', 409);
  return value;
}

function validateCanvasOpenUrl(value) {
  if (typeof value !== 'string' || value.length > 4000) throw error('ERR_CANVAS_OPEN_URL', 'Canvas 没有返回可用的打开链接', 503);
  let parsed;
  try { parsed = new URL(value); } catch { throw error('ERR_CANVAS_OPEN_URL', 'Canvas 打开链接无效', 503); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !isLoopback(parsed.hostname)
    || parsed.username || parsed.password || /(?:token|api[_-]?key|bridgeUrl|authorization|secret)=/i.test(`${parsed.search}${parsed.hash}`)) {
    throw error('ERR_CANVAS_OPEN_URL', 'Canvas 打开链接不是本机安全地址', 503);
  }
  return value;
}

function cleanPublicAsset(record) { return publicAsset(record); }

export function createStudioServer({
  root = dataRoot(),
  agent = null,
  canvas = null,
  fetchImpl = globalThis.fetch,
  readConfig = null,
  staticDir = path.resolve(import.meta.dirname, '../../web/dist'),
  maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES,
} = {}) {
  const data = path.resolve(root);
  const getConfig = readConfig || ((args) => defaultReadConfig({ ...args, root: data }));
  const jobs = createJobManager({ root: data, onOperation: (taskId, event) => appendOperation(taskId, event, data) });
  const ready = jobs.initialize();

  async function requireTask(taskId) {
    const id = assertUuid(taskId);
    return { id, task: await readTask(id, data) };
  }

  async function privateConfig(taskId = undefined) {
    return getConfig({ root: data, ...(taskId ? { taskId } : {}) });
  }

  async function currentFreshTask(taskId, expectedRevision, version, images) {
    const { id, task } = await requireTask(taskId);
    requiredRevision(expectedRevision);
    if (task.revision !== expectedRevision) {
      const stale = error('ERR_TASK_REVISION_CONFLICT', '任务版本已更新，请重新读取', 409);
      stale.expectedRevision = expectedRevision;
      stale.actualRevision = task.revision;
      throw stale;
    }
    if (!canvas || typeof canvas.assertFresh !== 'function') throw error('ERR_CANVAS_UNAVAILABLE', 'Canvas 当前不可用，不能执行此操作', 503);
    await canvas.assertFresh(id, { expectedRevision, version, images });
    return { id, task };
  }

  function sameApproval(left, right) {
    return Boolean(left && right
      && left.version === right.version
      && left.revision === right.revision
      && left.approvedAt === right.approvedAt
      && left.by === right.by
      && left.note === right.note
      && JSON.stringify(left.images) === JSON.stringify(right.images));
  }

  async function rollbackApproval(taskId, approvedTask) {
    const approval = approvedTask?.finalApproval;
    if (!approval) throw error('ERR_FINAL_APPROVAL_ROLLBACK_FAILED', 'Canvas 复核失败，无法定位本次批准记录；请检查任务状态。', 500);
    try {
      await withTask(taskId, (draft) => {
        if (!sameApproval(draft.finalApproval, approval)) {
          throw error('ERR_FINAL_APPROVAL_ROLLBACK_CONFLICT', 'Canvas 复核失败，批准记录已变化；请检查任务状态。', 409);
        }
        draft.finalApproval = null;
      }, { root: data, expectedRevision: approvedTask.revision });
    } catch (cause) {
      if (cause?.code === 'ERR_FINAL_APPROVAL_ROLLBACK_CONFLICT') throw cause;
      const failure = error('ERR_FINAL_APPROVAL_ROLLBACK_FAILED', 'Canvas 复核失败，无法自动撤销本次批准；请检查任务状态。', 500);
      failure.cause = cause;
      throw failure;
    }
  }

  function exportPaths(taskId, record) {
    const match = /^exports\/(export-\d{3,})$/.exec(record?.relativePath || '');
    if (!match || record.archiveRelativePath !== `${record.relativePath}.zip`) {
      throw error('ERR_EXPORT_ROLLBACK_PATH', '本次导出路径无效，无法安全清理。', 500);
    }
    const taskRoot = taskDirectory(taskId, data);
    const directory = path.resolve(taskRoot, ...record.relativePath.split('/'));
    const archive = path.resolve(taskRoot, ...record.archiveRelativePath.split('/'));
    if (!isInside(taskRoot, directory) || !isInside(taskRoot, archive)) {
      throw error('ERR_EXPORT_ROLLBACK_PATH', '本次导出路径越界，无法安全清理。', 500);
    }
    return { directory, archive };
  }

  async function rollbackExport(taskId, exportedTask, exportRecord) {
    const approval = exportedTask?.finalApproval;
    const paths = exportPaths(taskId, exportRecord);
    try {
      await withTask(taskId, (draft) => {
        const index = draft.exports.findIndex((record) => record.version === exportRecord.version
          && record.relativePath === exportRecord.relativePath
          && record.archiveRelativePath === exportRecord.archiveRelativePath
          && record.archiveSha256 === exportRecord.archiveSha256);
        if (index < 0) throw error('ERR_EXPORT_ROLLBACK_CONFLICT', 'Canvas 复核失败，无法定位本次导出记录；请检查任务状态。', 409);
        draft.exports.splice(index, 1);
        if (sameApproval(draft.finalApproval, approval)) draft.finalApproval = null;
      }, { root: data, expectedRevision: exportedTask.revision });
      await fs.rm(paths.directory, { recursive: true, force: true });
      await fs.rm(paths.archive, { force: true });
    } catch (cause) {
      if (cause?.code === 'ERR_EXPORT_ROLLBACK_CONFLICT' || cause?.code === 'ERR_EXPORT_ROLLBACK_PATH') throw cause;
      const failure = error('ERR_EXPORT_ROLLBACK_FAILED', 'Canvas 复核失败，无法完整撤销本次导出；请检查任务状态。', 500);
      failure.cause = cause;
      throw failure;
    }
  }

  async function assertFreshOrRollbackApproval(taskId, task, version, images) {
    try {
      await currentFreshTask(taskId, task.revision, version, images);
    } catch (freshError) {
      await rollbackApproval(taskId, task);
      throw freshError;
    }
  }

  async function actionTask(taskId, action, body) {
    const { id } = await requireTask(taskId);
    if (action === 'reconcile-canvas') {
      const expectedRevision = requiredRevision(body.expectedRevision);
      if (!canvas || typeof canvas.state !== 'function' || typeof canvas.assertFresh !== 'function') {
        throw error('ERR_CANVAS_UNAVAILABLE', 'Canvas 当前不可用，不能检查画布变更', 503);
      }
      return jobs.withMutation(`task:${id}`, async () => {
        const { task } = await requireTask(id);
        if (task.revision !== expectedRevision) {
          const stale = error('ERR_TASK_REVISION_CONFLICT', '任务版本已更新，请重新读取后检查画布', 409);
          stale.expectedRevision = expectedRevision;
          stale.actualRevision = task.revision;
          throw stale;
        }

        const canvasState = await canvas.state(id);
        if (Number.isInteger(canvasState?.task?.revision) && canvasState.task.revision !== task.revision) {
          const stale = error('ERR_TASK_REVISION_CONFLICT', '任务版本已更新，请重新读取后检查画布', 409);
          stale.expectedRevision = task.revision;
          stale.actualRevision = canvasState.task.revision;
          throw stale;
        }
        if (!canvasState?.clientConnected) {
          return {
            task: publicTask(task),
            canvas: makePublicCanvasState(canvasState),
            changedPages: [],
            needsSync: null,
          };
        }

        const staleCodes = new Set(['ERR_CANVAS_SYNC_REQUIRED', 'ERR_CANVAS_IMAGE_CHANGED', 'ERR_CANVAS_IMAGE_NOT_FOUND']);
        const changedPages = [];
        const pages = task.execution?.version === task.sheetVersion
          ? (task.execution.pages || []).filter((page) => page.status === 'succeeded')
          : [];
        for (const page of pages) {
          const sha256 = page.image?.sha256;
          if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)) {
            throw error('ERR_CANVAS_FRESHNESS_INPUT', `第 ${page.page} 页缺少有效成品哈希，无法安全检查`, 409);
          }
          try {
            await canvas.assertFresh(id, {
              expectedRevision: task.revision,
              version: task.sheetVersion,
              images: [{ page: page.page, sha256 }],
            });
          } catch (freshError) {
            if (!staleCodes.has(freshError?.code)) throw freshError;
            const observed = canvasState.task?.pages?.find((item) => item.page === page.page);
            changedPages.push({
              page: page.page,
              code: freshError.code,
              previousSha256: sha256,
              currentSha256: observed?.currentSha256 ?? null,
            });
          }
        }

        let reconciledTask = task;
        if (changedPages.length) {
          const affected = new Set(changedPages.map((item) => item.page));
          reconciledTask = await withTask(id, (draft) => {
            draft.reviews = draft.reviews.filter((review) => !(review.version === draft.sheetVersion && affected.has(review.page)));
            draft.finalApproval = null;
          }, { root: data, expectedRevision: task.revision });
        }
        return {
          task: publicTask(reconciledTask),
          canvas: makePublicCanvasState(canvasState),
          changedPages,
          needsSync: changedPages.length > 0,
        };
      });
    }
    if (action === 'execute' || action === 'resume') {
      requiredRevision(body.expectedRevision);
      const task = await readTask(id, data);
      if (task.revision !== body.expectedRevision) {
        const stale = error('ERR_TASK_REVISION_CONFLICT', '任务版本已更新，请重新读取', 409);
        stale.expectedRevision = body.expectedRevision;
        stale.actualRevision = task.revision;
        throw stale;
      }
      if (typeof canvas?.executionOptions !== 'function') throw error('ERR_CANVAS_EXECUTION_OPTIONS', 'Canvas 执行配置不可用', 503);
      return jobs.start({
        taskId: id,
        kind: action,
        run: async ({ signal }) => {
          const executionOptions = await canvas.executionOptions(id, { target: task.execution?.target });
          return executeTask(id, {
            ...executionOptions,
            version: body.version,
            expectedRevision: body.expectedRevision,
            retryPage: body.retryPage,
            root: data,
            signal,
          });
        },
        resultView: (result) => ({ taskRevision: result.revision, executionStatus: result.execution?.status }),
      });
    }

    return jobs.withMutation(`task:${id}`, async () => {
      const opts = { root: data, expectedRevision: body.expectedRevision };
      let task;
      if (action === 'set-brief') task = await setBrief(id, body.brief, opts);
      else if (action === 'set-sources') task = await setSources(id, body.sources, opts);
      else if (action === 'set-asset-sources') task = await setAssetSources(id, body.selections, opts);
      else if (action === 'references') task = await setReferences(id, body.items, opts);
      else if (action === 'apply-dna') task = await applyDna(id, { dnaRevision: body.dnaRevision }, opts);
      else if (action === 'confirm-inputs') task = await confirmInputs(id, { revision: body.revision, by: body.by, note: body.note }, opts);
      else if (action === 'set-sheet') task = await setSheet(id, body.sheet, { ...opts, inputRevision: body.inputRevision });
      else if (action === 'confirm-sheet') task = await confirmSheet(id, { version: body.version, by: body.by, note: body.note }, opts);
      else if (action === 'restore-page-edit') task = await restorePageEdit(id, { page: body.page, ...opts });
      else if (action === 'select-image') {
        if (!canvas || typeof canvas.sync !== 'function') throw error('ERR_CANVAS_UNAVAILABLE', 'Canvas 当前不可用，不能选取图片', 503);
        const result = await canvas.sync(id, {
          expectedRevision: body.expectedRevision,
          version: body.version,
          selections: [{ page: body.page, nodeId: body.nodeId }],
        });
        task = result.task;
      } else if (action === 'record-review') {
        const current = await readTask(id, data);
        const image = current.execution?.pages?.find((page) => page.page === body.page)?.image;
        if (!image || image.sha256 !== body.sha256) throw error('ERR_CANVAS_STALE_REVIEW', '复审图像已变化，请重新打开并检查当前图片', 409);
        await currentFreshTask(id, body.expectedRevision, current.sheetVersion, [{ page: body.page, sha256: body.sha256 }]);
        task = await recordReview(id, body, opts);
      } else if (action === 'approve-final') {
        await currentFreshTask(id, body.expectedRevision, body.version, body.images);
        task = await approveFinal(id, body, opts);
        await assertFreshOrRollbackApproval(id, task, body.version, task.finalApproval.images);
      } else if (action === 'export') {
        const current = await readTask(id, data);
        const images = current.finalApproval?.images;
        if (!Array.isArray(images) || !images.length) throw error('ERR_FINAL_APPROVAL_REQUIRED', '当前版本尚无最终批准图片');
        await currentFreshTask(id, body.expectedRevision, current.sheetVersion, images);
        const result = await exportTask(id, opts);
        try {
          await currentFreshTask(id, result.task.revision, result.task.sheetVersion, result.task.finalApproval.images);
        } catch (freshError) {
          await rollbackExport(id, result.task, result.export);
          throw freshError;
        }
        return { task: publicTask(result.task), export: { ...result.export, downloadUrl: `/api/tasks/${encodeURIComponent(id)}/exports/${encodeURIComponent(result.export.version)}` } };
      } else {
        throw error('ERR_ACTION_NOT_FOUND', `不支持的任务操作：${sanitizeText(action)}`, 404);
      }
      return { task: publicTask(task) };
    });
  }

  async function taskDetail(taskId) {
    const { id, task } = await requireTask(taskId);
    const [conversation, operations] = await Promise.all([
      readConversation(id, data),
      readOperations(id, data),
    ]);
    let canvasState;
    try { canvasState = await canvas?.state?.(id); }
    catch { canvasState = null; }
    return {
      task: publicTask(task),
      conversation,
      operations,
      job: jobs.latestForTask(id),
      canvas: makePublicCanvasState(canvasState),
    };
  }

  async function bootstrap() {
    const [tasks, dna, config, assets, tags] = await Promise.all([
      listTasks(data),
      readDna({ root: data }),
      readConfigRecord({ root: data }),
      listAssets({ limit: 100 }, { root: data }),
      listTags({ root: data }),
    ]);
    return {
      tasks,
      dna: { revision: dna.revision, enabled: dna.enabled, content: dna.content, savedAt: dna.savedAt ?? null },
      config: publicConfig(config),
      assets: assets.map(publicAsset),
      tags,
    };
  }

  async function handleApi(request, response, url) {
    const method = request.method || 'GET';
    const segments = url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (segments[0] !== 'api') throw error('ERR_ROUTE_NOT_FOUND', '接口不存在', 404);

    if (method === 'GET' && segments.length === 2 && segments[1] === 'bootstrap') {
      return json(response, 200, await bootstrap());
    }
    if (method === 'POST' && segments.length === 2 && segments[1] === 'tasks') {
      const body = await readJson(request);
      const task = await createTask({ title: body.title, brief: body.brief }, data);
      return json(response, 201, { task: publicTask(task) });
    }
    if (segments[1] === 'tasks' && segments.length === 3 && method === 'GET') {
      return json(response, 200, await taskDetail(segments[2]));
    }
    if (segments[1] === 'tasks' && segments.length === 4 && method === 'POST' && segments[3] === 'attachments') {
      const taskId = assertUuid(segments[2]);
      const parsed = await parseMultipart(request, { root: data, maxBytes: maxUploadBytes });
      try {
        const form = parsed.form;
        const allowedFields = new Set(['files', 'expectedRevision', 'uploadId', 'instructions']);
        for (const [field] of form.entries()) {
          if (!allowedFields.has(field)) throw error('ERR_MULTIPART_FIELD', `不接受附件字段：${sanitizeText(field)}`);
        }
        const singleText = (field) => {
          const values = form.getAll(field);
          if (values.length !== 1 || typeof values[0] !== 'string') {
            throw error('ERR_MULTIPART_FIELD', `${field} 必须且只能是一个文本字段`);
          }
          return values[0];
        };
        const rawFiles = form.getAll('files');
        if (rawFiles.length !== parsed.files.length || rawFiles.some((value) => typeof value === 'string')) {
          throw error('ERR_MULTIPART_FIELD', 'files 必须只包含附件文件');
        }
        const rawRevision = singleText('expectedRevision');
        if (!/^\d+$/.test(rawRevision)) throw error('ERR_TASK_REVISION_REQUIRED', '必须指定正整数 expectedRevision');
        const expectedRevision = Number(rawRevision);
        requiredRevision(expectedRevision);
        const uploadId = singleText('uploadId');
        if (!UUID.test(uploadId)) throw error('ERR_ID_INVALID', 'uploadId 无效');
        const instructions = singleText('instructions');
        if (instructions.length > 20000) throw error('ERR_MULTIPART_FIELD', 'instructions 不能超过 20000 个字符');
        const files = parsed.files.map((file) => ({
          order: file.order,
          name: file.name,
          mimeType: file.mimeType,
          sha256: null,
          path: file.path,
        }));
        for (const file of files) file.sha256 = await hashFile(file.path);
        const uploadFingerprint = fingerprintJobPayload({
          instructions,
          files: files.map(({ order, name, mimeType, sha256 }) => ({ order, name, mimeType, sha256 })),
        });
        const result = await jobs.withMutation(`task:${taskId}`, async () => {
          const current = await readTask(taskId, data);
          const priorUpload = current.sources.find((source) => source.uploadId === uploadId);
          if (priorUpload) {
            if (priorUpload.uploadFingerprint !== uploadFingerprint) {
              throw error('ERR_ATTACHMENT_UPLOAD_ID_CONFLICT', '该 uploadId 已用于不同的附件或说明', 409);
            }
            return {
              task: current,
              sourceId: priorUpload.id,
              replayed: true,
              uploadRevision: priorUpload.uploadRevision,
            };
          }
          if (current.revision !== expectedRevision) {
            const stale = error('ERR_TASK_REVISION_CONFLICT', '任务版本已更新，请重新读取', 409);
            stale.expectedRevision = expectedRevision;
            stale.actualRevision = current.revision;
            throw stale;
          }
          request.abortSignal.throwIfAborted();
          const extractions = await extractTaskUploads(parsed.files, request.abortSignal);
          request.abortSignal.throwIfAborted();
          const purpose = instructions.trim()
            ? instructions.slice(0, 2000)
            : '当前任务附件，具体用法待本轮对话澄清';
          const task = await attachTaskFiles(taskId, {
            files: parsed.files,
            title: parsed.files.map((file) => file.name).join('、').slice(0, 500),
            purpose,
            factBoundary: '仅依照用户本轮说明使用；未经本次确认不引用附件中的品牌、价格或日期作为事实',
            extractions,
            uploadId,
            uploadFingerprint,
          }, { root: data, expectedRevision });
          const source = task.sources.find((item) => item.uploadId === uploadId);
          if (!source) throw error('ERR_ATTACHMENT_SAVE', '附件来源未能保存', 500);
          return { task, sourceId: source.id, replayed: false, uploadRevision: source.uploadRevision };
        });
        return json(response, 200, { ...result, task: publicTask(result.task) });
      } finally { await parsed.cleanup(); }
    }
    if (segments[1] === 'tasks' && segments.length === 4 && method === 'POST') {
      const taskId = assertUuid(segments[2]);
      const action = segments[3];
      const body = await readJson(request);
      if (action === 'chat') {
        const requestId = assertUuid(body.requestId, 'requestId');
        const requestedModel = body.model === undefined ? null : validateModelId(body.model);
        const { requestId: _requestId, ...requestPayload } = body;
        const fingerprint = fingerprintJobPayload(requestPayload);
        const existing = await jobs.findRequest(taskId, 'chat', requestId, fingerprint);
        if (existing) return json(response, 202, { job: existing });
        requiredRevision(body.expectedRevision);
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20000) throw error('ERR_CHAT_TEXT', '消息必须是 1 到 20000 字的文本');
        if (!agent || typeof agent.chat !== 'function') throw error('ERR_AGENT_UNAVAILABLE', 'DSH Agent 当前不可用', 503);
        const { task } = await requireTask(taskId);
        if (body.expectedRevision !== task.revision) {
          const existingAfterRace = await jobs.findRequest(taskId, 'chat', requestId, fingerprint);
          if (existingAfterRace) return json(response, 202, { job: existingAfterRace });
          const stale = error('ERR_TASK_REVISION_CONFLICT', '任务版本已更新，请重新读取', 409);
          stale.expectedRevision = body.expectedRevision;
          stale.actualRevision = task.revision;
          throw stale;
        }
        const validateAttachmentSourceIds = (currentTask) => {
          if (body.attachmentSourceIds === undefined) return undefined;
          if (!Array.isArray(body.attachmentSourceIds) || body.attachmentSourceIds.length > MAX_UPLOAD_FILES) {
            throw error('ERR_CHAT_ATTACHMENT_INVALID', '附件来源 ID 列表无效');
          }
          const ids = body.attachmentSourceIds.map((value) => {
            if (typeof value !== 'string' || !UUID.test(value)) throw error('ERR_CHAT_ATTACHMENT_INVALID', '附件来源 ID 无效');
            return value;
          });
          if (new Set(ids).size !== ids.length) throw error('ERR_CHAT_ATTACHMENT_INVALID', '附件来源 ID 不能重复');
          for (const id of ids) {
            const source = currentTask.sources.find((item) => item.id === id);
            if (!source || source.type !== 'current_attachment' || source.uploadId !== requestId) {
              throw error('ERR_CHAT_ATTACHMENT_INVALID', '附件来源必须属于当前任务和本轮上传');
            }
          }
          return ids;
        };
        const attachmentSourceIds = validateAttachmentSourceIds(task);
        if (body.answers !== undefined) validateAnswers(await readConversation(taskId, data), body.answers);
        const config = await privateConfig();
        const model = requestedModel ?? defaultBaseModel(config.basic);
        const job = await jobs.start({
          taskId,
          kind: 'chat',
          model,
          requestId,
          fingerprint,
          run: async ({ signal, onEvent }) => {
            const currentTask = await readTask(taskId, data);
            if (currentTask.revision !== body.expectedRevision) {
              const stale = error('ERR_TASK_REVISION_CONFLICT', '任务版本已更新，请重新读取', 409);
              stale.expectedRevision = body.expectedRevision;
              stale.actualRevision = currentTask.revision;
              throw stale;
            }
            const currentAttachmentSourceIds = validateAttachmentSourceIds(currentTask);
            const conversationBeforeSend = await readConversation(taskId, data);
            const validatedAnswers = body.answers === undefined ? null : validateAnswers(conversationBeforeSend, body.answers);
            const userMessage = await appendConversation(taskId, {
              role: 'user',
              text: validatedAnswers?.summary ?? body.text,
              requestId,
              ...(currentAttachmentSourceIds === undefined ? {} : { attachmentSourceIds: currentAttachmentSourceIds }),
              ...(validatedAnswers ? { answers: validatedAnswers.answers } : {}),
            }, data);
            const conversation = await readConversation(taskId, data);
            let questionsMessage = null;
            const handleAgentEvent = async (event) => {
              if (event?.type === 'questions') {
                if (questionsMessage) throw error('ERR_CLARIFICATION_ALREADY_ASKED', '本轮已经提出点选问题');
                const questions = validateQuestions(event.questions);
                questionsMessage = await appendConversation(taskId, {
                  role: 'assistant',
                  text: '请按需选择下方选项并提交。',
                  questions,
                  model,
                }, data);
                await onEvent({ type: 'status', text: '已准备好点选问题，可在对话中回答。' });
                return;
              }
              return onEvent(event);
            };
            const editPages = async ({ mode, edits, expectedRevision }) => {
              const current = await readTask(taskId, data);
              const target = current.execution?.target || [...(current.executionHistory || [])].reverse().find(entry => entry.status === 'succeeded')?.target;
              const options = await canvas.executionOptions(taskId, { target });
              await onEvent({ type: 'status', text: `正在修改第 ${edits.map(edit => edit.page).join('、')} 页，其他页面保留。` });
              const updated = await editTaskPages(taskId, {
                ...options, mode, edits, expectedRevision, root: data, signal,
                authorization: { requestId, text: userMessage.text },
              });
              await onEvent({ type: 'status', text: '指定页面修改完成，图片已回收。' });
              return updated;
            };
            const mechanicalAttachments = new Map();
            const canvasState = async ({ expectedRevision } = {}) => {
              if (!canvas || typeof canvas.agentState !== 'function') throw error('ERR_CANVAS_UNAVAILABLE', 'Canvas 当前不可用', 503);
              return canvas.agentState(taskId, { expectedRevision, signal });
            };
            const canvasPreview = async ({ nodeId, expectedRevision } = {}) => {
              if (!canvas || typeof canvas.agentImage !== 'function') throw error('ERR_CANVAS_UNAVAILABLE', 'Canvas 图片预览当前不可用', 503);
              return canvas.agentImage(taskId, { nodeId, expectedRevision, signal });
            };
            const detectedSourceHashes = new Map();
            const canvasRegions = async ({ nodeId, kinds, expectedRevision } = {}) => {
              if (!canvas || typeof canvas.agentRegions !== 'function') throw error('ERR_CANVAS_UNAVAILABLE', 'Canvas 图像区域检测当前不可用', 503);
              const result = await canvas.agentRegions(taskId, { nodeId, kinds, expectedRevision, signal });
              detectedSourceHashes.set(result.nodeId, result.sha256);
              return result;
            };
            const canvasOperation = async (arguments_ = {}) => {
              if (!canvas || typeof canvas.mechanicalOperation !== 'function') throw error('ERR_CANVAS_UNAVAILABLE', 'Canvas 当前不可用', 503);
              const artifactCount = arguments_.operation === 'split'
                ? (Number.isInteger(arguments_.rows) && Number.isInteger(arguments_.columns) ? arguments_.rows * arguments_.columns : 0)
                : ['crop', 'resample', 'stitch', 'compose'].includes(arguments_.operation) ? 1 : 0;
              if (mechanicalAttachments.size + artifactCount > 200) {
                throw error('ERR_CANVAS_OPERATION_INPUT', '本轮机械图片附件数量超过上限。');
              }
              const operationSourceIds = arguments_.operation === 'stitch' ? arguments_.nodeIds
                : arguments_.operation === 'compose' ? [arguments_.nodeId, ...(Array.isArray(arguments_.layers) ? arguments_.layers.map((layer) => layer?.nodeId) : [])]
                  : arguments_.operation === 'import' ? [] : [arguments_.nodeId];
              const expectedSourceHashes = [...new Set(Array.isArray(operationSourceIds) ? operationSourceIds : [])]
                .filter((nodeId) => typeof nodeId === 'string' && detectedSourceHashes.has(nodeId))
                .map((nodeId) => ({ nodeId, sha256: detectedSourceHashes.get(nodeId) }));
              const operationId = arguments_.operationId;
              const outcome = await canvas.mechanicalOperation(taskId, {
                operation: arguments_.operation,
                ...(arguments_.nodeId === undefined ? {} : { nodeId: arguments_.nodeId }),
                ...(arguments_.image === undefined ? {} : { image: arguments_.image }),
                ...(arguments_.nodeIds === undefined ? {} : { nodeIds: arguments_.nodeIds }),
                ...(arguments_.direction === undefined ? {} : { direction: arguments_.direction }),
                ...(arguments_.gap === undefined ? {} : { gap: arguments_.gap }),
                ...(arguments_.background === undefined ? {} : { background: arguments_.background }),
                ...(arguments_.layers === undefined ? {} : { layers: arguments_.layers }),
                ...(arguments_.crop === undefined ? {} : { crop: arguments_.crop }),
                ...(arguments_.rows === undefined ? {} : { rows: arguments_.rows }),
                ...(arguments_.columns === undefined ? {} : { columns: arguments_.columns }),
                ...(arguments_.targetLongEdge === undefined ? {} : { targetLongEdge: arguments_.targetLongEdge }),
                ...(arguments_.algorithm === undefined ? {} : { algorithm: arguments_.algorithm }),
                ...(arguments_.x === undefined ? {} : { x: arguments_.x }),
                ...(arguments_.y === undefined ? {} : { y: arguments_.y }),
                ...(arguments_.width === undefined ? {} : { width: arguments_.width }),
                ...(arguments_.height === undefined ? {} : { height: arguments_.height }),
                ...(expectedSourceHashes.length ? { expectedSourceHashes } : {}),
                expectedRevision: arguments_.expectedRevision,
                operationId,
                requestId,
                callId: operationId,
                userText: userMessage.text,
                signal,
              });
              if (!outcome || !outcome.task || !Number.isInteger(outcome.task.revision)
                || !outcome.result || !Array.isArray(outcome.attachments)) {
                throw error('ERR_CANVAS_OPERATION_RESULT', 'Canvas 没有返回可保存的机械操作结果', 502);
              }
              for (const attachment of outcome.attachments) {
                if (!attachment || typeof attachment.fileUrl !== 'string'
                  || !attachment.fileUrl.startsWith(`/api/tasks/${taskId}/canvas-operations/${operationId}/images/`)) {
                  throw error('ERR_CANVAS_OPERATION_ATTACHMENT', 'Canvas 机械图片附件未能通过任务范围校验', 502);
                }
                mechanicalAttachments.set(attachment.fileUrl, attachment);
              }
              return outcome;
            };
            const result = await agent.chat({
              taskId,
              text: userMessage.text,
              conversation,
              signal,
              onEvent: handleAgentEvent,
              expectedRevision: body.expectedRevision,
              model,
              editPages,
              canvasState,
              canvasOperation,
              canvasPreview,
              canvasRegions,
            });
            if (typeof result?.text !== 'string') throw error('ERR_AGENT_RESULT', 'Agent 没有返回可显示消息', 500);
            const assistantMessage = await appendConversation(taskId, {
              role: 'assistant',
              text: result.text,
              model,
              ...(mechanicalAttachments.size ? { attachments: [...mechanicalAttachments.values()] } : {}),
            }, data);
            return { assistantMessage, task: result.task || await readTask(taskId, data) };
          },
          resultView: (result) => ({ text: result.assistantMessage.text, taskRevision: result.task?.revision ?? null }),
        });
        return json(response, 202, { job });
      }
      if (action === 'review') {
        const requestedModel = body.model === undefined ? null : validateModelId(body.model);
        const { task } = await requireTask(taskId);
        const config = await privateConfig();
        const model = requestedModel ?? defaultBaseModel(config.basic);
        requiredRevision(body.expectedRevision);
        const page = task.execution?.pages?.find((entry) => entry.page === body.page);
        if (!page?.image?.sha256) throw error('ERR_REVIEW_IMAGE_MISSING', '当前页面没有可审核成品');
        await currentFreshTask(taskId, body.expectedRevision, task.sheetVersion, [{ page: body.page, sha256: page.image.sha256 }]);
        if (!agent || typeof agent.review !== 'function') throw error('ERR_AGENT_UNAVAILABLE', '读图审核 Agent 当前不可用', 503);
        const job = await jobs.start({
          taskId,
          kind: 'review',
          model,
          run: async ({ signal, onEvent }) => agent.review({
            taskId,
            page: body.page,
            signal,
            onEvent,
            expectedRevision: body.expectedRevision,
            model,
            beforeRecordReview: async (review) => {
              const revision = review.expectedRevision ?? body.expectedRevision;
              const version = review.version ?? task.sheetVersion;
              await currentFreshTask(taskId, revision, version, [{ page: review.page, sha256: review.sha256 }]);
            },
          }),
          resultView: (result) => ({ text: result.text || '', taskRevision: result.task?.revision ?? null }),
        });
        return json(response, 202, { job });
      }
      if (action === 'canvas-sync') {
        if (!canvas || typeof canvas.sync !== 'function') throw error('ERR_CANVAS_UNAVAILABLE', 'Canvas 当前不可用', 503);
        const { task } = await requireTask(taskId);
        requiredRevision(body.expectedRevision);
        if (task.revision !== body.expectedRevision) {
          const stale = error('ERR_TASK_REVISION_CONFLICT', '任务版本已更新，请重新读取', 409);
          stale.expectedRevision = body.expectedRevision;
          stale.actualRevision = task.revision;
          throw stale;
        }
        const result = await jobs.withMutation(`task:${taskId}`, async () => canvas.sync(taskId, {
          ...body,
          version: body.version ?? task.sheetVersion,
        }));
        if (!Array.isArray(result?.candidates) || !result.task) {
          throw error('ERR_CANVAS_CONTRACT', 'Canvas 同步没有返回任务快照和候选图片列表', 502);
        }
        const candidates = result.candidates.map((candidate) => ({
          page: candidate.page,
          nodeId: candidate.nodeId,
          title: sanitizeText(candidate.title || `第 ${candidate.page} 页候选图`),
          width: candidate.width,
          height: candidate.height,
          sha256: candidate.sha256,
          status: candidate.status,
          selected: Boolean(candidate.selected),
          imageUrl: `/api/tasks/${encodeURIComponent(taskId)}/canvas/candidates/${encodeURIComponent(candidate.nodeId)}?version=${encodeURIComponent(body.version ?? task.sheetVersion)}&page=${encodeURIComponent(candidate.page)}`,
        }));
        return json(response, 200, { task: publicTask(result.task), candidates });
      }
      const result = await actionTask(taskId, action, body);
      if (result?.id && result?.status) return json(response, 202, { job: result });
      return json(response, 200, result);
    }
    if (segments[1] === 'tasks' && segments.length === 5 && method === 'POST'
      && segments[3] === 'canvas' && segments[4] === 'open') {
      const taskId = assertUuid(segments[2]);
      await readJson(request, { optional: true });
      await requireTask(taskId);
      if (!canvas || typeof canvas.ensure !== 'function') throw error('ERR_CANVAS_UNAVAILABLE', 'Canvas 当前不可用', 503);
      const result = await canvas.ensure(taskId);
      const openUrl = validateCanvasOpenUrl(result?.openUrl);
      return json(response, 200, { openUrl, projectId: result.projectId, clientConnected: Boolean(result.clientConnected) });
    }

    if (segments[1] === 'jobs' && segments.length === 3 && method === 'GET') {
      const job = jobs.get(segments[2]);
      if (!job) throw error('ERR_JOB_NOT_FOUND', 'Job 不存在', 404);
      return json(response, 200, { job });
    }
    if (segments[1] === 'jobs' && segments.length === 3 && method === 'DELETE') {
      const job = await jobs.cancel(segments[2]);
      if (!job) throw error('ERR_JOB_NOT_FOUND', 'Job 不存在', 404);
      return json(response, 200, { job });
    }

    if (segments[1] === 'tasks' && segments.length === 5 && method === 'GET' && segments[3] === 'images') {
      const { id, task } = await requireTask(segments[2]);
      const pageNumber = Number(segments[4]);
      if (!Number.isInteger(pageNumber) || pageNumber < 1) throw error('ERR_FILE_NOT_FOUND', '文件不存在', 404);
      const version = Number(url.searchParams.get('version'));
      const execution = task.execution?.version === version ? task.execution
        : [...(task.executionHistory || [])].reverse().find(entry => entry.version === version);
      const record = execution?.pages?.find(page => page.page === pageNumber);
      if (!record?.image?.path || !record.image.sha256) throw error('ERR_FILE_NOT_FOUND', '文件不存在', 404);
      const base = taskDirectory(id, data);
      const relative = path.relative(base, path.resolve(record.image.path));
      const resolved = await safeFilePath(data, path.join('tasks', id, relative), path.join('tasks', id));
      if (await hashFile(resolved.filePath) !== record.image.sha256) throw error('ERR_IMAGE_STALE', '图片内容已变化，请重新同步并审核', 409);
      const type = mimeForFile(record.image.path, 'image/png');
      if (!type.startsWith('image/')) throw error('ERR_IMAGE_TYPE', '当前文件不是图片', 415);
      return sendFile(response, resolved.filePath, { name: `page-${pageNumber}${path.extname(record.image.path) || '.png'}`, type, inline: true, expectedSha: record.image.sha256 });
    }

    if (segments[1] === 'tasks' && segments.length === 7 && method === 'GET'
      && segments[3] === 'canvas-operations' && segments[5] === 'images') {
      const { id } = await requireTask(segments[2]);
      const operationId = segments[4];
      const index = Number(segments[6]);
      if (!UUID.test(operationId) || !Number.isInteger(index) || index < 0) throw error('ERR_FILE_NOT_FOUND', '文件不存在', 404);
      let image;
      try { image = await readCanvasOperationImage(id, operationId, index, { root: data }); }
      catch (cause) {
        if (cause?.code === 'ERR_CANVAS_OPERATION_IMAGE_HASH') throw error('ERR_CANVAS_OPERATION_IMAGE_HASH', '机械图片附件校验失败', 409);
        throw error('ERR_FILE_NOT_FOUND', '文件不存在', 404);
      }
      if (!new Set(['image/png', 'image/jpeg', 'image/webp']).has(image.mimeType)) throw error('ERR_IMAGE_TYPE', '当前文件不是受支持的图片', 415);
      const relative = path.posix.join('tasks', id, 'canvas-operations', operationId, image.relativePath);
      const resolved = await safeFilePath(data, relative, path.join('tasks', id));
      if (await hashFile(resolved.filePath) !== image.sha256) throw error('ERR_CANVAS_OPERATION_IMAGE_HASH', '机械图片附件校验失败', 409);
      return sendFile(response, resolved.filePath, {
        name: image.name,
        type: image.mimeType,
        inline: url.searchParams.get('download') !== '1',
        expectedSha: image.sha256,
      });
    }

    if (segments[1] === 'tasks' && segments.length === 6 && method === 'GET' && segments[3] === 'source-files') {
      const { id, task } = await requireTask(segments[2]);
      const source = task.sources.find((item) => item.id === segments[4]);
      const order = Number(segments[5]);
      const file = source?.files?.find((entry, index) => Number(entry.order ?? index) === order);
      if (!file) throw error('ERR_FILE_NOT_FOUND', '文件不存在', 404);
      const relative = path.posix.join('tasks', id, file.relativePath);
      const resolved = await safeFilePath(data, relative, path.join('tasks', id));
      if (file.sha256 && await hashFile(resolved.filePath) !== file.sha256) throw error('ERR_SOURCE_HASH', '来源文件校验失败', 409);
      return sendFile(response, resolved.filePath, { name: file.name, type: mimeForFile(file.name, file.mimeType), inline: true, expectedSha: file.sha256 });
    }

    if (segments[1] === 'tasks' && segments.length === 5 && method === 'GET' && segments[3] === 'exports') {
      const { id, task } = await requireTask(segments[2]);
      const version = segments[4];
      if (!/^export-\d{3,}$/.test(version)) throw error('ERR_EXPORT_NOT_FOUND', '导出不存在', 404);
      const record = task.exports?.find((item) => item.version === version);
      if (!record?.archiveRelativePath || !/^exports\/export-\d{3,}\.zip$/.test(record.archiveRelativePath)) throw error('ERR_EXPORT_NOT_FOUND', '导出不存在', 404);
      const resolved = await safeFilePath(data, path.posix.join('tasks', id, record.archiveRelativePath), path.join('tasks', id));
      if (record.archiveSha256 && await hashFile(resolved.filePath) !== record.archiveSha256) throw error('ERR_EXPORT_HASH', '导出文件校验失败', 409);
      return sendFile(response, resolved.filePath, { name: `${version}.zip`, type: 'application/zip', expectedSha: record.archiveSha256 });
    }

    if (segments.length === 2 && segments[1] === 'assets' && method === 'GET') {
      const query = url.searchParams.get('query') || '';
      const tags = url.searchParams.getAll('tags');
      const options = {
        query,
        tags,
        tagMode: url.searchParams.get('tagMode') || 'all',
        status: url.searchParams.get('status') || undefined,
        includeDeleted: url.searchParams.get('includeDeleted') === 'true',
        confirmedOnly: url.searchParams.get('confirmedOnly') === 'true',
        offset: queryNumber(url.searchParams.get('offset'), 0, 0, 1_000_000),
        limit: queryNumber(url.searchParams.get('limit'), 100, 1, MAX_PAGE_LIMIT),
      };
      const assets = query
        ? await queryAssets(options, { root: data })
        : await listAssets(options, { root: data });
      return json(response, 200, { assets: assets.map(publicAsset) });
    }

    if (segments.length === 2 && segments[1] === 'assets' && method === 'POST') {
      const parsed = await parseMultipart(request, { root: data, maxBytes: maxUploadBytes });
      try {
        const form = parsed.form;
        const title = form.get('title');
        const body = form.get('body') ?? '';
        const result = await jobs.withMutation('asset-library', async () => importAsset({
          title: typeof title === 'string' ? title : '',
          body: typeof body === 'string' ? body : '',
          tags: parseJsonField(form, 'tags', []),
          source: parseJsonField(form, 'source', {}),
          files: parsed.files,
        }, { root: data }));
        return json(response, 201, { asset: publicAsset(result) });
      } finally { await parsed.cleanup(); }
    }

    if (segments[1] === 'assets' && segments.length === 3 && segments[2] === 'import-folder' && method === 'POST') {
      const parsed = await parseMultipart(request, { root: data, maxBytes: maxUploadBytes, allowedFileCount: 1000 });
      try {
        const batchId = parsed.form.get('batchId');
        const result = await jobs.withMutation(`folder-import:${batchId}`, () => importFolder({
          root: data, files: parsed.files, paths: parseJsonField(parsed.form, 'paths', []), batchId, signal: request.abortSignal,
        }));
        return json(response, 201, { ...result, entries: result.entries.map(entry => ({...entry,...(entry.asset?{asset:publicAsset(entry.asset)}:{})})) });
      } finally { await parsed.cleanup(); }
    }

    if (segments[1] === 'assets' && segments.length === 3 && method === 'GET') {
      const record = await readAsset(segments[2], { root: data });
      return json(response, 200, { asset: publicAsset(record) });
    }

    if (segments[1] === 'assets' && segments.length === 5 && method === 'GET' && segments[3] === 'files') {
      const id = segments[2];
      const order = Number(segments[4]);
      if (!Number.isInteger(order) || order < 0) throw error('ERR_FILE_NOT_FOUND', '文件不存在', 404);
      const record = await readAsset(id, { root: data });
      const file = record.files.find((item, index) => Number(item.order ?? index) === order);
      if (!file) throw error('ERR_FILE_NOT_FOUND', '文件不存在', 404);
      const resolved = await safeFilePath(data, file.relativePath, path.join('assets', 'items', id));
      if (await hashFile(resolved.filePath) !== file.sha256) throw error('ERR_ASSET_FILE_HASH', '素材原件校验失败', 409);
      return sendFile(response, resolved.filePath, { name: file.name, type: mimeForFile(file.name, file.mimeType), inline: true, expectedSha: file.sha256 });
    }

    if (segments[1] === 'assets' && segments.length === 3 && method === 'PUT') {
      const body = await readJson(request);
      const { id } = await requireAssetRecord(segments[2], data);
      const { expectedRevision: revision, ...payload } = body;
      const result = await jobs.withMutation(`asset:${id}`, () => editAsset(id, payload, { root: data, expectedRevision: revision }));
      return json(response, 200, { asset: publicAsset(result) });
    }

    if (segments[1] === 'assets' && segments.length === 4 && method === 'POST' && segments[3] === 'clean') {
      const body = await readJson(request);
      const { id } = await requireAssetRecord(segments[2], data);
      requiredRevision(body.expectedRevision);
      const job = await jobs.start({
        assetId: id,
        kind: 'asset-clean',
        run: async ({ signal }) => {
          const config = await privateConfig();
          const record = await cleanAsset(id, { root: data, expectedRevision: body.expectedRevision, config: config.basic, signal });
          if (record.status === 'needs_review') return record;
          if (record.status === 'clean_cancelled') {
            signal.throwIfAborted();
            const cancelled = new Error('清洗已取消，可重新清洗。');
            cancelled.name = 'AbortError';
            cancelled.code = 'ABORT_ERR';
            throw cancelled;
          }

          const failure = new Error(record.lastError?.message || '清洗未完成；请读取素材状态后重试。');
          failure.code = /^ERR_[A-Z0-9_]+$/.test(record.lastError?.code || '')
            ? record.lastError.code
            : record.status === 'clean_config_missing' ? 'ERR_ASSET_CLEAN_CONFIG' : 'ERR_ASSET_CLEAN_FAILED';
          failure.safeMessage = record.lastError?.message || '清洗未完成；请读取素材状态后重试。';
          throw failure;
        },
        resultView: (record) => publicAsset(record),
      });
      return json(response, 202, { job });
    }

    if (segments[1] === 'assets' && segments.length === 4 && method === 'POST' && segments[3] === 'confirm') {
      const body = await readJson(request);
      const { id } = await requireAssetRecord(segments[2], data);
      const result = await jobs.withMutation(`asset:${id}`, () => confirmAsset(id, { by: body.by, note: body.note }, { root: data, expectedRevision: body.expectedRevision }));
      return json(response, 200, { asset: publicAsset(result) });
    }

    if (segments[1] === 'assets' && segments.length === 4 && method === 'POST' && segments[3] === 'replace-files') {
      const parsed = await parseMultipart(request, { root: data, maxBytes: maxUploadBytes });
      try {
        const { id } = await requireAssetRecord(segments[2], data);
        const revision = Number(parsed.form.get('expectedRevision'));
        requiredRevision(revision);
        const result = await jobs.withMutation(`asset:${id}`, () => replaceAssetFiles(id, parsed.files, { root: data, expectedRevision: revision }));
        return json(response, 200, { asset: publicAsset(result) });
      } finally { await parsed.cleanup(); }
    }

    if (segments[1] === 'assets' && segments.length === 3 && method === 'DELETE') {
      const body = await readJson(request);
      const { id } = await requireAssetRecord(segments[2], data);
      const result = await jobs.withMutation(`asset:${id}`, () => deleteAsset(id, { root: data, expectedRevision: body.expectedRevision }));
      return json(response, 200, { asset: publicAsset(result) });
    }

    if (segments.length === 2 && segments[1] === 'tags' && method === 'GET') {
      return json(response, 200, await listTags({ root: data }));
    }
    if (segments.length === 3 && segments[1] === 'tags' && segments[2] === 'rename' && method === 'POST') {
      const body = await readJson(request);
      const result = await jobs.withMutation('asset-tags', () => renameTag(body.tag, body.newTag, { root: data, expectedRevision: body.expectedRevision }));
      return json(response, 200, result);
    }
    if (segments.length === 3 && segments[1] === 'tags' && segments[2] === 'delete' && method === 'POST') {
      const body = await readJson(request);
      const result = await jobs.withMutation('asset-tags', () => deleteTag(body.tag, { root: data, expectedRevision: body.expectedRevision }));
      return json(response, 200, result);
    }

    if (segments.length === 2 && segments[1] === 'dna' && method === 'GET') {
      const profile = await readDna({ root: data });
      return json(response, 200, { profile: { revision: profile.revision, enabled: profile.enabled, content: profile.content, savedAt: profile.savedAt ?? null } });
    }
    if (segments.length === 2 && segments[1] === 'dna' && method === 'POST') {
      const body = await readJson(request);
      const profile = await jobs.withMutation('dna', () => saveDna(body, { root: data }));
      return json(response, 200, { profile: { revision: profile.revision, enabled: profile.enabled, content: profile.content, savedAt: profile.savedAt ?? null } });
    }
    if (segments.length === 3 && segments[1] === 'dna' && segments[2] === 'organize' && method === 'POST') {
      const body = await readJson(request);
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20000) throw error('ERR_DNA_TEXT', 'DNA 整理内容必须是 1 到 20000 字的文本');
      if (!agent || typeof agent.organizeDna !== 'function') throw error('ERR_AGENT_UNAVAILABLE', 'DNA 整理 Agent 当前不可用', 503);
      const job = await jobs.start({
        resourceKey: 'dna-organize',
        kind: 'dna-organize',
        run: ({ signal, onEvent }) => agent.organizeDna({ text: body.text, signal, onEvent }),
        resultView: (result) => ({ draft: { content: result.content }, source: 'agent' }),
      });
      return json(response, 202, { job });
    }

    if (segments[1] === 'model-plugin') {
      if (segments.length === 2 && method === 'GET') return json(response, 200, await callModelPlugin('status', undefined, { root: data, start: false }));
      if (segments.length === 3 && method === 'POST' && ['login', 'logout', 'cancel'].includes(segments[2])) {
        return json(response, 200, await callModelPlugin(segments[2], await readJson(request), { root: data, signal: request.abortSignal }));
      }
    }

    if (segments.length === 2 && segments[1] === 'config' && method === 'GET') {
      return json(response, 200, { config: publicConfig(await readConfigRecord({ root: data })) });
    }
    if (segments.length === 2 && segments[1] === 'config' && method === 'POST') {
      const body = await readJson(request);
      const saved = await saveConfig(body, { root: data });
      let canvasSync;
      try {
        canvasSync = typeof canvas?.syncImageConfig === 'function'
          ? await canvas.syncImageConfig(saved)
          : { status: 'no-active-canvas', updated: 0, active: 0, message: '当前没有已打开的 Canvas，新配置会在下次打开时应用。' };
      } catch {
        canvasSync = { status: 'unsynced', updated: 0, active: 0, message: '图片配置已保存，但 Canvas 未同步；请在生成前重试同步。' };
      }
      return json(response, 200, { config: publicConfig(saved), canvasSync });
    }
    if (segments.length === 3 && segments[1] === 'config' && segments[2] === 'models' && method === 'POST') {
      const body = await readJson(request);
      if (!['base', 'image'].includes(body.kind)) throw error('ERR_MODEL_LIST_KIND', '模型范围必须是 base 或 image');
      const saved = await readConfigRecord({ root: data });
      const source = body.kind === 'base' ? (body.source ?? saved.base.source ?? 'custom') : 'custom';
      if (!MODEL_SOURCES.includes(source)) throw error('ERR_MODEL_LIST_INPUT', '模型来源无效');
      if (source !== 'custom') return json(response, 200, await callModelPlugin('models', { source }, { root: data, signal: request.abortSignal }));
      const channel = modelListChannel(body, saved[body.kind]);
      return json(response, 200, { models: await listProviderModels(channel, { fetchImpl, signal: request.abortSignal }) });
    }
    if (segments.length === 3 && segments[1] === 'config' && segments[2] === 'check' && method === 'POST') {
      const body = await readJson(request);
      if (!['base', 'image', 'all'].includes(body.kind)) throw error('ERR_CONFIG_CHECK_KIND', '检查范围必须是 base、image 或 all');
      const config = await readConfigRecord({ root: data });
      const channels = body.kind === 'all' ? ['base', 'image'] : [body.kind];
      const responseItems = {};
      for (const kind of channels) {
        const channel = kind === 'base' ? await resolveBasicConfig(config.base, { root: data }) : config[kind];
        if (!channel.baseUrl || !channel.model || !channel.apiKey) {
          responseItems[kind] = {
            status: 'not_configured',
            checkedAt: new Date().toISOString(),
            capabilities: kind === 'image' ? {
              provider: 'openai-compatible',
              model: channel.model ? sanitizeText(channel.model) : null,
              connectionTested: false,
              modelsEndpointAvailable: false,
              modelListed: null,
            } : {},
            message: '该模型尚未完整配置；没有发出请求。',
          };
          continue;
        }
        if (kind === 'image') {
          responseItems.image = await checkImageProvider(channel, { fetchImpl, signal: request.abortSignal });
          continue;
        }
        if (!agent || typeof agent.check !== 'function') throw error('ERR_AGENT_UNAVAILABLE', '模型连接检查当前不可用', 503);
        const checkedAt = new Date().toISOString();
        const result = await agent.check({ kind, signal: request.abortSignal });
        const capabilities = {
          text: Boolean(result?.text),
          tools: Boolean(result?.tools),
          vision: Boolean(result?.vision),
          notes: sanitizeText(result?.notes || ''),
        };
        const passed = capabilities.text && capabilities.tools;
        responseItems[kind] = {
          status: passed ? 'connected' : 'failed',
          checkedAt,
          capabilities,
          message: passed
            ? '基础模型对话及 DSH 工具调用检查通过；读图能力须通过实际成品审核链路确认。'
            : '基础模型连接或 DSH 工具调用检查未通过，请核对模型地址与能力。',
        };
      }
      return json(response, 200, { checks: responseItems });
    }

    if (segments[1] === 'tasks' && segments.length === 6 && method === 'GET' && segments[3] === 'canvas' && segments[4] === 'candidates') {
      const { id } = await requireTask(segments[2]);
      const nodeId = segments[5];
      if (!canvas || typeof canvas.candidateImage !== 'function') throw error('ERR_CANVAS_UNAVAILABLE', 'Canvas 当前不可用', 503);
      const version = Number(url.searchParams.get('version'));
      const page = Number(url.searchParams.get('page'));
      if (!Number.isInteger(version) || !Number.isInteger(page) || page < 1) throw error('ERR_CANVAS_CANDIDATE', 'Canvas 候选图片参数无效');
      const candidate = await canvas.candidateImage(id, { version, page, nodeId });
      const type = validateMimeFromCandidate(candidate.contentType);
      if (!Buffer.isBuffer(candidate.buffer) || candidate.buffer.length > 40 * 1024 * 1024) throw error('ERR_CANVAS_IMAGE', 'Canvas 图片无效或超过限制', 413);
      const digest = crypto.createHash('sha256').update(candidate.buffer).digest('hex');
      if (candidate.sha256 && candidate.sha256 !== digest) throw error('ERR_CANVAS_IMAGE_HASH', 'Canvas 候选图片校验失败', 409);
      response.writeHead(200, {
        'content-type': type,
        'content-length': candidate.buffer.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cross-origin-resource-policy': 'same-origin',
      });
      return response.end(candidate.buffer);
    }

    throw error('ERR_ROUTE_NOT_FOUND', '接口不存在', 404);
  }

  async function requireAssetRecord(id, rootValue) {
    const record = await readAsset(id, { root: rootValue });
    return { id: record.id, record };
  }

  const server = http.createServer(async (request, response) => {
    try {
      await ready;
      const mutating = !['GET', 'HEAD'].includes(request.method || 'GET');
      assertRequestOrigin(request, mutating);
      if (request.method === 'OPTIONS') throw error('ERR_METHOD_NOT_ALLOWED', '此服务不开放跨域请求', 405);
      const rawUrl = request.url || '/';
      let url;
      try { url = new URL(rawUrl, `http://${request.headers.host}`); }
      catch { throw error('ERR_URL_INVALID', '请求路径无效'); }
      if (url.origin !== `http://${request.headers.host}` && url.origin !== `https://${request.headers.host}`) {
        throw error('ERR_URL_INVALID', '请求路径无效');
      }
      const requestController = new AbortController();
      request.once('aborted', () => requestController.abort());
      response.once('close', () => { if (!response.writableEnded) requestController.abort(); });
      request.abortSignal = requestController.signal;
      if (url.pathname.startsWith('/api/')) {
        await handleApi(request, response, url);
        return;
      }
      if ((request.method || 'GET') === 'GET') {
        if (await staticFile(response, staticDir, url.pathname)) return;
      }
      throw error('ERR_ROUTE_NOT_FOUND', '页面或接口不存在', 404);
    } catch (errorValue) {
      if (response.headersSent) {
        if (!response.destroyed) response.destroy(errorValue);
        return;
      }
      const result = apiError(errorValue);
      json(response, result.status, result.body);
    }
  });
  server.requestTimeout = 5 * 60 * 1000;
  server.headersTimeout = 30 * 1000;
  server.keepAliveTimeout = 5 * 1000;
  server.studioReady = ready;
  server.studioJobs = jobs;
  server.shutdownStudio = async ({ timeoutMs } = {}) => {
    await jobs.close({ timeoutMs });
    await canvas?.stop?.();
  };
  return server;
}

export async function listenStudioServer(options = {}) {
  const host = options.host || '127.0.0.1';
  if (!isLoopback(host)) throw error('ERR_LOCAL_ONLY', 'Studio 服务只能绑定本机 loopback 地址', 403);
  const server = createStudioServer(options);
  await server.studioReady;
  const address = await new Promise((resolve, reject) => {
    const onError = (failure) => { server.off('listening', onListen); reject(failure); };
    const onListen = () => { server.off('error', onError); resolve(server.address()); };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(options.port ?? 0, host);
  });
  return {
    server,
    address,
    close: async () => {
      if (!server.listening) return;
      const closed = new Promise((resolve, reject) => server.close((failure) => failure ? reject(failure) : resolve()));
      try { await server.shutdownStudio(); }
      finally { await closed; }
    },
  };
}
