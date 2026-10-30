import fs from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataRoot } from '../canvas/client.mjs';

const configName = 'materials.json';

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function resolveRoot(root) {
  return path.resolve(root ?? dataRoot());
}

function configPaths(root) {
  const resolved = resolveRoot(root);
  const directory = path.join(resolved, 'config');
  return { root: resolved, directory, file: path.join(directory, configName) };
}

function isLocalHostname(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true;
  return isIP(host) === 4 && Number(host.split('.', 1)[0]) === 127;
}

export function normalizeMaterialBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('ERR_MATERIAL_CONFIG_INVALID', 'Teedy 服务地址无效'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash
    || isLocalHostname(url.hostname)) {
    throw fail('ERR_MATERIAL_CONFIG_INVALID', 'Teedy 服务地址必须是远端 HTTPS 地址，且不能包含凭据或查询参数');
  }
  return url.href.replace(/\/+$/, '');
}

function normalizeCredentials(value, { persisted = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('ERR_MATERIAL_CONFIG_INVALID', 'Teedy 登录配置无效');
  }
  const allowed = persisted ? ['schemaVersion', 'credentialId', 'baseUrl', 'username', 'password'] : ['baseUrl', 'username', 'password'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw fail('ERR_MATERIAL_CONFIG_INVALID', 'Teedy 登录配置包含不支持的字段');
  if (persisted && value.schemaVersion !== 1) throw fail('ERR_MATERIAL_CONFIG_CORRUPT', 'Teedy 登录配置文件无效');
  if (persisted && (typeof value.credentialId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.credentialId))) {
    throw fail('ERR_MATERIAL_CONFIG_CORRUPT', 'Teedy 登录配置文件无效');
  }
  const username = typeof value.username === 'string' ? value.username.trim() : '';
  const password = typeof value.password === 'string' ? value.password : '';
  if (!username || username.length > 300 || /[\u0000-\u001f\u007f]/.test(username)
    || !password || password.length > 4096) {
    throw fail('ERR_MATERIAL_CONFIG_INVALID', 'Teedy 用户名或密码无效');
  }
  return {
    ...(persisted ? { schemaVersion: 1, credentialId: value.credentialId } : {}),
    baseUrl: normalizeMaterialBaseUrl(value.baseUrl),
    username,
    password,
  };
}

async function ensureConfigDirectory({ root, directory }) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw fail('ERR_MATERIAL_CONFIG_PATH', '应用数据目录必须是普通目录');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await fs.lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw fail('ERR_MATERIAL_CONFIG_PATH', '配置目录必须是普通目录');
  const [rootReal, directoryReal] = await Promise.all([fs.realpath(root), fs.realpath(directory)]);
  if (directoryReal === rootReal || !directoryReal.startsWith(`${rootReal}${path.sep}`)) {
    throw fail('ERR_MATERIAL_CONFIG_PATH', '配置目录超出应用数据目录');
  }
  await fs.chmod(directoryReal, 0o700);
}

async function readPersisted(paths) {
  let rootInfo;
  try { rootInfo = await fs.lstat(paths.root); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw fail('ERR_MATERIAL_CONFIG_PATH', '应用数据目录必须是普通目录');
  let directoryInfo;
  try { directoryInfo = await fs.lstat(paths.directory); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw fail('ERR_MATERIAL_CONFIG_PATH', '配置目录必须是普通目录');
  const [rootReal, directoryReal] = await Promise.all([fs.realpath(paths.root), fs.realpath(paths.directory)]);
  if (!directoryReal.startsWith(`${rootReal}${path.sep}`)) throw fail('ERR_MATERIAL_CONFIG_PATH', '配置目录超出应用数据目录');
  let info;
  try { info = await fs.lstat(paths.file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw fail('ERR_MATERIAL_CONFIG_PATH', 'Teedy 配置必须是普通文件');
  try {
    return normalizeCredentials(JSON.parse(await fs.readFile(paths.file, 'utf8')), { persisted: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw fail('ERR_MATERIAL_CONFIG_CORRUPT', 'Teedy 登录配置文件无效');
    throw error;
  }
}

/** Read the private Teedy credentials for the shared Company Lite workspace. */
export async function readMaterialConfig({ root } = {}) {
  return readPersisted(configPaths(root));
}

/** Save Teedy credentials privately and rotate the identity used by setup checks. */
export async function saveMaterialConfig(input, { root } = {}) {
  const candidate = normalizeCredentials(input);
  const paths = configPaths(root);
  await ensureConfigDirectory(paths);
  const credentialId = randomUUID();
  const record = { schemaVersion: 1, credentialId, ...candidate };
  const temporary = `${paths.file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, paths.file);
    await fs.chmod(paths.file, 0o600);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return { path: paths.file, credentialId };
}
