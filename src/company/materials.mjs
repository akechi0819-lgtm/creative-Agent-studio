import { createHash } from 'node:crypto';

export const COMPANY_MATERIAL_MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024;
export const COMPANY_MATERIAL_MAX_JSON_BYTES = 10 * 1024 * 1024;

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 20;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_QUERY_LENGTH = 2_000;
const MAX_TAG_COUNT = 20;
const MAX_TAG_LENGTH = 200;
const MAX_CONCEPT_GROUPS = 20;
const MAX_CONCEPT_ALTERNATIVES = 10;
const MAX_CONCEPT_LENGTH = 500;
const MAX_CONCEPT_TOTAL_LENGTH = 10_000;
const MAX_OBSERVED_FILES = 2_000;
const SAFE_ERROR = Symbol('company-materials-error');
const SOURCE_BOUNDARY = 'company_teedy_readonly';
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const VIDEO_EXTENSIONS = new Set(['.3gp', '.avi', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg', '.mts', '.ts', '.webm']);

function companyError(code, message) {
  const error = new Error(message);
  error.code = code;
  error[SAFE_ERROR] = true;
  return error;
}

function isSafeError(error) {
  return Boolean(error?.[SAFE_ERROR]);
}

function requestContext(parentSignal) {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
  return { signal, parentSignal, timeoutSignal };
}

function requestAbortError(context) {
  if (context?.parentSignal?.aborted) return companyError('ERR_COMPANY_MATERIALS_ABORTED', '素材请求已取消');
  if (context?.timeoutSignal?.aborted) return companyError('ERR_COMPANY_TEEDY_TIMEOUT', '公司素材服务请求超过 30 秒，已取消');
  return companyError('ERR_COMPANY_MATERIALS_ABORTED', '素材请求已取消');
}

function abortable(operation, context) {
  const signal = context?.signal;
  if (!signal) return Promise.resolve().then(operation);
  if (signal.aborted) return Promise.reject(requestAbortError(context));
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(requestAbortError(context));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const pending = Promise.resolve().then(() => {
    if (signal.aborted) throw requestAbortError(context);
    return operation();
  });
  return Promise.race([pending, aborted]).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
}

function safeIdentifier(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 300 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw companyError('ERR_COMPANY_MATERIALS_INPUT', `${label} 无效`);
  }
  return value.trim();
}

function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw companyError('ERR_COMPANY_TEEDY_CONFIG', '公司 Teedy 服务地址无效'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw companyError('ERR_COMPANY_TEEDY_CONFIG', '公司 Teedy 服务地址必须是无凭据的 HTTPS 地址');
  }
  return url.href.replace(/\/+$/, '');
}

function readSetCookies(headers) {
  if (typeof headers?.getSetCookie === 'function') return headers.getSetCookie();
  const value = headers?.get?.('set-cookie');
  if (!value) return [];
  // A combined Set-Cookie header can contain a comma in Expires; split only
  // where the next cookie name begins.
  return value.split(/,(?=\s*[^;,=\s]+\s*=)/g);
}

function setCookiePair(value) {
  const pair = String(value).split(';', 1)[0];
  const separator = pair.indexOf('=');
  if (separator <= 0) return null;
  return [pair.slice(0, separator).trim(), pair.slice(separator + 1).trim()];
}

