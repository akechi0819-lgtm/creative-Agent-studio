#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareWorkspace } from '../src/launcher/prepare.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = await prepareWorkspace({
  root,
  force: process.argv.includes('--force'),
  onProgress: ({ message }) => process.stdout.write(`${message}\n`),
});
process.stdout.write(`${result.skipped ? '已跳过准备' : '准备完成'}，指纹 ${result.fingerprint}\n`);
