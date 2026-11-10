import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { saveConfig, readConfig } from '../src/web/config.mjs';
import { videoProviderFingerprint, createCanvasManager } from '../src/web/canvas.mjs';
import { createTask } from '../src/creative/tasks.mjs';
import { videoChannelForSave } from '../web/src/settings-contract.js';

test('saving base/image settings with an unused video channel keeps Canvas video config empty', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-empty-video-settings-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await createTask({ title: '空视频配置回归', brief: '只配置基础和图片通道' }, root);
  const video = videoChannelForSave({ baseUrl: '', model: '', apiKey: '' });
  assert.deepEqual(video, { baseUrl: '', model: '', apiKey: '', apiFormat: 'openai' });
  const stored = await saveConfig({
    expectedRevision: 1,
    base: { baseUrl: 'https://example.invalid/v1', model: 'fixture', apiKey: '', source: 'custom' },
    image: { baseUrl: 'https://example.invalid/v1', model: 'fixture-image', apiKey: '' },
    video,
  }, { root });
  assert.equal(stored.video.model, '');
  assert.equal(videoProviderFingerprint(stored.video), null);
  const manager = createCanvasManager({ root, readConfig: () => readConfig({ root }) });
  assert.deepEqual(await manager.videoModelInfo(task.id), { model: null, providerFingerprint: null, apiKeyConfigured: false });
});

test('saved video credentials cannot be kept without the required service address', () => {
  assert.throws(() => videoChannelForSave({ baseUrl: '', apiKey: '' }, { savedApiKeyConfigured: true }), /必须同时填写视频服务地址/);
});
