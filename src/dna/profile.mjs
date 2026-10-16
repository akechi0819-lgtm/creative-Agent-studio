import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataRoot } from '../canvas/client.mjs';

export const DNA_TEMPLATE = '表达语气：\n视觉与品牌偏好：\n常用内容要求：\n必须出现的元素：\n避免出现的元素：\n其他偏好：';
const NON_HUMAN_ACTOR = /^(?:(?:codex|dsh)(?:[\s_-]+(?:agent|assistant|bot))?|(?:ai|agent|assistant|model)(?:[\s_-]+(?:agent|assistant|bot|model))?|(?:ai|agent|assistant|model)(?:模型|机器人|智能体)|模型|自动|机器人|智能体)$/iu;
const directory = root => path.join(path.resolve(root ?? dataRoot()), 'dna');
const clone = value => structuredClone(value);
export async function readDna({root} = {}) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(directory(root), 'profile.json'), 'utf8'));
    if (!Number.isInteger(value.revision) || value.revision < 1 || typeof value.enabled !== 'boolean' || typeof value.content !== 'string' || !Array.isArray(value.history)) throw new Error('DNA 数据不可读');
    return value;
  }
  catch (error) { if (error.code === 'ENOENT') return {revision: 1, enabled: false, content: '', history: []}; throw error; }
}
export function dnaSnapshot(profile) {
  return {revision: profile.revision, enabled: profile.enabled, content: profile.enabled ? profile.content : '', savedAt: profile.savedAt ?? null};
}
export async function saveDna({enabled, content, by, note, expectedRevision}, {root} = {}) {
  if (typeof enabled !== 'boolean' || typeof content !== 'string' || content.length > 20000 || (enabled && !content.trim())) throw new Error('DNA 输入无效或启用内容为空');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('必须指定 DNA expectedRevision');
  if (typeof by !== 'string' || !by.trim() || NON_HUMAN_ACTOR.test(by.trim()) || typeof note !== 'string' || !note.trim()) throw new Error('必须记录人工保存依据');
  if (/\bBearer\s+\S{12,}|\bsk-[\w-]{16,}/i.test(content)) throw new Error('DNA 不得包含凭据');
  const dir = directory(root);
  await fs.mkdir(dir, {recursive: true, mode: 0o700});
  const lock = path.join(dir, '.write-lock');
  let handle;
  try { handle = await fs.open(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('DNA 正在保存'); throw error; }
  let temporary;
  try {
    await handle.writeFile(JSON.stringify({pid:process.pid}));
    const previous = await readDna({root});
    if (previous.revision !== expectedRevision) throw new Error('DNA 版本已更新，请重新读取');
    const record = {revision: previous.revision + 1, enabled, content, by: by.trim(), note: note.trim(), savedAt: new Date().toISOString()};
    const next = {...record, history: [...previous.history, {...previous, history: undefined}]};
    temporary = path.join(dir, `.profile-${crypto.randomUUID()}.json`);
    await fs.writeFile(temporary, JSON.stringify(next, null, 2), {mode: 0o600, flag: 'wx'});
    await fs.rename(temporary, path.join(dir, 'profile.json'));
    return clone(next);
  } finally { if (temporary) await fs.rm(temporary, {force:true}); await handle.close(); await fs.rm(lock, {force:true}); }
}

export async function unlockDna({deadPid}, {root} = {}) {
  if (!Number.isInteger(deadPid) || deadPid < 1) throw new Error('必须指定已退出的 PID');
  const lock = path.join(directory(root), '.write-lock');
  const before = await fs.readFile(lock, 'utf8');
  const owner = JSON.parse(before);
  if (owner.pid !== deadPid) throw new Error('PID 不符');
  try { process.kill(deadPid, 0); throw new Error('进程仍在'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  if (await fs.readFile(lock, 'utf8') !== before) throw new Error('锁已变化');
  await fs.unlink(lock);
  return {cleared:true};
}
