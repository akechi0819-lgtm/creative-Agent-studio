import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataRoot } from '../src/canvas/client.mjs';
import { recordMaterialCheck } from '../src/lite/setup.mjs';
import { readMaterialConfig } from '../src/materials/config.mjs';
import { verifyMaterials } from '../src/materials/verify.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function materialsMcpConfiguration({ root = dataRoot() } = {}) {
  return {
    mcpServers: {
      'company-lite-materials': {
        command: process.execPath,
        args: [path.join(sourceRoot, 'scripts/materials-mcp.mjs')],
        env: { STUDIO_DATA_DIR: path.resolve(root) },
      },
    },
  };
}

async function runCheck() {
  const root = dataRoot();
  const config = await readMaterialConfig({ root });
  const report = await verifyMaterials(config ?? undefined, { root });
  if (config) await recordMaterialCheck(report, { root, credentialId: config.credentialId });
  const succeeded = report.authenticated && report.queryVerified && report.downloadVerified && report.bytes > 0 && report.sha256;
  console.log(JSON.stringify({ ok: Boolean(succeeded), ...report }, null, 2));
  if (!succeeded) process.exitCode = 1;
}

async function main() {
  const [command = 'mcp-config'] = process.argv.slice(2);
  if (command === 'mcp-config') {
    console.log(JSON.stringify(materialsMcpConfiguration(), null, 2));
    return;
  }
  if (command === 'check') return runCheck();
  throw new Error('用法：node scripts/materials.mjs mcp-config | check');
}

main().catch(() => {
  console.error(JSON.stringify({ ok: false, failedStage: 'config' }));
  process.exitCode = 1;
});
