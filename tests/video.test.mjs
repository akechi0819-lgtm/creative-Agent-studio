import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTask, readTask } from '../src/creative/tasks.mjs';
import {
  writeVideoPlan,
  confirmVideoPlan,
  executeVideoTask,
  recordVideoReview,
  approveVideo,
  exportVideoTask,
  readVideoOutput,
} from '../src/creative/video.mjs';

const MODEL = 'studio-video::minimax_h3';
const FINGERPRINT = 'a'.repeat(64);
const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]),
  Buffer.from('isom\0\0\0\0isomiso2'),
  Buffer.from([0, 0, 0, 8, 0x6d, 0x64, 0x61, 0x74]),
]);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function setup(t, plan = { prompt: '一段桌面咖啡拉花的近景视频。' }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-video-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let task = await createTask({ title: '视频隔离测试', brief: '只验证本机视频工作流' }, root);
  task = await writeVideoPlan(task.id, plan, { root, expectedRevision: task.revision, model: MODEL, providerFingerprint: FINGERPRINT });
  task = await confirmVideoPlan(task.id, {
    version: task.video.version,
    by: '测试用户',
    note: '我已检查视频方案并确认提交本次生成。',
  }, { root, expectedRevision: task.revision });
  return { root, id: task.id, task };
}

function graphState(task) {
  return structuredClone({
    inputConfirmation: task.inputConfirmation,
    sheetVersion: task.sheetVersion,
    sheetInputsRevision: task.sheetInputsRevision,
    sheets: task.sheets,
    sheetConfirmation: task.sheetConfirmation,
    execution: task.execution,
    executionHistory: task.executionHistory,
    reviews: task.reviews,
    reviewHistory: task.reviewHistory,
    finalApproval: task.finalApproval,
    exports: task.exports,
  });
}

function fakeCanvas(initialStatus = 'success', initialNodes = []) {
  const nodes = structuredClone(initialNodes);
  const connections = [];
  let runCount = 0;
  let status = initialStatus === 'loading+content' ? 'loading' : initialStatus;
  const contentReady = initialStatus === 'loading+content';
  let taskSequence = 0;
  const config = {
    projectId: 'fixture-project',
    instanceId: 'fixture-instance',
    clientId: 'fixture-client',
    model: MODEL,
    providerFingerprint: FINGERPRINT,
  };
  const tool = async (name, input) => {
    if (name === 'canvas_get_state') return { nodes: structuredClone(nodes), connections: structuredClone(connections) };
    if (name !== 'canvas_apply_ops') throw new Error(`unexpected fake Canvas tool ${name}`);
    for (const operation of input.ops) {
      if (operation.type === 'add_node') nodes.push({
        id: operation.id,
        type: operation.nodeType,
        position: structuredClone(operation.position),
        width: operation.width || 340,
        height: operation.height || 240,
        metadata: structuredClone(operation.metadata),
      });
      else if (operation.type === 'connect_nodes') connections.push({ fromNodeId: operation.fromNodeId, toNodeId: operation.toNodeId });
      else if (operation.type === 'run_generation') {
        runCount += 1;
        const configNode = nodes.find(node => node.id === operation.nodeId);
        configNode.metadata.status = 'loading';
        const childId = `video-output-${runCount}`;
        taskSequence += 1;
        nodes.push({
          id: childId,
          type: 'video',
          position: { x: 0, y: 0 },
          width: 420,
          height: 236,
          metadata: {
            status,
            videoTaskId: `provider-task-${taskSequence}`,
            storageKey: `video:fixture-${taskSequence}`,
            ...(contentReady ? { content: 'blob:fixture/video' } : {}),
            mimeType: 'video/mp4',
            naturalWidth: 768,
            naturalHeight: 432,
            durationMs: 4000,
          },
        });
        connections.push({ fromNodeId: operation.nodeId, toNodeId: childId });
      }
    }
    return {};
  };
  return {
    config,
    providerFingerprint: FINGERPRINT,
    getHealth: async candidate => ({
      instanceId: candidate.instanceId,
      targets: [{ hasCanvas: true, projectId: candidate.projectId, clientId: candidate.clientId }],
    }),
    tool,
    recover: async (nodeId, destination) => {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, mp4);
      return {
        path: destination,
        nodeId,
        bytes: mp4.length,
        mimeType: 'video/mp4',
        width: 768,
        height: 432,
        durationMs: 4000,
        sha256: digest(mp4),
      };
    },
    setStatus(value) {
      status = value;
      for (const node of nodes) if (node.type === 'video') node.metadata.status = value;
    },
    runCount: () => runCount,
    nodes,
  };
}

