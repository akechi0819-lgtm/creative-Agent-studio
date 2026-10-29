import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { assertNativeTarget, isReleasePathAllowed, writeBundleManifest } from '../src/launcher/distribution.mjs';
import { checkDependencyGroup } from '../src/launcher/dependencies.mjs';
import { createSkillArchive } from '../src/launcher/skill-archive.mjs';
import { validateCompanyDefaults } from '../src/lite/config.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Company Lite allowlist includes the WorkBuddy runtime and excludes removed product surfaces', () => {
  for (const file of [
    'AGENTS.md', 'README.md', 'Creative_Agent_Studio_PRD.md', '开发与施工计划.md', 'Start.cmd', 'Studio.cmd',
    '.agents/skills/creative-studio/SKILL.md',
    '.agents/skills/creative-studio/references/workbuddy-entry.md',
    'docs/README.md', 'docs/代理宿主使用.md', 'scripts/setup.mjs', 'scripts/studio.mjs',
    'scripts/canvas-supervisor.mjs', 'scripts/canvas-mcp.mjs',
    'src/canvas/runtime.mjs', 'src/lite/setup.mjs',
    'third_party/canvas/canvas-agent/dist/index.js', 'third_party/canvas/web/dist/index.html',
    'licenses/xhs-ad-workbench-MIT.txt',
  ]) assert.equal(isReleasePathAllowed(file), true, file);

  for (const file of [
    'adapters/dsh/index.mjs', 'web/dist/index.html', 'src/web/server.mjs',
    'src/creative/tasks.mjs', 'scripts/ocr_materials.py', 'scripts/launcher.mjs', 'config/studio.json',
    'release/macos-launcher.applescript',
    'tasks/task-1/task.json', 'node_modules/fflate/index.js',
    '.studio-runtime/node/node.exe', 'company-defaults.json',
  ]) assert.equal(isReleasePathAllowed(file), false, file);
});

test('release target selection rejects cross-platform builds', () => {
  assert.throws(() => assertNativeTarget('darwin-arm64', { platform: 'win32', arch: 'x64' }), /禁止跨平台打包/);
  assert.throws(() => assertNativeTarget('win32-x64', { platform: 'darwin', arch: 'arm64' }), /禁止跨平台打包/);
});

test('locked MCP SDK production dependency resolves through its public server entry', async () => {
  const result = await checkDependencyGroup({ cwd: projectRoot, nodePath: process.execPath });
  assert.equal(result.ready, true, result.reason);
});

test('release manifest hashes package files and excludes Python startup metadata', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-lite-manifest-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/setup.mjs'), 'export {}\n');
  await fs.writeFile(path.join(root, 'company-defaults.json'), JSON.stringify({ image: { model: 'test' } }));

  const manifest = await writeBundleManifest(root, 'darwin-arm64', 'test.1');
  assert.equal(manifest.product, 'Creative Agent Studio Company Lite');
  assert.equal(manifest.nodeVersion, '22.23.3');
  assert.equal(Object.hasOwn(manifest, 'pythonRuntime'), false);
  assert.equal(manifest.files.length, 2);
  const setupRecord = manifest.files.find(file => file.path === 'src/setup.mjs');
  assert.equal(setupRecord.sha256, createHash('sha256').update('export {}\n').digest('hex'));
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'release-manifest.json'), 'utf8')).target, 'darwin-arm64');
});

test('release manifest refuses private user-data directories', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-lite-private-package-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  await fs.writeFile(path.join(root, 'config', 'studio.json'), '{"apiKey":"must-not-package"}');
  await assert.rejects(writeBundleManifest(root, 'win32-x64', 'test.1'), /不允许进入 Release/);
  await assert.rejects(fs.access(path.join(root, 'release-manifest.json')));
});

test('Company defaults accept only non-secret image and materials endpoints', () => {
  const valid = {
    image: { baseUrl: 'https://image.example.test/v1', model: 'company-image' },
    materials: { mcpUrl: 'https://materials.example.test/mcp', loginUrl: 'https://sso.example.test/login' },
  };
  assert.deepEqual(validateCompanyDefaults(valid), valid);
  assert.throws(() => validateCompanyDefaults({ ...valid, apiKey: 'secret' }), { code: 'ERR_COMPANY_DEFAULTS_INVALID' });
  assert.throws(() => validateCompanyDefaults({ image: { ...valid.image, apiKey: 'secret' }, materials: valid.materials }), { code: 'ERR_COMPANY_DEFAULTS_INVALID' });
  assert.throws(() => validateCompanyDefaults({ image: { ...valid.image, baseUrl: 'https://user:pass@example.test' }, materials: valid.materials }), { code: 'ERR_COMPANY_DEFAULTS_INVALID' });
  assert.throws(() => validateCompanyDefaults({ image: { ...valid.image, baseUrl: 'https://example.test/?token=secret' }, materials: valid.materials }), { code: 'ERR_COMPANY_DEFAULTS_INVALID' });
});