function apiUrl(baseUrl, endpoint, params) {
  const url = new URL(`${baseUrl}${endpoint}`);
  if (url.origin !== new URL(baseUrl).origin) throw companyError('ERR_COMPANY_TEEDY_URL', 'Teedy 请求地址越界');
  if (params) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

function responseStatusError(status, action) {
  if (status === 401 || status === 403) return companyError('ERR_COMPANY_TEEDY_ACL', `${action} 未通过 Teedy 登录或权限检查`);
  if (status === 404) return companyError('ERR_COMPANY_TEEDY_NOT_FOUND', `${action} 对应的 Teedy 资源不存在`);
  return companyError('ERR_COMPANY_TEEDY_HTTP', `${action} 返回 HTTP ${status}`);
}

async function cancelResponseBody(response) {
  try { await response?.body?.cancel?.(); } catch { /* response cleanup must not replace the safe error */ }
}

async function ensureNotRedirect(response) {
  if (response.status >= 300 && response.status < 400) {
    await cancelResponseBody(response);
    throw companyError('ERR_COMPANY_TEEDY_REDIRECT', 'Teedy 返回了重定向，已停止请求以保护登录凭据');
  }
}

function cleanText(value, maxLength = 5000) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function tagNames(document) {
  return (Array.isArray(document?.tags) ? document.tags : [])
    .map(tag => typeof tag === 'string' ? tag : tag?.name)
    .filter(name => typeof name === 'string' && name.trim())
    .map(name => name.trim());
}

function fileRecord(file) {
  const fileId = typeof file?.id === 'string' ? file.id : '';
  return {
    fileId,
    id: fileId,
    name: typeof file?.name === 'string' ? file.name : '',
    mimeType: typeof file?.mimetype === 'string' ? file.mimetype : (typeof file?.mimeType === 'string' ? file.mimeType : ''),
    mimetype: typeof file?.mimetype === 'string' ? file.mimetype : (typeof file?.mimeType === 'string' ? file.mimeType : ''),
    size: Number.isFinite(Number(file?.size)) ? Number(file.size) : null,
  };
}

function extension(name) {
  const match = /\.[^.\\/]+$/.exec(String(name || '').toLowerCase());
  return match?.[0] || '';
}

function isImage(file) {
  const mime = String(file?.mimetype ?? file?.mimeType ?? '').toLowerCase();
  return mime.startsWith('image/') || IMAGE_EXTENSIONS.has(extension(file?.name));
}

function isVideo(file) {
  const mime = String(file?.mimetype ?? file?.mimeType ?? '').toLowerCase();
  return mime.startsWith('video/') || VIDEO_EXTENSIONS.has(extension(file?.name));
}

function mediaType(document, files) {
  const markers = [
    document?.media_type, document?.mediaType, document?.content_type, document?.contentType,
    document?.source_type, document?.sourceType, document?.type, document?.source,
  ].filter(Boolean).map(String).join(' ').toLowerCase();
  if (/(video\/|video|视频|短视频)/i.test(markers) || files.some(isVideo)) return 'video';
  return files.some(file => isImage(file) && file.id) ? 'image' : 'unknown';
}

function normalizeConceptGroups(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw companyError('ERR_COMPANY_MATERIALS_INPUT', 'required_concepts 必须是分组数组');
  if (value.length > MAX_CONCEPT_GROUPS) throw companyError('ERR_COMPANY_MATERIALS_INPUT', `required_concepts 最多支持 ${MAX_CONCEPT_GROUPS} 组`);
  let totalLength = 0;
  const groups = value.map(group => {
    if (!Array.isArray(group)) throw companyError('ERR_COMPANY_MATERIALS_INPUT', 'required_concepts 每组必须是说法数组');
    if (!group.length || group.some(term => typeof term !== 'string' || !term.trim())) {
      throw companyError('ERR_COMPANY_MATERIALS_INPUT', 'required_concepts 每组都必须保留至少一个有效说法');
    }
    if (group.length > MAX_CONCEPT_ALTERNATIVES) throw companyError('ERR_COMPANY_MATERIALS_INPUT', `required_concepts 每组最多支持 ${MAX_CONCEPT_ALTERNATIVES} 个备选说法`);
    const terms = group.map(term => term.trim());
    for (const term of terms) {
      if (term.length > MAX_CONCEPT_LENGTH) throw companyError('ERR_COMPANY_MATERIALS_INPUT', `required_concepts 单个说法不能超过 ${MAX_CONCEPT_LENGTH} 个字符`);
      totalLength += term.length;
    }
    if (totalLength > MAX_CONCEPT_TOTAL_LENGTH) throw companyError('ERR_COMPANY_MATERIALS_INPUT', 'required_concepts 总长度超出限制');
    return terms;
  });
  return groups;
}

function requiredConceptsMatch(document, files, groups) {
  if (!groups.length) return true;
  const fields = ['title', 'description', 'source', 'subject', 'media_type', 'mediaType', 'content_type', 'contentType', 'body', 'content'];
  const values = fields.map(key => document?.[key]).filter(Boolean).map(String);
  values.push(...tagNames(document));
  values.push(...files.map(file => file.name).filter(Boolean));
  const searchable = values.join(' ').toLocaleLowerCase();
  return groups.every(group => group.some(term => searchable.includes(term.toLocaleLowerCase())));
}

function tagsMatch(document, requestedTags) {
  const available = new Set(tagNames(document).map(name => name.toLocaleLowerCase()));
  return requestedTags.every(tag => available.has(tag.toLocaleLowerCase()));
}

function safeName(value) {
  const clean = String(value || '').replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim();
  return (clean || 'download').slice(0, 240);
}

function contentDispositionName(value) {
  if (!value) return null;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value);
  if (encoded) {
    try { return safeName(decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ''))); } catch { /* use filename= below */ }
  }
  const regular = /filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]*))/i.exec(value);
  const name = regular?.[1]?.replace(/\\(.)/g, '$1') ?? regular?.[2]?.trim();
  return name ? safeName(name) : null;
}

