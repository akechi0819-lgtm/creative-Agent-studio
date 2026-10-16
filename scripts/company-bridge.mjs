#!/usr/bin/env node
import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { dataRoot as defaultDataRoot } from '../src/canvas/client.mjs';
import { readCompanyConfig } from '../src/company/config.mjs';
import { companyBridgeStatus, ensureDetachedCompanyBridge, startCompanyBridge, stopCompanyBridge } from '../src/company/bridge.mjs';

export { companyBridgeStatus, ensureDetachedCompanyBridge, startCompanyBridge, stopCompanyBridge };

async function askMissingConfig(options) {
  const root = options.root || defaultDataRoot();
  const current = await readCompanyConfig({ root });
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const webUrl = options.webUrl || current.canvas.webUrl || await rl.question('公司 Canvas Web HTTPS 地址: ');
    const taskId = options.taskId || await rl.question('本地任务 ID: ');
    return { ...options, root, webUrl: webUrl.trim(), taskId: taskId.trim() };
  } finally { rl.close(); }
}

async function main() {
  const [command = 'start', ...args] = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--web-url' && args[index + 1]) options.webUrl = args[++index];
    else if (args[index] === '--task-id' && args[index + 1]) options.taskId = args[++index];
    else throw new Error('用法：node scripts/company-bridge.mjs [start|status|stop] [--web-url URL] [--task-id ID]');
  }
  if (command === 'status' || command === 'stop') {
    const value = command === 'status'
      ? await companyBridgeStatus({ taskId: options.taskId })
      : await stopCompanyBridge({ taskId: options.taskId });
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if (command !== 'start') throw new Error('用法：node scripts/company-bridge.mjs [start|status|stop] [--web-url URL] [--task-id ID]');
  const configured = await askMissingConfig(options);
  const handle = await startCompanyBridge(configured);
  process.stdout.write(`${JSON.stringify({ running: handle.running, state: handle.state, reused: handle.reused, protocolVersion: handle.protocolVersion, tokenConfigured: handle.tokenConfigured })}\n`);
  if (handle.reused) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      resolve();
    };
    const shutdown = () => { void handle.stop().then(finish, finish); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    handle.stopped?.then(finish, finish);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code?.startsWith('ERR_COMPANY_BRIDGE') ? error.message : '公司 Canvas bridge 操作失败'}\n`);
    process.exitCode = 1;
  });
}
