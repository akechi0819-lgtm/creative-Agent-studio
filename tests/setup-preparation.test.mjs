import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  getSetupStatus,
  recordCanvasMcpCheck,
  recordMaterialCheck,
  reportHostProbe,
  saveAndVerifyImageConfig,
} from '../src/lite/setup.mjs';
import { saveMaterialConfig } from '../src/materials/config.mjs';

const image = { baseUrl: 'https://images.example/v1', model: 'image-v2', apiKey: 'setup-preparation-test-key' };
const materials = { baseUrl: 'https://materials.example', username: 'fixture-user', password: 'fixture-password' };
const materialHash = 'b'.repeat(64);
const dependencyTargets = ['.', 'third_party/canvas/canvas-agent', 'third_party/canvas/web'];
const buildTargets = ['CanvasAgent', 'CanvasWeb'];

async function withReadyRepo(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'company-lite-prepare-status-'));
  try {
    const repoRoot = path.join(directory, 'source');
    const root = path.join(directory, 'data');
    for (const relative of [
      'scripts/setup.mjs',
      'scripts/materials.mjs',
      'scripts/materials-mcp.mjs',
      'scripts/studio.mjs',
      'src/lite/setup.mjs',
      'src/lite/material-login.mjs',
      'src/lite/config.mjs',
      'src/materials/client.mjs',
      'src/materials/config.mjs',
      'src/materials/mcp.mjs',
      'src/materials/verify.mjs',
      'src/canvas/runtime.mjs',
    ]) {
      const file = path.join(repoRoot, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'fixture');
    }
    await fs.writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({
      dependencies: { '@modelcontextprotocol/sdk': '1.32.2', zod: '3.25.76' },
    }));
    const sdk = path.join(repoRoot, 'node_modules', '@modelcontextprotocol', 'sdk');
    await fs.mkdir(path.join(sdk, 'server'), { recursive: true });
    await fs.writeFile(path.join(sdk, 'package.json'), JSON.stringify({ name: '@modelcontextprotocol/sdk', main: 'index.js' }));
    await fs.writeFile(path.join(sdk, 'index.js'), 'module.exports = {};');
    await fs.writeFile(path.join(sdk, 'server', 'mcp.js'), 'module.exports = {};');
    const zod = path.join(repoRoot, 'node_modules', 'zod');
    await fs.mkdir(zod, { recursive: true });
    await fs.writeFile(path.join(zod, 'package.json'), JSON.stringify({ name: 'zod', main: 'index.js' }));
    await fs.writeFile(path.join(zod, 'index.js'), 'module.exports = {};');

    const canvasRoot = path.join(repoRoot, 'third_party', 'canvas');
    await fs.mkdir(path.join(canvasRoot, 'web', 'dist'), { recursive: true });
    await fs.writeFile(path.join(canvasRoot, 'web', 'dist', 'index.html'), '<!doctype html>');
    const agentRoot = path.join(canvasRoot, 'canvas-agent');
    await fs.mkdir(path.join(agentRoot, 'dist'), { recursive: true });
    await fs.writeFile(path.join(agentRoot, 'package.json'), JSON.stringify({ dependencies: {} }));
    await fs.writeFile(path.join(agentRoot, 'dist', 'index.js'), 'export {};');

    const savedMaterials = await saveMaterialConfig(materials, { root });
    await recordMaterialCheck({
      authenticated: true, queryVerified: true, downloadVerified: true,
      bytes: 1234, sha256: materialHash, failedStage: null, failureCode: null,
    }, { root, credentialId: savedMaterials.credentialId });
    await reportHostProbe({ status: 'connected', queryTool: 'search_materials', downloadTool: 'download_file' }, { root });
    await recordCanvasMcpCheck({ root });
    const ready = await saveAndVerifyImageConfig({ expectedRevision: 1, image }, {
      root,
      repoRoot,
      env: {},
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: image.model }] }) }),
    });
    assert.equal(ready.complete, true, 'the fixture starts with actual files and all other readiness checks passed');
    await run({ directory, repoRoot, root });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function writePreparation(repoRoot, { state, lock } = {}) {
  const directory = path.join(repoRoot, '.studio-runtime');
  await fs.mkdir(directory, { recursive: true });
  if (state !== undefined) await fs.writeFile(path.join(directory, 'prepare-state.json'), `${JSON.stringify(state)}\n`);
  if (lock !== undefined) await fs.writeFile(path.join(directory, 'prepare.lock'), `${JSON.stringify(lock)}\n`);
}

function readyPreparation() {
  const verifiedAt = new Date().toISOString();
  return {
    schemaVersion: 3,
    status: 'preparing',
    startedAt: verifiedAt,
    dependencies: Object.fromEntries(dependencyTargets.map((target) => [target, {
      status: 'ready', fingerprint: `dependency-${target}`, verifiedAt,
    }])),
    builds: Object.fromEntries(buildTargets.map((target) => [target, {
      status: 'ready', fingerprint: `build-${target}`, outputs: [], verifiedAt,
    }])),
  };
}

function activeLock(startedAt = new Date(Date.now() - 5_000).toISOString()) {
  return { pid: process.pid, token: 'active', startedAt };
}

async function currentStatus(root, repoRoot) {
  return getSetupStatus({ root, repoRoot, nodeVersion: 'v24.1.0', env: {} });
}

