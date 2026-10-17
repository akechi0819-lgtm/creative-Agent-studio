import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  RELEASE_TARGETS, assertCleanStatus, assertNativeTarget, copyAllowlistedFiles,
  hashFile, isReleasePathAllowed, materializeBundleSymlinks, normalizeTargetId,
  writeBundleManifest,
} from '../src/launcher/distribution.mjs';
import {
  assembleMacApp, moveMacPayloadIntoBundle, resolveRuntimeRoot, sealMacAppBundle,
  verifyMacAppBundle, verifyMacAppSeal,
} from '../src/launcher/macos-bundle.mjs';

async function temporaryDirectory() { return mkdtemp(path.join(os.tmpdir(), 'cas-distribution-test-')); }

test('release targets are fixed and reject cross-platform builds', () => {
  assert.deepEqual(Object.keys(RELEASE_TARGETS).sort(), ['darwin-arm64', 'win32-x64']);
  assert.equal(assertNativeTarget('darwin-arm64', { platform: 'darwin', arch: 'arm64' }).runner, 'macos-15');
  assert.throws(() => assertNativeTarget('win32-x64', { platform: 'darwin', arch: 'arm64' }), /禁止跨平台打包/);
  assert.throws(() => normalizeTargetId('linux-x64'), /不支持的 Release 平台/);
  assert.throws(() => normalizeTargetId('darwin-x64'), /不支持的 Release 平台/);
});

test('release workflow builds only Apple silicon macOS and Windows x64 and expects two archives', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /target: darwin-arm64\s+runner: macos-15/);
  assert.match(workflow, /target: win32-x64\s+runner: windows-2025/);
  assert.match(workflow, /len\(archives\) != 2/);
  assert.doesNotMatch(workflow, /darwin-x64|macos-15-intel/);
});

test('source allowlist includes runtime helpers and excludes user/company/development paths', () => {
  assert.equal(isReleasePathAllowed('src/workspace/python-helper.py'), true);
  assert.equal(isReleasePathAllowed('scripts/requirements-workspace.lock.txt'), true);
  assert.equal(isReleasePathAllowed('release/prepare-python.mjs'), true);
  assert.equal(isReleasePathAllowed('src/creative/tasks.mjs'), true);
  assert.equal(isReleasePathAllowed('src/company/connector.mjs'), false);
  assert.equal(isReleasePathAllowed('node_modules/pkg/index.js'), false);
  assert.equal(isReleasePathAllowed('.studio-runtime/private.json'), false);
  assert.equal(isReleasePathAllowed('docs/evidence/private.json'), false);
  assert.equal(isReleasePathAllowed('../secrets.txt'), false);
});

test('dirty source status blocks all package creation', () => {
  assert.doesNotThrow(() => assertCleanStatus(''));
  assert.throws(() => assertCleanStatus('?? node_modules\n M package.json'), /拒绝从脏工作树打包/);
});

test('allowlisted staging copies tracked files only and never follows the development node_modules link', async t => {
  const fixture = await temporaryDirectory();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const source = path.join(fixture, 'source');
  const destination = path.join(fixture, 'stage');
  const devModules = path.join(fixture, 'development-node-modules');
  await mkdir(source, { recursive: true });
  await mkdir(path.join(source, 'src/creative'), { recursive: true });
  await mkdir(path.join(source, 'src/workspace'), { recursive: true });
  await mkdir(path.join(source, 'scripts'), { recursive: true });
  await mkdir(devModules, { recursive: true });
  await writeFile(path.join(devModules, 'secret.json'), 'personal');
  await symlink(devModules, path.join(source, 'node_modules'), 'dir');
  for (const file of ['package.json', 'package-lock.json', 'scripts/web.mjs', 'release/launcher.mjs']) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), 'safe');
  }
  await writeFile(path.join(source, 'src/creative/tasks.mjs'), 'export const source = true;');
  await writeFile(path.join(source, 'src/workspace/python-helper.py'), '# helper');
  const copied = await copyAllowlistedFiles(source, destination, [
    'package.json', 'package-lock.json', 'scripts/web.mjs', 'release/launcher.mjs',
    'src/creative/tasks.mjs', 'src/workspace/python-helper.py', 'node_modules/secret.json',
  ]);
  assert.ok(copied.includes('src/workspace/python-helper.py'));
  assert.equal(copied.some(file => file.startsWith('node_modules/')), false);
  await assert.rejects(lstat(path.join(destination, 'node_modules')));
  await assert.rejects(readFile(path.join(destination, 'node_modules/secret.json')));
});

