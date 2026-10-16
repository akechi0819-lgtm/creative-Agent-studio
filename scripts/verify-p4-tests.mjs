import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, '..');

function repositoryRoot(args) {
  const index = args.indexOf('--root');
  const value = index >= 0 ? args[index + 1] : process.env.STUDIO_REPO_ROOT;
  if (index >= 0 && (!value || value.startsWith('--'))) throw new Error('--root 需要一个目录路径。');
  return path.resolve(value || defaultRoot);
}

async function listTests(directory) {
  const result = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listTests(absolute));
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) result.push(absolute);
  }
  return result;
}

const root = repositoryRoot(process.argv.slice(2));
const testDirectory = path.join(root, 'tests');
const files = await listTests(testDirectory);
assert.ok(files.length > 0, `No .test.mjs files found under ${testDirectory}`);
const python = path.join(root, '.venv-ocr', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
await fs.access(python).catch(() => {
  throw new Error(`The private OCR runtime is missing: ${python}. Run node scripts/prepare.mjs first.`);
});
console.log(`Running ${files.length} Node test files without shell glob expansion, using the private OCR runtime.`);

const temporaryDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-studio-p4-tests-'));
try {
  const child = spawn(process.execPath, ['--test', ...files], {
    cwd: root,
    env: { ...process.env, STUDIO_DATA_DIR: temporaryDataRoot, STUDIO_OCR_PYTHON: python },
    stdio: 'inherit',
    windowsHide: true,
  });
  process.exitCode = await new Promise((resolve) => {
    child.once('error', (error) => {
      console.error(`Could not start Node's test runner (${error.code || 'unknown error'}).`);
      resolve(1);
    });
    child.once('exit', (code, signal) => {
      if (signal) {
        console.error(`Node's test runner stopped by ${signal}.`);
        resolve(1);
      } else {
        resolve(code ?? 1);
      }
    });
  });
} finally {
  await fs.rm(temporaryDataRoot, { recursive: true, force: true });
}
