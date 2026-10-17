import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assembleMacApp, moveMacPayloadIntoBundle, resolveRuntimeRoot, sealMacAppBundle,
  verifyMacAppBundle, verifyMacAppSeal,
} from '../src/launcher/macos-bundle.mjs';
import { writeBundleManifest } from '../src/launcher/distribution.mjs';

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), 'cas-company-macos-test-'));
}

test('Company app keeps its own payload through mocked AppTranslocation and Windows stays flat', async t => {
  const fixture = await temporaryDirectory();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const stage = path.join(fixture, 'stage');
  const companyBundle = path.join(stage, 'Creative Agent Studio Company.app');
  const nodeDirectory = 'node-v22.23.3-darwin-arm64';
  const nodePath = path.join(stage, `.studio-runtime/node/${nodeDirectory}/bin/node`);
  await mkdir(path.join(companyBundle, 'Contents/Resources/Scripts'), { recursive: true });
  await mkdir(path.join(stage, 'Creative Agent Studio.app/Contents'), { recursive: true });
  await writeFile(path.join(stage, 'Creative Agent Studio.app/Contents/stale'), 'personal bundle');
  await writeFile(path.join(companyBundle, 'Contents/Info.plist'), 'fixture');
  await writeFile(path.join(companyBundle, 'Contents/Resources/Scripts/main.scpt'), 'fixture');
  await mkdir(path.dirname(nodePath), { recursive: true });
  await writeFile(nodePath, 'company node');
  await mkdir(path.join(stage, 'release'), { recursive: true });
  await writeFile(path.join(stage, 'release/launcher.mjs'), 'company launcher');
  await writeFile(path.join(stage, 'release-manifest.json'), 'stale flat manifest');
  await mkdir(path.join(stage, '.hidden'), { recursive: true });
  await writeFile(path.join(stage, '.hidden/payload'), 'company hidden payload');

  const companyProfile = { profile: 'company' };
  const stagedRuntimeRoot = await moveMacPayloadIntoBundle(stage, undefined, companyProfile);
  assert.equal(stagedRuntimeRoot, resolveRuntimeRoot(stage, 'darwin-arm64', companyProfile));
  assert.equal(resolveRuntimeRoot(stage, 'darwin-arm64'), path.join(stage, 'Creative Agent Studio.app/Contents/Resources/studio'));
  assert.deepEqual(await readdir(stage), ['Creative Agent Studio Company.app']);
  await assert.rejects(readFile(path.join(stagedRuntimeRoot, 'Creative Agent Studio.app/Contents/stale')));
  await assert.rejects(readFile(path.join(stage, 'release-manifest.json')));
  const manifest = await writeBundleManifest(stagedRuntimeRoot, 'darwin-arm64', 'company-fixture', companyProfile);
  assert.equal(manifest.profile, 'company');
  assert.equal(manifest.product, 'Creative Agent Studio Company');

  const translocationRoot = path.join(fixture, 'AppTranslocation', 'A1B2C3', 'd');
  await mkdir(translocationRoot, { recursive: true });
  await rename(companyBundle, path.join(translocationRoot, 'Creative Agent Studio Company.app'));
  const relocatedRoot = resolveRuntimeRoot(translocationRoot, 'darwin-arm64', companyProfile);
  assert.equal(await readFile(path.join(relocatedRoot, `.studio-runtime/node/${nodeDirectory}/bin/node`), 'utf8'), 'company node');
  assert.equal(await readFile(path.join(relocatedRoot, 'release/launcher.mjs'), 'utf8'), 'company launcher');
  assert.equal(await readFile(path.join(relocatedRoot, '.hidden/payload'), 'utf8'), 'company hidden payload');
  const relocatedManifest = JSON.parse(await readFile(path.join(relocatedRoot, 'release-manifest.json'), 'utf8'));
  assert.equal(relocatedManifest.product, 'Creative Agent Studio Company');

  const windowsStage = path.join(fixture, 'windows-stage');
  await mkdir(windowsStage, { recursive: true });
  assert.equal(resolveRuntimeRoot(windowsStage, 'win32-x64', companyProfile), windowsStage);
});

test('Company macOS launcher compiles with the private runtime path, company identity, and valid seal', async t => {
  if (process.platform !== 'darwin') return t.skip('osacompile and codesign are available only on macOS runners.');
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'cas-company-macos-compile-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const source = await readFile(new URL('../release/macos-launcher.applescript', import.meta.url), 'utf8');
  const nodeDirectory = `node-v22.23.3-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  const stage = path.join(fixture, 'stage');
  const sourcePath = path.join(stage, 'release/macos-launcher.applescript');
  const nodeRelative = `.studio-runtime/node/${nodeDirectory}/bin/node`;
  const nodePath = path.join(stage, nodeRelative);
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, source);
  await mkdir(path.dirname(nodePath), { recursive: true });
  await writeFile(nodePath, 'fixture company node');
  await writeFile(path.join(stage, 'release/launcher.mjs'), 'fixture company launcher');

  const companyProfile = { profile: 'company' };
  const runtimeRoot = await assembleMacApp(stage, { platform: 'darwin', nodeRelative }, companyProfile);
  assert.equal(runtimeRoot, resolveRuntimeRoot(stage, 'darwin-arm64', companyProfile));
  assert.deepEqual(await readdir(stage), ['Creative Agent Studio Company.app']);
  const appPath = path.join(stage, 'Creative Agent Studio Company.app');
  const compiledSource = await verifyMacAppBundle(appPath, { platform: 'darwin', nodeRelative }, companyProfile);
  const bundleIdentifier = execFileSync('/usr/libexec/PlistBuddy', [
    '-c', 'Print :CFBundleIdentifier', path.join(appPath, 'Contents/Info.plist'),
  ], { encoding: 'utf8' }).trim();
  assert.equal(bundleIdentifier, 'com.creativeagentstudio.company');
  assert.match(compiledSource, /Creative Agent Studio Company/);
  assert.ok(compiledSource.includes(nodeDirectory));
  assert.ok(compiledSource.includes('/Contents/Resources/studio'));
  assert.ok(compiledSource.includes('/release/launcher.mjs'));
  assert.equal(await readFile(path.join(runtimeRoot, nodeRelative), 'utf8'), 'fixture company node');
  assert.equal(await readFile(path.join(runtimeRoot, 'release/launcher.mjs'), 'utf8'), 'fixture company launcher');
  sealMacAppBundle(appPath);
  verifyMacAppSeal(appPath);
});
