import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTask, readTask, taskDirectory, withTask } from '../src/creative/tasks.mjs';
import { listenStudioServer } from '../src/web/server.mjs';

function fakeMp4() {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.write('ftyp', 4, 'ascii');
  bytes.write('isom', 8, 'ascii');
  bytes.writeUInt32BE(0, 12);
  bytes.write('isom', 16, 'ascii');
  bytes.write('iso2', 20, 'ascii');
  return bytes;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-studio-video-web-'));
  const staticDir = path.join(root, 'web-dist');
  await fs.mkdir(staticDir, { recursive: true });
  await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>video fixture</title>');
  const running = await listenStudioServer({
    root,
    staticDir,
    canvas: {
      videoModelInfo: async () => ({ model: 'studio-video::minimax_h3', providerFingerprint: 'a'.repeat(64), apiKeyConfigured: true }),
    },
  });
  const origin = `http://127.0.0.1:${running.address.port}`;
  t.after(async () => { await running.close(); await fs.rm(root, { recursive: true, force: true }); });
  return {
    root,
    origin,
    async request(url, { json, ...options } = {}) {
      const headers = new Headers(options.headers || {});
      if (options.method && options.method !== 'GET' && options.method !== 'HEAD') headers.set('origin', origin);
      let body = options.body;
      if (json !== undefined) { headers.set('content-type', 'application/json'); body = JSON.stringify(json); }
      const response = await fetch(`${origin}${url}`, { ...options, headers, body });
      const type = response.headers.get('content-type') || '';
      return { response, data: type.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
    },
  };
}

test('Web saves a storyboard without execution, then exports only the current user-confirmed video SHA', async (t) => {
  const f = await fixture(t);
  const task = await createTask({ title: '独立视频交付', brief: '视频与图文审核分开' }, f.root);
  const planned = await f.request(`/api/tasks/${task.id}/write-video-plan`, {
    method: 'POST',
    json: { expectedRevision: task.revision, plan: { prompt: '镜头由窗边缓慢移向书桌，角色翻开一本书', seconds: 6, ratio: '16:9', resolution: '1080p' } },
  });
  assert.equal(planned.response.status, 200);
  assert.equal(planned.data.task.video.version, 1);
  assert.equal(planned.data.task.video.plans[0].confirmedAt, null);
  assert.equal(planned.data.task.video.execution.submitted, false);

  const bytes = fakeMp4();
  const relativePath = 'videos/v1/video.mp4';
  const absolutePath = path.join(taskDirectory(task.id, f.root), relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, bytes, { mode: 0o600 });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const completed = await withTask(task.id, (draft) => {
    draft.video.execution.status = 'succeeded';
    draft.video.execution.submitted = true;
    draft.video.execution.output = {
      relativePath, sha256, mimeType: 'video/mp4', size: bytes.length,
      width: 640, height: 360, durationMs: 6000,
      nodeId: 'fixture-video-node', videoTaskId: 'fixture-video-task', storageKey: 'video:fixture',
    };
    draft.video.execution.completedAt = new Date().toISOString();
  }, { root: f.root, expectedRevision: planned.data.task.revision });

  const detail = await f.request(`/api/tasks/${task.id}`);
  const outputUrl = detail.data.task.video.execution.output.videoUrl;
  const preview = await f.request(outputUrl);
  assert.equal(preview.response.status, 200);
  assert.deepEqual(preview.data, bytes);

  const delivery = await f.request(`/api/tasks/${task.id}/video-approve-and-export`, {
    method: 'POST', json: { expectedRevision: completed.revision, version: 1, sha256 },
  });
  assert.equal(delivery.response.status, 200);
  assert.equal(delivery.data.task.video.reviews.at(-1).notes, '用户确认当前展示视频用于交付');
  assert.equal(delivery.data.task.video.approval.sha256, sha256);
  assert.equal(delivery.data.export.sha256, sha256);
  assert.ok(delivery.data.export.videoUrl);
  assert.ok(delivery.data.export.manifestUrl);

  const exportedVideo = await f.request(delivery.data.export.videoUrl);
  assert.equal(exportedVideo.response.status, 200);
  assert.deepEqual(exportedVideo.data, bytes);
  const manifestResponse = await f.request(delivery.data.export.manifestUrl);
  assert.equal(manifestResponse.response.status, 200);
  const manifest = Buffer.isBuffer(manifestResponse.data)
    ? JSON.parse(manifestResponse.data.toString('utf8'))
    : manifestResponse.data;
  assert.equal(manifest.output.sha256, sha256);
  assert.equal(manifest.review.notes, '用户确认当前展示视频用于交付');

  const repeated = await f.request(`/api/tasks/${task.id}/video-approve-and-export`, {
    method: 'POST', json: { expectedRevision: completed.revision, version: 1, sha256 },
  });
  assert.equal(repeated.response.status, 409);
  assert.equal((await readTask(task.id, f.root)).video.exports.length, 1, 'stale delivery cannot create a duplicate export');

  await fs.writeFile(path.join(taskDirectory(task.id, f.root), delivery.data.export.version ? `videos/exports/${delivery.data.export.version}/video.mp4` : 'missing'), Buffer.concat([bytes, Buffer.from([1])]), { mode: 0o600 });
  const tampered = await f.request(delivery.data.export.videoUrl);
  assert.equal(tampered.response.status, 409, 'export route verifies only the registered local SHA');
});
