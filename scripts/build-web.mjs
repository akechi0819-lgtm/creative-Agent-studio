import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const outputRoot = path.join(webRoot, 'dist');

await fs.rm(outputRoot, { recursive: true, force: true });
await fs.mkdir(path.join(outputRoot, 'assets'), { recursive: true });
await fs.copyFile(path.join(webRoot, 'index.html'), path.join(outputRoot, 'index.html'));
await fs.cp(path.join(webRoot, 'public'), outputRoot, { recursive: true });

await build({
  entryPoints: [path.join(webRoot, 'src/main.jsx')],
  outfile: path.join(outputRoot, 'assets/app.js'),
  bundle: true,
  external: ['/brand/*'],
  minify: true,
  sourcemap: false,
  jsx: 'automatic',
  loader: { '.png': 'file', '.svg': 'file' },
  assetNames: 'assets/[name]-[hash]',
  logLevel: 'info',
});

console.log(`Built Studio Web UI to ${path.relative(root, outputRoot)}`);
