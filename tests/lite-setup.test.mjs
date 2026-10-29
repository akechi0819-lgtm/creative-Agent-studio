import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  getSetupStatus,
  recordCanvasMcpCheck,
  reportHostProbe,
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
  const studioDependencies = { '@modelcontextprotocol/sdk': '1.32.2', zod: '3.25.76' };
  await fs.writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({ dependencies: studioDependencies }));
  for (const [name, version] of Object.entries(studioDependencies)) {
    const packageDirectory = path.join(repoRoot, 'node_modules', name);
    await fs.mkdir(packageDirectory, { recursive: true });
    await fs.writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
    await fs.writeFile(path.join(packageDirectory, 'index.js'), 'module.exports = {};');
    if (name === '@modelcontextprotocol/sdk') {
      const serverDirectory = path.join(packageDirectory, 'server');
      await fs.mkdir(serverDirectory, { recursive: true });
      await fs.writeFile(path.join(serverDirectory, 'mcp.js'), 'module.exports = {};');
    }
  }
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

async function createFreshSourceCliFixture(repoRoot) {
  const sourceRoot = path.resolve(import.meta.dirname, '..');
  for (const relative of [
    'scripts/setup.mjs',
    'scripts/studio.mjs',
    'src/lite/setup.mjs',
    'src/lite/config.mjs',
    'src/lite/clipboard.mjs',
    'src/canvas/client.mjs',
    'src/canvas/runtime.mjs',
  ]) {
    const destination = path.join(repoRoot, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(sourceRoot, relative), destination);
  }
  await fs.writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({
    type: 'module',
    dependencies: { '@modelcontextprotocol/sdk': '1.32.2', zod: '3.25.76' },
  }));
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

test('derives source and Canvas readiness from project files and dependencies without requiring Python', async () => {
  await withTemp(async (directory) => {
    const repoRoot = path.join(directory, 'app');
    const dataRoot = path.join(directory, 'data');
    await createPackageFixture(repoRoot);
    const status = await getSetupStatus({ root: dataRoot, repoRoot, nodeVersion: 'v24.1.0', env: {} });
    assert.equal(status.steps.find((step) => step.id === 'package').complete, true);
    assert.equal(status.steps.find((step) => step.id === 'canvas').componentsReady, true);
    assert.equal(status.steps.find((step) => step.id === 'canvas').complete, false);
    assert.match(status.steps.find((step) => step.id === 'canvas').summary, /等待宿主智能体连接/);
    assert.equal(status.steps.find((step) => step.id === 'materials').status, 'waiting');
    assert.equal(status.complete, false);
    assert.equal(status.current, 'canvas');
    assert.match(status.steps.find((step) => step.id === 'materials').summary, /等待公司提供素材库连接/);
    assert.match(status.steps.find((step) => step.id === 'materials').hostInstruction, /宿主自己的 MCP 配置功能/);
    assert.match(status.steps.find((step) => step.id === 'canvas').nextAction, /command\/args/);
    assert.match(status.steps.find((step) => step.id === 'canvas').nextAction, /node scripts\/studio\.mjs mcp-config/);
    assert.match(status.steps.find((step) => step.id === 'materials').hostInstruction, /node scripts\/setup\.mjs report-host connected/);
    assert.equal(Object.hasOwn(status, 'guide'), false);
    assert.equal(Object.hasOwn(status.steps.find((step) => step.id === 'materials'), 'provider'), false);
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
    assert.match(canvasStep.nextAction, /node scripts\/prepare\.mjs/);
  });
});

