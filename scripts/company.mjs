import fs from 'node:fs/promises';
import path from 'node:path';
import {
  publicCompanyConfig,
  readCompanyConfig,
  saveCompanyConfig,
} from '../src/company/config.mjs';
import { createCompanyMaterials } from '../src/company/materials.mjs';
import { checkCompanyCopy } from '../src/company/risk.mjs';
import { stageCompanySources } from '../src/creative/tasks.mjs';
import { dataRoot } from '../src/canvas/client.mjs';

const USAGE = `用法：
  node scripts/company.mjs config-show
  node scripts/company.mjs config-save @payload.json
  node scripts/company.mjs search @payload.json
  node scripts/company.mjs check-copy @payload.json`;

function cliError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function usageError() {
  return cliError('ERR_COMPANY_CLI_USAGE', USAGE);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function safeError(error) {
  if (error?.code === 'ERR_COMPANY_CLI_USAGE') return error.message;
  if (typeof error?.code === 'string' && (error.code.startsWith('ERR_COMPANY_') || error.code === 'ERR_TASK_REVISION_CONFLICT')) {
    return error.message;
  }
  return '公司命令执行失败。';
}

function payloadPath(argument) {
  if (typeof argument !== 'string' || !argument.startsWith('@') || argument.length < 2) throw usageError();
  return path.resolve(process.cwd(), argument.slice(1));
}

async function readPayload(argument) {
  let raw;
  try { raw = await fs.readFile(payloadPath(argument), 'utf8'); }
  catch { throw cliError('ERR_COMPANY_CLI_INPUT', '无法读取输入文件。'); }
  let value;
  try { value = JSON.parse(raw); }
  catch { throw cliError('ERR_COMPANY_CLI_INPUT', '输入文件不是有效 JSON。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw usageError();
  return value;
}

function hasOnlyKeys(value, allowed) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw usageError();
}

function publicCandidate(item) {
  return {
    documentId: item.documentId,
    title: item.title,
    summary: String(item.summary || '').slice(0, 600),
    tags: item.tags,
    previews: (item.previews || []).map((preview) => ({
      fileId: preview.fileId || preview.id,
      name: preview.name || '',
      mimeType: preview.mimeType || preview.mimetype || '',
    })),
  };
}

const root = dataRoot();
const materials = createCompanyMaterials({ root });

async function run(args) {
  const [command, ...rest] = args;
  if (command === 'config-show' && rest.length === 0) {
    return { config: publicCompanyConfig(await readCompanyConfig({ root })) };
  }
  if (command === 'config-save' && rest.length === 1) {
    const input = await readPayload(rest[0]);
    return { config: publicCompanyConfig(await saveCompanyConfig(input, { root })) };
  }
  if (command === 'search' && rest.length === 1) {
    const input = await readPayload(rest[0]);
    hasOnlyKeys(input, ['taskId', 'expectedRevision', 'query', 'tags', 'required_concepts', 'limit']);
    if (input.taskId != null && (typeof input.taskId !== 'string' || !input.taskId.trim())) throw usageError();
    if (input.taskId && (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)) {
      throw cliError('ERR_COMPANY_CLI_USAGE', '关联任务搜索必须指定正整数 expectedRevision。');
    }
    if (!input.taskId && input.expectedRevision != null) throw usageError();
    const result = await materials.search({
      query: input.query,
      tags: input.tags,
      required_concepts: input.required_concepts,
      limit: input.limit,
    });
    let taskRevision;
    if (input.taskId) {
      const task = await stageCompanySources(input.taskId, result.items, { root, expectedRevision: input.expectedRevision });
      taskRevision = task.revision;
    }
    return {
      total: result.total,
      query: result.query,
      tags: result.tags,
      required_concepts: result.required_concepts,
      mediaFilter: result.mediaFilter,
      rejectedTags: result.rejectedTags,
      rejectedRequiredConcepts: result.rejectedRequiredConcepts,
      items: result.items.map(publicCandidate),
      ...(input.taskId ? { taskRevision } : {}),
    };
  }
  if (command === 'check-copy' && rest.length === 1) {
    const input = await readPayload(rest[0]);
    hasOnlyKeys(input, ['text']);
    return checkCompanyCopy(input.text);
  }
  throw usageError();
}

try {
  print(await run(process.argv.slice(2)));
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
}
