import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = path.join(root, 'third_party/our-free-model/workbuddy')
const sourcePath = path.join(sourceDir, 'upstream-business.mjs')
const outputPath = path.join(sourceDir, 'runtime.mjs')
const expectedSourceHash = '13e407d870e276a3ccd55984119f87b745d1549b88ae2ad3a6476fb4b154fa6f'

const source = await fs.readFile(sourcePath, 'utf8')
const sourceHash = crypto.createHash('sha256').update(source).digest('hex')
if (sourceHash !== expectedSourceHash) {
  throw new Error(`上游 WorkBuddy bundle 校验失败：${sourceHash}`)
}

const exportStart = source.lastIndexOf('\nexport {')
if (exportStart < 0) throw new Error('上游 bundle 缺少末尾导出块')
const exportEnd = source.indexOf('};', exportStart)
if (exportEnd < 0 || source.slice(exportEnd + 2).trim() !== '') {
  throw new Error('上游 bundle 导出块格式已变化，停止生成')
}

let extracted = source.slice(0, exportStart)
function replaceOnce(before, after, description) {
  const first = extracted.indexOf(before)
  if (first < 0 || extracted.indexOf(before, first + before.length) >= 0) {
    throw new Error(`上游 ${description} 签名已变化，停止生成`)
  }
  extracted = `${extracted.slice(0, first)}${after}${extracted.slice(first + before.length)}`
}

// runBuddyLoginFlow 本身已经把 signal 传给 token/account 轮询；补上 auth/state 首请求。
replaceOnce(
  'const result = await fetchAuthState(fetcher, void 0, product);',
  'const result = await fetchAuthState(fetcher, options.signal, product);',
  'auth/state 取消信号'
)
replaceOnce(
  '  const pollOptions = {\n    fetcher,',
  '  const pollOptions = {\n    fetcher,\n    ...options.signal !== void 0 ? { signal: options.signal } : {},',
  '登录轮询取消信号'
)

extracted += `\nexport {\n  BuddyAuth, CODEBUDDY, WORKBUDDY, fetchAuthState, decorateLoginUrl, runBuddyLoginFlow,\n  makeReadImage, makeReadImageRequest, registerBuddyLlm, configureDeadModelStore,\n  toGenerateOptions, toResponsesGenerateOptions, normalizeReasoningEffort,\n  responsesReasoningEffort, normalizeMaxTokens, responsesMaxOutputTokens, markGatewayChannel,\n  collectGatewayModels, collectGatewayEffortViews, toOpenAiModels\n};\n`

const intermediate = path.join(sourceDir, `.workbuddy-extract-${process.pid}.mjs`)
try {
  await fs.writeFile(intermediate, extracted, { mode: 0o600, flag: 'wx' })
  await build({
    absWorkingDir: sourceDir,
    entryPoints: [intermediate],
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node22'],
    treeShaking: true,
    minifyWhitespace: true,
    sourcemap: false,
    metafile: true,
    logLevel: 'silent',
  })
} finally {
  await fs.rm(intermediate, { force: true })
}

const outputHash = crypto.createHash('sha256').update(await fs.readFile(outputPath)).digest('hex')
process.stdout.write(`[workbuddy] runtime built source=${sourceHash} output=${outputHash} bytes=${(await fs.stat(outputPath)).size}\n`)
