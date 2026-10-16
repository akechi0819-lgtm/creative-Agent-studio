import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dataRoot } from '../canvas/client.mjs';

import { MODEL_SOURCES, matchesSource, ensureModelPlugin } from './model-plugin.mjs';

const CHANNELS = ['base', 'image'];
const DEFAULT_CHANNEL = Object.freeze({ baseUrl: '', model: '', apiKey: '' });

function configDirectory(root) {
  const value = root ?? dataRoot();
  if (typeof value !== 'string' || !value.trim()) throw configError('ERR_CONFIG_ROOT', '配置根目录无效');
  return path.join(path.resolve(value), 'config');
}

function configPath(root) {
  return path.join(configDirectory(root), 'studio.json');
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function configError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function emptyRecord() {
  return { schemaVersion: 1, revision: 1, base: { ...DEFAULT_CHANNEL, source: 'custom' }, image: { ...DEFAULT_CHANNEL } };
}

function normalizeChannel(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError('ERR_CONFIG_INVALID', `${label} 配置必须是对象`);
  }
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
  if (baseUrl.length > 2000 || model.length > 300 || apiKey.length > 5000) {
    throw configError('ERR_CONFIG_INVALID', `${label} 配置长度超出限制`);
  }
  if (baseUrl) {
    let parsed;
    try { parsed = new URL(baseUrl); } catch {
      throw configError('ERR_CONFIG_INVALID', `${label} 服务地址无效`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw configError('ERR_CONFIG_INVALID', `${label} 服务地址仅支持不含凭据或查询参数的 HTTP(S) 地址`);
    }
  }
  if (label === '基础模型') {
    const source = value.source ?? 'custom';
    if (!MODEL_SOURCES.includes(source) || (source !== 'custom' && model && !matchesSource(model, source))) throw configError('ERR_CONFIG_INVALID', '基础模型来源与模型不匹配');
    return { baseUrl, model, apiKey, source };
  }
  return { baseUrl, model, apiKey };
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1 || !Number.isInteger(value.revision) || value.revision < 1) {
    throw configError('ERR_CONFIG_CORRUPT', '模型配置文件无效');
  }
  return {
    schemaVersion: 1,
    revision: value.revision,
    base: normalizeChannel(value.base ?? DEFAULT_CHANNEL, '基础模型'),
    image: normalizeChannel(value.image ?? DEFAULT_CHANNEL, '图片模型'),
  };
}

async function readRecord(root) {
  const directory = configDirectory(root);
  let directoryInfo;
  try { directoryInfo = await fs.lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return emptyRecord(); throw error; }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw configError('ERR_CONFIG_PATH', '模型配置目录必须是应用数据目录中的普通目录');
  const rootReal = await fs.realpath(path.resolve(root ?? dataRoot()));
  const directoryReal = await fs.realpath(directory);
  if (!isInside(rootReal, directoryReal)) throw configError('ERR_CONFIG_PATH', '模型配置目录超出应用数据目录');
  let fileInfo;
  try { fileInfo = await fs.lstat(configPath(root)); }
  catch (error) { if (error.code === 'ENOENT') return emptyRecord(); throw error; }
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw configError('ERR_CONFIG_PATH', '模型配置必须是普通文件');
  try {
    const raw = await fs.readFile(configPath(root), 'utf8');
    await fs.chmod(configPath(root), 0o600);
    return normalizeRecord(JSON.parse(raw));
  } catch (error) {
    if (error.code === 'ENOENT') return emptyRecord();
    if (error instanceof SyntaxError) throw configError('ERR_CONFIG_CORRUPT', '模型配置文件无效');
    throw error;
  }
}

/** Internal-only configuration consumed by the DSH runtime and Canvas manager. */
export async function readConfig({ root } = {}) {
  const record = await readRecord(root);
  return {
    revision: record.revision,
    basic: await resolveBasicConfig(record.base, { root }),
    image: { ...record.image },
  };
}

export async function resolveBasicConfig(base, { root } = {}) {
  if (!base.source || base.source === 'custom' || !base.model) return { ...base };
  const connection = await ensureModelPlugin({ root });
  return { source: base.source, model: base.model, baseUrl: `${connection.baseUrl}/v1`, apiKey: connection.apiKey };
}

export async function readConfigRecord({ root } = {}) {
  return readRecord(root);
}

