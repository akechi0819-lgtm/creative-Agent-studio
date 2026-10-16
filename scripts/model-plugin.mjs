import path from 'node:path';
import { startModelPlugin } from '../adapters/free-model/service.mjs';
const root = process.argv[2];
if (!root || !path.isAbsolute(root)) process.exit(2);
try {
  const service = await startModelPlugin({ root, onStop: () => process.exit(0) });
  process.once('SIGTERM', () => void service.close());
  process.once('SIGINT', () => void service.close());
  process.send?.({ ready: true });
} catch { process.exit(1); }
