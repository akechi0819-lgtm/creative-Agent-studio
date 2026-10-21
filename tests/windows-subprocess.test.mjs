import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const childProcess = (await import('node:child_process')).default;

function mockChild(stdoutText) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  setImmediate(() => {
    child.stdout.end(stdoutText);
    child.stderr.end();
    setImmediate(() => {
      child.exitCode = 0;
      child.emit('close', 0, null);
    });
  });
  return child;
}

test('cleaner and workspace runners pass windowsHide to their actual spawn calls', async t => {
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const output = args[0]?.endsWith('ocr_materials.py')
      ? JSON.stringify({ kind: 'image', pages: [{ page: 1, text: 'fixture OCR' }] })
      : 'fixture workspace result';
    return mockChild(output);
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  });

  const { cleanMaterial } = await import('../src/assets/cleaner.mjs');
  const { runWorkspaceScript } = await import('../src/workspace/process.mjs');
  const image = fileURLToPath(new URL('./fixtures/workspace/S-001.jpg', import.meta.url));
  const cleaned = await cleanMaterial(
    { title: 'fixture', body: '', files: [image] },
    {
      ocrPythonPath: process.execPath,
      config: { baseUrl: 'https://model.invalid/v1', model: 'fixture', apiKey: 'test-only' },
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: 'fixture summary', tags: ['fixture'] }) } }] }),
      }),
    },
  );
  assert.equal(cleaned.fileResults[0].text, 'fixture OCR');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.windowsHide, true);

  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'studio-hidden-process-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const result = await runWorkspaceScript({ workspaceRoot, language: 'javascript', code: 'console.log("fixture")' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'fixture workspace result');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.windowsHide, true);
});

test('model plugin fork passes windowsHide to the actual fork call', async t => {
  const originalFork = childProcess.fork;
  const originalFetch = globalThis.fetch;
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-hidden-fork-'));
  const instance = {
    baseUrl: 'http://127.0.0.1:43129',
    apiKey: 'a'.repeat(64),
    instanceId: 'windows-hide-fixture',
  };
  let forkOptions;
  childProcess.fork = (_entry, _args, options) => {
    forkOptions = options;
    const child = new EventEmitter();
    child.connected = true;
    child.disconnect = () => { child.connected = false; };
    child.unref = () => {};
    child.kill = () => {};
    setImmediate(async () => {
      const directory = path.join(root, 'model-plugin');
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'instance.json'), JSON.stringify(instance));
      child.emit('message', { ready: true });
    });
    return child;
  };
  syncBuiltinESMExports();
  globalThis.fetch = async () => Response.json({ service: 'studio-model-plugin', instanceId: instance.instanceId });
  t.after(async () => {
    childProcess.fork = originalFork;
    syncBuiltinESMExports();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  });

  const { ensureModelPlugin } = await import('../src/web/model-plugin.mjs');
  const connection = await ensureModelPlugin({ root });
  assert.equal(connection.instanceId, instance.instanceId);
  assert.equal(forkOptions.windowsHide, true);
});

test('remaining runtime launch sites include Windows hidden-window options', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const sources = new Map(await Promise.all([
    'src/web/canvas.mjs',
    'scripts/canvas-supervisor.mjs',
    'scripts/canvas.mjs',
    'scripts/web.mjs',
  ].map(async relative => [relative, await readFile(path.join(root, relative), 'utf8')])));

  const canvas = sources.get('src/web/canvas.mjs');
  assert.equal((canvas.match(/const child = spawn\(/g) || []).length, 2);
  assert.equal((canvas.match(/windowsHide: true/g) || []).length, 2);
  assert.match(sources.get('scripts/canvas-supervisor.mjs'), /stdio:\['ignore',logs\.fd,logs\.fd\],windowsHide:true/);
  assert.match(sources.get('scripts/canvas.mjs'), /detached:true,windowsHide:true,stdio:/);
  assert.match(sources.get('scripts/web.mjs'), /spawn\(command,parameters,\{stdio:'ignore',windowsHide:true\}\)/);
});
