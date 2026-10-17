import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildTargets, canAdoptBuild, captureBuildInputs, inspectBuildOutputs } from '../src/launcher/builds.mjs';

async function put(root, relativePath, content = `fixture:${relativePath}`) {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-builds-'));
  const inputFiles = new Set(buildTargets.flatMap(target => target.inputFiles ?? []));
  for (const relativePath of inputFiles) await put(root, relativePath);

  await put(root, 'web/src/main.jsx');
  await put(root, 'web/public/brand/favicon.ico');
  await put(root, 'third_party/canvas/canvas-agent/src/index.ts');
  await put(root, 'third_party/canvas/canvas-agent/src/nested/settings.ts');
  await put(root, 'third_party/canvas/canvas-agent/src/config.test.ts');
  await put(root, 'third_party/canvas/web/src/main.tsx');
  await put(root, 'third_party/canvas/web/public/config.js');
  await put(root, 'adapters/dsh/client/business-node.tsx');
  await put(root, 'third_party/our-free-model/workbuddy/upstream-business.mjs');

  await put(root, 'web/dist/index.html', '<link rel="stylesheet" href="/assets/app.css"><script src="/assets/app.js"></script>');
  await put(root, 'web/dist/assets/app.js');
  await put(root, 'web/dist/assets/app.css');
  await put(root, 'third_party/canvas/canvas-agent/dist/index.js');
  await put(root, 'third_party/canvas/canvas-agent/dist/index.d.ts');
  await put(root, 'third_party/canvas/canvas-agent/dist/nested/settings.js');
  await put(root, 'third_party/canvas/canvas-agent/dist/nested/settings.d.ts');
  await put(root, 'third_party/canvas/web/dist/index.html', '<link rel="icon" href="/logo.svg"><script src="/config.js"></script><script type="module" src="/assets/index.js"></script>');
  await put(root, 'third_party/canvas/web/dist/logo.svg');
  await put(root, 'third_party/canvas/web/dist/config.js');
  await put(root, 'third_party/canvas/web/dist/assets/index.js');
  await put(root, 'adapters/dsh/lib/client.js');
  await put(root, 'third_party/our-free-model/workbuddy/runtime.mjs');
  return root;
}

async function withFixture(run) {
  const root = await createFixture();
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function fingerprints(root) {
  const pairs = await Promise.all(buildTargets.map(async target => [
    target.id,
    (await captureBuildInputs(root, target)).fingerprint,
  ]));
  return new Map(pairs);
}

test('source snapshots are scoped to the matching builder inputs', async () => {
  await withFixture(async root => {
    const files = [
      ['web/src/main.jsx', 'StudioWeb'],
      ['third_party/canvas/canvas-agent/src/index.ts', 'CanvasAgent'],
      ['third_party/canvas/web/src/main.tsx', 'CanvasWeb'],
      ['adapters/dsh/client/business-node.tsx', 'DSH'],
      ['third_party/our-free-model/workbuddy/upstream-business.mjs', 'WorkBuddy'],
    ];
    for (const [relativePath, changedTarget] of files) {
      const before = await fingerprints(root);
      await put(root, relativePath, `changed:${relativePath}`);
      const after = await fingerprints(root);
      for (const target of buildTargets) {
        assert.equal(after.get(target.id) !== before.get(target.id), target.id === changedTarget, `${relativePath} should affect only ${changedTarget}`);
      }
    }

    const beforeTestSourceChange = await captureBuildInputs(root, buildTargets.find(target => target.id === 'CanvasAgent'));
    await put(root, 'third_party/canvas/canvas-agent/src/config.test.ts', 'changed test-only source');
    const afterTestSourceChange = await captureBuildInputs(root, buildTargets.find(target => target.id === 'CanvasAgent'));
    assert.equal(afterTestSourceChange.fingerprint, beforeTestSourceChange.fingerprint);
  });
});

test('output inspection returns sorted hashes and rejects a missing referenced asset', async () => {
  await withFixture(async root => {
    for (const target of buildTargets) {
      const output = await inspectBuildOutputs(root, target);
      assert.equal(output.ready, true, `${target.id}: ${output.reason}`);
    }

    const target = buildTargets.find(item => item.id === 'CanvasWeb');
    const complete = await inspectBuildOutputs(root, target);
    assert.equal(complete.ready, true, complete.reason);
    assert.deepEqual(complete.files.map(file => file.path), [...complete.files.map(file => file.path)].sort());
    assert.ok(complete.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256) && Number.isFinite(file.size)));

    await rm(path.join(root, 'third_party/canvas/web/dist/config.js'));
    const incomplete = await inspectBuildOutputs(root, target);
    assert.equal(incomplete.ready, false);
    assert.match(incomplete.reason, /HTML 引用的资源缺失/);
  });
});

test('legacy outputs are adoptable only when complete and at least as new as inputs', async () => {
  await withFixture(async root => {
    const target = buildTargets.find(item => item.id === 'StudioWeb');
    const input = await captureBuildInputs(root, target);
    const future = new Date(Date.now() + 60_000);
    for (const relativePath of target.output.primaryFiles) {
      await utimes(path.join(root, relativePath), future, future);
    }
    const freshOutputs = await inspectBuildOutputs(root, target);
    assert.equal(canAdoptBuild(input, freshOutputs), true);

    const laterInputTime = new Date(Date.now() + 120_000);
    await utimes(path.join(root, 'web/src/main.jsx'), laterInputTime, laterInputTime);
    const staleInput = await captureBuildInputs(root, target);
    assert.equal(canAdoptBuild(staleInput, freshOutputs), false);

    await rm(path.join(root, 'web/dist/assets/app.js'));
    const incompleteOutputs = await inspectBuildOutputs(root, target);
    assert.equal(canAdoptBuild(input, incompleteOutputs), false);
  });
});

test('separate input snapshots reveal source changes made during a build', async () => {
  await withFixture(async root => {
    const target = buildTargets.find(item => item.id === 'WorkBuddy');
    const before = await captureBuildInputs(root, target);
    await put(root, 'third_party/our-free-model/workbuddy/upstream-business.mjs', 'changed while the build was running');
    const after = await captureBuildInputs(root, target);
    assert.notEqual(after.fingerprint, before.fingerprint);
    assert.ok(after.latestInputMtime >= before.latestInputMtime);
  });
});