async function readBoundedBody(response, context, { maxBytes = COMPANY_MATERIAL_MAX_DOWNLOAD_BYTES, code = 'ERR_COMPANY_TEEDY_DOWNLOAD_TOO_LARGE', message = 'Teedy 文件超过下载大小限制' } = {}) {
  const signal = context?.signal ?? context;
  if (signal?.aborted) throw requestAbortError(context);
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel?.().catch?.(() => {});
    throw companyError(code, message);
  }
  if (!response.body) {
    try {
      const bytes = Buffer.from(await abortable(() => response.arrayBuffer(), context));
      if (bytes.length > maxBytes) throw companyError(code, message);
      return bytes;
    } catch (error) {
      if (isSafeError(error)) throw error;
      if (signal?.aborted) throw requestAbortError(context);
      throw companyError('ERR_COMPANY_TEEDY_DOWNLOAD_READ', '读取 Teedy 文件失败');
    }
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      if (signal?.aborted) throw companyError('ERR_COMPANY_MATERIALS_ABORTED', '素材请求已取消');
      const { done, value } = await abortable(() => reader.read(), context);
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw companyError(code, message);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (isSafeError(error)) throw error;
    if (signal?.aborted) throw requestAbortError(context);
    throw companyError('ERR_COMPANY_TEEDY_DOWNLOAD_READ', '读取 Teedy 文件失败');
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, size);
}

async function defaultReadConfig({ root }) {
  const { readCompanyConfig } = await import('./config.mjs');
  return readCompanyConfig({ root });
}

