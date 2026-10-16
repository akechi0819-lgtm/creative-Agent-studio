import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { importAsset, readAsset } from './library.mjs';

const SUPPORTED = /\.(png|jpe?g|webp|bmp|txt|md|pdf)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const natural = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
function invalid(message) { return Object.assign(new Error(message), { code: 'ERR_FOLDER_IMPORT', statusCode: 400 }); }

/** Relative names are grouping labels, never server filesystem paths. */
export function planFolderImport(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 1000) throw invalid('目录文件数必须为 1—1000。');
  const groups = new Map(), ignored = [], seen = new Set();
  for (const [index, value] of paths.entries()) {
    if (typeof value !== 'string' || value.length > 2000 || /[\\\u0000-\u001f\u007f]/.test(value)
      || /^[A-Za-z]:/.test(value) || value.startsWith('/')) throw invalid('目录相对路径无效。');
    const parts = value.split('/');
    if (parts.length < 2 || parts.some(p => !p || p === '.' || p === '..') || seen.has(value)) throw invalid('目录路径重复或不完整。');
    seen.add(value);
    const name = parts.at(-1);
    if (parts.some(p => p.startsWith('.')) || !SUPPORTED.test(name)) { ignored.push({ name: value, reason: '隐藏文件或不支持的格式' }); continue; }
    const directory = parts.slice(0, -1).join('/');
    const group = groups.get(directory) || { directory, title: parts.at(-2), files: [] };
    group.files.push({ index, name }); groups.set(directory, group);
  }
  // Preserve the article order confirmed in the Web preview; sort files within each article.
  const entries = [...groups.values()];
  for (const entry of entries) entry.files.sort((a,b) => natural.compare(a.name,b.name));
  if (entries.some(e => e.files.length > 100)) throw invalid('单篇最多支持 100 个原件，请检查目录分组。');
  if (!entries.length) throw invalid('目录内没有支持的图片、TXT、MD 或 PDF。');
  return { entries, ignored };
}

export async function importFolder({ files, paths, batchId, root, signal }) {
  if (!UUID.test(batchId || '')) throw invalid('必须提供有效批次标识。');
  if (!Array.isArray(files) || files.length !== paths?.length) throw invalid('目录清单与上传文件数不一致。');
  const plan = planFolderImport(paths);
  for (const group of plan.entries) for (const item of group.files) {
    if (files[item.index]?.name !== item.name) throw invalid('文件名与目录清单不匹配。');
  }
  const hashes = [];
  for (const file of files) {
    signal?.throwIfAborted();
    hashes.push(crypto.createHash('sha256').update(await fs.readFile(file.path)).digest('hex'));
  }
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ paths, hashes })).digest('hex');
  const directory = path.join(root, 'web', 'folder-imports');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const receiptFile = path.join(directory, `${batchId}.json`);
  let receipt;
  try { receipt = JSON.parse(await fs.readFile(receiptFile,'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (receipt && receipt.fingerprint !== fingerprint) throw Object.assign(invalid('该批次标识已用于其他文件，请重新选择目录。'), { statusCode: 409 });
  receipt ||= { batchId, fingerprint, entries: [], ignored: plan.ignored };
  const save = async () => {
    const temporary = `${receiptFile}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(receipt), { flag:'wx', mode:0o600 });
    try { await fs.rename(temporary, receiptFile); } finally { await fs.rm(temporary,{force:true}); }
  };
  for (const group of plan.entries) {
    signal?.throwIfAborted();
    const prior = receipt.entries.find(e => e.directory === group.directory);
    if (prior) {
      if (prior.status === 'importing') { prior.status='failed'; prior.error={code:'ERR_FOLDER_INTERRUPTED',message:'上次导入中断，请先在素材库核对，未自动重复导入。'}; await save(); }
      continue;
    }
    const entry = { directory:group.directory, title:group.title, status:'importing' };
    receipt.entries.push(entry); await save();
    try {
      const originals = group.files.map(item => files[item.index]);
      const textFiles = originals.filter(file => /\.(txt|md)$/i.test(file.name));
      const bodies = [];
      for (const file of textFiles) { const bytes=await fs.readFile(file.path); if (bytes.length>600_000) throw invalid('正文文件过大，请缩减到 600 KB 内。'); bodies.push(bytes.toString('utf8')); }
      const body = bodies.join('\n\n');
      if (body.length>200_000) throw invalid('单篇正文超过 20 万字限制。');
      const asset = await importAsset({title:group.title,body,files:originals,source:{kind:'folder-upload',batchId,directory:group.directory,factBoundary:'用户上传资料；涉及日期、价格和政策须按本次需求确认。'}},{root});
      entry.status='staged'; entry.assetId=asset.id;
    } catch (e) {
      entry.status='failed'; entry.error={code:'ERR_FOLDER_ARTICLE',message:'该篇导入失败，请检查文件内容、格式和大小后重试；其他篇继续处理。'};
    }
    await save();
  }
  return {
    batchId,
    entries: await Promise.all(receipt.entries.map(async entry => ({directory:entry.directory,title:entry.title,status:entry.status,...(entry.assetId?{asset:await readAsset(entry.assetId,{root})}:{}),...(entry.error?{error:entry.error}:{})}))),
    ignored:receipt.ignored,
    totals:{articles:plan.entries.length,staged:receipt.entries.filter(e=>e.status==='staged').length,failed:receipt.entries.filter(e=>e.status==='failed').length,files:plan.entries.reduce((n,e)=>n+e.files.length,0)},
  };
}
