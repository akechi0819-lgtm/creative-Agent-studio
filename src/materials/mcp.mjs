import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { dataRoot } from '../canvas/client.mjs';
import { createCompanyMaterials } from './client.mjs';

const output = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const reservedTags = new Set(['外部参考', '制作辅助Logo']);

function cleanName(value) {
  return String(value || 'download').replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim().slice(0, 180) || 'download';
}

async function downloadDirectory(root) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('应用数据目录必须是普通目录');
  const directory = path.join(root, 'material-downloads');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await fs.lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('素材下载目录必须是普通目录');
  const [rootReal, directoryReal] = await Promise.all([fs.realpath(root), fs.realpath(directory)]);
  if (!directoryReal.startsWith(`${rootReal}${path.sep}`)) throw new Error('素材下载目录超出应用数据目录');
  await fs.chmod(directoryReal, 0o700);
  return directoryReal;
}

/** A thin, read-only stdio MCP over the shared Teedy adapter. */
export function createCompanyMaterialsMcp({ root = dataRoot(), client = createCompanyMaterials({ root }) } = {}) {
  const server = new McpServer({
    name: 'company-lite-materials',
    version: '0.1.0',
  }, {
    instructions: '只读取用户当前 Teedy 账号有权查看的标签、素材和原件。不得上传、改写标签或删除 Teedy 内容。搜索结果是候选，只有调用 download_file 才会实际下载附件到本机。',
  });
  const register = (name, config, handler) => server.registerTool(name, config, async args => {
    try { return await handler(args); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error?.message || `${name} failed` }] }; }
  });

  register('list_tags', {
    description: '列出当前 Teedy 账号可见的正式素材标签。只有需要按标签筛选时才先调用。',
    inputSchema: {},
  }, async () => {
    const tags = await client.listTags();
    return output({
      vocab_version: 'v0',
      note: '请使用 name 作为 search_materials 的 tags 参数；系统分区标签不显示。',
      tags: tags.filter(tag => tag.name && !reservedTags.has(tag.name)),
    });
  });

  register('search_materials', {
    description: '按用户给出的关键词或标签搜索 Teedy 候选素材。默认内部图像素材、12 项候选池，最多 20 项。不会自动下载原件。',
    inputSchema: {
      tags: z.array(z.string()).optional(),
      query: z.string().optional(),
      required_concepts: z.array(z.array(z.string())).optional(),
      media_type: z.literal('image').default('image').describe('Company Lite 当前仅检索图像素材。'),
      scope: z.enum(['internal', 'external', 'all']).default('internal'),
      asset_kind: z.enum(['material', 'logo']).default('material'),
      limit: z.number().int().min(1).max(20).default(12),
    },
  }, async ({ tags, query, required_concepts, media_type: _mediaType, scope, asset_kind, limit }) => {
    const result = await client.search({
      tags,
      query,
      required_concepts,
      sourceScope: scope,
      assetKind: asset_kind,
      limit,
    });
    return output({
      match: result.total ? (tags?.length && query?.trim() ? 'tag_and' : tags?.length ? 'tag' : 'keyword') : null,
      scope,
      asset_kind,
      used_tags: result.tags,
      keywords: result.query,
      search: result.search,
      media_filter: { requested: 'image', ...result.mediaFilter },
      required_concepts: result.required_concepts,
      rejected_required_concepts: result.rejectedRequiredConcepts,
      rejected_asset_kind: result.rejectedAssetKind,
      teedy_total: result.teedyTotal,
      search_limit: result.limit,
      search_truncated: result.teedyTotal != null && result.teedyTotal > result.limit,
      total: result.total,
      items: result.items.map(item => ({
        id: item.documentId,
        title: item.title,
        summary: item.summary,
        tags: item.tags,
        file_count: item.files.length,
        media_type: 'image',
        zip_url: item.zipUrl,
        previews: item.previews.map(preview => ({
          id: preview.id,
          name: preview.name,
          preview_url: preview.preview_url,
          download_url: item.files.find(file => file.id === preview.id)?.download_url ?? null,
        })),
        files: item.files,
        attachment_status: item.files.length ? 'available' : 'none',
        source: item.materialSource,
        original_url: item.originalUrl,
        match: tags?.length && query?.trim() ? 'tag_and' : tags?.length ? 'tag' : 'keyword',
        highlight: null,
      })),
    });
  });

  register('get_material', {
    description: '读取搜索结果中一份素材的摘要、标签、预览和附件清单。document_id 必须来自先前检索。',
    inputSchema: { document_id: z.string() },
  }, async ({ document_id }) => {
    const material = await client.get(document_id);
    const files = material.files || [];
    return output({
      id: material.documentId,
      title: material.title,
      summary: material.summary,
      catalog_source: material.source,
      folder: material.subject,
      language: material.language,
      tags: material.tags,
      writable: false,
      source: material.materialSource,
      original_url: material.originalUrl,
      zip_url: material.zipUrl,
      previews: material.previews,
      files,
      file_count: files.length,
      attachment_status: files.length ? 'available' : 'none',
      attachment_note: material.materialSource === 'external' && !files.length
        ? '该外部参考没有 Teedy 附件，不能预览或下载。' : null,
    });
  });

  register('download_file', {
    description: '把已在当前素材检索或读取结果中出现的 Teedy 原件下载到本机 Company Lite 数据目录，返回可供宿主读取的绝对路径。',
    inputSchema: { file_id: z.string(), filename: z.string().optional() },
  }, async ({ file_id, filename }) => {
    const downloaded = await client.download(file_id);
    if (!downloaded.bytes.length) throw new Error('Teedy 返回的原件为空');
    const directory = await downloadDirectory(path.resolve(root));
    const name = cleanName(filename || downloaded.name);
    const destination = path.join(directory, `${randomUUID()}_${name}`);
    await fs.writeFile(destination, downloaded.bytes, { flag: 'wx', mode: 0o600 });
    return output({
      file_id,
      path: destination,
      bytes: downloaded.bytes.length,
      content_type: downloaded.mimeType,
      name,
      sha256: downloaded.sha256,
    });
  });

  return server;
}
