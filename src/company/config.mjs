import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dataRoot } from '../canvas/client.mjs';
import { readCompanyDeployment } from './deployment.mjs';

const SECRET_FIELDS = ['teedy.password'];
const TEEDY_FIELDS = ['baseUrl', 'username', 'password'];
const CANVAS_FIELDS = ['webUrl'];

function configError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function configDirectory(root) {
  const value = root ?? dataRoot();
  if (typeof value !== 'string' || !value.trim()) throw configError('ERR_COMPANY_CONFIG_ROOT', '公司配置根目录无效');
  return path.join(path.resolve(value), 'config');
}

function configPath(root) {
  return path.join(configDirectory(root), 'company.json');
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function emptyRecord() {
  return {
    revision: 1,
    teedy: { baseUrl: '', username: '', password: '' },
    canvas: { webUrl: '' },
  };
}

function assertObject(value, label, code = 'ERR_COMPANY_CONFIG_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError(code, `${label}必须是对象`);
  }
}

function checkedText(value, label, maxLength, { secret = false } = {}) {
  if (typeof value !== 'string') throw configError('ERR_COMPANY_CONFIG_INVALID', `${label}必须是文本`);
  if (value.length > maxLength) throw configError('ERR_COMPANY_CONFIG_INVALID', `${label}长度超出限制`);
  return secret ? value : value.trim();
}

function checkedUrl(value, label, { protocol, loopback = false } = {}) {
  const text = checkedText(value, label, 2000);
  if (!text) return '';
  if (/\s/u.test(text) || text.includes('?') || text.includes('#')) {
    throw configError('ERR_COMPANY_CONFIG_INVALID', `${label}地址无效`);
  }
  let parsed;
  try { parsed = new URL(text); } catch {
    throw configError('ERR_COMPANY_CONFIG_INVALID', `${label}地址无效`);
  }
  if (parsed.protocol !== protocol || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw configError('ERR_COMPANY_CONFIG_INVALID', `${label}地址必须使用有效的 ${protocol} 地址，且不含凭据、查询参数或片段`);
  }
  if (loopback) {
    const host = parsed.hostname.toLowerCase();
    const ipv4Loopback = /^127(?:\.\d{1,3}){3}$/u.test(host);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host) && !ipv4Loopback) {
      throw configError('ERR_COMPANY_CONFIG_INVALID', `${label}必须指向本机回环地址`);
    }
    if (!parsed.port || parsed.pathname !== '/') {
      throw configError('ERR_COMPANY_CONFIG_INVALID', `${label}必须包含端口且不能包含路径`);
    }
  }
  return text;
}

function normalizeTeedy(value, code = 'ERR_COMPANY_CONFIG_CORRUPT') {
  assertObject(value, 'Teedy 配置', code);
  if (Object.keys(value).some((key) => !TEEDY_FIELDS.includes(key))) throw configError(code, 'Teedy 配置包含不支持的字段');
  const baseUrl = checkedUrl(value.baseUrl ?? '', 'Teedy 服务', { protocol: 'https:' });
  const username = checkedText(value.username ?? '', 'Teedy 用户名', 300);
  const password = checkedText(value.password ?? '', 'Teedy 密码', 5000, { secret: true });
  return { baseUrl, username, password };
}

function normalizeCanvas(value, code = 'ERR_COMPANY_CONFIG_CORRUPT') {
  assertObject(value, 'Canvas 配置', code);
  if (Object.keys(value).some((key) => !CANVAS_FIELDS.includes(key))) throw configError(code, 'Canvas 配置包含不支持的字段');
  const webUrl = checkedUrl(value.webUrl ?? '', 'Canvas Web', { protocol: 'https:' });
  return { webUrl };
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isInteger(value.revision) || value.revision < 1
    || Object.keys(value).some((key) => !['revision', 'teedy', 'canvas'].includes(key))) {
    throw configError('ERR_COMPANY_CONFIG_CORRUPT', '公司配置文件无效');
  }
  return {
    revision: value.revision,
    teedy: normalizeTeedy(value.teedy),
    canvas: normalizeCanvas(value.canvas),
  };
}

async function verifyConfigDirectory(root, { create = false } = {}) {
  const directory = configDirectory(root);
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let directoryInfo;
  try { directoryInfo = await fs.lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw configError('ERR_COMPANY_CONFIG_PATH', '公司配置目录必须是应用数据目录中的普通目录');
  }
  const rootReal = await fs.realpath(path.resolve(root ?? dataRoot()));
  const directoryReal = await fs.realpath(directory);
  if (!isInside(rootReal, directoryReal)) throw configError('ERR_COMPANY_CONFIG_PATH', '公司配置目录超出应用数据目录');
  return { directory, directoryReal, rootReal };
}

async function readRecord(root) {
  const verified = await verifyConfigDirectory(root);
  if (!verified) return emptyRecord();
  const file = configPath(root);
  let fileInfo;
  try { fileInfo = await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return emptyRecord(); throw error; }
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw configError('ERR_COMPANY_CONFIG_PATH', '公司配置必须是普通文件');
  try {
    const raw = await fs.readFile(file, 'utf8');
    await fs.chmod(file, 0o600);
    return normalizeRecord(JSON.parse(raw));
  } catch (error) {
    if (error.code === 'ENOENT') return emptyRecord();
    if (error instanceof SyntaxError) throw configError('ERR_COMPANY_CONFIG_CORRUPT', '公司配置文件无效');
    throw error;
  }
}

