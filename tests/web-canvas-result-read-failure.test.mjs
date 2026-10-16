import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listenStudioServer } from '../src/web/server.mjs';
import { confirmInputs, confirmSheet, createTask, readTask, setSheet } from '../src/creative/tasks.mjs';

const SAFE_MESSAGE = '第1页图片返回后读取失败，尚未保存；请查看画布错误并重试。';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-studio-canvas-read-failure-'));
  const staticDir = path.join(root, 'web-dist');
  await fs.mkdir(staticDir, { recursive: true });
  await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>fixture</title>');

  const config = { projectId: 'fixture-project', webUrl: 'http://fixture.invalid', clientId: 'fixture-client' };
  let nodes = [];
  let connections = [];
  let generationSubmissions = 0;
  const tool = async (name, input = {}) => {
    if (name === 'canvas_get_state') return { nodes, connections };
    if (name === 'canvas_apply_ops') {
      nodes = [
        ...nodes,
        ...input.ops
          .filter((operation) => operation.type === 'add_node')
          .map((operation) => ({ id: operation.id, type: operation.nodeType, metadata: operation.metadata })),
      ];
      connections = [
        ...connections,
        ...input.ops.filter((operation) => operation.type === 'connect_nodes')
          .map((operation) => ({ fromNodeId: operation.fromNodeId, toNodeId: operation.toNodeId })),
      ];
      return {};
    }
    if (name === 'canvas_run_generation') {
      generationSubmissions += 1;
      return {};
    }
    if (name === 'generation_get_status') {
      return {
        tasks: [{
          id: input.nodeIds[0],
          status: 'failed',
          error: '读取图片失败',
          providerError: 'private upstream response must never be persisted',
        }],
      };
    }
    throw new Error(`unexpected fixture Canvas tool: ${name}`);
  };
  const canvas = {
    executionOptions: async () => ({
      config,
      getHealth: async () => ({ targets: [{ hasCanvas: true, projectId: config.projectId, clientId: config.clientId }] }),
      tool,
    }),
  };
  const running = await listenStudioServer({ root, staticDir, canvas });
  const origin = `http://127.0.0.1:${running.address.port}`;
  t.after(async () => {
    await running.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  return {
    root,
    generationSubmissions: () => generationSubmissions,
    async request(url, { json, ...options } = {}) {
      const headers = new Headers(options.headers || {});
      if (options.method && options.method !== 'GET' && options.method !== 'HEAD') headers.set('origin', origin);
      let body = options.body;
      if (json !== undefined) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(json);
      }
      const response = await fetch(`${origin}${url}`, { ...options, headers, body });
      return { response, data: await response.json() };
    },
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function prepareTask(root) {
  let task = await createTask({ title: 'Canvas 结果读取失败隔离夹具', brief: { topic: '验证本地读取错误映射' } }, root);
  task = await confirmInputs(task.id, { revision: task.revision, by: 'fixture user', note: '本地隔离测试' }, { root });
  task = await setSheet(task.id, {
    title: '隔离夹具',
    pages: [{ page: 1, copy: '测试文案', prompt: '测试画面', size: '3:4' }],
  }, { root, expectedRevision: task.revision, inputRevision: task.inputConfirmation.revision });
  task = await confirmSheet(task.id, { version: task.sheetVersion, by: 'fixture user', note: '本地隔离测试' }, { root, expectedRevision: task.revision });
  return task;
}

async function readJob(f, id) {
  const response = await f.request(`/api/jobs/${id}`);
  assert.equal(response.response.status, 200);
  return response.data.job;
}

test('Canvas报告固定读取失败时Web job与任务均失败，恢复不会再次提交生图', async (t) => {
  const f = await fixture(t);
  const task = await prepareTask(f.root);
  const execute = async (expectedRevision) => f.request(`/api/tasks/${task.id}/execute`, {
    method: 'POST',
    json: { version: task.sheetVersion, expectedRevision },
  });

  const started = await execute(task.revision);
  assert.equal(started.response.status, 202, JSON.stringify(started.data));
  const firstTerminal = await waitFor(async () => {
    const job = await readJob(f, started.data.job.id);
    return ['failed', 'succeeded', 'cancelled'].includes(job.status) ? job : null;
  }, 'Canvas图片读取失败应使首次execute job进入终态');
  assert.equal(firstTerminal.status, 'failed');
  assert.equal(firstTerminal.error.code, 'ERR_CANVAS_RESULT_READ_FAILED');
  assert.equal(firstTerminal.error.message, SAFE_MESSAGE);
  assert.equal(firstTerminal.result, null);

  let current = await readTask(task.id, f.root);
  assert.equal(current.execution.status, 'failed');
  assert.equal(current.execution.error, SAFE_MESSAGE);
  assert.equal(current.execution.pages[0].status, 'failed');
  assert.equal(current.execution.pages[0].submitted, true);
  assert.equal(JSON.stringify(current.execution).includes('private upstream response'), false);
  assert.equal(f.generationSubmissions(), 1);

  const resumed = await execute(current.revision);
  assert.equal(resumed.response.status, 202, JSON.stringify(resumed.data));
  const resumedTerminal = await waitFor(async () => {
    const job = await readJob(f, resumed.data.job.id);
    return ['failed', 'succeeded', 'cancelled'].includes(job.status) ? job : null;
  }, '恢复应重新查询原节点并返回固定读取失败');
  assert.equal(resumedTerminal.status, 'failed');
  assert.equal(resumedTerminal.error.code, 'ERR_CANVAS_RESULT_READ_FAILED');
  assert.equal(resumedTerminal.error.message, SAFE_MESSAGE);

  current = await readTask(task.id, f.root);
  assert.equal(current.execution.status, 'failed');
  assert.equal(current.execution.pages[0].status, 'failed');
  assert.equal(f.generationSubmissions(), 1);
});
