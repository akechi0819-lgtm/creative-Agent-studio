import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pythonInternals } from '../src/launcher/python.mjs';

const REQUIREMENTS = [
  'rapidocr==3.10.0',
  'onnxruntime==1.31.0',
  'opencv-python-headless==5.0.0.93',
  'pypdfium2==5.14.0',
].join('\n') + '\n';

const LOCK = [
  'numpy==2.2.0 \\',
  '    --hash=sha256:0000000000000000000000000000000000000000000000000000000000000000',
  'onnxruntime==1.31.0 \\',
  '    --hash=sha256:0000000000000000000000000000000000000000000000000000000000000000',
  'opencv-python-headless==5.0.0.93 \\',
  '    --hash=sha256:0000000000000000000000000000000000000000000000000000000000000000',
  'pypdfium2==5.14.0 \\',
  '    --hash=sha256:0000000000000000000000000000000000000000000000000000000000000000',
  'rapidocr==3.10.0 \\',
  '    --hash=sha256:0000000000000000000000000000000000000000000000000000000000000000',
  "colorama==0.4.6 ; sys_platform == 'win32' \\",
  '    --hash=sha256:0000000000000000000000000000000000000000000000000000000000000000',
].join('\n') + '\n';

async function makeFixture(t, { python = true, models = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-python-prepare-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(root, 'scripts', 'requirements-cleaner-ocr.txt'), REQUIREMENTS);
  await fs.writeFile(path.join(root, 'scripts', 'requirements-cleaner-ocr.lock.txt'), LOCK);
  await fs.writeFile(path.join(root, 'scripts', 'requirements-workspace.txt'), '# fixture Office requirements\n');
  await fs.writeFile(path.join(root, 'scripts', 'requirements-workspace.lock.txt'), '# fixture Office lock\n');
  await fs.writeFile(path.join(root, 'scripts', 'ocr_materials.py'), '# fixture helper\n');
  const paths = pythonInternals.runtimePaths(root);
  if (python) {
    await fs.mkdir(path.dirname(pythonInternals.pythonExecutable(paths.venv)), { recursive: true });
    await fs.writeFile(pythonInternals.pythonExecutable(paths.venv), 'fixture-python');
  }
  if (models) await writeModels(paths.modelRoot);
  return { root, paths };
}

async function writeModels(modelRoot) {
  await fs.mkdir(modelRoot, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(modelRoot, 'det.onnx'), 'detector fixture'),
    fs.writeFile(path.join(modelRoot, 'rec.onnx'), 'recognizer fixture'),
    fs.writeFile(path.join(modelRoot, 'cls.onnx'), 'classifier fixture'),
  ]);
}

function findMarkerTestPython() {
  const candidates = [...(process.env.STUDIO_OCR_PYTHON ? [{ command: process.env.STUDIO_OCR_PYTHON, prefix: [] }] : []), ...(process.platform === 'win32'
    ? [{ command: 'py', prefix: ['-3.12'] }, { command: 'python3.12', prefix: [] }]
    : [{ command: 'python3.12', prefix: [] }, { command: 'python3', prefix: [] }])];
  const probe = 'import importlib.util, json, sys; print(json.dumps({"version": list(sys.version_info[:2]), "platform": sys.platform, "venv": sys.prefix, "packaging": importlib.util.find_spec("packaging") is not None}))';
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, [...candidate.prefix, '-c', probe], { encoding: 'utf8', timeout: 20_000 });
    if (result.status !== 0) continue;
    try {
      const identity = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
      if (identity.version?.[0] === 3 && identity.version?.[1] === 12 && identity.packaging) {
        return { ...candidate, platform: identity.platform, venv: identity.venv };
      }
    } catch { /* Continue through the available Python 3.12 launchers. */ }
  }
  return null;
}

const markerTestPython = findMarkerTestPython();

