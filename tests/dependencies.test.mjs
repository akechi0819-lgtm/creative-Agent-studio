import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { checkDependencyGroup } from '../src/launcher/dependencies.mjs';

const fixtures = new Set();
const packageIntegrity = `sha512-${Buffer.alloc(64).toString('base64')}`;

async function makeFixture({ platformOptional = false, extraneous = false, hiddenLock = false } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'studio-dependencies-'));
  fixtures.add(cwd);
  const rootPackage = {
    name: 'dependency-fixture',
    version: '1.0.0',
    dependencies: { 'fixture-leaf': '1.2.3' },
    ...(platformOptional ? { optionalDependencies: { 'fixture-platform-only': '9.0.0' } } : {}),
  };
  const packages = {
    '': {
      name: rootPackage.name,
      version: rootPackage.version,
      dependencies: rootPackage.dependencies,
      ...(rootPackage.optionalDependencies ? { optionalDependencies: rootPackage.optionalDependencies } : {}),
    },
    'node_modules/fixture-leaf': {
      name: 'fixture-leaf',
      version: '1.2.3',
      resolved: 'https://registry.npmjs.org/fixture-leaf/-/fixture-leaf-1.2.3.tgz',
      integrity: packageIntegrity,
    },
    ...(platformOptional ? {
      'node_modules/fixture-platform-only': {
        name: 'fixture-platform-only',
        version: '9.0.0',
        os: [`!${process.platform}`],
        optional: true,
      },
    } : {}),
  };
  const lock = {
    name: rootPackage.name,
    version: rootPackage.version,
    lockfileVersion: 3,
    requires: true,
    packages,
  };

  await mkdir(path.join(cwd, 'node_modules', 'fixture-leaf'), { recursive: true });
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify(rootPackage));
  await writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify(lock));
  await writeFile(path.join(cwd, 'node_modules', 'fixture-leaf', 'package.json'), JSON.stringify({
    name: 'fixture-leaf',
    version: '1.2.3',
    main: 'index.js',
  }));
  await writeFile(path.join(cwd, 'node_modules', 'fixture-leaf', 'index.js'), 'module.exports = true;\n');

  if (extraneous) {
    await mkdir(path.join(cwd, 'node_modules', 'unlocked-extra'), { recursive: true });
    await writeFile(path.join(cwd, 'node_modules', 'unlocked-extra', 'package.json'), JSON.stringify({
      name: 'unlocked-extra',
      version: '99.0.0',
      main: 'does-not-exist.js',
    }));
  }
  if (hiddenLock) {
    await writeFile(path.join(cwd, 'node_modules', '.package-lock.json'), JSON.stringify(lock));
  }
  return { cwd, lock };
}

afterEach(async () => {
  await Promise.all([...fixtures].map((cwd) => rm(cwd, { recursive: true, force: true })));
  fixtures.clear();
});

test('accepts a complete v3 locked install and ignores unrelated extraneous packages', async () => {
  const { cwd } = await makeFixture({ platformOptional: true, extraneous: true });
  const result = await checkDependencyGroup({ cwd });
  assert.equal(result.ready, true, result.reason);
});

test('rejects a missing locked package', async () => {
  const { cwd } = await makeFixture();
  await rm(path.join(cwd, 'node_modules', 'fixture-leaf'), { recursive: true, force: true });
  const result = await checkDependencyGroup({ cwd });
  assert.equal(result.ready, false);
  assert.match(result.reason, /missing/i);
});

test('rejects an installed version that differs from the lock', async () => {
  const { cwd, lock } = await makeFixture();
  const hiddenLock = structuredClone(lock);
  hiddenLock.packages['node_modules/fixture-leaf'].version = '1.2.4';
  await writeFile(path.join(cwd, 'node_modules', '.package-lock.json'), JSON.stringify(hiddenLock));
  await writeFile(path.join(cwd, 'node_modules', 'fixture-leaf', 'package.json'), JSON.stringify({
    name: 'fixture-leaf',
    version: '1.2.4',
    main: 'index.js',
  }));
  const result = await checkDependencyGroup({ cwd });
  assert.equal(result.ready, false);
  assert.match(result.reason, /match the lock/i);
});

test('rejects a lock integrity change when installed metadata is still stale', async () => {
  const { cwd, lock } = await makeFixture({ hiddenLock: true });
  lock.packages['node_modules/fixture-leaf'].integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
  await writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify(lock));
  const result = await checkDependencyGroup({ cwd });
  assert.equal(result.ready, false);
  assert.match(result.reason, /match the lock/i);
});

test('rejects a missing direct dependency entry point', async () => {
  const { cwd } = await makeFixture();
  await rm(path.join(cwd, 'node_modules', 'fixture-leaf', 'index.js'));
  await writeFile(path.join(cwd, 'node_modules', 'fixture-leaf', 'package.json'), JSON.stringify({
    name: 'fixture-leaf',
    version: '1.2.3',
    main: 'index.js',
    types: 'index.d.ts',
  }));
  await writeFile(path.join(cwd, 'node_modules', 'fixture-leaf', 'index.d.ts'), 'export declare const value: true;\n');
  const result = await checkDependencyGroup({ cwd });
  assert.equal(result.ready, false);
  assert.match(result.reason, /runtime entry/i);
});

test('accepts a type-only direct dependency when its declaration file is present', async () => {
  const { cwd } = await makeFixture();
  const packageRoot = path.join(cwd, 'node_modules', 'fixture-leaf');
  await rm(path.join(packageRoot, 'index.js'));
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'fixture-leaf',
    version: '1.2.3',
    types: 'index.d.ts',
  }));
  await writeFile(path.join(packageRoot, 'index.d.ts'), 'export declare const value: true;\n');
  const result = await checkDependencyGroup({ cwd });
  assert.equal(result.ready, true, result.reason);
});

test('rejects a missing declared executable even when the runtime entry exists', async () => {
  const { cwd } = await makeFixture();
  const packageRoot = path.join(cwd, 'node_modules', 'fixture-leaf');
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'fixture-leaf',
    version: '1.2.3',
    main: 'index.js',
    bin: { 'fixture-leaf': 'bin/cli.js' },
  }));
  const result = await checkDependencyGroup({ cwd });
  assert.equal(result.ready, false);
  assert.match(result.reason, /declared bin entry/i);
});

test('requires npm lockfile version 3', async () => {
  const { cwd } = await makeFixture();
  const lockPath = path.join(cwd, 'package-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  lock.lockfileVersion = 2;
  await writeFile(lockPath, JSON.stringify(lock));
  const result = await checkDependencyGroup({ cwd });
  assert.equal(result.ready, false);
  assert.match(result.reason, /lockfileVersion 3/i);
});