test('an active root dependency install overrides an otherwise ready old workspace', async () => {
  await withReadyRepo(async ({ repoRoot, root }) => {
    const state = {
      schemaVersion: 3,
      status: 'preparing',
      startedAt: new Date().toISOString(),
      dependencies: { '.': { status: 'installing', fingerprint: 'current-input', reason: 'missing' } },
      builds: {},
    };
    await writePreparation(repoRoot, { state, lock: activeLock() });

    const status = await currentStatus(root, repoRoot);
    const packageStep = status.steps.find((step) => step.id === 'package');
    assert.equal(status.complete, false);
    assert.equal(status.current, 'package');
    assert.equal(packageStep.complete, false);
    assert.equal(packageStep.status, 'preparing');
    assert.equal(packageStep.actionNeeded, false);
    assert.equal(packageStep.summary, '正在安装 项目 依赖。');
    assert.match(packageStep.nextAction, /仍在进行/);
  });
});

test('an active Canvas build overrides old dist and completed host/API checks', async () => {
  await withReadyRepo(async ({ repoRoot, root }) => {
    const state = readyPreparation();
    state.builds.CanvasWeb = { status: 'building', fingerprint: 'current-source' };
    await writePreparation(repoRoot, { state, lock: activeLock() });

    const status = await currentStatus(root, repoRoot);
    const canvasStep = status.steps.find((step) => step.id === 'canvas');
    assert.equal(status.complete, false);
    assert.equal(status.current, 'canvas');
    assert.equal(canvasStep.complete, false);
    assert.equal(canvasStep.status, 'preparing');
    assert.match(canvasStep.summary, /正在构建 Canvas Web/);
    assert.equal(status.steps.find((step) => step.id === 'materials').complete, true);
    assert.equal(status.steps.find((step) => step.id === 'image').complete, true);
  });
});

test('a failed preparation is visible and cannot reuse old Canvas dist as success', async () => {
  await withReadyRepo(async ({ repoRoot, root }) => {
    const state = readyPreparation();
    state.status = 'failed';
    state.failedAt = new Date().toISOString();
    state.builds.CanvasWeb = { status: 'failed', error: 'Canvas Web compiler failed' };
    state.error = 'prepare wrapper failed';
    await writePreparation(repoRoot, { state });

    const status = await currentStatus(root, repoRoot);
    const canvasStep = status.steps.find((step) => step.id === 'canvas');
    assert.equal(status.complete, false);
    assert.equal(status.current, 'canvas');
    assert.equal(canvasStep.complete, false);
    assert.equal(canvasStep.status, 'needs_action');
    assert.equal(canvasStep.error.code, 'ERR_SETUP_PREPARATION_FAILED');
    assert.match(canvasStep.summary, /Canvas Web compiler failed/);
    assert.doesNotMatch(canvasStep.summary, /prepare wrapper failed/);
    assert.equal(canvasStep.nextAction, '修复准备失败原因后运行 node scripts/prepare.mjs。');
  });
});

test('a preparing record without a live lock is interrupted and can be restarted', async () => {
  await withReadyRepo(async ({ repoRoot, root }) => {
    const state = readyPreparation();
    state.builds.CanvasAgent = { status: 'building', fingerprint: 'current-source' };
    await writePreparation(repoRoot, { state });

    const status = await currentStatus(root, repoRoot);
    const canvasStep = status.steps.find((step) => step.id === 'canvas');
    assert.equal(status.complete, false);
    assert.equal(status.current, 'canvas');
    assert.equal(canvasStep.status, 'needs_action');
    assert.equal(canvasStep.error.code, 'ERR_SETUP_PREPARATION_INTERRUPTED');
    assert.match(canvasStep.summary, /已中断.*未发现活动准备进程/);
    assert.match(canvasStep.nextAction, /node scripts\/prepare\.mjs/);
  });
});

test('a live prepare lock before the first state write does not falsely report ready', async () => {
  await withReadyRepo(async ({ repoRoot, root }) => {
    await writePreparation(repoRoot, { lock: { pid: process.pid, token: 'active-before-state', startedAt: new Date().toISOString() } });

    const status = await currentStatus(root, repoRoot);
    const packageStep = status.steps.find((step) => step.id === 'package');
    assert.equal(status.complete, false);
    assert.equal(status.current, 'package');
    assert.equal(packageStep.status, 'preparing');
    assert.match(packageStep.summary, /正在写入准备状态/);
  });
});

test('a newer active lock supersedes a completed preparation before the new state write', async () => {
  await withReadyRepo(async ({ repoRoot, root }) => {
    const completedAt = new Date(Date.now() - 10_000).toISOString();
    const state = readyPreparation();
    state.status = 'ready';
    state.startedAt = completedAt;
    state.completedAt = completedAt;
    state.fingerprint = 'previous-run';
    await writePreparation(repoRoot, { state, lock: activeLock() });

    const status = await currentStatus(root, repoRoot);
    const packageStep = status.steps.find((step) => step.id === 'package');
    assert.equal(status.complete, false);
    assert.equal(status.current, 'package');
    assert.equal(packageStep.status, 'preparing');
    assert.match(packageStep.summary, /正在写入准备状态/);
  });
});

test('a lock from a completed run does not keep a ready preparation blocked', async () => {
  await withReadyRepo(async ({ repoRoot, root }) => {
    const startAt = new Date(Date.now() - 10_000).toISOString();
    const lockAt = new Date(Date.now() - 5_000).toISOString();
    const completeAt = new Date(Date.now() - 2_000).toISOString();
    const state = readyPreparation();
    state.status = 'ready';
    state.startedAt = startAt;
    state.completedAt = completeAt;
    state.fingerprint = 'completed-run';
    await writePreparation(repoRoot, { state, lock: activeLock(lockAt) });

    const status = await currentStatus(root, repoRoot);
    assert.equal(status.complete, true);
    assert.equal(status.current, 'finish');
  });
});

test('a clean first clone without preparation state still follows actual file checks', async () => {
  await withReadyRepo(async ({ repoRoot, root }) => {
    const status = await currentStatus(root, repoRoot);
    assert.equal(status.complete, true);
    assert.equal(status.current, 'finish');
  });
});
