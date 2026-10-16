#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataRoot } from '../src/canvas/client.mjs';
import { acquirePrepareLock } from '../src/launcher/prepare.mjs';
import { preparePython } from '../src/launcher/python.mjs';

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(dataRoot(), 'runtime');
const onProgress = ({ phase, message }) => {
  process.stderr.write(`[${new Date().toISOString()}] ${phase}: ${message}\n`);
};

const releaseLock = await acquirePrepareLock(runtimeRoot, onProgress);
try {
  await preparePython({ root: bundleRoot, runtimeRoot, nodePath: process.execPath, onProgress });
} finally {
  await releaseLock();
}
