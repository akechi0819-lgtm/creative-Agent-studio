import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, '..');
const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
if (rootIndex >= 0 && (!args[rootIndex + 1] || args[rootIndex + 1].startsWith('--'))) {
  throw new Error('--root 需要一个目录路径。');
}
const root = path.resolve(rootIndex >= 0 ? args[rootIndex + 1] : process.env.STUDIO_REPO_ROOT || defaultRoot);
const fixtureTest = path.join(root, 'tests', 'image-regions.test.mjs');
await fs.access(fixtureTest);
console.log('Running the PNG/JPEG barcode, text, rectangle, and negative image fixtures.');

const temporaryDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-studio-p4-images-'));
try {
  const child = spawn(process.execPath, ['--test', fixtureTest], {
    cwd: root,
    env: { ...process.env, STUDIO_DATA_DIR: temporaryDataRoot },
    stdio: 'inherit',
    windowsHide: true,
  });
  process.exitCode = await new Promise((resolve) => {
    child.once('error', (error) => {
      console.error(`Could not start the image fixture regression (${error.code || 'unknown error'}).`);
      resolve(1);
    });
    child.once('exit', (code, signal) => {
      if (signal) {
        console.error(`The image fixture regression stopped by ${signal}.`);
        resolve(1);
      } else {
        resolve(code ?? 1);
      }
    });
  });
} finally {
  await fs.rm(temporaryDataRoot, { recursive: true, force: true });
}
