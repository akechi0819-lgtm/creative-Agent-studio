import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publicConfig, readConfig, readConfigRecord, saveConfig } from '../src/lite/config.mjs';

async function withRoot(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-lite-config-'));
  try { await run(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('stores only an image channel, keeps it private, and never exposes its API key publicly', async () => {
  await withRoot(async (root) => {
    const initial = await readConfigRecord({ root });
    assert.deepEqual(initial, {
      schemaVersion: 1,
      revision: 1,
      image: { baseUrl: '', model: '', apiKey: '' },
    });
    assert.equal(Object.hasOwn(initial, 'base'), false);

    const saved = await saveConfig({
      expectedRevision: 1,
      image: { baseUrl: 'https://images.example/v1', model: 'image-v2', apiKey: 'secret-image-key' },
    }, { root });
    assert.equal(saved.revision, 2);
    assert.equal(saved.image.apiKey, 'secret-image-key');
    assert.equal(Object.hasOwn(saved, 'base'), false);

    const internal = await readConfig({ root });
    assert.deepEqual(internal, { revision: 2, image: saved.image });
    const visible = publicConfig(saved);
    assert.deepEqual(visible, {
      revision: 2,
      image: { baseUrl: 'https://images.example/v1', model: 'image-v2', apiKeyConfigured: true },
    });
    assert.equal(JSON.stringify(visible).includes('secret-image-key'), false);

    const file = await fs.readFile(path.join(root, 'config', 'studio.json'), 'utf8');
    assert.equal(file.includes('"base"'), false);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(path.join(root, 'config'))).mode & 0o777, 0o700);
      assert.equal((await fs.stat(path.join(root, 'config', 'studio.json'))).mode & 0o777, 0o600);
    }
  });
});

test('blank keys preserve the saved secret, clearKeys removes it, and revisions reject stale writes', async () => {
  await withRoot(async (root) => {
    const saved = await saveConfig({
      expectedRevision: 1,
      image: { baseUrl: 'https://images.example/v1', model: 'image-v2', apiKey: 'saved-secret' },
    }, { root });

    const retained = await saveConfig({
      expectedRevision: saved.revision,
      image: { baseUrl: 'https://images.example/v1', model: 'image-v3', apiKey: '' },
    }, { root });
    assert.equal(retained.image.apiKey, 'saved-secret');

    await assert.rejects(
      saveConfig({ expectedRevision: saved.revision, image: { model: 'stale' } }, { root }),
      (error) => error.code === 'ERR_CONFIG_REVISION_CONFLICT',
    );
    const cleared = await saveConfig({
      expectedRevision: retained.revision,
      image: { model: 'image-v3' },
      clearKeys: ['image'],
    }, { root });
    assert.equal(cleared.image.apiKey, '');
    assert.equal(publicConfig(cleared).image.apiKeyConfigured, false);
  });
});

test('rejects embedded credentials, query strings, and unknown fields in image settings', async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      saveConfig({ expectedRevision: 1, image: { baseUrl: 'https://user:pass@example.test/v1', model: 'm' } }, { root }),
      (error) => error.code === 'ERR_CONFIG_INVALID',
    );
    await assert.rejects(
      saveConfig({ expectedRevision: 1, image: { baseUrl: 'https://example.test/v1?token=x', model: 'm' } }, { root }),
      (error) => error.code === 'ERR_CONFIG_INVALID',
    );
    await assert.rejects(
      saveConfig({ expectedRevision: 1, image: { model: 'm', source: 'workbuddy' } }, { root }),
      (error) => error.code === 'ERR_CONFIG_INVALID',
    );
  });
});

test('rejects persisted non-image channels instead of silently dropping them', async () => {
  await withRoot(async (root) => {
    const directory = path.join(root, 'config');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'studio.json'), JSON.stringify({
      schemaVersion: 1,
      revision: 2,
      base: { baseUrl: 'https://text.example/v1', apiKey: 'must-not-be-retained' },
      image: { baseUrl: '', model: '', apiKey: '' },
    }));
    await assert.rejects(readConfigRecord({ root }), (error) => error.code === 'ERR_CONFIG_CORRUPT');
  });
});