export function publicConfig(record) {
  return {
    revision: record.revision,
    base: {
      source: record.base.source ?? 'custom',
      baseUrl: record.base.baseUrl,
      model: record.base.model,
      apiKeyConfigured: Boolean(record.base.apiKey),
    },
    image: {
      baseUrl: record.image.baseUrl,
      model: record.image.model,
      apiKeyConfigured: Boolean(record.image.apiKey),
    },
  };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function takeLock(root) {
  const directory = configDirectory(root);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await fs.lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw configError('ERR_CONFIG_PATH', '模型配置目录必须是应用数据目录中的普通目录');
  const rootReal = await fs.realpath(path.resolve(root ?? dataRoot()));
  const directoryReal = await fs.realpath(directory);
  if (!isInside(rootReal, directoryReal)) throw configError('ERR_CONFIG_PATH', '模型配置目录超出应用数据目录');
  await fs.chmod(directoryReal, 0o700);
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
        throw configError('ERR_CONFIG_BUSY', '模型配置正在更新，请稍后重试');
      }
      if (processIsAlive(existing.pid)) throw configError('ERR_CONFIG_BUSY', '模型配置正在更新，请稍后重试');
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
  throw configError('ERR_CONFIG_BUSY', '模型配置正在更新，请稍后重试');
}

async function releaseLock(lock) {
  try {
    const value = JSON.parse(await fs.readFile(lock.lockPath, 'utf8'));
    if (value.pid === lock.owner.pid && value.token === lock.owner.token) await fs.unlink(lock.lockPath);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Save model settings with revision CAS; blank keys preserve secrets unless explicitly cleared. */
export async function saveConfig(input, { root } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw configError('ERR_CONFIG_INVALID', '配置输入无效');
  const expectedRevision = input.expectedRevision;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw configError('ERR_CONFIG_REVISION_REQUIRED', '必须指定正整数 expectedRevision');
  }
  const clearKeys = input.clearKeys ?? [];
  if (!Array.isArray(clearKeys) || clearKeys.some((key) => !CHANNELS.includes(key))) {
    throw configError('ERR_CONFIG_INVALID', 'clearKeys 只能包含 base 或 image');
  }
  for (const key of Object.keys(input)) {
    if (!['expectedRevision', 'base', 'image', 'clearKeys'].includes(key)) {
      throw configError('ERR_CONFIG_INVALID', '配置包含不支持的字段');
    }
  }
  for (const name of CHANNELS) {
    if (input[name] != null && (!input[name] || typeof input[name] !== 'object' || Array.isArray(input[name]))) {
      throw configError('ERR_CONFIG_INVALID', `${name} 配置必须是对象`);
    }
    if (input[name] && Object.keys(input[name]).some((key) => !(name === 'base' ? ['source', 'baseUrl', 'model', 'apiKey'] : ['baseUrl', 'model', 'apiKey']).includes(key))) {
      throw configError('ERR_CONFIG_INVALID', `${name} 配置包含不支持的字段`);
    }
  }

  const lock = await takeLock(root);
  let temporary;
  try {
    const previous = await readRecord(root);
    if (previous.revision !== expectedRevision) {
      const error = configError('ERR_CONFIG_REVISION_CONFLICT', '模型配置已更新，请重新读取');
      error.expectedRevision = expectedRevision;
      error.actualRevision = previous.revision;
      throw error;
    }
    const next = { ...previous, revision: previous.revision + 1 };
    for (const name of CHANNELS) {
      const channel = { ...previous[name] };
      const source = input[name];
      if (source) {
        if (name === 'base' && Object.hasOwn(source, 'source')) channel.source = source.source;
        if (Object.hasOwn(source, 'baseUrl')) channel.baseUrl = source.baseUrl;
        if (Object.hasOwn(source, 'model')) channel.model = source.model;
        if (Object.hasOwn(source, 'apiKey') && typeof source.apiKey !== 'string') {
          throw configError('ERR_CONFIG_INVALID', `${name} 凭据必须是文本`);
        }
        if (typeof source.apiKey === 'string' && source.apiKey.trim()) channel.apiKey = source.apiKey;
      }
      if (clearKeys.includes(name)) channel.apiKey = '';
      if (!source && !clearKeys.includes(name)) continue;
      next[name] = normalizeChannel(channel, name === 'base' ? '基础模型' : '图片模型');
    }
    const destination = configPath(root);
    temporary = path.join(path.dirname(destination), `.studio-${crypto.randomUUID()}.tmp`);
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, destination);
    temporary = null;
    return next;
  } finally {
    if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
    await releaseLock(lock);
  }
}