function readyHealth(paths, candidatePaths = paths, { dependencies = true, version = [3, 12, 0] } = {}) {
  const runtimeHealthy = path.resolve(candidatePaths.venv) === path.resolve(paths.venv)
    || path.resolve(candidatePaths.venv) === path.resolve(paths.venvStage);
  return {
    runtimeHealthy,
    dependenciesHealthy: dependencies,
    ready: runtimeHealthy && dependencies,
    version,
    basePrefix: '/Library/Frameworks/Python.framework/Versions/3.12',
    versions: {},
  };
}

function warmOperation(counter) {
  return async (_python, modelRoot) => {
    counter.warm = (counter.warm ?? 0) + 1;
    await writeModels(modelRoot);
    return { blankText: '', sampleText: 'P4 OCR SAMPLE' };
  };
}

test('managed-only preparation replaces an external base with the bundled Python runtime', async (t) => {
  const { root, paths } = await makeFixture(t, { models: false });
  const state = { created: false, synced: false, systemLookups: 0, warmups: 0 };
  const managedBase = path.join(paths.pythonHome, 'cpython-3.12.15');
  const stagedRunnerPython = pythonInternals.pythonExecutable(paths.venvStage);
  await fs.mkdir(path.dirname(stagedRunnerPython), { recursive: true });
  await fs.writeFile(stagedRunnerPython, 'runner-python');
  const managedHealth = (dependencies = true) => ({
    runtimeHealthy: true,
    dependenciesHealthy: dependencies,
    ready: dependencies,
    version: [3, 12, 15],
    basePrefix: managedBase,
    versions: {},
  });
  const operations = {
    inspectPython: async (_pythonPath, candidatePaths) => {
      const candidate = path.resolve(candidatePaths.venv);
      if (candidate === path.resolve(paths.venvStage)) {
        return state.created ? managedHealth(state.synced) : readyHealth(paths, candidatePaths);
      }
      if (candidate === path.resolve(paths.venv)) {
        if (!state.created) return readyHealth(paths, candidatePaths);
        return managedHealth(state.synced);
      }
      return null;
    },
    resolveUv: async () => ({ command: 'fixture-uv', version: '0.12.24', source: 'fixture' }),
    findSystemPython312: async () => {
      state.systemLookups += 1;
      return { executable: '/runner/python3.12', version: [3, 12, 15] };
    },
    createVenv: async (_uv, stagePath, systemPython) => {
      assert.equal(systemPython, null, 'managed-only mode must not use the runner Python');
      await fs.mkdir(managedBase, { recursive: true });
      const stagePython = pythonInternals.pythonExecutable(stagePath);
      const bin = path.dirname(stagePython);
      await fs.mkdir(bin, { recursive: true });
      await fs.writeFile(stagePython, 'managed-python');
      await fs.writeFile(path.join(bin, 'activate'), 'VIRTUAL_ENV=/portable/venv\n');
      await fs.writeFile(path.join(bin, 'studio-ocr'), '#!/usr/bin/env python3\nprint("ready")\n');
      state.created = true;
    },
    syncDependencies: async () => { state.synced = true; },
    warmOcr: async (_python, modelRoot) => {
      state.warmups += 1;
      await writeModels(modelRoot);
      return { blankText: '', sampleText: 'P4 OCR SAMPLE' };
    },
  };

  const prepared = await pythonInternals.prepareWithOperations({ root, managedOnly: true }, operations);
  assert.equal(prepared.runtimeSource, 'project-managed-python');
  assert.equal(state.systemLookups, 0);
  assert.equal(state.warmups, 1);
  assert.equal(JSON.parse(await fs.readFile(paths.pythonRuntimeState, 'utf8')).runtimeSource, 'project-managed-python');
});

