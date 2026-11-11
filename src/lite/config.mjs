import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { dataRoot } from '../canvas/client.mjs';

const DEFAULT_IMAGE = Object.freeze({ baseUrl: '', model: '', apiKey: '' });
export const VIDEO_PROVIDER = Object.freeze({
  baseUrl: 'https://api.osodm.com',
  model: 'minimax_h3',
  apiFormat: 'openai',
});
const DEFAULT_VIDEO = Object.freeze({ apiKey: '' });

function configError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rootPath(root) {
  const value = root ?? dataRoot();
  if (typeof value !== 'string' || !value.trim()) throw configError('ERR_CONFIG_ROOT', '配置根目录无效');
  return path.resolve(value);
}

function configDirectory(root) {
  return path.join(rootPath(root), 'config');
}

function configPath(root) {
  return path.join(configDirectory(root), 'studio.json');
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function emptyRecord() {
  return {
    schemaVersion: 1,
    revision: 1,
    imageRevision: 1,
    image: { ...DEFAULT_IMAGE },
    video: { ...DEFAULT_VIDEO },
  };
}

function normalizeImage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError('ERR_CONFIG_INVALID', '图片模型配置必须是对象');
  }
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
  if (baseUrl.length > 2000 || model.length > 300 || apiKey.length > 5000) {
    throw configError('ERR_CONFIG_INVALID', '图片模型配置长度超出限制');
  }
  if (baseUrl) {
    let parsed;
    try { parsed = new URL(baseUrl); } catch {
      throw configError('ERR_CONFIG_INVALID', '图片服务地址无效');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw configError('ERR_CONFIG_INVALID', '图片服务地址仅支持不含凭据或查询参数的 HTTP(S) 地址');
    }
  }
  return { baseUrl, model, apiKey };
}

function normalizeVideo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => key !== 'apiKey')) {
    throw configError('ERR_CONFIG_INVALID', 'H3 视频配置只允许本机 API Key');
  }
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
  if (apiKey.length > 5000) throw configError('ERR_CONFIG_INVALID', '视频 API Key 长度超出限制');
  return { apiKey };
}

function normalizePublicEndpoint(value, label) {
  if (typeof value !== 'string') throw configError('ERR_COMPANY_DEFAULTS_INVALID', `${label} 必须是文本`);
  const result = value.trim();
  if (result.length > 2000) throw configError('ERR_COMPANY_DEFAULTS_INVALID', `${label} 长度超出限制`);
  if (result) {
    let parsed;
    try { parsed = new URL(result); } catch {
      throw configError('ERR_COMPANY_DEFAULTS_INVALID', `${label} 地址无效`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw configError('ERR_COMPANY_DEFAULTS_INVALID', `${label} 仅支持不含凭据或查询参数的 HTTP(S) 地址`);
    }
  }
  return result;
}

function normalizeMaterialBaseUrl(value) {
  if (typeof value !== 'string') throw configError('ERR_COMPANY_DEFAULTS_INVALID', '公司素材库地址必须是文本');
  const result = value.trim();
  if (result.length > 2000) throw configError('ERR_COMPANY_DEFAULTS_INVALID', '公司素材库地址长度超出限制');
  if (!result) return '';
  let parsed;
  try { parsed = new URL(result); } catch {
    throw configError('ERR_COMPANY_DEFAULTS_INVALID', '公司素材库地址无效');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const localHostname = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1'
    || (net.isIP(hostname) === 4 && Number(hostname.split('.')[0]) === 127);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || localHostname) {
    throw configError('ERR_COMPANY_DEFAULTS_INVALID', '公司素材库地址仅支持非本机、不含凭据或查询参数的 HTTPS 地址');
  }
  return parsed.toString().replace(/\/$/, '');
}

/** Validate the non-secret defaults shared by packaging and the setup UI. */
export function validateCompanyDefaults(value) {
  const invalid = () => configError('ERR_COMPANY_DEFAULTS_INVALID', '公司默认配置只允许图片地址/模型及素材库地址，不接受 API Key、token 或账号口令');
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['image', 'materials'].includes(key))) throw invalid();
  const image = Object.hasOwn(value, 'image') ? value.image : {};
  const materials = Object.hasOwn(value, 'materials') ? value.materials : {};
  if (!image || typeof image !== 'object' || Array.isArray(image)
    || Object.keys(image).some((key) => !['baseUrl', 'model'].includes(key))) throw invalid();
  if (!materials || typeof materials !== 'object' || Array.isArray(materials)
    || Object.keys(materials).some((key) => !['baseUrl'].includes(key))) throw invalid();
  if (['baseUrl', 'model'].some((key) => Object.hasOwn(image, key) && typeof image[key] !== 'string')
    || (Object.hasOwn(materials, 'baseUrl') && typeof materials.baseUrl !== 'string')) throw invalid();
  const model = typeof image.model === 'string' ? image.model.trim() : '';
  if (model.length > 300) throw configError('ERR_COMPANY_DEFAULTS_INVALID', '图片模型名称长度超出限制');
  return {
    image: { baseUrl: normalizePublicEndpoint(image.baseUrl === undefined ? '' : image.baseUrl, '图片服务'), model },
    materials: { baseUrl: normalizeMaterialBaseUrl(materials.baseUrl === undefined ? '' : materials.baseUrl) },
  };
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['schemaVersion', 'revision', 'imageRevision', 'image', 'video'].includes(key))
    || value.schemaVersion !== 1 || !Number.isInteger(value.revision) || value.revision < 1) {
    throw configError('ERR_CONFIG_CORRUPT', '本机服务配置文件无效');
  }
  if (!value.image || typeof value.image !== 'object' || Array.isArray(value.image)
    || Object.keys(value.image).some((key) => !['baseUrl', 'model', 'apiKey'].includes(key))
    || ['baseUrl', 'model', 'apiKey'].some((key) => typeof value.image[key] !== 'string')) {
    throw configError('ERR_CONFIG_CORRUPT', '本机图片服务配置无效');
  }
  const imageRevision = value.imageRevision ?? value.revision;
  if (!Number.isInteger(imageRevision) || imageRevision < 1) throw configError('ERR_CONFIG_CORRUPT', '本机图片配置版本无效');
  let video;
  try { video = normalizeVideo(value.video ?? DEFAULT_VIDEO); }
  catch { throw configError('ERR_CONFIG_CORRUPT', '本机视频服务配置无效'); }
  return {
    schemaVersion: 1,
    revision: value.revision,
    imageRevision,
    image: normalizeImage(value.image),
    video,
  };
}