/** Read the private company integration settings from config/company.json. */
export async function readCompanyConfig({ root } = {}) {
  const [record, deployment] = await Promise.all([readRecord(root), readCompanyDeployment()]);
  // The saved origin binds the personal password; a newly provisioned origin must never receive the previous service's password.
  return { ...record, deploymentConfigured: deployment.configured,
    teedy: { ...record.teedy, baseUrl: deployment.teedy.baseUrl,
      password: record.teedy.baseUrl === deployment.teedy.baseUrl ? record.teedy.password : '' },
    canvas: { webUrl: deployment.canvas.webUrl } };

}

/** Return only non-secret values and whether each secret is configured. */
export function publicCompanyConfig(record) {
  return {
    revision: record.revision,
    deploymentConfigured: record.deploymentConfigured === true,
    teedy: {
      baseUrl: record.teedy.baseUrl,
      username: record.teedy.username,
      passwordConfigured: Boolean(record.teedy.password),
    },
    canvas: {
      webUrl: record.canvas.webUrl,
    },
  };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function takeLock(root) {
  const verified = await verifyConfigDirectory(root, { create: true });
  await fs.chmod(verified.directoryReal, 0o700);
  const lockPath = path.join(verified.directory, '.company-write-lock');
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
        const info = await fs.lstat(lockPath);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('invalid lock');
        before = await fs.readFile(lockPath, 'utf8');
        existing = JSON.parse(before);
      } catch {
        throw configError('ERR_COMPANY_CONFIG_BUSY', '公司配置正在更新，请稍后重试');
      }
      if (processIsAlive(existing.pid)) throw configError('ERR_COMPANY_CONFIG_BUSY', '公司配置正在更新，请稍后重试');
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
  throw configError('ERR_COMPANY_CONFIG_BUSY', '公司配置正在更新，请稍后重试');
}

async function releaseLock(lock) {
  try {
    const value = JSON.parse(await fs.readFile(lock.lockPath, 'utf8'));
    if (value.pid === lock.owner.pid && value.token === lock.owner.token) await fs.unlink(lock.lockPath);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function validateSaveInput(input) {
  assertObject(input, '公司配置输入', 'ERR_COMPANY_CONFIG_INVALID');
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw configError('ERR_COMPANY_CONFIG_REVISION_REQUIRED', '必须指定正整数 expectedRevision');
  }
  if (Object.keys(input).some((key) => !['expectedRevision', 'teedy', 'clearSecrets'].includes(key))) {
    throw configError('ERR_COMPANY_CONFIG_INVALID', '公司配置输入包含不支持的字段');
  }
  for (const [section, fields] of [['teedy', ['username', 'password']]]) {
    if (input[section] == null) continue;
    assertObject(input[section], `${section} 配置`, 'ERR_COMPANY_CONFIG_INVALID');
    if (Object.keys(input[section]).some((key) => !fields.includes(key))) {
      throw configError('ERR_COMPANY_CONFIG_INVALID', `${section} 配置包含不支持的字段`);
    }
  }
  const clearSecrets = input.clearSecrets ?? [];
  if (!Array.isArray(clearSecrets) || clearSecrets.some((field) => !SECRET_FIELDS.includes(field))) {
    throw configError('ERR_COMPANY_CONFIG_INVALID', 'clearSecrets 只能包含 teedy.password');
  }
  return clearSecrets;
}

/** Save integration settings with revision CAS; a blank Teedy password keeps the existing value. */
export async function saveCompanyConfig(input, { root } = {}) {
  const clearSecrets = validateSaveInput(input);
  const lock = await takeLock(root);
  let temporary;
  try {
    const previous = await readCompanyConfig({ root });
    if (!previous.deploymentConfigured) throw configError('ERR_COMPANY_DEPLOYMENT_REQUIRED', '运行包尚未预配公司服务，请联系管理员');
    if (previous.revision !== input.expectedRevision) {
      const error = configError('ERR_COMPANY_CONFIG_REVISION_CONFLICT', '公司配置已更新，请重新读取');
      error.expectedRevision = input.expectedRevision;
      error.actualRevision = previous.revision;
      throw error;
    }
    const next = {
      revision: previous.revision + 1,
      teedy: { ...previous.teedy },
      canvas: { ...previous.canvas },
    };
    for (const [section, fields] of [['teedy', ['username', 'password']]]) {
      const source = input[section];
      if (!source) continue;
      for (const field of fields) {
        if (!Object.hasOwn(source, field)) continue;
        const value = source[field];
        if (field === 'password') {
          const maximum = 5000;
          const checked = checkedText(value, `${section} ${field}`, maximum, { secret: true });
          if (checked.trim()) next[section][field] = checked;
          continue;
        }
        next[section][field] = checkedText(value, `${section} ${field}`, 300);
      }
    }
    const teedyIdentityChanged = next.teedy.baseUrl !== previous.teedy.baseUrl || next.teedy.username !== previous.teedy.username;
    const teedyPasswordProvided = typeof input.teedy?.password === 'string' && input.teedy.password.trim().length > 0;
    if (teedyIdentityChanged && previous.teedy.password && !teedyPasswordProvided && !clearSecrets.includes('teedy.password')) {
      throw configError('ERR_COMPANY_CONFIG_SECRET_CONTEXT', '更换 Teedy 服务或账号时必须提供新密码，或显式清除旧密码');
    }
    for (const field of clearSecrets) {
      const [section, key] = field.split('.');
      next[section][key] = '';
    }
    const record = normalizeRecord(next);
    const destination = configPath(root);
    temporary = path.join(path.dirname(destination), `.company-${crypto.randomUUID()}.tmp`);
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, destination);
    temporary = null;
    return { ...record, deploymentConfigured: true };
  } finally {
    if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
    await releaseLock(lock);
  }
}