test('claims a healthy external Python 3.12 venv without state and ignores helper changes', async (t) => {
  const { root, paths } = await makeFixture(t);
  const counters = { resolveUv: 0, sync: 0, create: 0, warm: 0, guard: 0 };
  const operations = {
    inspectPython: async (_pythonPath, candidatePaths) => readyHealth(paths, candidatePaths),
    resolveUv: async () => { counters.resolveUv += 1; throw new Error('unexpected uv resolution'); },
    syncDependencies: async () => { counters.sync += 1; throw new Error('unexpected dependency sync'); },
    createVenv: async () => { counters.create += 1; throw new Error('unexpected venv creation'); },
    warmOcr: warmOperation(counters),
  };

  const first = await pythonInternals.prepareWithOperations({
    root, beforeChange: async () => { counters.guard += 1; },
  }, operations);
  assert.equal(first.pythonVersion, '3.12.0');
  assert.equal(first.runtimeSource, 'external-python-base');
  assert.equal(first.skipped, false);
  assert.equal(counters.warm, 1, 'missing model manifest requires a real warmup');
  assert.equal(counters.sync, 0);
  assert.equal(counters.create, 0);

  await fs.rm(paths.pythonState, { force: true });
  await fs.rm(paths.pythonRuntimeState, { force: true });
  const fingerprintBeforeHelperEdit = first.fingerprint;
  await fs.writeFile(path.join(root, 'scripts', 'ocr_materials.py'), '# helper implementation changed\n');
  const second = await pythonInternals.prepareWithOperations({
    root, beforeChange: async () => { counters.guard += 1; },
  }, operations);

  assert.equal(second.fingerprint, fingerprintBeforeHelperEdit);
  assert.equal(second.skipped, true, 'validated runtime and model manifest are claimed without reinstalling');
  assert.deepEqual(counters, { resolveUv: 0, sync: 0, create: 0, warm: 1, guard: 1 });
  assert.equal(JSON.parse(await fs.readFile(paths.pythonState, 'utf8')).status, 'ready');
  assert.equal(JSON.parse(await fs.readFile(paths.pythonRuntimeState, 'utf8')).status, 'ready');
});

test('syncs only the locked dependencies in place and retains runtime and models after failure', async (t) => {
  const { root, paths } = await makeFixture(t);
  const state = { dependencies: true };
  const counters = { sync: 0, create: 0, warm: 0, guard: 0 };
  let failNextSync = false;
  const operations = {
    inspectPython: async (_pythonPath, candidatePaths) => readyHealth(paths, candidatePaths, { dependencies: state.dependencies }),
    resolveUv: async () => ({ command: 'fixture-uv', version: '0.11.25', source: 'fixture' }),
    syncDependencies: async () => {
      counters.sync += 1;
      if (failNextSync) {
        failNextSync = false;
        throw new Error('fixture sync interruption');
      }
      state.dependencies = true;
    },
    createVenv: async () => { counters.create += 1; throw new Error('healthy runtime must not be recreated'); },
    warmOcr: warmOperation(counters),
  };
  const options = { root, beforeChange: async () => { counters.guard += 1; } };
  await pythonInternals.prepareWithOperations(options, operations);
  const pythonPath = pythonInternals.pythonExecutable(paths.venv);
  const modelBefore = await fs.readFile(path.join(paths.modelRoot, 'det.onnx'));

  state.dependencies = false;
  failNextSync = true;
  await assert.rejects(pythonInternals.prepareWithOperations(options, operations), /fixture sync interruption/);
  assert.equal(await fs.readFile(pythonPath, 'utf8'), 'fixture-python');
  assert.deepEqual(await fs.readFile(path.join(paths.modelRoot, 'det.onnx')), modelBefore);
  assert.equal(JSON.parse(await fs.readFile(paths.pythonRuntimeState, 'utf8')).status, 'ready');
  assert.equal(JSON.parse(await fs.readFile(paths.pythonState, 'utf8')).status, 'failed');

  const retry = await pythonInternals.prepareWithOperations(options, operations);
  assert.equal(retry.skipped, false);
  assert.equal(counters.sync, 2, 'initial claim does not sync; failed sync is retried once');
  assert.equal(counters.create, 0);
  assert.equal(counters.warm, 1, 'a valid model manifest avoids a second warmup');
  assert.equal(await fs.readFile(pythonPath, 'utf8'), 'fixture-python');
  assert.equal(JSON.parse(await fs.readFile(paths.pythonState, 'utf8')).status, 'ready');
});