test('missing Studio dependency or invalid Canvas manifest is an explicit package failure', async () => {
  await withTemp(async (directory) => {
    const repoRoot = path.join(directory, 'app');
    await createPackageFixture(repoRoot);
    await fs.rm(path.join(repoRoot, 'node_modules/zod'), { recursive: true, force: true });
    await fs.writeFile(path.join(repoRoot, 'third_party/canvas/canvas-agent/package.json'), '{bad json');
    const status = await getSetupStatus({ root: path.join(directory, 'data'), repoRoot, nodeVersion: 'v24.1.0', env: {} });
    const packageStep = status.steps.find((step) => step.id === 'package');
    const canvasStep = status.steps.find((step) => step.id === 'canvas');
    assert.equal(packageStep.complete, false);
    assert.match(packageStep.error.message, /zod/);
    assert.match(packageStep.nextAction, /node scripts\/prepare\.mjs/);
    assert.equal(canvasStep.complete, false);
    assert.match(canvasStep.error.message, /package\.json 格式无效/);
    assert.match(canvasStep.nextAction, /node scripts\/prepare\.mjs/);
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

test('reports image API HTTP failures and never completes until the host supplies a read-only probe report', async () => {
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

    const report = await reportHostProbe({ status: 'connected', toolName: 'search_documents' }, { root });
    await recordCanvasMcpCheck({root});
    assert.equal(report.source, '宿主报告');
    assert.equal(report.independentlyVerified, false);
    assert.equal(await fs.stat(path.join(root, 'setup', 'host-report.json')).then((info) => info.isFile()), true);
    const status = await getSetupStatus({ root, repoRoot, nodeVersion: 'v24.1.0', env: {} });
    const materialStep = status.steps.find((step) => step.id === 'materials');
    assert.equal(materialStep.status, 'host_reported');
    assert.equal(materialStep.independentlyVerified, false);
    assert.equal(materialStep.source, '宿主报告');
    assert.match(materialStep.checks[0].detail, /上次探测.*新宿主或新会话请实际调用只读工具确认/);
    assert.match(status.steps.find((step) => step.id === 'canvas').checks.find((check) => check.name === '宿主调用本地 Canvas MCP').detail, /上次探测.*新宿主或新会话请实际调用 canvas_status/);
    assert.equal(status.complete, false, 'the failed image connection must keep final setup incomplete');
    assert.equal(status.current, 'image');

    await reportHostProbe({ status: 'failed', toolName: 'search_documents' }, { root });
    const failedHostStatus = await getSetupStatus({ root, repoRoot, nodeVersion: 'v24.1.0', env: {} });
    assert.equal(failedHostStatus.steps.find((step) => step.id === 'materials').error.code, 'ERR_HOST_PROBE');
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

test('final setup stays blocked until the current image revision and host probe report both pass', async () => {
  await withTemp(async (directory) => {
    const repoRoot = path.join(directory, 'app');
    const root = path.join(directory, 'data');
    await createPackageFixture(repoRoot);
    await saveConfig({ expectedRevision: 1, image }, { root });
    await reportHostProbe({ status: 'connected', toolName: 'list_materials' }, { root });
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
      reportHostProbe({ status: 'connected' }, { root }),
      (error) => error.code === 'ERR_HOST_REPORT',
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

test('setup status runs from a fresh source clone without node_modules or Canvas build and gives one prepare command', async () => {
  await withTemp(async (directory) => {
    const repoRoot = path.join(directory, 'source');
    const dataRoot = path.join(directory, 'data');
    await fs.mkdir(repoRoot, { recursive: true });
    await createFreshSourceCliFixture(repoRoot);
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/setup.mjs'), 'status'], {
      cwd: repoRoot,
      env: { ...process.env, STUDIO_DATA_DIR: dataRoot, COMPANY_LITE_DEFAULTS_FILE: '' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.steps.find((step) => step.id === 'package').complete, false);
    assert.equal(status.steps.find((step) => step.id === 'canvas').complete, false);
    assert.equal(status.current, 'package');
    assert.match(status.nextAction, /^源码文件或运行依赖缺失时运行 node scripts\/prepare\.mjs/);
    assert.match(status.steps.find((step) => step.id === 'package').error.message, /@modelcontextprotocol\/sdk.*zod|zod.*@modelcontextprotocol\/sdk/);
    assert.match(status.steps.find((step) => step.id === 'canvas').nextAction, /node scripts\/prepare\.mjs/);
    assert.equal(await fs.lstat(path.join(repoRoot, 'node_modules')).then(() => true, (error) => error.code === 'ENOENT'), true);
  });
});

test('host CLI reports return full status JSON and require a real tool name for connected', async () => {
  await withTemp(async (directory) => {
    const root = path.join(directory, 'data');
    const defaultsFile = await createCliDefaults(directory);
    const report = runSetupCli(['report-host', 'connected', 'search_materials'], { root, defaultsFile });
    assert.equal(report.status, 0, report.stderr);
    const status = JSON.parse(report.stdout);
    const materials = status.steps.find((step) => step.id === 'materials');
    assert.equal(materials.status, 'host_reported');
    assert.equal(materials.independentlyVerified, false);
    assert.match(materials.summary, /上次宿主探测已报告素材 MCP 可用/);
    assert.equal(JSON.stringify(status).includes(image.apiKey), false);

    const missingTool = runSetupCli(['report-host', 'connected'], { root, defaultsFile });
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
