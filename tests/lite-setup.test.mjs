import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  getSetupStatus,
  recordCanvasMcpCheck,
  reportWorkBuddyProbe,
  saveAndVerifyImageConfig,
  verifyImageApi,
} from '../src/lite/setup.mjs';
import { saveConfig } from '../src/lite/config.mjs';

async function withTemp(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-lite-setup-'));
  try { await run(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function createPackageFixture(repoRoot, { canvas = true } = {}) {
  const files = [
    'package.json',
    'scripts/setup.mjs',
    'scripts/studio.mjs',
    'src/lite/setup.mjs',
    'src/lite/config.mjs',
    'src/canvas/runtime.mjs',
  ];
  for (const relative of files) {
    const file = path.join(repoRoot, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'fixture');
  }
  await fs.writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({ dependencies: { fflate: '0.8.3' } }));
  const studioDependency = path.join(repoRoot, 'node_modules/fflate');
  await fs.mkdir(studioDependency, { recursive: true });
  await fs.writeFile(path.join(studioDependency, 'package.json'), JSON.stringify({ name: 'fflate', main: 'index.js' }));
  await fs.writeFile(path.join(studioDependency, 'index.js'), 'module.exports = {};');
  if (!canvas) return;
  const webIndex = path.join(repoRoot, 'third_party/canvas/web/dist/index.html');
  const agentIndex = path.join(repoRoot, 'third_party/canvas/canvas-agent/dist/index.js');
  const agentPackage = path.join(repoRoot, 'third_party/canvas/canvas-agent/package.json');
  await fs.mkdir(path.dirname(webIndex), { recursive: true });
  await fs.mkdir(path.dirname(agentIndex), { recursive: true });
  await fs.writeFile(webIndex, '<!doctype html>');
  await fs.writeFile(agentIndex, 'export {};');
  await fs.writeFile(agentPackage, JSON.stringify({ dependencies: { express: '^5.0.0', zod: '^3.0.0' } }));
  for (const name of ['express', 'zod']) {
    const packageDirectory = path.join(repoRoot, 'third_party/canvas/canvas-agent/node_modules', name);
    await fs.mkdir(packageDirectory, { recursive: true });
    await fs.writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
    await fs.writeFile(path.join(packageDirectory, 'index.js'), 'module.exports = {};');
  }
}

const image = { baseUrl: 'https://images.example/v1', model: 'image-v2', apiKey: 'image-secret-never-public' };

test('clipboard key input stays local and accepts a non-secret parameter file', {skip:process.platform!=='darwin'}, async()=>{
  await withTemp(async directory=>{
    const bin=path.join(directory,'bin');await fs.mkdir(bin);
    await fs.writeFile(path.join(bin,'pbpaste'),'#!/bin/sh\nprintf fixture-clipboard-key\n',{mode:0o700});
    const payload=path.join(directory,'public-params.json');
    await fs.writeFile(payload,JSON.stringify({expectedRevision:1,image:{baseUrl:'',model:'fixture'}}),{mode:0o644});
    const root=path.join(directory,'data');
    const result=spawnSync(process.execPath,['scripts/setup.mjs','configure-image','@'+payload,'--key-from-clipboard'],{
      cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,STUDIO_DATA_DIR:root,PATH:bin+path.delimiter+process.env.PATH},encoding:'utf8',
    });
    assert.equal(result.status,1,'missing API URL is an explicit check failure, not a network request');
    assert.doesNotMatch(result.stdout+result.stderr,/fixture-clipboard-key/);
    const saved=JSON.parse(await fs.readFile(path.join(root,'config/studio.json'),'utf8'));
    assert.equal(saved.image.apiKey,'fixture-clipboard-key');
    assert.equal(JSON.parse(result.stdout).config.image.apiKeyConfigured,true);
  });
});

async function createCliDefaults(directory) {
  const file = path.join(directory, 'cli-company-defaults.json');
  await fs.writeFile(file, '{}');
  return file;
}

function runSetupCli(args, { root, defaultsFile }) {
  const script = path.resolve(import.meta.dirname, '../scripts/setup.mjs');
  return spawnSync(process.execPath, [script, ...args], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, STUDIO_DATA_DIR: root, COMPANY_LITE_DEFAULTS_FILE: defaultsFile },
    encoding: 'utf8',
  });
}

