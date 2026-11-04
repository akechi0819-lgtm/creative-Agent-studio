import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createCanvasRuntime } from '../src/canvas/runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lifecycleEvents = new Set(['ready', 'bridge_exit', 'exit']);

function parseLifecycleLines(text) {
  return text.split(/\r?\n/).flatMap((line) => {
    try {
      const record = JSON.parse(line);
      return lifecycleEvents.has(record.event) ? [record] : [];
    } catch {
      return [];
    }
  });
}

function assertRecord(record, instanceId) {
  assert.equal(new Date(record.timestamp).toISOString(), record.timestamp);
  assert.equal(record.instanceId, instanceId);
  assert.equal(Object.hasOwn(record, 'token'), false);
  if (record.event === 'bridge_exit' || record.event === 'exit') {
    assert.equal(Object.hasOwn(record, 'exitCode'), true);
    assert.equal(Object.hasOwn(record, 'signal'), true);
  }
}

function assertReadyAndExit(records, expectedSupervisorStatus, expectedSupervisorCode) {
  const ready = records.find((record) => record.event === 'ready');
  const exit = records.find((record) => record.event === 'exit');
  assert.ok(ready?.ready, 'ready record preserves the existing ready flag');
  assert.ok(exit, 'supervisor exit record is present');
  assertRecord(ready, ready.instanceId);
  assertRecord(exit, ready.instanceId);
  assert.equal(exit.status, expectedSupervisorStatus);
  assert.equal(exit.exitCode, expectedSupervisorCode);
  assert.equal(exit.signal, null);
  return ready.instanceId;
}

async function readExitRecords(logPath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const records = parseLifecycleLines(await fs.readFile(logPath, 'utf8'));
      if (records.some((record) => record.event === 'exit')) return records;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('supervisor lifecycle exit record was not written');
}

async function startRuntime(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const runtime = createCanvasRuntime({ root });
  t.after(async () => {
    await runtime.stop().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const instance = await runtime.ensure();
  return { root, runtime, instance };
}

test('active Canvas stop records ready and normal bridge and supervisor exits', { timeout: 60_000 }, async (t) => {
  const { root, runtime } = await startRuntime(t, 'company-lite-supervisor-stop-');
  await runtime.stop();
  const records = await readExitRecords(path.join(root, 'canvas-runtime.log'));
  const instanceId = assertReadyAndExit(records, 'normal', 0);
  const bridgeExit = records.find((record) => record.event === 'bridge_exit');
  assert.ok(bridgeExit, 'bridge exit record is present');
  assertRecord(bridgeExit, instanceId);
  assert.equal(bridgeExit.status, 'normal');
  if (process.platform !== 'win32') {
    assert.equal(bridgeExit.exitCode, 0);
    assert.equal(bridgeExit.signal, null);
  }
  assert.equal((await fs.readFile(path.join(root, 'canvas-runtime.log'), 'utf8')).includes('token'), false);
});

test('unexpected bridge termination records its signal and lets the supervisor exit', { timeout: 60_000 }, async (t) => {
  const { root } = await startRuntime(t, 'company-lite-supervisor-bridge-exit-');
  const bridgeLock = JSON.parse(await fs.readFile(path.join(root, 'bridge', 'canvas-agent.lock'), 'utf8'));
  assert.ok(Number.isInteger(bridgeLock.pid));
  const signal = process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL';
  process.kill(bridgeLock.pid, signal);

  const records = await readExitRecords(path.join(root, 'canvas-runtime.log'));
  const instanceId = assertReadyAndExit(records, 'abnormal', 1);
  const bridgeExit = records.find((record) => record.event === 'bridge_exit');
  assert.ok(bridgeExit, 'bridge exit record is present');
  assertRecord(bridgeExit, instanceId);
  assert.equal(bridgeExit.status, 'abnormal');
  if (process.platform === 'win32') {
    assert.ok(bridgeExit.exitCode !== null || bridgeExit.signal !== null, 'Windows reports an exit code or signal for the terminated bridge');
  } else {
    assert.equal(bridgeExit.exitCode, null);
    assert.equal(bridgeExit.signal, signal);
  }
  assert.equal((await fs.readFile(path.join(root, 'canvas-runtime.log'), 'utf8')).includes('token'), false);
});