test('stages a replacement and preserves the old venv when sync fails', async (t) => {
  const { root, paths } = await makeFixture(t, { python: false, models: true });
  const oldPython = pythonInternals.pythonExecutable(paths.venv);
  await fs.mkdir(path.dirname(oldPython), { recursive: true });
  await fs.writeFile(oldPython, 'old-environment');

  const state = { stageCreated: false, stageDependencies: false, syncs: 0, creates: 0, warm: 0 };
  const operations = {
    inspectPython: async (pythonPath, candidatePaths) => {
      const candidate = path.resolve(candidatePaths.venv);
      if (candidate === path.resolve(paths.venvStage)) {
        if (!state.stageCreated) return null;
        return readyHealth(paths, candidatePaths, { dependencies: state.stageDependencies });
      }
      if (candidate === path.resolve(paths.venv)) {
        if (state.stageDependencies && await fs.readFile(pythonPath, 'utf8').then((value) => value === 'new-environment', () => false)) {
          return readyHealth(paths, candidatePaths);
        }
        return { runtimeHealthy: false, dependenciesHealthy: false, ready: false };
      }
      return null;
    },
    resolveUv: async () => ({ command: 'fixture-uv', version: '0.11.25', source: 'fixture' }),
    findSystemPython312: async () => ({ executable: '/fixture/python3.12', version: [3, 12, 0] }),
    createVenv: async (_uv, stagePath, systemPython) => {
      state.creates += 1;
      assert.equal(systemPython.executable, '/fixture/python3.12');
      const stagePython = pythonInternals.pythonExecutable(stagePath);
      await fs.mkdir(path.dirname(stagePython), { recursive: true });
      await fs.writeFile(stagePython, 'new-environment');
      await fs.writeFile(path.join(path.dirname(stagePython), 'activate'), 'VIRTUAL_ENV="$(cd "$(dirname "$BASH_SOURCE")/.." && pwd)"\n');
      await fs.writeFile(path.join(path.dirname(stagePython), 'studio-ocr'), '#!/usr/bin/env python3\nprint("ready")\n');
      state.stageCreated = true;
    },
    syncDependencies: async () => {
      state.syncs += 1;
      if (state.syncs === 1) throw new Error('fixture first sync fails');
      state.stageDependencies = true;
    },
    warmOcr: warmOperation(state),
  };
  const options = { root };

  await assert.rejects(pythonInternals.prepareWithOperations(options, operations), /fixture first sync fails/);
  assert.equal(await fs.readFile(oldPython, 'utf8'), 'old-environment');
  assert.equal(await fs.readFile(pythonInternals.pythonExecutable(paths.venvStage), 'utf8'), 'new-environment');

  const prepared = await pythonInternals.prepareWithOperations(options, operations);
  assert.equal(prepared.pythonVersion, '3.12.0');
  assert.equal(prepared.runtimeSource, 'external-python-base');
  assert.equal(state.creates, 1, 'retry reuses the staged interpreter instead of creating another');
  assert.equal(state.syncs, 2);
  assert.equal(await fs.readFile(pythonInternals.pythonExecutable(paths.venv), 'utf8'), 'new-environment');
  const backups = await fs.readdir(paths.venvBackups);
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(pythonInternals.pythonExecutable(path.join(paths.venvBackups, backups[0])), 'utf8'), 'old-environment');
});