test('derives package and Canvas readiness from bundled files without requiring Python', async () => {
  await withTemp(async (directory) => {
    const repoRoot = path.join(directory, 'app');
    const dataRoot = path.join(directory, 'data');
    await createPackageFixture(repoRoot);
    const status = await getSetupStatus({ root: dataRoot, repoRoot, nodeVersion: 'v24.1.0', env: {} });
    assert.equal(status.steps.find((step) => step.id === 'package').complete, true);
    assert.equal(status.steps.find((step) => step.id === 'canvas').componentsReady, true);
    assert.equal(status.steps.find((step) => step.id === 'canvas').complete, false);
    assert.match(status.steps.find((step) => step.id === 'canvas').summary, /等待 WorkBuddy 接通/);
    assert.equal(status.steps.find((step) => step.id === 'materials').status, 'waiting');
    assert.equal(status.complete, false);
    assert.equal(status.current, 'canvas');
    assert.match(status.steps.find((step) => step.id === 'materials').summary, /等待公司提供素材库连接/);
    assert.match(status.steps.find((step) => step.id === 'materials').hostInstruction, /Start\.command/);
    assert.match(status.steps.find((step) => step.id === 'materials').hostInstruction, /Start\.cmd/);
    assert.doesNotMatch(status.steps.find((step) => step.id === 'materials').nextAction, /node scripts/);
    assert.equal(JSON.stringify(status).toLowerCase().includes('python'), false);
  });
});

test('missing Canvas dist or runtime dependency blocks the Canvas step and names the actual files', async () => {
  await withTemp(async (directory) => {
    const repoRoot = path.join(directory, 'app');
    await createPackageFixture(repoRoot, { canvas: false });
    const status = await getSetupStatus({ root: path.join(directory, 'data'), repoRoot, nodeVersion: 'v24.1.0', env: {} });
    const canvasStep = status.steps.find((step) => step.id === 'canvas');
    assert.equal(canvasStep.complete, false);
    assert.match(canvasStep.error.message, /third_party\/canvas\/web\/dist\/index.html/);
    assert.match(canvasStep.nextAction, /prepare:dev/);
  });
});

test('missing Studio dependency or invalid Canvas manifest is an explicit package failure', async () => {
  await withTemp(async (directory) => {
    const repoRoot = path.join(directory, 'app');
    await createPackageFixture(repoRoot);
    await fs.rm(path.join(repoRoot, 'node_modules/fflate'), { recursive: true, force: true });
    await fs.writeFile(path.join(repoRoot, 'third_party/canvas/canvas-agent/package.json'), '{bad json');
    const status = await getSetupStatus({ root: path.join(directory, 'data'), repoRoot, nodeVersion: 'v24.1.0', env: {} });
    const packageStep = status.steps.find((step) => step.id === 'package');
    const canvasStep = status.steps.find((step) => step.id === 'canvas');
    assert.equal(packageStep.complete, false);
    assert.match(packageStep.error.message, /fflate/);
    assert.equal(canvasStep.complete, false);
    assert.match(canvasStep.error.message, /package\.json 格式无效/);
  });
});