async function execute(id, root, task, canvas, overrides = {}) {
  return executeVideoTask(id, {
    version: task.video.version,
    expectedRevision: task.revision,
    root,
    pollMs: 1,
    timeoutMs: 100,
    ...canvas,
    ...overrides,
  });
}

test('video plan defaults, Studio rejects unavailable reference URLs, and graph workflow remains unchanged', async t => {
  const { root, id, task } = await setup(t);
  const before = graphState(task);
  assert.deepEqual({ seconds: task.video.plans[0].seconds, ratio: task.video.plans[0].ratio, resolution: task.video.plans[0].resolution }, {
    seconds: 4, ratio: '16:9', resolution: '768',
  });
  assert.equal(task.video.plans[0].model, MODEL);
  await assert.rejects(writeVideoPlan(id, { prompt: '带参考图', images: ['some-image'] }, {
    root, expectedRevision: task.revision, model: MODEL, providerFingerprint: FINGERPRINT,
  }), /Studio 尚未接入公网参考素材 URL，本地文件不能直接传给此渠道/);
  await assert.rejects(writeVideoPlan(id, { prompt: '超长视频', seconds: 16 }, {
    root, expectedRevision: task.revision, model: MODEL, providerFingerprint: FINGERPRINT,
  }), /4 到 15 秒/);
  await assert.rejects(writeVideoPlan(id, { prompt: '自动比例', ratio: 'auto' }, {
    root, expectedRevision: task.revision, model: MODEL, providerFingerprint: FINGERPRINT,
  }), /比例无效/);
  await assert.rejects(writeVideoPlan(id, { prompt: '数值分辨率', resolution: 768 }, {
    root, expectedRevision: task.revision, model: MODEL, providerFingerprint: FINGERPRINT,
  }), /分辨率必须是 768、1080p、2K 或 4K/);
  await assert.rejects(writeVideoPlan(id, { prompt: '省略音频参数', generateAudio: true }, {
    root, expectedRevision: task.revision, model: MODEL, providerFingerprint: FINGERPRINT,
  }), /含不支持字段：generateAudio/);
  const canvas = fakeCanvas();
  const done = await execute(id, root, task, canvas);
  assert.equal(canvas.runCount(), 1);
  assert.equal(done.video.execution.status, 'succeeded');
  assert.equal(done.video.execution.submitted, true);
  assert.equal(done.video.execution.videoTaskId, 'provider-task-1');
  assert.equal(done.video.execution.output.sha256, digest(mp4));
  assert.deepEqual(graphState(done), before);
  const preview = await readVideoOutput(id, { root });
  assert.equal(preview.mimeType, 'video/mp4');
  assert.equal(preview.width, 768);
  assert.equal(preview.durationMs, 4000);
  assert.deepEqual(preview.bytes, mp4);
});

test('video nodes are placed to the right of existing graph nodes without moving them', async t => {
  const { root, id, task } = await setup(t);
  const existingNodes = [
    { id: 'existing-text', type: 'text', position: { x: 0, y: 0 }, width: 340, height: 240, metadata: { content: '既有图文文案' } },
    { id: 'existing-config', type: 'config', position: { x: 520, y: 0 }, width: 340, height: 240, metadata: { generationMode: 'image' } },
    { id: 'existing-image', type: 'image', position: { x: 900, y: 0 }, width: 400, height: 300, metadata: { status: 'success' } },
  ];
  const original = structuredClone(existingNodes);
  const canvas = fakeCanvas('success', existingNodes);
  const done = await execute(id, root, task, canvas);
  const textNode = canvas.nodes.find(node => node.id === done.video.execution.textNodeId);
  const configNode = canvas.nodes.find(node => node.id === done.video.execution.configNodeId);
  const existingRight = Math.max(...original.map(node => node.position.x + node.width));
  assert.ok(textNode.position.x >= existingRight + 160);
  assert.ok(configNode.position.x >= textNode.position.x + textNode.width + 80);
  assert.deepEqual(canvas.nodes.filter(node => original.some(item => item.id === node.id)).map(node => ({
    id: node.id, position: node.position, width: node.width, height: node.height,
  })), original.map(({ id: nodeId, position, width, height }) => ({ id: nodeId, position, width, height })));
});

