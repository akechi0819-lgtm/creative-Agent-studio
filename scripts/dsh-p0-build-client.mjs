import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const workspaceRoot = path.resolve(scriptDir, '..')
const packageRoot = path.join(workspaceRoot, 'adapters/dsh')
const { build } = createRequire(path.join(packageRoot, 'package.json'))('esbuild')
const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
const outputDir = path.join(packageRoot, 'lib')
const result = await build({
  absWorkingDir: packageRoot,
  entryPoints: ['client/business-node.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: ['es2022'],
  jsx: 'automatic',
  external: ['react', 'react-dom'],
  define: { __DSH_P0_CWD__: JSON.stringify(workspaceRoot) },
  write: false,
  sourcemap: false,
  logLevel: 'silent',
})

const source = result.outputFiles[0].text
const clientBundle = `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(packageJson.name)},\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n${source}\n    return module.exports;\n  },\n});\n`

await mkdir(outputDir, { recursive: true })
await writeFile(path.join(outputDir, 'client.js'), clientBundle)
process.stdout.write(`[dsh-p0] UI_BUNDLE_BUILT id=${packageJson.name} bytes=${Buffer.byteLength(clientBundle)} path=adapters/dsh/lib/client.js\n`)