test('allowlisted source symlinks are rejected instead of copying their target', async t => {
  const fixture = await temporaryDirectory();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const source = path.join(fixture, 'source');
  const destination = path.join(fixture, 'stage');
  const secret = path.join(fixture, 'private-secret');
  await mkdir(path.join(source, 'src/assets'), { recursive: true });
  await mkdir(path.join(source, 'scripts'), { recursive: true });
  await writeFile(secret, 'should not leak');
  await symlink(secret, path.join(source, 'src/assets/cleaner.mjs'));
  for (const file of ['package.json', 'package-lock.json', 'scripts/web.mjs', 'release/launcher.mjs']) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), 'safe');
  }
  await assert.rejects(copyAllowlistedFiles(source, destination, [
    'package.json', 'package-lock.json', 'scripts/web.mjs', 'release/launcher.mjs', 'src/assets/cleaner.mjs',
  ]), /必须是普通文件/);
});

test('bundle links are materialized as in-tree copies and outside links fail closed', async t => {
  const fixture = await temporaryDirectory();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, 'bundle');
  const privateTarget = path.join(root, 'runtime/node');
  await mkdir(privateTarget, { recursive: true });
  await writeFile(path.join(privateTarget, 'node.exe'), 'runtime');
  await symlink(privateTarget, path.join(root, 'runtime/node-link'), 'dir');
  await materializeBundleSymlinks(root);
  assert.equal(await readFile(path.join(root, 'runtime/node-link/node.exe'), 'utf8'), 'runtime');
  assert.equal((await lstat(path.join(root, 'runtime/node-link'))).isSymbolicLink(), false);
  await writeBundleManifest(root, 'win32-x64', 'test.1');
  assert.equal((await readFile(path.join(root, 'release-manifest.json'), 'utf8')).includes('runtime/node-link/node.exe'), true);

  const outside = path.join(fixture, 'outside-secret');
  await writeFile(outside, 'private');
  await symlink(outside, path.join(root, 'runtime/external-link'));
  await assert.rejects(materializeBundleSymlinks(root), /指向 staging 外部/);
});

test('manifest hashes individual packaged files', async t => {
  const fixture = await temporaryDirectory();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await writeFile(path.join(fixture, 'app.bin'), 'release bytes');
  const manifest = await writeBundleManifest(fixture, 'darwin-arm64', 'v1.2.3');
  assert.equal(manifest.files[0].sha256, await hashFile(path.join(fixture, 'app.bin')));
  assert.equal(manifest.target, 'darwin-arm64');
  assert.deepEqual(manifest.pythonRuntime, {
    version: '3.12.15', bundled: false, preparedOnFirstStart: true,
    lockFiles: ['scripts/requirements-cleaner-ocr.lock.txt', 'scripts/requirements-workspace.lock.txt'],
  });
});

test('manifest refuses user-data Python environments and downloaded OCR model caches', async t => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of ['.venv-ocr/python', '.studio-runtime/python/python3.12', '.studio-runtime/rapidocr-models/model.onnx']) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'must not ship');
    await assert.rejects(writeBundleManifest(root, 'darwin-arm64', 'v1'), /不允许进入 Release/);
    await rm(path.dirname(file), { recursive: true, force: true });
    if (relative.startsWith('.studio-runtime/')) await rm(path.join(root, '.studio-runtime'), { recursive: true, force: true });
  }
});

test('manifest accepts locked SDK session code while still rejecting user session data', async t => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdkFile = 'adapters/dsh/node_modules/@anthropic-ai/sdk/lib/sessions/accumulate.d.mts';
  const userSession = 'web/dsh/sessions/current.json';
  await mkdir(path.dirname(path.join(root, sdkFile)), { recursive: true });
  await writeFile(path.join(root, sdkFile), 'export interface Accumulate {}\n');
  await mkdir(path.dirname(path.join(root, userSession)), { recursive: true });
  await writeFile(path.join(root, userSession), '{"messages":[]}\n');

  await assert.rejects(writeBundleManifest(root, 'darwin-arm64', 'v1'), /不允许进入 Release 的路径：web\/dsh\/sessions\/current\.json/);
  await rm(path.join(root, 'web/dsh'), { recursive: true, force: true });
  const manifest = await writeBundleManifest(root, 'darwin-arm64', 'v1');
  assert.ok(manifest.files.some(file => file.path === sdkFile));
});

