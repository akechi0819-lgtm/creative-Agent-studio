import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function makeWebFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-release-readonly-'));
  t.after(async () => {
    await chmod(path.join(root, 'payload/.studio-runtime'), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const payload = path.join(root, 'payload');
  const script = path.join(payload, 'scripts/web.mjs');
  const sourceRuntime = path.join(payload, '.studio-runtime');
  const trace = path.join(root, 'trace.log');
  const data = path.join(root, 'user-data');
  const identitySource = await readFile(new URL('../src/launcher/identity.mjs', import.meta.url), 'utf8');
  await mkdir(payload, { recursive: true });
  await Promise.all([
    mkdir(path.dirname(script), { recursive: true }),
    mkdir(sourceRuntime, { recursive: true }),
    mkdir(path.join(payload, 'web/dist'), { recursive: true }),
    mkdir(data, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(trace, ''),
    writeFile(path.join(payload, 'package.json'), '{"type":"module"}'),
    writeFile(path.join(payload, 'web/dist/index.html'), '<main>fixture</main>'),
    writeFile(path.join(sourceRuntime, 'prepare.lock'), '{"pid":999999}'),
    writeFile(script, await readFile(new URL('../scripts/web.mjs', import.meta.url))),
  ]);

  async function module(relative, source) {
    const filename = path.join(payload, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, source);
  }

  await Promise.all([
    module('src/launcher/control.mjs', `
      import { appendFile, readFile, readdir } from 'node:fs/promises';
      export function alive(pid) { return pid === 999999; }
      export async function readJson(filename) {
        if (filename.endsWith('prepare.lock')) {
          await appendFile(process.env.TEST_TRACE, 'prepare-check\\n');
          const markers = await readdir(process.env.TEST_SOURCE_SERVERS).catch(() => []);
          if (markers.some(name => name.endsWith('.json'))) await appendFile(process.env.TEST_TRACE, 'marker-present\\n');
        }
        try { return JSON.parse(await readFile(filename, 'utf8')); } catch { return null; }
      }
      export async function runtimeStatus() { return { running: false }; }
      export async function serveControl() { return async () => {}; }
    `),
    module('src/launcher/identity.mjs', identitySource),
    module('src/canvas/client.mjs', `export function dataRoot() { return process.env.STUDIO_DATA_DIR; }`),
    module('src/web/model-plugin.mjs', `export async function ensureModelPlugin() {}\nexport async function stopModelPlugin() {}`),
    module('src/web/config.mjs', `export async function readConfig() { return {}; }`),
    module('src/web/server.mjs', `
      import { appendFile } from 'node:fs/promises';
      export async function listenStudioServer() {
        await appendFile(process.env.TEST_TRACE, 'listen\\n');
        setImmediate(() => process.exit(0));
        return { address: { port: 4310 }, close: async () => {} };
      }
    `),
    module('src/web/canvas.mjs', `export function createCanvasManager() { return { stop: async () => {} }; }`),
    module('adapters/dsh/runtime.mjs', `export function createStudioAgent() { return {}; }`),
  ]);

  return { root, payload, script, sourceRuntime, trace, data };
}

function runWeb(fixture, { releaseBundle = false } = {}) {
  const child = spawn(process.execPath, [fixture.script, '--no-open'], {
    cwd: fixture.payload,
    env: {
      ...process.env,
      STUDIO_DATA_DIR: fixture.data,
      TEST_TRACE: fixture.trace,
      TEST_SOURCE_SERVERS: path.join(fixture.sourceRuntime, 'servers'),
      ...(releaseBundle ? { STUDIO_RELEASE_BUNDLE: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
  const result = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  return { child, result, output: () => ({ stdout, stderr }) };
}

async function readTrace(filename) {
  return readFile(filename, 'utf8');
}

test('source web startup keeps the source prepare lock guard and marker', async t => {
  const fixture = await makeWebFixture(t);
  const run = runWeb(fixture);
  const result = await run.result;

  assert.equal(result.code, 1);
  const trace = await readTrace(fixture.trace);
  assert.match(trace, /prepare-check/);
  assert.match(trace, /marker-present/);
  assert.doesNotMatch(trace, /listen/);
  assert.deepEqual((await readdir(path.join(fixture.sourceRuntime, 'servers'))).filter(name => name.endsWith('.json')), []);
});

test('release web startup skips source runtime writes and prepare lock checks', async t => {
  const fixture = await makeWebFixture(t);
  await chmod(fixture.sourceRuntime, 0o555);
  const run = runWeb(fixture, { releaseBundle: true });
  const result = await run.result;

  assert.equal(result.code, 0, run.output().stderr);
  assert.match(run.output().stdout, /Creative Agent Studio Web UI/);
  assert.match(await readTrace(fixture.trace), /^listen\n$/);
  await assert.rejects(access(path.join(fixture.sourceRuntime, 'servers')));
  assert.equal(await readFile(path.join(fixture.data, 'web/instance.lock'), 'utf8').then(() => true, () => false), true);
});

test('release launcher marks its web child as a bundled runtime', async () => {
  const source = await readFile(new URL('../release/launcher.mjs', import.meta.url), 'utf8');
  assert.match(source, /STUDIO_RELEASE_BUNDLE:\s*'1'/);
});
