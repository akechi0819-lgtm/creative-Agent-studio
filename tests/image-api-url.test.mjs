import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyImageApi } from '../src/lite/setup.mjs';
import { saveConfig } from '../src/lite/config.mjs';

const cases = [
  ['root URL', 'https://images.example', 'https://images.example/v1/models'],
  ['/v1 URL', 'https://images.example/v1', 'https://images.example/v1/models'],
  ['trailing slash', 'https://images.example/v1/', 'https://images.example/v1/models'],
  ['custom prefix', 'https://images.example/custom/gateway', 'https://images.example/custom/gateway/v1/models'],
  ['custom prefix ending in /v1/', 'https://images.example/custom/gateway/v1/', 'https://images.example/custom/gateway/v1/models'],
];

for (const [label, baseUrl, expectedUrl] of cases) {
  test(`image API model check uses the Canvas-compatible URL for ${label}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-api-url-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await saveConfig({
      expectedRevision: 1,
      image: { baseUrl, model: 'image-v2', apiKey: 'fixture-secret' },
    }, { root });

    let requestedUrl;
    const result = await verifyImageApi({
      root,
      fetchImpl: async (url, options) => {
        requestedUrl = url;
        assert.equal(options.method, 'GET');
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'image-v2' }] }) };
      },
    });

    assert.equal(requestedUrl, expectedUrl);
    assert.equal(result.ok, true);
  });
}