test('self-contained macOS app keeps its payload after mock AppTranslocation and Windows stays flat', async t => {
  const fixture = await temporaryDirectory();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const stage = path.join(fixture, 'stage');
  const bundle = path.join(stage, 'Creative Agent Studio.app');
  const shell = path.join(bundle, 'Contents/Resources/Scripts');
  const nodeDirectory = 'node-v22.23.3-darwin-arm64';
  const nodePath = path.join(stage, `.studio-runtime/node/${nodeDirectory}/bin/node`);
  await mkdir(shell, { recursive: true });
  await writeFile(path.join(bundle, 'Contents/Info.plist'), 'fixture');
  await writeFile(path.join(shell, 'main.scpt'), 'fixture');
  await mkdir(path.dirname(nodePath), { recursive: true });
  await writeFile(nodePath, 'node');
  await mkdir(path.join(stage, 'release'), { recursive: true });
  await writeFile(path.join(stage, 'release/launcher.mjs'), 'launcher');
  await writeFile(path.join(stage, 'release-manifest.json'), 'stale flat manifest');
  await mkdir(path.join(stage, '.hidden'), { recursive: true });
  await writeFile(path.join(stage, '.hidden/payload'), 'hidden payload');

  const stagedRuntimeRoot = await moveMacPayloadIntoBundle(stage, bundle);
  assert.equal(stagedRuntimeRoot, resolveRuntimeRoot(stage, 'darwin-arm64'));
  assert.deepEqual(await readdir(stage), ['Creative Agent Studio.app']);
  await assert.rejects(readFile(path.join(stage, 'release-manifest.json')));
  await writeBundleManifest(stagedRuntimeRoot, 'darwin-arm64', 'fixture');

  const translocationRoot = path.join(fixture, 'AppTranslocation', 'A1B2C3', 'd');
  await mkdir(translocationRoot, { recursive: true });
  await rename(bundle, path.join(translocationRoot, 'Creative Agent Studio.app'));
  const relocatedRoot = resolveRuntimeRoot(translocationRoot, 'darwin-arm64');
  assert.equal(await readFile(path.join(relocatedRoot, `.studio-runtime/node/${nodeDirectory}/bin/node`), 'utf8'), 'node');
  assert.equal(await readFile(path.join(relocatedRoot, 'release/launcher.mjs'), 'utf8'), 'launcher');
  assert.equal(await readFile(path.join(relocatedRoot, '.hidden/payload'), 'utf8'), 'hidden payload');
  assert.ok(JSON.parse(await readFile(path.join(relocatedRoot, 'release-manifest.json'), 'utf8')).files.length > 0);

  const windowsStage = path.join(fixture, 'windows-stage');
  await mkdir(windowsStage, { recursive: true });
  assert.equal(resolveRuntimeRoot(windowsStage, 'win32-x64'), windowsStage);
});

test('compiled macOS launcher points to the native bundled Node path without opening its GUI', async t => {
  if (process.platform !== 'darwin') return t.skip('osacompile is available only on macOS runners.');
  const fixture = await temporaryDirectory();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const source = await readFile(new URL('../release/macos-launcher.applescript', import.meta.url), 'utf8');
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const nodeDirectory = `node-v22.23.3-darwin-${architecture}`;
  assert.match(source, /set packageRoot to bundlePath & "\/Contents\/Resources\/studio"/);
  assert.doesNotMatch(source, /set packageRoot to do shell script .*dirname/);
  assert.ok(source.includes('__NODE_DIRECTORY__'));
  const stage = path.join(fixture, 'stage');
  const sourcePath = path.join(stage, 'release/macos-launcher.applescript');
  const nodeRelative = `.studio-runtime/node/${nodeDirectory}/bin/node`;
  const nodePath = path.join(stage, nodeRelative);
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, source);
  await mkdir(path.dirname(nodePath), { recursive: true });
  await writeFile(nodePath, 'fixture node');
  await writeFile(path.join(stage, 'release/launcher.mjs'), 'fixture launcher');
  const runtimeRoot = await assembleMacApp(stage, { platform: 'darwin', nodeRelative });
  assert.equal(runtimeRoot, resolveRuntimeRoot(stage, 'darwin-arm64'));
  assert.deepEqual(await readdir(stage), ['Creative Agent Studio.app']);
  const appPath = path.join(stage, 'Creative Agent Studio.app');
  const compiledSource = await verifyMacAppBundle(appPath, {
    platform: 'darwin', nodeRelative,
  });
  sealMacAppBundle(appPath);
  verifyMacAppSeal(appPath);
  assert.ok(compiledSource.includes(nodeDirectory));
  assert.ok(compiledSource.includes('/Contents/Resources/studio'));
  assert.ok(compiledSource.includes('/release/launcher.mjs'));
  assert.equal(await readFile(path.join(runtimeRoot, nodeRelative), 'utf8'), 'fixture node');
  assert.equal(await readFile(path.join(runtimeRoot, 'release/launcher.mjs'), 'utf8'), 'fixture launcher');
});

