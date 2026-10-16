#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanMaterial, CleanerError } from '../src/assets/cleaner.mjs';
import { dataRoot } from '../src/canvas/client.mjs';
import { readConfig } from '../src/web/config.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const abortController = new AbortController();
const abort = () => abortController.abort();
process.once('SIGINT', abort);
process.once('SIGTERM', abort);
const SENSITIVE_FIELD = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|authorization|bearer|\btoken\b)/i;
const SECRET_TEXT = /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/gi;
const SECRET_QUERY = /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^&#\s]+/gi;
const SECRET_ASSIGNMENT = /\b(?:OPENAI_API_KEY|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{12,}/gi;

function safeString(value, secrets) {
  let safe = value
    .replace(SECRET_TEXT, '[已隐藏凭据]')
    .replace(SECRET_QUERY, '$1[已隐藏]')
    .replace(SECRET_ASSIGNMENT, '[已隐藏凭据]');
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join('[已隐藏凭据]');
  }
  return safe;
}

function safeOutput(value, secrets) {
  if (typeof value === 'string') return safeString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => safeOutput(item, secrets));
  if (!value || typeof value !== 'object') return value;
  const safe = {};
  for (const [key, child] of Object.entries(value)) {
    safe[key] = SENSITIVE_FIELD.test(key) ? '[已隐藏]' : safeOutput(child, secrets);
  }
  return safe;
}

async function main(argv) {
  if (argv.length !== 1 || !argv[0].startsWith('@') || argv[0].length === 1) {
    process.stderr.write('用法：node scripts/clean-materials.mjs @input.json\n');
    return 2;
  }

  let input;
  try {
    const inputPath = path.resolve(workspaceRoot, argv[0].slice(1));
    input = JSON.parse(await readFile(inputPath, 'utf8'));
  } catch {
    process.stdout.write(`${JSON.stringify({ error: { code: 'INPUT_READ_FAILED', message: '无法读取或解析输入 JSON' } })}\n`);
    return 1;
  }

  try {
    const config = (await readConfig({ root: dataRoot() })).basic;
    const result = await cleanMaterial(input, { config, signal: abortController.signal });
    process.stdout.write(`${JSON.stringify(safeOutput(result, [config.apiKey]), null, 2)}\n`);
    return 0;
  } catch (error) {
    const safeError = error instanceof CleanerError
      ? { code: error.code, message: error.message }
      : { code: 'CLEANING_FAILED', message: '素材清洗失败' };
    process.stdout.write(`${JSON.stringify({ error: safeError }, null, 2)}\n`);
    return 1;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} finally {
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
}