test('a saved image API is reused on reopen and a successful /models GET stays separate from host verification', async () => {
  await withTemp(async (directory) => {
    const repoRoot = path.join(directory, 'app');
    const root = path.join(directory, 'data');
    await createPackageFixture(repoRoot);
    let request;
    const saved = await saveAndVerifyImageConfig({ expectedRevision: 1, image }, {
      root,
      now: () => new Date('2026-10-29T10:00:00.000Z'),
      fetchImpl: async (url, options) => {
        request = { url, options };
        return { ok: true, status: 200, json: async () => ({ data: [{ id: image.model }] }) };
      },
    });
    assert.equal(request.url, 'https://images.example/v1/models');
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.headers.authorization, `Bearer ${image.apiKey}`);
    assert.equal(saved.steps.find((step) => step.id === 'image').complete, true);
    assert.equal(saved.steps.find((step) => step.id === 'materials').status, 'waiting');
    assert.equal(saved.complete, false);
    assert.equal(saved.current, 'canvas');
    assert.equal(JSON.stringify(saved).includes(image.apiKey), false);

    const reopened = await getSetupStatus({ root, repoRoot, nodeVersion: 'v24.1.0', env: {} });
    assert.equal(reopened.steps.find((step) => step.id === 'image').complete, true);
    assert.equal(reopened.config.image.apiKeyConfigured, true);
    assert.equal(JSON.stringify(reopened).includes(image.apiKey), false);
  });
});

test('reports image API HTTP failures and never completes until WorkBuddy supplies a host report', async () => {
  await withTemp(async (directory) => {
    const repoRoot = path.join(directory, 'app');
    const root = path.join(directory, 'data');
    await createPackageFixture(repoRoot);
    const failed = await saveAndVerifyImageConfig({ expectedRevision: 1, image }, {
      root,
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    });
    assert.equal(failed.steps.find((step) => step.id === 'image').complete, false);
    assert.match(failed.steps.find((step) => step.id === 'image').error.message, /HTTP 401/);
    assert.ok(failed.logs.some((entry) => entry.stage === 'image' && /HTTP 401/.test(entry.message)));
    assert.equal(failed.steps.find((step) => step.id === 'materials').status, 'waiting');
    assert.equal(failed.complete, false);

    const report = await reportWorkBuddyProbe({ status: 'connected', toolName: 'search_documents' }, { root });
    await recordCanvasMcpCheck({root});
    assert.equal(report.source, 'WorkBuddy 宿主报告');
    assert.equal(report.independentlyVerified, false);
    const status = await getSetupStatus({ root, repoRoot, nodeVersion: 'v24.1.0', env: {} });
    const materialStep = status.steps.find((step) => step.id === 'materials');
    assert.equal(materialStep.status, 'host_reported');
    assert.equal(materialStep.independentlyVerified, false);
    assert.equal(materialStep.source, 'WorkBuddy 宿主报告');
    assert.equal(status.complete, false, 'the failed image connection must keep final setup incomplete');
    assert.equal(status.current, 'image');
  });
});

test('a 200 HTML response or a model list without the configured ID does not pass /models verification', async () => {
  await withTemp(async (directory) => {
    const repoRoot = path.join(directory, 'app');
    const root = path.join(directory, 'data');
    await createPackageFixture(repoRoot);
    const html = await saveAndVerifyImageConfig({ expectedRevision: 1, image }, {
      root,
      repoRoot,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('html'); } }),
    });
    assert.equal(html.steps.find((step) => step.id === 'image').complete, false);
    assert.ok(html.logs.some((entry) => entry.stage === 'image' && /非 OpenAI 兼容/.test(entry.message)));

    const missingModel = await saveAndVerifyImageConfig({
      expectedRevision: html.config.revision,
      image: { baseUrl: image.baseUrl, model: image.model, apiKey: '' },
    }, {
      root,
      repoRoot,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'another-image-model' }] }) }),
    });
    assert.equal(missingModel.steps.find((step) => step.id === 'image').complete, false);
    assert.ok(missingModel.logs.some((entry) => entry.stage === 'image' && /未列出所配置模型/.test(entry.message)));
    assert.equal(missingModel.complete, false);
  });
});

