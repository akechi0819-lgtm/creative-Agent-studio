#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareWorkspace } from '../src/launcher/prepare.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.stdout.write('正在检查源码依赖与 Canvas 构建；首次准备需要下载依赖，后续将显示当前安装或构建步骤。\n');
const result = await prepareWorkspace({
  root,
  force: process.argv.includes('--force'),
  onProgress: ({ message }) => process.stdout.write(`${message}\n`),
});
process.stdout.write(`${result.skipped ? '已跳过准备' : '准备完成'}，指纹 ${result.fingerprint}\n`);