test('keeps a healthy promoted venv after warmup fails and retries only model warmup', async (t) => {
  const { root, paths } = await makeFixture(t, { python: false, models: false });
  const oldPython = pythonInternals.pythonExecutable(paths.venv);
  await fs.mkdir(path.dirname(oldPython), { recursive: true });
  await fs.writeFile(oldPython, 'old-environment');

  const state = { stageCreated: false, stageDependencies: false, creates: 0, syncs: 0, warms: 0 };
  const counters = { resolveUv: 0, guard: 0 };
  const operations = {
    inspectPython: async (pythonPath, candidatePaths) => {
      const candidate = path.resolve(candidatePaths.venv);
      if (candidate === path.resolve(paths.venvStage)) {
        return state.stageCreated ? readyHealth(paths, candidatePaths, { dependencies: state.stageDependencies }) : null;
      }
      if (candidate === path.resolve(paths.venv)) {
        const isReplacement = await fs.readFile(pythonPath, 'utf8').then((value) => value === 'replacement-environment', () => false);
        return isReplacement ? readyHealth(paths, candidatePaths) : { runtimeHealthy: false, dependenciesHealthy: false, ready: false };
      }
      return null;
    },
    resolveUv: async () => {
      counters.resolveUv += 1;
      return { command: 'fixture-uv', version: '0.11.25', source: 'fixture' };
    },
    findSystemPython312: async () => ({ executable: '/fixture/python3.12', version: [3, 12, 0] }),
    createVenv: async (_uv, stagePath) => {
      state.creates += 1;
      const stagePython = pythonInternals.pythonExecutable(stagePath);
      const bin = path.dirname(stagePython);
      await fs.mkdir(bin, { recursive: true });
      await fs.writeFile(stagePython, 'replacement-environment');
      await fs.writeFile(path.join(bin, 'activate'), 'VIRTUAL_ENV="$(cd "$(dirname "$BASH_SOURCE")/.." && pwd)"\n');
      await fs.writeFile(path.join(bin, 'studio-ocr'), '#!/usr/bin/env python3\nprint("ready")\n');
      state.stageCreated = true;
    },
    syncDependencies: async () => {
      state.syncs += 1;
      state.stageDependencies = true;
    },
    warmOcr: async (_python, modelRoot) => {
      state.warms += 1;
      if (state.warms === 1) throw new Error('fixture model warmup interruption');
      await writeModels(modelRoot);
      return { blankText: '', sampleText: 'P4 OCR SAMPLE' };
    },
  };
  const options = { root, beforeChange: async () => { counters.guard += 1; } };

  await assert.rejects(
    pythonInternals.prepareWithOperations(options, operations),
    /fixture model warmup interruption/,
  );
  const activePython = pythonInternals.pythonExecutable(paths.venv);
  assert.equal(await fs.readFile(activePython, 'utf8'), 'replacement-environment');
  assert.equal(await fs.readFile(path.join(paths.venv, 'bin', 'activate'), 'utf8')
    .then((text) => text.includes(paths.venvStage)), false);
  assert.equal(await fs.readFile(path.join(paths.venv, 'bin', 'studio-ocr'), 'utf8')
    .then((text) => text.includes(paths.venvStage)), false);
  assert.equal(JSON.parse(await fs.readFile(paths.pythonRuntimeState, 'utf8')).status, 'ready');
  assert.equal(JSON.parse(await fs.readFile(paths.pythonState, 'utf8')).status, 'ready');
  assert.equal(JSON.parse(await fs.readFile(paths.modelState, 'utf8')).status, 'failed');
  const backups = await fs.readdir(paths.venvBackups);
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(paths.venvBackups, backups[0], 'bin', 'python'), 'utf8'), 'old-environment');

  const retry = await pythonInternals.prepareWithOperations(options, operations);
  assert.equal(retry.skipped, false);
  assert.deepEqual(state, { stageCreated: true, stageDependencies: true, creates: 1, syncs: 1, warms: 2 });
  assert.deepEqual(counters, { resolveUv: 1, guard: 2 });
  assert.equal(JSON.parse(await fs.readFile(paths.pythonRuntimeState, 'utf8')).status, 'ready');
  assert.equal(JSON.parse(await fs.readFile(paths.pythonState, 'utf8')).status, 'ready');
  assert.equal(JSON.parse(await fs.readFile(paths.modelState, 'utf8')).status, 'ready');
});