test('video approval and export bind the current SHA and produce MP4 plus manifest', async t => {
  const { root, id, task } = await setup(t);
  const before = graphState(task);
  const canvas = fakeCanvas();
  let done = await execute(id, root, task, canvas);
  const hash = done.video.execution.output.sha256;
  await assert.rejects(recordVideoReview(id, {
    sha256: '0'.repeat(64), decision: 'pass', reviewer: '测试用户', notes: '已播放并核对当前视频内容。',
  }, { root, expectedRevision: done.revision }), /SHA-256 与当前成品不一致/);
  done = await recordVideoReview(id, {
    sha256: hash, decision: 'pass', reviewer: '测试用户', notes: '已逐段播放并核对画面、文案和时长。',
  }, { root, expectedRevision: done.revision });
  await assert.rejects(approveVideo(id, {
    version: done.video.version, sha256: hash, by: 'Codex', note: '模型不可代替用户批准。',
  }, { root, expectedRevision: done.revision }), /实际人工姓名或身份/);
  done = await approveVideo(id, {
    version: done.video.version, sha256: hash, by: '测试用户', note: '已看完当前视频并确认交付。',
  }, { root, expectedRevision: done.revision });
  const result = await exportVideoTask(id, { root, expectedRevision: done.revision });
  assert.equal(result.export.videoVersion, 1);
  const taskRoot = path.join(root, 'tasks', id);
  const output = await fs.readFile(path.join(taskRoot, result.export.videoRelativePath));
  assert.deepEqual(output, mp4);
  assert.equal(digest(output), hash);
  const manifest = JSON.parse(await fs.readFile(path.join(taskRoot, result.export.manifestRelativePath), 'utf8'));
  assert.equal(manifest.videoVersion, 1);
  assert.equal(manifest.output.sha256, hash);
  assert.equal(Object.hasOwn(manifest.plan, 'generateAudio'), false);
  assert.deepEqual(graphState(result.task), before);
});

test('pending resume queries the fixed config node and does not submit twice', async t => {
  const { root, id, task } = await setup(t);
  const canvas = fakeCanvas('loading');
  await assert.rejects(execute(id, root, task, canvas, { timeoutMs: 5, pollMs: 2 }), /超时/);
  let current = await readTask(id, root);
  assert.equal(current.video.execution.status, 'uncertain');
  assert.ok(current.video.execution.submissionIntentAt);
  canvas.setStatus('success');
  current = await execute(id, root, current, canvas);
  assert.equal(canvas.runCount(), 1);
  assert.equal(current.video.execution.status, 'succeeded');
});

test('completed Canvas video with loading status and stored media is recoverable', async t => {
  const { root, id, task } = await setup(t);
  const canvas = fakeCanvas('loading+content');
  const done = await execute(id, root, task, canvas);
  assert.equal(canvas.runCount(), 1);
  assert.equal(done.video.execution.status, 'succeeded');
  assert.equal(done.video.execution.output.storageKey, 'video:fixture-1');
});

