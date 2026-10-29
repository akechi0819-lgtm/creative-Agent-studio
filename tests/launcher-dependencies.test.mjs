import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDependencyGroup } from '../src/launcher/dependencies.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('source preparation recognizes the locked MCP SDK public runtime entry', async () => {
  const result = await checkDependencyGroup({ cwd: projectRoot, nodePath: process.execPath });
  assert.equal(result.ready, true, result.reason);
});