/** Create an authenticated, read-only adapter for the company Teedy library. */
export function createCompanyMaterials({ root, readConfig = defaultReadConfig, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw companyError('ERR_COMPANY_MATERIALS_FETCH', '当前运行环境没有可用的 fetch');
  const observedFiles = new Map();

  async function createClient(signal) {
    if (signal?.aborted) throw companyError('ERR_COMPANY_MATERIALS_ABORTED', '素材请求已取消');
    let configuration;
    try { configuration = await readConfig({ root }); }
    catch { throw companyError('ERR_COMPANY_TEEDY_CONFIG', '无法读取公司 Teedy 配置'); }
    const teedy = configuration?.teedy;
    if (!teedy || typeof teedy.username !== 'string' || typeof teedy.password !== 'string' || !teedy.username || !teedy.password) {
      throw companyError('ERR_COMPANY_TEEDY_CONFIG', '公司 Teedy 登录配置不完整');
    }
    const baseUrl = normalizeBaseUrl(teedy.baseUrl);
    const cookieJar = new Map();
    const responseContexts = new WeakMap();

    async function rawFetch(url, init, action) {
      const context = requestContext(init.signal ?? signal);
      if (context.signal.aborted) throw requestAbortError(context);
      try {
        const response = await abortable(() => fetchImpl(url, { ...init, signal: context.signal, redirect: 'manual', credentials: 'omit' }), context);
        responseContexts.set(response, context);
        if (response.url) {
          let responseUrl;
          try { responseUrl = new URL(response.url); }
          catch {
            await response.body?.cancel?.().catch?.(() => {});
            throw companyError('ERR_COMPANY_TEEDY_REDIRECT', 'Teedy 返回了无效的响应地址');
          }
          if (responseUrl.origin !== new URL(baseUrl).origin) {
            await response.body?.cancel?.().catch?.(() => {});
            throw companyError('ERR_COMPANY_TEEDY_REDIRECT', 'Teedy 响应地址超出固定服务范围');
          }
        }
        for (const cookie of readSetCookies(response.headers)) {
          const pair = setCookiePair(cookie);
          if (pair) cookieJar.set(pair[0], pair[1]);
        }
        await ensureNotRedirect(response);
        return response;
      } catch (error) {
        if (isSafeError(error)) throw error;
        if (context.signal.aborted) throw requestAbortError(context);
        throw companyError('ERR_COMPANY_TEEDY_NETWORK', `${action} 请求失败`);
      }
    }

    async function login() {
      const headers = { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' };
      const cookie = [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; ');
      if (cookie) headers.cookie = cookie;
      const response = await rawFetch(apiUrl(baseUrl, '/api/user/login'), {
        method: 'POST', headers,
        body: new URLSearchParams({ username: teedy.username, password: teedy.password }),
      }, 'Teedy 登录');
      await cancelResponseBody(response);
      if (!response.ok) throw companyError('ERR_COMPANY_TEEDY_LOGIN', `Teedy 登录失败（HTTP ${response.status}）`);
    }

    async function request(endpoint, { params, signal: requestSignal = signal, retryAuth = true } = {}) {
      const url = apiUrl(baseUrl, endpoint, params);
      const headers = {};
      const cookie = [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; ');
      if (cookie) headers.cookie = cookie;
      const response = await rawFetch(url, { method: 'GET', headers, signal: requestSignal }, 'Teedy 读取');
      if ((response.status === 401 || response.status === 403) && retryAuth) {
        await response.body?.cancel?.().catch?.(() => {});
        await login();
        return request(endpoint, { params, signal: requestSignal, retryAuth: false });
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw responseStatusError(response.status, 'Teedy 读取');
      }
      return response;
    }

    async function json(endpoint, options) {
      const response = await request(endpoint, options);
      const bytes = await readBoundedBody(response, responseContexts.get(response), {
        maxBytes: COMPANY_MATERIAL_MAX_JSON_BYTES,
        code: 'ERR_COMPANY_TEEDY_RESPONSE_TOO_LARGE',
        message: 'Teedy JSON 响应超过 10 MiB 限制',
      });
      try { return JSON.parse(bytes.toString('utf8')); }
      catch { throw companyError('ERR_COMPANY_TEEDY_RESPONSE', 'Teedy 返回了无效的 JSON'); }
    }

    await login();
    return { baseUrl, json, request, responseContexts };
  }

  async function listFiles(client, documentId, signal) {
    const payload = await client.json('/api/file/list', { params: { id: documentId }, signal });
    const files = Array.isArray(payload?.files) ? payload.files : [];
    for (const file of files) {
      if (!file?.id) continue;
      const fileId = String(file.id);
      let current = observedFiles.get(fileId);
      if (!current) {
        current = new Map();
        observedFiles.set(fileId, current);
        if (observedFiles.size > MAX_OBSERVED_FILES) {
          observedFiles.delete(observedFiles.keys().next().value);
        }
      }
      current.set(`${client.baseUrl}\0${documentId}`, { baseUrl: client.baseUrl, documentId, name: file.name, mimetype: file.mimetype });
    }
    return files;
  }

  function previewRecords(baseUrl, files, count = Infinity) {
    return files.filter(file => file.id && isImage(file)).slice(0, count).map(file => ({
      fileId: String(file.id),
      id: String(file.id),
      name: file.name ?? '',
      mimeType: file.mimetype ?? file.mimeType ?? '',
      mimetype: file.mimetype ?? file.mimeType ?? '',
      preview_url: `${baseUrl}/api/file/${encodeURIComponent(String(file.id))}/data?size=web`,
    }));
  }

  function normalizeFiles(files) {
    return files.filter(file => file?.id).map(fileRecord);
  }

  async function search(input = {}, { signal } = {}) {
    signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw companyError('ERR_COMPANY_MATERIALS_INPUT', '搜索条件无效');
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (input.query != null && typeof input.query !== 'string') throw companyError('ERR_COMPANY_MATERIALS_INPUT', 'query 必须是文本');
    if (query.length > MAX_QUERY_LENGTH) throw companyError('ERR_COMPANY_MATERIALS_INPUT', `query 不能超过 ${MAX_QUERY_LENGTH} 个字符`);
    const tags = input.tags == null ? [] : input.tags;
    if (!Array.isArray(tags)) throw companyError('ERR_COMPANY_MATERIALS_INPUT', 'tags 必须是数组');
    if (tags.length > MAX_TAG_COUNT) throw companyError('ERR_COMPANY_MATERIALS_INPUT', `tags 最多支持 ${MAX_TAG_COUNT} 个标签`);
    const requestedTags = tags.map(tag => typeof tag === 'string' ? tag.trim() : '').filter(Boolean);
    if (requestedTags.length !== tags.length) throw companyError('ERR_COMPANY_MATERIALS_INPUT', 'tags 中包含空标签或无效值');
    if (requestedTags.some(tag => tag.length > MAX_TAG_LENGTH)) throw companyError('ERR_COMPANY_MATERIALS_INPUT', `单个标签不能超过 ${MAX_TAG_LENGTH} 个字符`);
    const groups = normalizeConceptGroups(input.required_concepts);
    if (!query && !requestedTags.length) throw companyError('ERR_COMPANY_MATERIALS_INPUT', '请提供 query 或显式 tags');
    const rawLimit = input.limit == null ? DEFAULT_LIMIT : Number(input.limit);
    if (!Number.isFinite(rawLimit) || rawLimit < 1) throw companyError('ERR_COMPANY_MATERIALS_INPUT', 'limit 必须是正数');
    const limit = Math.min(MAX_LIMIT, Math.floor(rawLimit));
    const teedySearch = [...requestedTags.map(tag => `tag:${tag}`), ...(query ? [query] : [])].join(' ');
    const client = await createClient(signal);
    const payload = await client.json('/api/document/list', { params: { search: teedySearch, limit }, signal });
    const documents = Array.isArray(payload?.documents) ? payload.documents : [];
    const items = [];
    let excludedVideo = 0;
    let excludedUnclassified = 0;
    let rejectedTags = 0;
    let rejectedConcepts = 0;
    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index];
      const documentId = typeof document?.id === 'string' ? document.id : '';
      if (!documentId) continue;
      const rawFiles = await listFiles(client, documentId, signal);
      if (!tagsMatch(document, requestedTags)) { rejectedTags += 1; continue; }
      const detectedMedia = mediaType(document, rawFiles);
      if (detectedMedia !== 'image') {
        if (detectedMedia === 'video') excludedVideo += 1;
        else excludedUnclassified += 1;
        continue;
      }
      if (!requiredConceptsMatch(document, rawFiles, groups)) { rejectedConcepts += 1; continue; }
      const files = normalizeFiles(rawFiles);
      items.push({
        documentId,
        title: cleanText(document.title, 1000),
        summary: cleanText(document.description ?? document.summary),
        tags: tagNames(document),
        previews: previewRecords(client.baseUrl, rawFiles, 1),
        files,
        order: index,
        sourceBoundary: SOURCE_BOUNDARY,
        source: 'company_teedy',
      });
    }
    return {
      query,
      tags: requestedTags,
      search: teedySearch,
      limit,
      teedyTotal: Number.isFinite(Number(payload?.total)) ? Number(payload.total) : null,
      total: items.length,
      mediaFilter: { requested: 'image', excludedVideo, excludedUnclassified },
      rejectedTags,
      required_concepts: groups,
      rejectedRequiredConcepts: rejectedConcepts,
      items,
    };
  }

  async function get(documentIdValue, { signal } = {}) {
    const documentId = safeIdentifier(documentIdValue, 'documentId');
    const client = await createClient(signal);
    const document = await client.json(`/api/document/${encodeURIComponent(documentId)}`, { signal });
    const bodyValue = document.body ?? document.content ?? document.extracted_text ?? document.extractedText ?? '';
    const contentValue = document.content ?? document.body ?? document.extracted_text ?? document.extractedText ?? '';
    if ([bodyValue, contentValue].some(value => typeof value === 'string' && value.length > 500_000)) {
      throw companyError('ERR_COMPANY_TEEDY_TEXT_TOO_LARGE', 'Teedy 正文超过 500,000 个字符限制，未保留来源');
    }
    const rawFiles = await listFiles(client, documentId, signal);
    return {
      documentId: typeof document.id === 'string' ? document.id : documentId,
      title: cleanText(document.title, 1000),
      summary: cleanText(document.description ?? document.summary),
      description: cleanText(document.description),
      body: typeof bodyValue === 'string' ? bodyValue : '',
      content: typeof contentValue === 'string' ? contentValue : '',
      source: cleanText(document.source, 1000),
      subject: cleanText(document.subject, 1000),
      language: cleanText(document.language, 100),
      tags: tagNames(document),
      writable: false,
      previews: previewRecords(client.baseUrl, rawFiles),
      files: normalizeFiles(rawFiles),
      sourceBoundary: SOURCE_BOUNDARY,
    };
  }

  async function preview(documentIdValue, fileIdValue, { signal } = {}) {
    const documentId = safeIdentifier(documentIdValue, 'documentId');
    const fileId = safeIdentifier(fileIdValue, 'fileId');
    const client = await createClient(signal);
    const currentFiles = await listFiles(client, documentId, signal);
    const currentFile = currentFiles.find(file => String(file?.id) === fileId);
    if (!currentFile) throw companyError('ERR_COMPANY_TEEDY_ACL', '当前账号无权预览该 Teedy 文件');
    const response = await client.request(`/api/file/${encodeURIComponent(fileId)}/data`, { params: { size: 'web' }, signal });
    const bytes = await readBoundedBody(response, client.responseContexts.get(response), {
      maxBytes: MAX_PREVIEW_BYTES,
      code: 'ERR_COMPANY_TEEDY_PREVIEW_TOO_LARGE',
      message: 'Teedy 预览超过 8 MiB 限制',
    });
    return { bytes, mimeType: (response.headers?.get?.('content-type') || currentFile.mimetype || 'application/octet-stream').split(';', 1)[0].trim() };
  }

  async function download(fileIdValue, { signal } = {}) {
    const fileId = safeIdentifier(fileIdValue, 'fileId');
    const authorizedDocs = observedFiles.get(fileId);
    if (!authorizedDocs?.size) throw companyError('ERR_COMPANY_TEEDY_FILE_UNOBSERVED', '文件未通过当前公司素材实例的文档 ACL 检查');
    const client = await createClient(signal);
    const accessibleDocument = [...authorizedDocs.values()].find(record => record.baseUrl === client.baseUrl);
    if (!accessibleDocument) throw companyError('ERR_COMPANY_TEEDY_FILE_UNOBSERVED', '文件来源与当前公司 Teedy 实例不一致');
    const currentFiles = await listFiles(client, accessibleDocument.documentId, signal);
    const currentFile = currentFiles.find(file => String(file?.id) === fileId);
    if (!currentFile) throw companyError('ERR_COMPANY_TEEDY_ACL', '当前账号无权读取该 Teedy 文件');
    const response = await client.request(`/api/file/${encodeURIComponent(fileId)}/data`, { signal });
    const bytes = await readBoundedBody(response, client.responseContexts.get(response));
    const mimeType = (response.headers?.get?.('content-type') || currentFile.mimetype || 'application/octet-stream').split(';', 1)[0].trim();
    const name = contentDispositionName(response.headers?.get?.('content-disposition')) || safeName(currentFile.name || fileId);
    return { bytes, mimeType, name, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  return { search, get, preview, download };
}
