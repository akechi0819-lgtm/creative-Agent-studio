import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const launcherSource = await readFile(new URL('../release/launcher.mjs', import.meta.url), 'utf8');
const identitySource = await readFile(new URL('../src/launcher/identity.mjs', import.meta.url), 'utf8');

async function makeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-release-startup-'));
  const payload = path.join(root, 'payload');
  const data = path.join(root, 'user-data');
  const trace = path.join(root, 'prepare-count.log');
  const gate = path.join(root, 'allow-prepare-to-finish');
  const running = path.join(root, 'workbench-running');
  const logPath = path.join(data, 'python-prepare.log');
  const lockPath = path.join(data, 'runtime/.studio-runtime/release-start.lock');
  const runs = [];

  t.after(async () => {
    for (const run of runs) {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill();
    }
    await Promise.all(runs.map(run => run.result.catch(() => {})));
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(payload, { recursive: true });
  const files = [
    'release', 'src/canvas', 'src/launcher', 'scripts', 'web/src', 'web/dist',
    'third_party/canvas/web/dist', 'third_party/canvas/canvas-agent/dist',
    'adapters/dsh/lib', 'adapters/free-model',
  ];
  await Promise.all(files.map(relative => mkdir(path.join(payload, relative), { recursive: true })));
  await Promise.all([
    writeFile(path.join(payload, 'package.json'), '{"type":"module"}'),
    writeFile(path.join(payload, 'release/launcher.mjs'), launcherSource),
    writeFile(path.join(payload, 'src/launcher/identity.mjs'), identitySource),
    writeFile(path.join(payload, 'release-manifest.json'), JSON.stringify({
      profile: 'general',
      product: 'Creative Agent Studio',
      target: `${process.platform}-${process.arch}`,
      pythonRuntime: { bundled: false, preparedOnFirstStart: true },
      files: [],
    })),
    writeFile(path.join(payload, 'web/dist/index.html'), '<main>fixture</main>'),
    writeFile(path.join(payload, 'third_party/canvas/web/dist/index.html'), '<main>canvas</main>'),
    writeFile(path.join(payload, 'third_party/canvas/canvas-agent/dist/index.js'), 'export {};'),
    writeFile(path.join(payload, 'adapters/dsh/lib/client.js'), 'export {};'),
    writeFile(path.join(payload, 'scripts/requirements-cleaner-ocr.lock.txt'), ''),
    writeFile(path.join(payload, 'scripts/requirements-workspace.lock.txt'), ''),
    writeFile(path.join(payload, 'scripts/web.mjs'), "process.stderr.write('fixture web should not be reached\\n'); process.exitCode = 1;"),
    writeFile(path.join(payload, 'src/canvas/client.mjs'), 'export function dataRoot() { return process.env.STUDIO_DATA_DIR; }'),
    writeFile(path.join(payload, 'src/launcher/distribution.mjs'), `
      import path from 'node:path';
      export function pathWithin(parent, candidate) {
        const relative = path.relative(parent, candidate);
        return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
      }
    `),
    writeFile(path.join(payload, 'src/launcher/control.mjs'), `
      import { access, readFile } from 'node:fs/promises';
      export function alive(pid) {
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('invalid pid');
        try { process.kill(pid, 0); return true; }
        catch (error) { if (error.code === 'ESRCH') return false; throw error; }
      }
      export async function readJson(filename) {
        try { return JSON.parse(await readFile(filename, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      }
      export async function runtimeStatus(root, currentIdentity) {
        try {
          await access(process.env.TEST_RUNNING_MARKER);
          const sourceIdentity = process.env.TEST_RUNNING_LEGACY === '1' ? null : currentIdentity;
          return { running: true, url: 'http://127.0.0.1:4311', sourceIdentity, currentIdentity, identityMatches: Boolean(sourceIdentity) };
        }
        catch { return { running: false }; }
      }
      export async function stopRuntime() { return { running: false }; }
    `),
    writeFile(path.join(payload, 'src/launcher/services.mjs'), `
      export async function auxiliaryStatus() { return {}; }
      export async function stopAuxiliary() { return {}; }
    `),
    writeFile(path.join(payload, 'release/prepare-python.mjs'), `
      import { access, appendFile, mkdir, writeFile } from 'node:fs/promises';
      import path from 'node:path';
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
      await appendFile(process.env.TEST_PREP_COUNT, String(process.pid) + '\\n');
      process.stdout.write('fixture: stdout logged\\n');
      process.stderr.write('fixture: early progress\\n');
      if (process.env.TEST_PREP_GATE) {
        for (;;) {
          try { await access(process.env.TEST_PREP_GATE); break; }
          catch { await pause(15); }
        }
      }
      if (process.env.TEST_PREP_FAIL === '1') {
        process.stderr.write('fixture specific error: uv dependency timeout\\n');
        process.exitCode = 13;
      } else {
        const data = process.env.STUDIO_DATA_DIR;
        const runtime = path.join(data, 'runtime');
        const state = path.join(runtime, '.studio-runtime');
        const python = path.join(runtime, 'python.exe');
        const models = path.join(runtime, 'models');
        await mkdir(state, { recursive: true });
        await mkdir(models, { recursive: true });
        await writeFile(python, 'fixture python');
        await Promise.all([
          writeFile(path.join(state, 'python-runtime-state.json'), JSON.stringify({ status: 'ready', pythonExecutable: python, pythonVersion: '3.12.8' })),
          writeFile(path.join(state, 'python-state.json'), JSON.stringify({ status: 'ready' })),
          writeFile(path.join(state, 'rapidocr-model-state.json'), JSON.stringify({ status: 'ready', modelRoot: models })),
          writeFile(process.env.TEST_RUNNING_MARKER, 'running'),
        ]);
        process.stderr.write('fixture: preparation finished\\n');
      }
    `),
  ]);

  function runLauncher(extraEnv = {}) {
    const child = spawn(process.execPath, [path.join(payload, 'release/launcher.mjs'), 'start'], {
      cwd: payload,
      env: {
        ...process.env,
        STUDIO_DATA_DIR: data,
        STUDIO_RELEASE_NO_OPEN: '1',
        TEST_PREP_COUNT: trace,
        TEST_RUNNING_MARKER: running,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    const result = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const run = { child, result, output: () => ({ stdout, stderr }) };
    runs.push(run);
    return run;
  }

  return { root, payload, data, trace, gate, running, logPath, lockPath, runs, runLauncher };
}

function waitForText(run, text, timeoutMs = 5000) {
  if (run.output().stderr.includes(text)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${JSON.stringify(text)}; got: ${run.output().stderr}`)), timeoutMs);
    const onData = () => {
      if (run.output().stderr.includes(text)) finish();
    };
    const onClose = result => finish(new Error(`Launcher exited before ${JSON.stringify(text)}: ${JSON.stringify(result)}`));
    function finish(error) {
      clearTimeout(timer);
      run.child.stderr.off('data', onData);
      resolveOrReject(error);
    }
    function resolveOrReject(error) {
      if (error) reject(error);
      else resolve();
    }
    run.child.stderr.on('data', onData);
    run.result.then(onClose);
  });
}

async function waitForExit(run, timeoutMs = 2500) {
  let timer;
  try {
    return await Promise.race([
      run.result,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Launcher did not exit within ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fileExists(filename) {
  return access(filename).then(() => true, () => false);
}

test('release start rejects a concurrent prepare quickly and forwards live progress', async t => {
  const fixture = await makeFixture(t);
  const first = fixture.runLauncher({ TEST_PREP_GATE: fixture.gate });
  await waitForText(first, 'fixture: early progress');
  assert.equal(first.child.exitCode, null, 'the prepare fixture should still be waiting when progress reaches the launcher');

  const second = fixture.runLauncher();
  const startedAt = Date.now();
  const secondResult = await waitForExit(second);
  assert.equal(secondResult.code, 1);
  assert.match(second.output().stderr, /已有启动或 Python\/OCR 准备正在进行/);
  assert.ok(Date.now() - startedAt < 2500, 'the duplicate start must return promptly');
  assert.equal((await readFile(fixture.trace, 'utf8')).trim().split('\n').length, 1);

  await writeFile(fixture.gate, 'continue');
  const firstResult = await first.result;
  assert.equal(firstResult.code, 0, first.output().stderr);
  assert.match(first.output().stderr, /fixture: early progress/);
  assert.equal((await readFile(fixture.trace, 'utf8')).trim().split('\n').length, 1);
  assert.equal(await fileExists(fixture.lockPath), false);
  const log = await readFile(fixture.logPath, 'utf8');
  assert.match(log, /fixture: stdout logged/);
  assert.match(log, /fixture: early progress/);
});

test('a failed prepare releases its lock and reports only this run output', async t => {
  const fixture = await makeFixture(t);
  await mkdir(path.dirname(fixture.logPath), { recursive: true });
  await writeFile(fixture.logPath, 'OLD FAILURE: stale error from a previous attempt\n');

  const failed = fixture.runLauncher({ TEST_PREP_FAIL: '1' });
  const failedResult = await failed.result;
  assert.equal(failedResult.code, 1);
  assert.match(failed.output().stderr, /fixture specific error: uv dependency timeout/);
  assert.match(failed.output().stderr, new RegExp(`安装日志：${fixture.logPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(failed.output().stderr, /完整日志：/);
  assert.doesNotMatch(failed.output().stderr, /OLD FAILURE/);
  assert.equal(await fileExists(fixture.lockPath), false);

  const retry = fixture.runLauncher();
  const retryResult = await retry.result;
  assert.equal(retryResult.code, 0, retry.output().stderr);
  assert.equal((await readFile(fixture.trace, 'utf8')).trim().split('\n').length, 2);
});

test('a dead pid start lock can be reclaimed and preparation retried', async t => {
  const fixture = await makeFixture(t);
  const deadProcess = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
  const deadPid = deadProcess.pid;
  await new Promise(resolve => deadProcess.once('close', resolve));
  await mkdir(path.dirname(fixture.lockPath), { recursive: true });
  await writeFile(fixture.lockPath, JSON.stringify({ pid: deadPid, token: 'dead-owner' }));

  const run = fixture.runLauncher();
  const result = await run.result;
  assert.equal(result.code, 0, run.output().stderr);
  assert.equal((await readFile(fixture.trace, 'utf8')).trim().split('\n').length, 1);
  assert.equal(await fileExists(fixture.lockPath), false);
});

test('an already running workbench is reused without preparing Python', async t => {
  const fixture = await makeFixture(t);
  await writeFile(fixture.running, 'running');

  const run = fixture.runLauncher();
  const result = await run.result;
  assert.equal(result.code, 0, run.output().stderr);
  assert.match(run.output().stdout, /工作台已在运行/);
  assert.doesNotMatch(run.output().stderr, /安装日志：/);
  assert.equal(await fileExists(fixture.trace), false);
});

test('an already running workbench without a reported identity is not opened by the release entry', async t => {
  const fixture = await makeFixture(t);
  await writeFile(fixture.running, 'running');

  const run = fixture.runLauncher({ TEST_RUNNING_LEGACY: '1' });
  const result = await run.result;
  assert.equal(result.code, 1, run.output().stdout);
  assert.match(run.output().stderr, /当前入口不会打开旧实例/);
  assert.match(run.output().stderr, /旧版本实例未上报运行身份/);
  assert.match(run.output().stderr, /Start\.vbs/);
  assert.match(run.output().stderr, /停止工作台/);
  assert.doesNotMatch(run.output().stdout, /已打开本机页面/);
  assert.equal(await fileExists(fixture.trace), false);
});

test('start lock release leaves a different token untouched', async t => {
  const fixture = await makeFixture(t);
  const run = fixture.runLauncher({ TEST_PREP_GATE: fixture.gate });
  await waitForText(run, 'fixture: early progress');
  await writeFile(fixture.lockPath, JSON.stringify({ pid: process.pid, token: 'replacement-owner' }));
  await writeFile(fixture.gate, 'continue');

  const result = await run.result;
  assert.equal(result.code, 0, run.output().stderr);
  assert.deepEqual(JSON.parse(await readFile(fixture.lockPath, 'utf8')), { pid: process.pid, token: 'replacement-owner' });
});
