import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publicConfig, readConfigRecord, saveConfig } from '../src/web/config.mjs';

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-shared-model-key-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('explicit sharing copies a saved custom base credential into image storage without returning it publicly', async (t) => {
  const root = await temporaryRoot(t);
  const baseUrl = 'https://provider.example.invalid/v1';
  const secret = 'fixture-shared-key-never-returned';
  const initial = await saveConfig({
    expectedRevision: 1,
    base: { source: 'custom', baseUrl, model: 'chat-fixture', apiKey: secret },
  }, { root });

  // The saved base key is reused; this request contains no credential at all.
  const saved = await saveConfig({
    expectedRevision: initial.revision,
    image: { model: 'image-fixture', useBaseCredentials: true },
  }, { root });

  assert.equal(saved.base.source, 'custom');
  assert.equal(saved.image.baseUrl, baseUrl);
  assert.equal(saved.image.apiKey, secret);
  assert.notEqual(saved.image, saved.base);
  assert.equal(Object.hasOwn(saved.image, 'useBaseCredentials'), false);

  const outward = publicConfig(saved);
  assert.equal(outward.image.apiKeyConfigured, true);
  assert.doesNotMatch(JSON.stringify(outward), /fixture-shared-key-never-returned/u);
  const persistedText = await fs.readFile(path.join(root, 'config', 'studio.json'), 'utf8');
  assert.doesNotMatch(persistedText, /useBaseCredentials/u);
  assert.match(persistedText, /fixture-shared-key-never-returned/u);
});

test('copying base credentials uses the matching CAS revision and stale requests cannot replace them', async (t) => {
  const root = await temporaryRoot(t);
  const saved = await saveConfig({
    expectedRevision: 1,
    base: { source: 'custom', baseUrl: 'https://provider.example.invalid/v1', model: 'chat-fixture', apiKey: 'current-fixture-key' },
    image: { model: 'image-fixture', useBaseCredentials: true },
  }, { root });

  await assert.rejects(saveConfig({
    expectedRevision: 1,
    base: { source: 'custom', baseUrl: 'https://other.example.invalid/v1', model: 'other-chat', apiKey: 'stale-fixture-key' },
    image: { model: 'other-image', useBaseCredentials: true },
  }, { root }), { code: 'ERR_CONFIG_REVISION_CONFLICT' });

  const current = await readConfigRecord({ root });
  assert.equal(current.revision, saved.revision);
  assert.equal(current.base.apiKey, 'current-fixture-key');
  assert.equal(current.image.apiKey, 'current-fixture-key');
  assert.equal(current.image.baseUrl, current.base.baseUrl);
});

test('credential sharing rejects managed sources and incomplete custom base credentials', async (t) => {
  const root = await temporaryRoot(t);

  await assert.rejects(saveConfig({
    expectedRevision: 1,
    base: { source: 'kilo', model: 'kilo/fixture-model' },
    image: { model: 'image-fixture', useBaseCredentials: true },
  }, { root }), { code: 'ERR_CONFIG_INVALID' });

  await assert.rejects(saveConfig({
    expectedRevision: 1,
    base: { source: 'custom', baseUrl: 'https://provider.example.invalid/v1', model: 'chat-fixture' },
    image: { model: 'image-fixture', useBaseCredentials: true },
  }, { root }), { code: 'ERR_CONFIG_INVALID' });

  const unchanged = await readConfigRecord({ root });
  assert.equal(unchanged.revision, 1);
  assert.equal(unchanged.base.apiKey, '');
  assert.equal(unchanged.image.apiKey, '');
});