test('lock parser covers transitive pinned packages and rejects direct lock drift', async (t) => {
  const { paths } = await makeFixture(t);
  const spec = await pythonInternals.dependencySpec(paths);
  assert.equal(spec.packages.numpy.version, '2.2.0');
  assert.equal(spec.packages.colorama.version, '0.4.6');
  assert.equal(spec.packages.colorama.marker, "sys_platform == 'win32'");
  assert.equal(Object.keys(spec.packages).length, 6);

  await fs.writeFile(paths.lock, LOCK.replace('rapidocr==3.10.0', 'rapidocr==3.10.1'));
  await assert.rejects(pythonInternals.dependencySpec(paths), /固定依赖锁缺少匹配版本/);
});

test('does not require an installed package whose PEP 508 marker is false', { skip: !markerTestPython }, async (t) => {
  const { root, paths } = await makeFixture(t, { python: false, models: false });

  const spec = {
    packages: {
      'fixture-not-installed': { version: '1.0', marker: `sys_platform != '${markerTestPython.platform}'` },
    },
    imports: [],
  };
  const probe = spawnSync(markerTestPython.command, [...markerTestPython.prefix, '-c', 'import sys; print(sys.executable)'], {encoding:'utf8'});
  assert.equal(probe.status, 0);
  const health = await pythonInternals.inspectPython(probe.stdout.trim(), {...paths,venv:markerTestPython.venv}, spec);
  assert.equal(health.runtimeHealthy, true);
  assert.equal(health.dependenciesHealthy, true);
  assert.deepEqual(health.versions, {});
  assert.equal(health.ready, true);
});

test('does not report ready for a dependency lock edited during model preparation', async t => {
  const {root,paths}=await makeFixture(t);
  let edited=false;
  const operations={
    inspectPython:async(_python,candidatePaths)=>readyHealth(paths,candidatePaths),
    resolveUv:async()=>{throw new Error('existing dependencies must not be reinstalled');},
    warmOcr:async(_python,modelRoot)=>{
      await writeModels(modelRoot);
      if(!edited){edited=true;await fs.writeFile(paths.lock,LOCK.replace('numpy==2.2.0','numpy==2.2.1'));}
      return {blankText:'',sampleText:'SAMPLE'};
    },
  };
  await assert.rejects(pythonInternals.prepareWithOperations({root},operations),/依赖清单在准备期间变化/);
  assert.equal(await fs.readFile(pythonInternals.pythonExecutable(paths.venv),'utf8'),'fixture-python');
  const result=await pythonInternals.prepareWithOperations({root},operations);
  assert.equal(result.pythonVersion,'3.12.0');
  assert.equal(JSON.parse(await fs.readFile(paths.pythonState,'utf8')).status,'ready');
});


test('Office requirements are included in the shared Python fingerprint and package validation',async t=>{
  const {paths}=await makeFixture(t);
  const before=await pythonInternals.fingerprint(paths);
  await fs.writeFile(paths.workspaceRequirements,'openpyxl==3.1.5\n');
  await assert.rejects(pythonInternals.dependencySpec(paths),/固定依赖锁缺少/);
  await fs.writeFile(paths.workspaceLock,'openpyxl==3.1.5 \\\n    --hash=sha256:'+'0'.repeat(64)+'\n');
  const spec=await pythonInternals.dependencySpec(paths);
  assert.equal(spec.packages.openpyxl.version,'3.1.5');
  assert.notEqual(await pythonInternals.fingerprint(paths),before);
});