test('optional WorkBuddy Skill ZIP contains verified instructions and no runtime', async () => {
  const { archive, files } = await createSkillArchive(projectRoot);
  const extracted = unzipSync(archive);
  assert.deepEqual(files, [
    'creative-studio/SKILL.md',
    'creative-studio/references/workbuddy-entry.md',
  ]);
  assert.match(Buffer.from(extracted['creative-studio/SKILL.md']).toString('utf8'), /WorkBuddy/);
  assert.match(Buffer.from(extracted['creative-studio/references/workbuddy-entry.md']).toString('utf8'), /工作目录/);
  assert.equal(Object.keys(extracted).some(name => /(?:node_modules|node\.exe|\.app)/i.test(name)), false);
});

test('thin launcher wrappers use bundled Node, preserve arguments, and default to status', async () => {
  const [startCmd, studioCmd, startCommand, studioCommand, packageScript, setupScript] = await Promise.all([
    'Start.cmd', 'Studio.cmd', 'Start.command', 'Studio.command', 'scripts/package-release.mjs', 'scripts/setup.mjs',
  ].map(relative => fs.readFile(path.join(projectRoot, relative), 'utf8')));
  assert.match(startCmd, /node-v22\.23\.3-win-x64\\node\.exe/);
  assert.match(startCmd, /scripts\\setup\.mjs" %\*/);
  assert.match(startCmd, /%\*/);
  assert.match(studioCmd, /node-v22\.23\.3-win-x64\\node\.exe/);
  assert.match(studioCmd, /%\*/);
  assert.doesNotMatch(startCmd, /where node|bootstrap-node|PATH=/i);
  assert.doesNotMatch(studioCmd, /where node|bootstrap-node|PATH=/i);
  assert.doesNotMatch(startCmd, /ExecutionPolicy\s+Bypass/i);
  assert.match(startCommand, /node-v22\.23\.3-darwin-arm64\/bin\/node/);
  assert.match(startCommand, /scripts\/setup\.mjs/);
  assert.match(startCommand, /"\$@"/);
  assert.match(studioCommand, /node-v22\.23\.3-darwin-arm64\/bin\/node/);
  assert.match(studioCommand, /"\$@"/);
  assert.doesNotMatch(startCommand, /command -v node|bootstrap-node|open /);
  assert.doesNotMatch(studioCommand, /command -v node|bootstrap-node/);
  assert.match(setupScript, /\[command = 'status'/);
  assert.doesNotMatch(packageScript, /macos-bundle|macos-launcher|assembleMacApp|sealMacAppBundle/i);
});

test('macOS package wrappers preserve paths and WorkBuddy arguments with spaces', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company lite 工作目录-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const physicalRoot = await fs.realpath(root);
  const nodePath = path.join(root, '.studio-runtime/node/node-v22.23.3-darwin-arm64/bin/node');
  await fs.mkdir(path.dirname(nodePath), { recursive: true });
  await fs.writeFile(nodePath, '#!/bin/sh\nprintf "%s\\0" "$@" > "$CAPTURE"\n', { mode: 0o755 });
  const capture = path.join(root, 'captured args.bin');
  const env = { ...process.env, CAPTURE: capture };

  for (const [wrapper, entry, args] of [
    ['Start.command', 'setup.mjs', ['report-workbuddy', 'connected', '只读 MCP 工具 1']],
    ['Studio.command', 'studio.mjs', ['mcp-config']],
  ]) {
    const destination = path.join(root, wrapper);
    await fs.copyFile(path.join(projectRoot, wrapper), destination);
    await fs.chmod(destination, 0o755);
    execFileSync(destination, args, { env, windowsHide: true });
    const forwarded = (await fs.readFile(capture, 'utf8')).split('\0').filter(Boolean);
    assert.deepEqual(forwarded, [path.join(physicalRoot, 'scripts', entry), ...args]);
  }
});
