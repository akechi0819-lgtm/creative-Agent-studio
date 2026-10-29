#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { readImageKeyFromClipboard } from '../src/lite/clipboard.mjs';
import {
  getSetupStatus,
  reportWorkBuddyProbe,
  saveAndVerifyImageConfig,
  verifyImageApi,
} from '../src/lite/setup.mjs';

const [command = 'status', ...args] = process.argv.slice(2);
const root = process.env.STUDIO_DATA_DIR;

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function usage() {
  return '用法：setup.mjs [status|report-workbuddy connected <工具名>|failed [工具名]|configure-image @JSON文件 [--key-from-clipboard]|check-image]';
}

async function readPrivatePayload(argument, publicFieldsOnly = false) {
  if (typeof argument !== 'string' || !argument.startsWith('@') || argument.length < 2) {
    throw new Error('configure-image 需要 @私有JSON文件 参数');
  }
  const file = path.resolve(argument.slice(1));
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('图片配置载荷必须是普通文件');
  if (!publicFieldsOnly && process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error('图片配置载荷权限过宽；请先限制为仅本人可读写');
  }
  let source;
  try { source = await fs.readFile(file, 'utf8'); }
  catch (error) { throw new Error(`图片配置载荷无法读取（${error.code || 'I/O 错误'}）`); }
  try {
    const value=JSON.parse(source);
    if(publicFieldsOnly && Object.hasOwn(value.image || {},'apiKey'))throw new Error('剪贴板模式的参数文件只填写图片地址和模型，不填写密钥');
    return value;
  }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('图片配置载荷 JSON 格式无效');
    throw error;
  }
}

async function emitStatus() {
  output(await getSetupStatus({ root }));
}

async function run() {
  if (command === 'status') {
    if (args.length) throw new Error(usage());
    await emitStatus();
    return;
  }
  if (command === 'report-workbuddy') {
    if (args.length < 1 || args.length > 2 || !['connected', 'failed'].includes(args[0])) throw new Error(usage());
    await reportWorkBuddyProbe({ status: args[0], toolName: args[1] || '' }, { root });
    await emitStatus();
    return;
  }
  if (command === 'configure-image') {
    const clipboard=args.length===2 && args[1]==='--key-from-clipboard';
    if (args.length !== 1 && !clipboard) throw new Error(usage());
    const payload = await readPrivatePayload(args[0],clipboard);
    if(clipboard)payload.image={...payload.image,apiKey:await readImageKeyFromClipboard()};
    const status = await saveAndVerifyImageConfig(payload, { root });
    output(status);
    if (!status.steps.find((step) => step.id === 'image')?.complete) process.exitCode = 1;
    return;
  }
  if (command === 'check-image') {
    if (args.length) throw new Error(usage());
    await verifyImageApi({ root });
    const status = await getSetupStatus({ root });
    output(status);
    if (!status.steps.find((step) => step.id === 'image')?.complete) process.exitCode = 1;
    return;
  }
  throw new Error(usage());
}

try { await run(); }
catch (error) {
  process.stderr.write(`${error.message || '本机准备状态读取失败'}\n`);
  process.exitCode = 1;
}
