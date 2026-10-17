import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  RELEASE_TARGETS, assertCleanStatus, assertNativeTarget, copyAllowlistedFiles, overlayAllowlistedFiles,
  hashFile, isReleasePathAllowed, materializeBundleSymlinks, normalizeTargetId,
  writeBundleManifest,
} from '../src/launcher/distribution.mjs';

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

test('Company release workflow reuses pinned P5 artifacts and uploads private build artifacts without publishing a Release', async () => {
  const workflow = await readFile(new URL('../.github/workflows/company-release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /actions\/download-artifact@v4/);
  assert.match(workflow, /run-id: 39001846741/);
  assert.match(workflow, /release-\$\{\{ matrix\.target \}\}/);
  assert.match(workflow, /--profile company/);
  assert.match(workflow, /STUDIO_COMPANY_SERVICES_JSON/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(workflow, /gh release create|contents: write/);
});

test('source allowlist includes runtime helpers and excludes user/company/development paths', () => {
  assert.equal(isReleasePathAllowed('src/workspace/python-helper.py'), true);
  assert.equal(isReleasePathAllowed('scripts/requirements-workspace.lock.txt'), true);
  assert.equal(isReleasePathAllowed('release/prepare-python.mjs'), true);
  assert.equal(isReleasePathAllowed('src/creative/tasks.mjs'), true);
  assert.equal(isReleasePathAllowed('src/company/connector.mjs'), false);
  assert.equal(isReleasePathAllowed('src/company/config.mjs', { profile: 'company' }), true);
  assert.equal(isReleasePathAllowed('src/company/evidence/secret.json', { profile: 'company' }), false);
  assert.equal(isReleasePathAllowed('scripts/company-bridge.mjs', { profile: 'company' }), false);
  assert.equal(isReleasePathAllowed('licenses/xhs-ad-workbench-MIT.txt', { profile: 'company' }), true);
  assert.equal(isReleasePathAllowed('web/dist/assets/app.js', { profile: 'company' }), true);
  assert.equal(isReleasePathAllowed('company-services.json', { profile: 'company' }), false);
  assert.equal(isReleasePathAllowed('company/private.json', { profile: 'company' }), false);
  assert.equal(isReleasePathAllowed('node_modules/pkg/index.js'), false);
  assert.equal(isReleasePathAllowed('.studio-runtime/private.json'), false);
  assert.equal(isReleasePathAllowed('docs/evidence/private.json'), false);
  assert.equal(isReleasePathAllowed('../secrets.txt'), false);
});

test('Company profile overlays only its allowlist into a verified existing bundle', async t => {
  const fixture = await temporaryDirectory();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const source = path.join(fixture, 'source');
  const destination = path.join(fixture, 'bundle');
  await mkdir(path.join(source, 'src/company'), { recursive: true });
  await mkdir(path.join(source, 'web/dist/assets'), { recursive: true });
  await mkdir(path.join(source, 'company'), { recursive: true });
  await mkdir(path.join(destination, 'src/company'), { recursive: true });
  await mkdir(path.join(destination, 'web/dist/assets'), { recursive: true });
  await writeFile(path.join(source, 'src/company/config.mjs'), 'export const company = true;');
  await writeFile(path.join(source, 'web/dist/assets/app.js'), 'company UI');
  await writeFile(path.join(source, 'company/private.json'), '{"secret":true}');
  await writeFile(path.join(destination, 'src/company/config.mjs'), 'old source');
  await writeFile(path.join(destination, 'web/dist/index.html'), '<!doctype html>');
  const selected = await overlayAllowlistedFiles(source, destination, [
    'src/company/config.mjs', 'web/dist/assets/app.js', 'company/private.json',
  ], { profile: 'company' });
  assert.deepEqual(selected, ['src/company/config.mjs', 'web/dist/assets/app.js']);
  assert.equal(await readFile(path.join(destination, 'src/company/config.mjs'), 'utf8'), 'export const company = true;');
  assert.equal(await readFile(path.join(destination, 'web/dist/assets/app.js'), 'utf8'), 'company UI');
  await assert.rejects(readFile(path.join(destination, 'company/private.json')));
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

test('Company manifest identifies its product and still blocks company user data', async t => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src/company'), { recursive: true });
  await writeFile(path.join(root, 'src/company/risk-lexicon.json'), '{"terms":[]}');
  await writeFile(path.join(root, 'company-services.json'), '{"schemaVersion":1}');
  const manifest = await writeBundleManifest(root, 'darwin-arm64', 'company-test', { profile: 'company' });
  assert.equal(manifest.profile, 'company');
  assert.equal(manifest.product, 'Creative Agent Studio Company');
  assert.ok(manifest.files.some(file => file.path === 'company-services.json'));
  await rm(path.join(root, 'release-manifest.json'));
  await mkdir(path.join(root, 'src/company/user-data'), { recursive: true });
  await writeFile(path.join(root, 'src/company/user-data/secret.json'), '{}');
  await assert.rejects(writeBundleManifest(root, 'darwin-arm64', 'company-test', { profile: 'company' }), /不允许进入 Release/);
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

test('compiled macOS launcher points to the native bundled Node path without opening its GUI', async t => {
  if (process.platform !== 'darwin') return t.skip('osacompile is available only on macOS runners.');
  const fixture = await temporaryDirectory();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const source = await readFile(new URL('../release/macos-launcher.applescript', import.meta.url), 'utf8');
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const nodeDirectory = `node-v22.23.3-darwin-${architecture}`;
  const resolved = source.replaceAll('__NODE_DIRECTORY__', nodeDirectory);
  assert.ok(!resolved.includes('__NODE_DIRECTORY__'));
  const sourcePath = path.join(fixture, 'launcher.applescript');
  const appPath = path.join(fixture, 'Creative Agent Studio.app');
  await writeFile(sourcePath, resolved);
  execFileSync('osacompile', ['-o', appPath, sourcePath], { stdio: 'pipe' });
  const compiledSource = execFileSync('osadecompile', [path.join(appPath, 'Contents/Resources/Scripts/main.scpt')], { encoding: 'utf8' });
  assert.ok(compiledSource.includes(nodeDirectory));
  assert.ok(compiledSource.includes('/.studio-runtime/node/'));
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

test('Company bundle has its own identity, service profile, data root and port', async () => {
  const launcher = await readFile(new URL('../release/launcher.mjs', import.meta.url), 'utf8');
  const client = await readFile(new URL('../src/canvas/client.mjs', import.meta.url), 'utf8');
  const packager = await readFile(new URL('../scripts/package-release.mjs', import.meta.url), 'utf8');
  assert.match(launcher, /profile === 'company' \? 'Creative Agent Studio Company'/);
  assert.match(launcher, /readCompanyDeployment\(\{ file \}\)/);
  assert.match(launcher, /webArgs\.push\('--port', '4311'\)/);
  assert.match(client, /Creative Agent Studio Company/);
  assert.match(client, /creative-agent-studio-company/);
  assert.match(packager, /COMPANY_BASE_PACKAGE/);
  assert.match(packager, /writeCompanyServicesFile/);
  assert.match(packager, /companyRiskLexicon/);
  assert.match(packager, /relocatedRuntimeSmoke\(runtimeRoot, target, \{ profile: 'company' \}\)/);
  assert.match(packager, /Company 运行包未按要求绑定本机 4311 端口/);
  assert.doesNotMatch(packager, /https:\/\/teedy\.apinova\.cn|https:\/\/image\.apinova\.cn/);
});

test('archive Office smoke keeps shared conversion and surfaces native error diagnostics on failure', async () => {
  const source = await readFile(new URL('../scripts/package-release.mjs', import.meta.url), 'utf8');
  assert.match(source, /convertWorkspaceDocument\(\{ workspaceRoot/);
  assert.match(source, /Native LibreOfficeKit diagnostic:/);
  assert.match(source, /diagnosticConverter\.convert\(\{ inputPath, outputPath: diagnosticOutputPath \}\)/);
  assert.match(source, /const \{ ensureLibreOfficeKitWindowsPathFix \} = await import\(pathToFileURL\(path\.join\(stage, 'src\/launcher\/prepare\.mjs'\)\)\.href\);\s+await ensureLibreOfficeKitWindowsPathFix\(stage\)/);
});
