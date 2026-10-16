import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { publicCompanyConfig, readCompanyConfig, saveCompanyConfig } from '../src/company/config.mjs';

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-company-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('company dataRoot has a separate default and honors STUDIO_DATA_DIR', () => {
  const moduleUrl = pathToFileURL(path.resolve('src/canvas/client.mjs')).href;
  const home = path.join(os.tmpdir(), 'company-home-fixture');
  const dataHome = path.join(os.tmpdir(), 'company-xdg-fixture');
  const localAppData = path.join(os.tmpdir(), 'company-local-fixture');
  const script = `import { dataRoot } from ${JSON.stringify(moduleUrl)}; process.stdout.write(dataRoot());`;
  const environment = {
    PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home,
    XDG_DATA_HOME: dataHome, LOCALAPPDATA: localAppData,
  };
  const defaultResult = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: environment });
  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  const expected = process.platform === 'darwin'
    ? path.join(home, 'Library/Application Support/Creative Agent Studio Company')
    : process.platform === 'win32'
      ? path.join(localAppData, 'Creative Agent Studio Company')
      : path.join(dataHome, 'creative-agent-studio-company');
  assert.equal(defaultResult.stdout, expected);

  const explicit = path.join(os.tmpdir(), 'company-explicit-data');
  const explicitResult = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...environment, STUDIO_DATA_DIR: explicit },
  });
  assert.equal(explicitResult.status, 0, explicitResult.stderr);
  assert.equal(explicitResult.stdout, explicit);
});

test('private company config preserves blank secrets, supports explicit clear and removes secrets from public view', async (t) => {
  const root = await temporaryDirectory(t);
  assert.deepEqual(await readCompanyConfig({ root }), {
    revision: 1,
    teedy: { baseUrl: '', username: '', password: '' },
    canvas: { webUrl: '' },
  });

  const saved = await saveCompanyConfig({
    expectedRevision: 1,
    teedy: { baseUrl: 'https://teedy.example', username: 'operator', password: 'teedy-private' },
    canvas: { webUrl: 'https://canvas.example' },
  }, { root });
  assert.equal(saved.revision, 2);
  const publicView = publicCompanyConfig(saved);
  assert.deepEqual(publicView, {
    revision: 2,
    teedy: { baseUrl: 'https://teedy.example', username: 'operator', passwordConfigured: true },
    canvas: { webUrl: 'https://canvas.example' },
  });
  assert.doesNotMatch(JSON.stringify(publicView), /teedy-private|"password"|"token"|bridgeUrl|projectId|clientId/u);

  const updated = await saveCompanyConfig({
    expectedRevision: 2,
    teedy: { password: '' },
    canvas: { webUrl: 'https://canvas-two.example' },
  }, { root });
  assert.equal(updated.teedy.password, 'teedy-private');
  assert.equal(updated.canvas.webUrl, 'https://canvas-two.example');
  await assert.rejects(
    saveCompanyConfig({ expectedRevision: 2, teedy: { username: 'stale' } }, { root }),
    (error) => error.code === 'ERR_COMPANY_CONFIG_REVISION_CONFLICT' && error.actualRevision === 3,
  );

  const cleared = await saveCompanyConfig({ expectedRevision: 3, clearSecrets: ['teedy.password'] }, { root });
  assert.equal(cleared.revision, 4);
  assert.equal(cleared.teedy.password, '');
  assert.deepEqual(cleared.canvas, { webUrl: 'https://canvas-two.example' });
  const file = path.join(root, 'config', 'company.json');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), cleared);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  }
});

test('company config rejects stale revisions, invalid URLs, oversized values and unknown fields', async (t) => {
  const root = await temporaryDirectory(t);
  const invalidInputs = [
    { teedy: { baseUrl: 'http://teedy.example' } },
    { canvas: { webUrl: 'http://canvas.example' } },
    { teedy: { baseUrl: `https://${'a'.repeat(2001)}` } },
    { canvas: { bridgeUrl: 'http://127.0.0.1:4312' } },
    { canvas: { token: 'obsolete-global-secret' } },
    { canvas: { projectId: 'obsolete-global-project' } },
  ];
  for (const fields of invalidInputs) {
    await assert.rejects(saveCompanyConfig({ expectedRevision: 1, ...fields }, { root }));
  }
  await assert.rejects(saveCompanyConfig({ expectedRevision: 1, clearSecrets: ['canvas.token'] }, { root }));
  await assert.rejects(saveCompanyConfig({ teedy: {} }, { root }), (error) => error.code === 'ERR_COMPANY_CONFIG_REVISION_REQUIRED');
});

test('Teedy identity changes cannot carry a saved password to a different service or account', async (t) => {
  const root = await temporaryDirectory(t);
  const first = await saveCompanyConfig({
    expectedRevision: 1,
    teedy: { baseUrl: 'https://teedy-one.example', username: 'one', password: 'old-password' },
  }, { root });
  await assert.rejects(
    saveCompanyConfig({ expectedRevision: first.revision, teedy: { baseUrl: 'https://teedy-two.example' } }, { root }),
    (error) => error.code === 'ERR_COMPANY_CONFIG_SECRET_CONTEXT',
  );
  await assert.rejects(
    saveCompanyConfig({ expectedRevision: first.revision, teedy: { username: 'two' } }, { root }),
    (error) => error.code === 'ERR_COMPANY_CONFIG_SECRET_CONTEXT',
  );
  const updated = await saveCompanyConfig({
    expectedRevision: first.revision,
    teedy: { baseUrl: 'https://teedy-two.example', password: 'new-password' },
  }, { root });
  assert.equal(updated.teedy.password, 'new-password');
  assert.deepEqual(updated.canvas, { webUrl: '' });
});

test('company config rejects symlinked config directories and files', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink fixture requires POSIX permissions');
  const root = await temporaryDirectory(t);
  const outside = await temporaryDirectory(t);
  await fs.mkdir(path.join(outside, 'config'));
  await fs.symlink(path.join(outside, 'config'), path.join(root, 'config'));
  await assert.rejects(readCompanyConfig({ root }), (error) => error.code === 'ERR_COMPANY_CONFIG_PATH');
  await assert.rejects(saveCompanyConfig({ expectedRevision: 1 }, { root }), (error) => error.code === 'ERR_COMPANY_CONFIG_PATH');

  const secondRoot = await temporaryDirectory(t);
  await fs.mkdir(path.join(secondRoot, 'config'));
  await fs.writeFile(path.join(outside, 'company.json'), '{}');
  await fs.symlink(path.join(outside, 'company.json'), path.join(secondRoot, 'config', 'company.json'));
  await assert.rejects(readCompanyConfig({ root: secondRoot }), (error) => error.code === 'ERR_COMPANY_CONFIG_PATH');
});
