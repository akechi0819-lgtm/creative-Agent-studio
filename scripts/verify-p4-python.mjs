import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, '..');
const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
if (rootIndex >= 0 && (!args[rootIndex + 1] || args[rootIndex + 1].startsWith('--'))) {
  throw new Error('--root 需要一个目录路径。');
}
const root = path.resolve(rootIndex >= 0 ? args[rootIndex + 1] : process.env.STUDIO_REPO_ROOT || defaultRoot);
const moduleUrl = pathToFileURL(path.join(root, 'src', 'launcher', 'python.mjs')).href;
const { preparePython, pythonInternals } = await import(moduleUrl);
const prepared = await preparePython({
  root,
  onProgress: ({ message }) => process.stdout.write(`${message}\n`),
});
const paths = pythonInternals.runtimePaths(root);
assert.equal(prepared.pythonExecutable, pythonInternals.pythonExecutable(paths.venv));
assert.ok(await pythonInternals.checkPython(prepared.pythonExecutable, paths), 'The isolated OCR interpreter must import all fixed packages at their pinned versions.');
assert.ok(await pythonInternals.verifyModelCache(paths.modelRoot), 'RapidOCR weights must be cached under .studio-runtime.');
await fs.access(prepared.pythonExecutable);
console.log(`P4 Python regression passed: Python ${prepared.pythonVersion}, uv ${prepared.uvVersion || 'not invoked (environment reused)'}, pinned OCR imports and verified model cache; source=${prepared.runtimeSource}.`);
