import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCanvasManager, videoProviderFingerprint } from '../src/web/canvas.mjs';
import { createTask, taskDirectory } from '../src/creative/tasks.mjs';

test('videoModelInfo reads only the exact H3 provider metadata without starting Canvas or requiring a key', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-video-model-info-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await createTask({ title: '视频模型信息夹具', brief: '本地只读测试' }, root);
  let record = {
    revision: 1,
    image: {},
    video: { baseUrl: 'https://api.osodm.com', model: 'minimax_h3', apiKey: '', apiFormat: 'openai' },
  };
  let configReads = 0;
  const manager = createCanvasManager({
    root,
    readConfig: async () => { configReads += 1; return record; },
  });
  const info = await manager.videoModelInfo(task.id);
  assert.deepEqual(info, {
    model: 'studio-video::minimax_h3',
    providerFingerprint: videoProviderFingerprint(record.video),
    apiKeyConfigured: false,
  });
  assert.equal(await fs.access(path.join(root, 'canvas')).then(() => true, () => false), false, 'model info must not start or create a Canvas');

  record = { ...record, revision: 2, video: { ...record.video, apiKey: 'fixture-video-key-never-real' } };
  const withKey = await manager.videoModelInfo(task.id);
  assert.equal(withKey.providerFingerprint, info.providerFingerprint, 'credentials do not enter the provider fingerprint');
  assert.equal(withKey.apiKeyConfigured, true);
  assert.equal(configReads, 2);
});

test('video recover uses fragmented MP4 movie presentation duration from a MediaRecorder fixture', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-video-recover-metadata-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await createTask({ title: '视频元数据回归夹具', brief: '仅测试任务内视频恢复' }, root);
  const instanceId = crypto.randomUUID();
  const clientId = `fixture-client-${task.id}`;
  const storageKey = `video:${crypto.randomUUID()}`;
  let targetClientIds = [clientId];
  const videoNode = {
    id: 'fixture-video-node',
    type: 'video',
    metadata: {
      videoTaskId: 'native-video-task',
      storageKey,
      status: 'success',
      content: 'data:video/mp4;base64,fixture',
      model: 'studio-video::minimax_h3',
      durationMs: 4004,
    },
  };
  const state = { projectId: task.id, clientId, nodes: [videoNode] };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/__studio/health') {
      response.end(JSON.stringify({ projectId: task.id, instanceId }));
      return;
    }
    if (request.method === 'POST' && request.url === '/__studio/config') {
      response.end(JSON.stringify({ ok: true, configRevision: body.configRevision }));
      return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      response.end(JSON.stringify({
        instanceId,
        targets: targetClientIds.map((currentClientId) => ({ hasCanvas: true, projectId: task.id, clientId: currentClientId })),
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/tools') {
      assert.equal(body.name, 'canvas_get_state');
      assert.equal(body.projectId, task.id);
      assert.equal(body.clientId, clientId);
      response.end(JSON.stringify({ ok: true, result: state }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ ok: false }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const canvasDirectory = path.join(root, 'canvas', task.id);
  const instance = {
    projectId: task.id,
    instanceId,
    clientId,
    token: 'fixture-instance-token',
    webUrl: baseUrl,
    bridgeUrl: baseUrl,
  };
  await fs.mkdir(canvasDirectory, { recursive: true });
  await fs.writeFile(path.join(canvasDirectory, 'canvas-instance.json'), JSON.stringify(instance));

  const fixture = await fs.readFile(new URL('./fixtures/video-mediarecorder-fragmented.mp4', import.meta.url));
  const mediaDirectory = path.join(canvasDirectory, 'storage', 'media_files');
  await fs.mkdir(mediaDirectory, { recursive: true });
  const mediaRecordPath = path.join(mediaDirectory, `${crypto.createHash('sha256').update(storageKey).digest('hex')}.json`);
  await fs.writeFile(mediaRecordPath, JSON.stringify({
    key: storageKey,
    contentType: 'video/mp4',
    base64: fixture.toString('base64'),
  }));

  const manager = createCanvasManager({
    root,
    readConfig: async () => ({ revision: 1, image: null, video: {
      baseUrl: 'https://api.osodm.com', model: 'minimax_h3', apiKey: 'fixture-only-key', apiFormat: 'openai',
    } }),
    bridgeHealth: async () => ({ instanceId, targets: [{ hasCanvas: true, projectId: task.id, clientId }] }),
  });
  t.after(() => manager.stop());
  const execution = await manager.videoExecutionOptions(task.id, { target: { clientId: 'expired-client-after-refresh' } });
  assert.equal(execution.config.clientId, clientId, 'a single current task Canvas can replace the vanished browser client');
  targetClientIds = ['ambiguous-client-a', 'ambiguous-client-b'];
  await assert.rejects(
    manager.videoExecutionOptions(task.id, { target: { clientId: 'expired-client-after-refresh' } }),
    (error) => error.code === 'ERR_CANVAS_AMBIGUOUS',
  );
  targetClientIds = [clientId];
  const destination = path.join(taskDirectory(task.id, root), 'videos', 'recovered.mp4');
  const recovered = await execution.recover(videoNode.id, destination, execution.config);
  assert.equal(recovered.durationMs, 4005);
  assert.equal(recovered.width, 640);
  assert.equal(recovered.height, 360);
  assert.equal(recovered.bytes, fixture.length);
  assert.equal(recovered.sha256, crypto.createHash('sha256').update(fixture).digest('hex'));
  assert.deepEqual(await fs.readFile(destination), fixture);

  const invalidPresentation = Buffer.from(fixture);
  const movieHeader = invalidPresentation.indexOf('mvhd');
  assert.ok(movieHeader >= 0 && invalidPresentation[movieHeader + 4] === 1, 'fixture must contain a version-1 movie header');
  invalidPresentation.writeBigUInt64BE(0n, movieHeader + 28);
  await fs.writeFile(mediaRecordPath, JSON.stringify({
    key: storageKey,
    contentType: 'video/mp4',
    base64: invalidPresentation.toString('base64'),
  }));
  await assert.rejects(execution.recover(videoNode.id, destination, execution.config), (error) => error.code === 'ERR_CANVAS_VIDEO_UNAVAILABLE');
  assert.deepEqual(await fs.readFile(destination), fixture, 'invalid movie duration must not overwrite a valid previous recovery');
});