test('Windows archive writer includes hidden app files, checks the first-start runtime contract, and excludes Python assets', async () => {
  const source = await readFile(new URL('../scripts/package-release.mjs', import.meta.url), 'utf8');
  assert.match(source, /Get-ChildItem -LiteralPath \$source -Force -File -Recurse/);
  assert.match(source, /ZipFileExtensions\]::CreateEntryFromFile/);
  assert.match(source, /foreach \(\$file in \$manifest\.files\)/);
  assert.match(source, /\.studio-runtime\/node\/node-v22\.23\.3-win-x64\/node\.exe/);
  assert.match(source, /third_party\/canvas\/web\/dist\/index\.html/);
  assert.match(source, /release\/prepare-python\.mjs/);
  assert.match(source, /verifyArchiveAfterExtraction\(archivePath/);
  assert.match(source, /await assembleMacApp\(stage, target\)/);
  assert.match(source, /resolveRuntimeRoot\(stage, target\)/);
  assert.match(source, /info\.size !== file\.size/);
  assert.match(source, /await hashFile\(filePath\) !== file\.sha256/);
  assert.match(source, /sealMacAppBundle\(path\.join\(stage, 'Creative Agent Studio\.app'\)\)/);
  assert.match(source, /\.studio-runtime\/python\//);
  assert.match(source, /\.studio-runtime\/rapidocr-models\//);
  assert.doesNotMatch(source, /\.venv-ocr\/Scripts\/python\.exe/);
  assert.doesNotMatch(source, /Compress-Archive/);
});

test('release launcher prepares Python outside the bundle and passes both private paths to the web process', async () => {
  const launcher = await readFile(new URL('../release/launcher.mjs', import.meta.url), 'utf8');
  const prepare = await readFile(new URL('../release/prepare-python.mjs', import.meta.url), 'utf8');
  assert.match(launcher, /release\/prepare-python\.mjs/);
  assert.match(launcher, /STUDIO_OCR_PYTHON: pythonRuntime\.pythonPath/);
  assert.match(launcher, /STUDIO_RAPIDOCR_MODEL_DIR: pythonRuntime\.modelRoot/);
  assert.match(launcher, /python-prepare\.log/);
  assert.doesNotMatch(launcher, /path\.join\(bundleRoot, '\.venv-ocr'/);
  assert.match(prepare, /path\.join\(dataRoot\(\), 'runtime'\)/);
  assert.match(prepare, /acquirePrepareLock\(runtimeRoot/);
  assert.match(prepare, /preparePython\(\{ root: bundleRoot, runtimeRoot/);
});

test('archive Office smoke keeps shared conversion and surfaces native error diagnostics on failure', async () => {
  const source = await readFile(new URL('../scripts/package-release.mjs', import.meta.url), 'utf8');
  assert.match(source, /convertWorkspaceDocument\(\{ workspaceRoot/);
  assert.match(source, /Native LibreOfficeKit diagnostic:/);
  assert.match(source, /diagnosticConverter\.convert\(\{ inputPath, outputPath: diagnosticOutputPath \}\)/);
  assert.match(source, /const \{ ensureLibreOfficeKitWindowsPathFix \} = await import\(pathToFileURL\(path\.join\(stage, 'src\/launcher\/prepare\.mjs'\)\)\.href\);\s+await ensureLibreOfficeKitWindowsPathFix\(stage\)/);
});
