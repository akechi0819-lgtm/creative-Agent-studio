import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { confirmInputs, confirmSheet, createTask, readTask, setSheet, setSources } from '../src/creative/tasks.mjs';
import { executeTask } from '../src/creative/executor.mjs';
import { createStudioAgent } from '../adapters/dsh/runtime.mjs';

function sheet(pageCount) {
  return {
    title: '两张海报制作单',
    sourceIds: [],
    pages: Array.from({ length: pageCount }, (_, index) => ({
      page: index + 1,
      copy: `第 ${index + 1} 张海报文案`,
      prompt: `第 ${index + 1} 张海报绘图指令`,
      size: '3:4',
      sourceIds: [],
    })),
  };
}

function canvasFixture() {
  const nodes = [];
  const connections = [];
  let generationCount = 0;
  return {
    async tool(name, input) {
      if (name === 'canvas_get_state') return { nodes, connections };
      if (name === 'canvas_apply_ops') {
        for (const op of input.ops) {
          if (op.type === 'add_node') nodes.push({ id: op.id, type: op.nodeType, metadata: op.metadata });
          if (op.type === 'connect_nodes') connections.push({ fromNodeId: op.fromNodeId, toNodeId: op.toNodeId });
        }
        return {};
      }
      if (name === 'canvas_run_generation') {
        generationCount += 1;
        const imageId = `fixture-image-${generationCount}`;
        nodes.push({ id: imageId, type: 'image', metadata: { status: 'success' } });
        connections.push({ fromNodeId: input.nodeId, toNodeId: imageId });
        return {};
      }
      throw new Error(`Unexpected Canvas tool: ${name}`);
    },
    async recover(nodeId, destination) {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, `fixture image ${nodeId}`);
      return { path: destination, nodeId };
    },
    get generationCount() { return generationCount; },
  };
}

test('DSH can write a two-page sheet from chat through the shared confirmation and execution flow', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'creative-two-page-sheet-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const writtenSheet = sheet(2);
  const requests = [];
  const server = createServer(async (req, res) => {
    let bodyText = '';
    for await (const chunk of req) bodyText += chunk;
    const body = JSON.parse(bodyText);
    requests.push(body);
    const hasToolResult = body.messages.some((message) => message.role === 'tool');
    const delta = hasToolResult
      ? { content: '已整理两页制作单，请在工作台检查并确认。' }
      : {
          tool_calls: [{
            index: 0,
            id: 'two-page-sheet-call',
            type: 'function',
            function: {
              name: 'studio_write_sheet',
              arguments: JSON.stringify({ payload: JSON.stringify(writtenSheet) }),
            },
          }],
        };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: hasToolResult ? 'stop' : 'tool_calls' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const readConfig = async () => ({ basic: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'fixture-model',
    apiKey: 'fixture-only-key',
  } });
  const agent = createStudioAgent({ root, readConfig });

  let task = await createTask({ title: '对话决定形式与张数', brief: '根据聊天描述整理海报内容' }, root);
  task = await setSources(task.id, [], { root, expectedRevision: task.revision });
  task = await confirmInputs(task.id, {
    revision: task.revision,
    by: '测试用户',
    note: '确认需求草稿和空参考清单',
  }, { root });

  for (const invalidCount of [0, 6]) {
    await assert.rejects(
      setSheet(task.id, sheet(invalidCount), {
        root,
        expectedRevision: task.revision,
        inputRevision: task.inputConfirmation.revision,
      }),
      /制作单必须包含 1 到 5 页/,
    );
  }

  await agent.chat({
    taskId: task.id,
    text: '请把我的聊天描述整理为两张海报；参考图如有推断请标为待核。',
    expectedRevision: task.revision,
  });

  const requestText = JSON.stringify(requests[0].messages);
  assert.match(requestText, /形式和张数不是新任务入口预设/);
  assert.match(requestText, /参考图中识别出的内容、事实和归因属于待核推断/);
  const writeTool = requests[0].tools.find((tool) => tool.function.name === 'studio_write_sheet');
  assert.ok(writeTool);
  assert.match(writeTool.function.description, /支持1—5页/);
  assert.match(writeTool.function.description, /包括两张海报/);
  assert.match(writeTool.function.description, /sourceIds仅填写用户人工保留的来源/);

  task = await readTask(task.id, root);
  assert.equal(task.sheets.at(-1).pages.length, 2);
  task = await confirmSheet(task.id, {
    version: task.sheetVersion,
    by: '测试用户',
    note: '确认两张海报的文案与绘图指令',
  }, { root, expectedRevision: task.revision });

  const canvas = canvasFixture();
  await executeTask(task.id, {
    root,
    version: task.sheetVersion,
    expectedRevision: task.revision,
    config: { projectId: 'fixture-project', webUrl: 'http://fixture-canvas', clientId: 'fixture-client' },
    getHealth: async () => ({ targets: [{ hasCanvas: true, projectId: 'fixture-project', clientId: 'fixture-client' }] }),
    tool: canvas.tool,
    recover: canvas.recover,
  });

  const completed = await readTask(task.id, root);
  assert.equal(completed.execution.status, 'succeeded');
  assert.equal(completed.execution.version, completed.sheetVersion);
  assert.deepEqual(completed.execution.pages.map((page) => page.page), [1, 2]);
  assert.equal(canvas.generationCount, 2);
});