test('non-native Canvas status strings stay uncertain and cannot trigger a duplicate generation', async t => {
  for (const status of ['not-a-known-state', 'succeeded', 'completed', 'failed']) {
    const { root, id, task } = await setup(t);
    const canvas = fakeCanvas(status);
    await assert.rejects(execute(id, root, task, canvas, { timeoutMs: 5, pollMs: 2 }), /超时/);
    const current = await readTask(id, root);
    assert.equal(current.video.execution.status, 'uncertain', `${status} must not be interpreted as a native Canvas status`);
    await assert.rejects(writeVideoPlan(id, { prompt: '未知状态期间不能重复提交。' }, {
      root, expectedRevision: current.revision, model: MODEL, providerFingerprint: FINGERPRINT,
    }), /仍未确认结果/);
    await assert.rejects(execute(id, root, current, canvas, { timeoutMs: 5, pollMs: 2 }), /超时/);
    assert.equal(canvas.runCount(), 1);
    assert.equal((await readTask(id, root)).video.execution.status, 'uncertain');
  }
});

test('a submitted video task cannot resume through a different provider fingerprint', async t => {
  const { root, id, task } = await setup(t);
  const canvas = fakeCanvas('loading');
  await assert.rejects(execute(id, root, task, canvas, { timeoutMs: 5, pollMs: 2 }), /超时/);
  const current = await readTask(id, root);
  const switched = {
    ...canvas,
    config: { ...canvas.config, providerFingerprint: 'b'.repeat(64) },
    providerFingerprint: 'b'.repeat(64),
  };
  await assert.rejects(execute(id, root, current, switched), /渠道或模型与已确认方案不一致/);
  assert.equal(canvas.runCount(), 1);
});

test('explicit provider failure cannot retry under the same plan; a new confirmed plan gets fresh fixed node IDs', async t => {
  const { root, id, task } = await setup(t);
  const canvas = fakeCanvas('error');
  await assert.rejects(execute(id, root, task, canvas), /明确失败/);
  let current = await readTask(id, root);
  assert.equal(current.video.execution.status, 'failed');
  await assert.rejects(execute(id, root, current, canvas), /新建方案/);
  assert.equal(canvas.runCount(), 1);
  const oldConfigId = current.video.execution.configNodeId;
  current = await writeVideoPlan(id, { prompt: '改成远景拍摄。' }, {
    root, expectedRevision: current.revision, model: MODEL, providerFingerprint: FINGERPRINT,
  });
  assert.equal(current.video.version, 2);
  assert.notEqual(current.video.execution.configNodeId, oldConfigId);
  current = await confirmVideoPlan(id, {
    version: 2, by: '测试用户', note: '新方案已重新检查并确认。',
  }, { root, expectedRevision: current.revision });
  const nextCanvas = fakeCanvas();
  current = await execute(id, root, current, nextCanvas);
  assert.equal(nextCanvas.runCount(), 1);
  assert.equal(current.video.execution.status, 'succeeded');
  assert.equal(current.video.executionHistory[0].status, 'failed');
});

test('changed current MP4 hash blocks review, approval, preview, and export', async t => {
  const { root, id, task } = await setup(t);
  const canvas = fakeCanvas();
  let done = await execute(id, root, task, canvas);
  const videoFile = path.join(root, 'tasks', id, done.video.execution.output.relativePath);
  const hash = done.video.execution.output.sha256;
  done = await recordVideoReview(id, {
    sha256: hash, decision: 'pass', reviewer: '测试用户', notes: '已播放并确认视频内容。',
  }, { root, expectedRevision: done.revision });
  done = await approveVideo(id, {
    version: done.video.version, sha256: hash, by: '测试用户', note: '已确认当前视频成品。',
  }, { root, expectedRevision: done.revision });
  await fs.writeFile(videoFile, Buffer.from('changed'));
  await assert.rejects(readVideoOutput(id, { root }), /SHA-256 已变化/);
  await assert.rejects(recordVideoReview(id, {
    sha256: hash, decision: 'pass', reviewer: '测试用户', notes: '检查过。',
  }, { root, expectedRevision: done.revision }), /SHA-256 已变化/);
  await assert.rejects(approveVideo(id, {
    version: 1, sha256: hash, by: '测试用户', note: '确认。',
  }, { root, expectedRevision: done.revision }), /SHA-256 已变化/);
  await assert.rejects(exportVideoTask(id, { root, expectedRevision: done.revision }), /SHA-256 已变化/);
});
