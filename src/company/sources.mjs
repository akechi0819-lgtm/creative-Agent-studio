import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createCompanyMaterials } from './materials.mjs';

const extension = new Map([['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/webp', '.webp'], ['image/bmp', '.bmp'], ['application/pdf', '.pdf'], ['text/plain', '.txt'], ['text/markdown', '.md']]);

/** The caller holds the task lock; network failure must not commit a retained decision. */
export async function freezeCompanySource(source, { root, taskId, materials = createCompanyMaterials({ root }), created = [] } = {}) {
  const signal = AbortSignal.timeout(180_000);
  const { taskDirectory, assertNoCredentials } = await import('../creative/tasks.mjs');
  const document = await materials.get(source.company.documentId, { signal });
  const body = String(document.body || document.content || document.description || document.summary || '');
  if (body.length > 500_000) throw new Error('公司素材正文超过 500,000 个字符限制，未保留来源');
  const originals = document.files || [];
  if (!Array.isArray(originals) || originals.length === 0) throw new Error('公司素材附件当前不可读取，未保留来源');
  if (originals.length > 100) throw new Error('公司素材附件超过 100 个，请缩小选择范围');
  const directory = taskDirectory(taskId, root);
  const destination = path.join(directory, 'sources', source.id);
  const parent = path.dirname(destination);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.company-${randomUUID()}`);
  let temporaryCreated = false;
  try {
    await fs.mkdir(temporary, { mode: 0o700 });
    temporaryCreated = true;
    const real = await fs.realpath(temporary);
    const taskReal = await fs.realpath(directory);
    if (!real.startsWith(taskReal + path.sep)) throw new Error('公司素材快照路径越界');
    const files = [];
    let total = 0;
    for (const [index, original] of originals.entries()) {
      const declaredMimeType = original.mimeType || original.mimetype || 'application/octet-stream';
      const fileId = original.fileId || original.id;
      signal.throwIfAborted();
      const downloaded = await materials.download(fileId, { signal });
      const responseMimeType = String(downloaded.mimeType || '').split(';', 1)[0].toLowerCase();
      const mimeType = responseMimeType && responseMimeType !== 'application/octet-stream' ? responseMimeType : declaredMimeType;
      const bytes = Buffer.from(downloaded.bytes);
      total += bytes.length;
      if (bytes.length > 100 * 1024 * 1024 || total > 250 * 1024 * 1024) throw new Error('公司素材快照超过本机任务大小限制');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const name = path.basename(String(original.name || downloaded.name || `附件${index + 1}`)).slice(0, 200);
      if (/^(?:\.env(?:\..*)?|.*(?:credentials?|secrets?)\.(?:json|ya?ml)|.*\.(?:pem|key))$/i.test(name)) throw new Error('公司素材含凭据文件，未保存到任务');
      if (mimeType.startsWith('text/') || declaredMimeType.startsWith('text/') || /\.(?:txt|md|json|ya?ml|csv)$/i.test(name)) assertNoCredentials(bytes.toString('utf8'), '公司素材附件');
      const originalExtension = path.extname(name).toLowerCase();
      const suffix = /^\.[a-z0-9]{1,10}$/.test(originalExtension) ? originalExtension : extension.get(mimeType) || '.bin';
      const filename = `${index + 1}-${sha256}${suffix}`;
      const relativePath = `sources/${source.id}/${filename}`;
      const target = path.join(temporary, filename);
      try { await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const actual = await fs.lstat(target);
      if (!actual.isFile() || actual.isSymbolicLink() || createHash('sha256').update(await fs.readFile(target)).digest('hex') !== sha256) throw new Error('公司素材快照哈希核对失败');
      files.push({ order: index + 1, name, mimeType, relativePath, sha256, fileId });
    }
    const snapshot = {
      ...source, title: String(document.title || source.title).slice(0, 500),
      body,
      summary: String(document.summary || document.description || source.summary).slice(0, 6000),
      files, company: { ...source.company, snapshotAt: new Date().toISOString() },
    };
    signal.throwIfAborted();
    assertNoCredentials(snapshot);
    try { await fs.lstat(destination); throw new Error('公司素材快照目录已存在，请先检查任务状态'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(temporary, destination);
    created.push(destination);
    return snapshot;
  } finally { if (temporaryCreated) await fs.rm(temporary, { recursive: true, force: true }); }
}