test('final setup stays blocked until the current image revision and WorkBuddy host report both pass', async () => {
  await withTemp(async (directory) => {
    const repoRoot = path.join(directory, 'app');
    const root = path.join(directory, 'data');
    await createPackageFixture(repoRoot);
    await saveConfig({ expectedRevision: 1, image }, { root });
    await reportWorkBuddyProbe({ status: 'connected', toolName: 'list_materials' }, { root });
    const beforeImageCheck = await getSetupStatus({ root, repoRoot, nodeVersion: 'v24.1.0', env: {} });
    assert.equal(beforeImageCheck.current, 'canvas');
    assert.equal(beforeImageCheck.steps.find((step) => step.id === 'finish').complete, false);

    await verifyImageApi({
      root,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: image.model }] }) }),
    });
    const missingCanvas = await getSetupStatus({ root, repoRoot, nodeVersion: 'v24.1.0', env: {} });
    assert.equal(missingCanvas.complete, false, 'files and a materials report do not prove the Canvas MCP was connected');
    await recordCanvasMcpCheck({root});
    const finalStatus = await getSetupStatus({ root, repoRoot, nodeVersion: 'v24.1.0', env: {} });
    assert.equal(finalStatus.complete, true);
    assert.equal(finalStatus.current, 'finish');
    assert.equal(finalStatus.steps.find((step) => step.id === 'finish').status, 'complete');
    await assert.rejects(
      reportWorkBuddyProbe({ status: 'connected' }, { root }),
      (error) => error.code === 'ERR_WORKBUDDY_REPORT',
    );
  });
});

test('external defaults can prefill non-secret image fields but must stay outside the repository and cannot contain keys', async () => {
  await withTemp(async (directory) => {
    const repoRoot = path.join(directory, 'app');
    const root = path.join(directory, 'data');
    await createPackageFixture(repoRoot);
    const outsideDefaults = path.join(directory, 'company-lite-defaults.json');
    await fs.writeFile(outsideDefaults, JSON.stringify({
      image: { baseUrl: 'https://company.example/v1', model: 'img-prod' },
      materials: { mcpUrl: 'https://materials.example/mcp', loginUrl: 'https://materials.example/login' },
    }));
    const valid = await getSetupStatus({ root, repoRoot, nodeVersion: 'v24.1.0', env: { COMPANY_LITE_DEFAULTS_FILE: outsideDefaults } });
    assert.deepEqual(valid.steps.find((step) => step.id === 'image').defaults, {
      baseUrl: 'https://company.example/v1', model: 'img-prod',
    });
    assert.equal(valid.steps.find((step) => step.id === 'materials').mcpUrl, 'https://materials.example/mcp');
    assert.equal(valid.steps.find((step) => step.id === 'materials').loginUrl, 'https://materials.example/login');

    await fs.writeFile(outsideDefaults, JSON.stringify({ image: { baseUrl: 'https://company.example/v1', model: 'img-prod', apiKey: 'private' } }));
    const withKey = await getSetupStatus({ root, repoRoot, nodeVersion: 'v24.1.0', env: { COMPANY_LITE_DEFAULTS_FILE: outsideDefaults } });
    assert.match(withKey.steps.find((step) => step.id === 'image').defaultsError, /不接受 API Key/);
    assert.equal(JSON.stringify(withKey).includes('private'), false);

    const insideDefaults = path.join(repoRoot, 'defaults.json');
    await fs.writeFile(insideDefaults, JSON.stringify({ image: { baseUrl: 'https://company.example/v1', model: 'img-prod' } }));
    const inside = await getSetupStatus({ root, repoRoot, nodeVersion: 'v24.1.0', env: { COMPANY_LITE_DEFAULTS_FILE: insideDefaults } });
    assert.match(inside.steps.find((step) => step.id === 'image').defaultsError, /仓库目录之外/);
  });
});

