import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publicConfig, readConfig, readConfigRecord, saveConfig, saveVideoConfig, validateCompanyDefaults, VIDEO_PROVIDER } from '../src/lite/config.mjs';

async function withRoot(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-lite-config-'));
  try { await run(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('stores image and optional fixed H3 channels privately and never exposes API keys publicly', async () => {
  await withRoot(async (root) => {
    const initial = await readConfigRecord({ root });
    assert.deepEqual(initial, {
      schemaVersion: 1,
      revision: 1,
      imageRevision: 1,
      image: { baseUrl: '', model: '', apiKey: '' },
      video: { apiKey: '' },
    });
    assert.equal(Object.hasOwn(initial, 'base'), false);

    const saved = await saveConfig({
      expectedRevision: 1,
      image: { baseUrl: 'https://images.example/v1', model: 'image-v2', apiKey: 'secret-image-key' },
    }, { root });
    assert.equal(saved.revision, 2);
    assert.equal(saved.imageRevision, 2);
    assert.equal(saved.image.apiKey, 'secret-image-key');
    assert.equal(Object.hasOwn(saved, 'base'), false);

    const internal = await readConfig({ root });
    assert.deepEqual(internal, {
      revision: 2,
      imageRevision: 2,
      image: saved.image,
      video: { ...VIDEO_PROVIDER, apiKey: '' },
    });
    const visible = publicConfig(saved);
    assert.deepEqual(visible, {
      revision: 2,
      imageRevision: 2,
      image: { baseUrl: 'https://images.example/v1', model: 'image-v2', apiKeyConfigured: true },
      video: { ...VIDEO_PROVIDER, apiKeyConfigured: false },
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

test('video configuration uses file CAS without invalidating the image configuration revision', async () => {
  await withRoot(async (root) => {
    const image = await saveConfig({
      expectedRevision: 1,
      image: { baseUrl: 'https://images.example/v1', model: 'image-v2', apiKey: 'fixture-image-key' },
    }, { root });
    const video = await saveVideoConfig({
      expectedRevision: image.revision,
      video: { apiKey: 'fixture-video-key' },
    }, { root });

    assert.equal(video.revision, image.revision + 1);
    assert.equal(video.imageRevision, image.imageRevision);
    assert.equal(video.image.apiKey, 'fixture-image-key');
    assert.equal(video.video.apiKey, 'fixture-video-key');
    assert.deepEqual(publicConfig(video).video, { ...VIDEO_PROVIDER, apiKeyConfigured: true });
    assert.equal(JSON.stringify(publicConfig(video)).includes('fixture-video-key'), false);

    const file = JSON.parse(await fs.readFile(path.join(root, 'config', 'studio.json'), 'utf8'));
    assert.deepEqual(Object.keys(file.video), ['apiKey']);
    assert.equal(file.image.apiKey, 'fixture-image-key');
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(root, 'config', 'studio.json'))).mode & 0o777, 0o600);

    await assert.rejects(
      saveVideoConfig({ expectedRevision: image.revision, video: { apiKey: 'stale' } }, { root }),
      (error) => error.code === 'ERR_CONFIG_REVISION_CONFLICT',
    );

    const cleared = await saveVideoConfig({
      expectedRevision: video.revision,
      video: {},
      clearKeys: ['video'],
    }, { root });
    assert.equal(cleared.video.apiKey, '');
    assert.equal(cleared.imageRevision, image.imageRevision);
    assert.equal(publicConfig(cleared).video.apiKeyConfigured, false);
  });
});

test('rejects video provider overrides and unsupported private channels', async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      saveVideoConfig({ expectedRevision: 1, video: { baseUrl: 'https://evil.example', apiKey: 'fixture' } }, { root }),
      (error) => error.code === 'ERR_CONFIG_INVALID',
    );
    await assert.rejects(
      saveVideoConfig({ expectedRevision: 1, video: { apiKey: 'fixture', generateAudio: true } }, { root }),
      (error) => error.code === 'ERR_CONFIG_INVALID',
    );
  });
});

test('reads an existing image-only private config and supplies the optional video channel as unconfigured', async () => {
  await withRoot(async (root) => {
    const directory = path.join(root, 'config');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'studio.json'), JSON.stringify({
      schemaVersion: 1,
      revision: 4,
      image: { baseUrl: 'https://images.example/v1', model: 'image-v2', apiKey: 'fixture-image-key' },
    }));
    const record = await readConfigRecord({ root });
    assert.equal(record.revision, 4);
    assert.equal(record.imageRevision, 4);
    assert.equal(record.video.apiKey, '');
    assert.equal(publicConfig(record).video.apiKeyConfigured, false);
    assert.equal((await readConfig({ root })).video.apiKey, '');
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
      saveConfig({ expectedRevision: 1, image: { model: 'm', source: 'host' } }, { root }),
      (error) => error.code === 'ERR_CONFIG_INVALID',
    );
  });
});

test('rejects unsupported persisted channels instead of silently dropping them', async () => {
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

test('company defaults accept one non-secret materials base URL and reject the old MCP endpoint fields', () => {
  assert.deepEqual(validateCompanyDefaults({
    image: { baseUrl: 'https://images.example/v1', model: 'image-v2' },
    materials: { baseUrl: 'https://teedy.example' },
  }), {
    image: { baseUrl: 'https://images.example/v1', model: 'image-v2' },
    materials: { baseUrl: 'https://teedy.example', },
  });
  assert.throws(() => validateCompanyDefaults({ materials: { mcpUrl: 'https://teedy.example/mcp' } }), error => error.code === 'ERR_COMPANY_DEFAULTS_INVALID');
  assert.throws(() => validateCompanyDefaults({ materials: { loginUrl: 'https://teedy.example/login' } }), error => error.code === 'ERR_COMPANY_DEFAULTS_INVALID');
  assert.throws(() => validateCompanyDefaults({ materials: { baseUrl: 'http://teedy.example' } }), error => error.code === 'ERR_COMPANY_DEFAULTS_INVALID');
});