async function ensureContainedDirectory(root) {
  const resolvedRoot = rootPath(root);
  const directory = configDirectory(resolvedRoot);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await fs.lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw configError('ERR_CONFIG_PATH', '配置目录必须是应用数据目录中的普通目录');
  }
  const rootReal = await fs.realpath(resolvedRoot);
  const directoryReal = await fs.realpath(directory);
  if (!isInside(rootReal, directoryReal)) throw configError('ERR_CONFIG_PATH', '配置目录超出应用数据目录');
  await fs.chmod(directoryReal, 0o700);
  return directory;
}

async function readRecord(root) {
  const directory = configDirectory(root);
  let directoryInfo;
  try { directoryInfo = await fs.lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return emptyRecord(); throw error; }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw configError('ERR_CONFIG_PATH', '配置目录必须是应用数据目录中的普通目录');
  }
  const resolvedRoot = rootPath(root);
  const rootReal = await fs.realpath(resolvedRoot);
  const directoryReal = await fs.realpath(directory);
  if (!isInside(rootReal, directoryReal)) throw configError('ERR_CONFIG_PATH', '配置目录超出应用数据目录');

  let fileInfo;
  try { fileInfo = await fs.lstat(configPath(resolvedRoot)); }
  catch (error) { if (error.code === 'ENOENT') return emptyRecord(); throw error; }
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw configError('ERR_CONFIG_PATH', '图片模型配置必须是普通文件');
  try {
    return normalizeRecord(JSON.parse(await fs.readFile(configPath(resolvedRoot), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return emptyRecord();
    if (error instanceof SyntaxError) throw configError('ERR_CONFIG_CORRUPT', '图片模型配置文件无效');
    throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function takeLock(directory) {
  const lockPath = path.join(directory, '.write-lock');
  const owner = { pid: process.pid, token: crypto.randomUUID() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); }
      finally { await handle.close(); }
      return { lockPath, owner };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let before;
      let existing;
      try {
        before = await fs.readFile(lockPath, 'utf8');
        existing = JSON.parse(before);
      } catch {
        throw configError('ERR_CONFIG_BUSY', '图片配置正在更新，请稍后重试');
      }
      if (processIsAlive(existing.pid)) throw configError('ERR_CONFIG_BUSY', '图片配置正在更新，请稍后重试');
      try {
        if (await fs.readFile(lockPath, 'utf8') !== before) continue;
        const retired = `${lockPath}.dead-${crypto.randomUUID()}`;
        await fs.rename(lockPath, retired);
        await fs.rm(retired, { force: true });
      } catch (removeError) {
        if (removeError.code !== 'ENOENT') throw removeError;
      }
    }
  }
  throw configError('ERR_CONFIG_BUSY', '图片配置正在更新，请稍后重试');
}

async function releaseLock(lock) {
  try {
    const value = JSON.parse(await fs.readFile(lock.lockPath, 'utf8'));
    if (value.pid === lock.owner.pid && value.token === lock.owner.token) await fs.unlink(lock.lockPath);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Read the private local service record. Keys are omitted from publicConfig. */
export async function readConfigRecord({ root } = {}) {
  return readRecord(root);
}

/** Internal provider configuration for the shared local Canvas server. */
export async function readConfig({ root } = {}) {
  const record = await readRecord(root);
  return {
    revision: record.revision,
    imageRevision: record.imageRevision,
    image: { ...record.image },
    video: { ...VIDEO_PROVIDER, ...record.video },
  };
}

export function publicConfig(record) {
  return {
    revision: record.revision,
    imageRevision: record.imageRevision ?? record.revision,
    image: {
      baseUrl: record.image.baseUrl,
      model: record.image.model,
      apiKeyConfigured: Boolean(record.image.apiKey),
    },
    video: {
      ...VIDEO_PROVIDER,
      apiKeyConfigured: Boolean(record.video?.apiKey),
    },
  };
}

async function saveRecord(expectedRevision, update, root, label) {
  const directory = await ensureContainedDirectory(root);
  const lock = await takeLock(directory);
  let temporary;
  try {
    const previous = await readRecord(root);
    if (previous.revision !== expectedRevision) {
      const error = configError('ERR_CONFIG_REVISION_CONFLICT', `${label}配置已更新，请重新读取`);
      error.expectedRevision = expectedRevision;
      error.actualRevision = previous.revision;
      throw error;
    }
    const next = normalizeRecord(update(previous));
    const destination = configPath(root);
    temporary = path.join(directory, `.studio-${crypto.randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, destination);
    temporary = null;
    return next;
  } finally {
    if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
    await releaseLock(lock);
  }
}

/** Save the image API with file CAS and an image-only revision; a blank key preserves it. */
export async function saveConfig(input, { root } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw configError('ERR_CONFIG_INVALID', '配置输入无效');
  if (Object.keys(input).some((key) => !['expectedRevision', 'image', 'clearKeys'].includes(key))) {
    throw configError('ERR_CONFIG_INVALID', '配置包含不支持的字段');
  }
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw configError('ERR_CONFIG_REVISION_REQUIRED', '必须指定正整数 expectedRevision');
  }
  if (!input.image || typeof input.image !== 'object' || Array.isArray(input.image)) {
    throw configError('ERR_CONFIG_INVALID', '图片模型配置必须是对象');
  }
  if (Object.keys(input.image).some((key) => !['baseUrl', 'model', 'apiKey'].includes(key))) {
    throw configError('ERR_CONFIG_INVALID', '图片模型配置包含不支持的字段');
  }
  if (Object.hasOwn(input.image, 'apiKey') && typeof input.image.apiKey !== 'string') {
    throw configError('ERR_CONFIG_INVALID', '图片 API Key 必须是文本');
  }
  const clearKeys = input.clearKeys ?? [];
  if (!Array.isArray(clearKeys) || clearKeys.some((key) => key !== 'image')) {
    throw configError('ERR_CONFIG_INVALID', 'clearKeys 只能包含 image');
  }
  return saveRecord(input.expectedRevision, (previous) => {
    const candidate = { ...previous.image };
    if (Object.hasOwn(input.image, 'baseUrl')) candidate.baseUrl = input.image.baseUrl;
    if (Object.hasOwn(input.image, 'model')) candidate.model = input.image.model;
    if (typeof input.image.apiKey === 'string' && input.image.apiKey.trim()) candidate.apiKey = input.image.apiKey;
    if (clearKeys.includes('image')) candidate.apiKey = '';
    return {
      schemaVersion: 1,
      revision: previous.revision + 1,
      imageRevision: previous.imageRevision + 1,
      image: normalizeImage(candidate),
      video: previous.video,
    };
  }, root, '图片');
}

/** Save the fixed H3 provider key in the same private file without changing imageRevision. */
export async function saveVideoConfig(input, { root } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['expectedRevision', 'video', 'clearKeys'].includes(key))) {
    throw configError('ERR_CONFIG_INVALID', '视频配置输入无效');
  }
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw configError('ERR_CONFIG_REVISION_REQUIRED', '必须指定正整数 expectedRevision');
  }
  if (!input.video || typeof input.video !== 'object' || Array.isArray(input.video)
    || Object.keys(input.video).some((key) => key !== 'apiKey')) {
    throw configError('ERR_CONFIG_INVALID', 'H3 视频配置只允许本机 API Key');
  }
  if (Object.hasOwn(input.video, 'apiKey') && typeof input.video.apiKey !== 'string') {
    throw configError('ERR_CONFIG_INVALID', '视频 API Key 必须是文本');
  }
  const clearKeys = input.clearKeys ?? [];
  if (!Array.isArray(clearKeys) || clearKeys.some((key) => key !== 'video')) {
    throw configError('ERR_CONFIG_INVALID', 'clearKeys 只能包含 video');
  }
  return saveRecord(input.expectedRevision, (previous) => {
    const candidate = { ...previous.video };
    if (typeof input.video.apiKey === 'string' && input.video.apiKey.trim()) candidate.apiKey = input.video.apiKey;
    if (clearKeys.includes('video')) candidate.apiKey = '';
    return {
      schemaVersion: 1,
      revision: previous.revision + 1,
      imageRevision: previous.imageRevision,
      image: previous.image,
      video: normalizeVideo(candidate),
    };
  }, root, '视频');
}