test('default and status CLI commands return the same read-only JSON without starting a web server', async () => {
  await withTemp(async (directory) => {
    const root = path.join(directory, 'data');
    const defaultsFile = await createCliDefaults(directory);
    await saveConfig({ expectedRevision: 1, image }, { root });
    const configPath = path.join(root, 'config', 'studio.json');
    const before = await fs.readFile(configPath, 'utf8');
    const defaultCommand = runSetupCli([], { root, defaultsFile });
    const statusCommand = runSetupCli(['status'], { root, defaultsFile });
    assert.equal(defaultCommand.status, 0, defaultCommand.stderr);
    assert.equal(statusCommand.status, 0, statusCommand.stderr);
    assert.equal(defaultCommand.stdout, statusCommand.stdout);
    const status = JSON.parse(defaultCommand.stdout);
    assert.equal(Object.hasOwn(status, 'running'), false);
    assert.equal(Object.hasOwn(status, 'url'), false);
    assert.equal(typeof status.current, 'string');
    assert.equal(typeof status.actionNeeded, 'boolean');
    assert.equal(typeof status.nextAction, 'string');
    assert.equal(status.steps.length, 5);
    assert.equal(status.config.image.apiKeyConfigured, true);
    assert.equal(defaultCommand.stdout.includes(image.apiKey), false);
    assert.equal(await fs.readFile(configPath, 'utf8'), before);
    await assert.rejects(fs.lstat(path.join(root, 'setup')), (error) => error.code === 'ENOENT');
  });
});

test('WorkBuddy CLI reports return full status JSON and require a real tool name for connected', async () => {
  await withTemp(async (directory) => {
    const root = path.join(directory, 'data');
    const defaultsFile = await createCliDefaults(directory);
    const report = runSetupCli(['report-workbuddy', 'connected', 'search_materials'], { root, defaultsFile });
    assert.equal(report.status, 0, report.stderr);
    const status = JSON.parse(report.stdout);
    const materials = status.steps.find((step) => step.id === 'materials');
    assert.equal(materials.status, 'host_reported');
    assert.equal(materials.independentlyVerified, false);
    assert.match(materials.summary, /WorkBuddy 已报告连接可用/);
    assert.equal(JSON.stringify(status).includes(image.apiKey), false);

    const missingTool = runSetupCli(['report-workbuddy', 'connected'], { root, defaultsFile });
    assert.equal(missingTool.status, 1);
    assert.match(missingTool.stderr, /实际只读工具名/);
  });
});

test('configure-image reads a private file, saves before a failed check, and never echoes its key', async () => {
  await withTemp(async (directory) => {
    const root = path.join(directory, 'data');
    const defaultsFile = await createCliDefaults(directory);
    const payloadFile = path.join(directory, 'image-payload.json');
    const payloadKey = 'fixture-private-payload-key';
    await fs.writeFile(payloadFile, JSON.stringify({
      expectedRevision: 1,
      image: { baseUrl: '', model: 'fixture-image', apiKey: payloadKey },
    }), { mode: 0o600 });
    if (process.platform !== 'win32') await fs.chmod(payloadFile, 0o600);

    const configured = runSetupCli(['configure-image', `@${payloadFile}`], { root, defaultsFile });
    assert.equal(configured.status, 1);
    assert.equal(configured.stderr, '');
    const status = JSON.parse(configured.stdout);
    const imageStep = status.steps.find((step) => step.id === 'image');
    assert.equal(imageStep.complete, false);
    assert.match(imageStep.error.message, /必须填写/);
    assert.equal(status.config.image.apiKeyConfigured, true, 'the provided settings are kept even when connection checking fails');
    assert.equal(configured.stdout.includes(payloadKey), false);
    assert.equal((await fs.readFile(payloadFile, 'utf8')).includes(payloadKey), true, 'payload cleanup belongs to the host caller');

    const checked = runSetupCli(['check-image'], { root, defaultsFile });
    assert.equal(checked.status, 1);
    const checkedStatus = JSON.parse(checked.stdout);
    assert.equal(checkedStatus.steps.find((step) => step.id === 'image').complete, false);
    assert.equal(checked.stdout.includes(payloadKey), false);
  });
});
