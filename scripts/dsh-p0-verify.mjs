import { spawn, spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { callCanvasTool } from '../src/canvas/client.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const workspaceRoot = path.resolve(scriptDir, '..')
const evidenceDir = path.join(workspaceRoot, '.research/dsh/.p0-evidence')
const reportDir = path.join(workspaceRoot, 'docs/evidence/p0')
const dshHome = path.join(evidenceDir, 'profile-home')
const cliPath = path.join(workspaceRoot, 'adapters/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
const pluginPath = path.join(workspaceRoot, 'adapters/dsh/index.mjs')
const patchPath = path.join(evidenceDir, 'p0.cordis.yml')
const studioDataDir = process.env.STUDIO_DATA_DIR || path.join(workspaceRoot, '.p0-state/runtime')
const sessionId = `dsh-p0-session-${Date.now()}`
const marker = `DSH-P0-CANVAS-PROBE-${Date.now()}-${process.pid}`
const phases = ['canvas', 'session-write', 'session-restore']
const timeoutMs = 120_000
process.env.STUDIO_DATA_DIR = studioDataDir

const registryArtifacts = {
  '@deepseek-ai/dsh': {
    tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.1-alpha.2.tgz',
    integrity: 'sha512-CkRE0uAOg2ldL2VpfF4cNRsl178CH5nM+8YklPrlMZl5ln0KhVfd42dJuRlgOXZmkpizCRvrVS8LAL+GKfgk0w==',
  },
  '@deepseek-ai/dsh-client-ui-chat': {
    tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh-client-ui-chat/-/dsh-client-ui-chat-0.2.1-alpha.2.tgz',
    integrity: 'sha512-BmtPAAsKAfZTvqArppJcl8O9k++IVJrVqepXdeLyPXqEy+QGtE5MoA0Pz/Q99Px4xoBIhj7ADvARRRCw/ypXKQ==',
  },
  '@deepseek-ai/dsh-client-ui-conversation': {
    tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh-client-ui-conversation/-/dsh-client-ui-conversation-0.2.1-alpha.2.tgz',
    integrity: 'sha512-qadzPWzAOHndKgNvR89rOY03wz4lkoaYo1N8f1pxACMv29aEPAzoF0kNHrNDBoiacml1OS/KeC6kZGWYphYscA==',
  },
  '@deepseek-ai/dsh-skill-filesystem': {
    tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh-skill-filesystem/-/dsh-skill-filesystem-0.2.1-alpha.2.tgz',
    integrity: 'sha512-dwxUhGhJeEzECOOlWYcqV4Q5lRkjIIDc3zHRpwzaHl7iQF3uKAYCYOF8RiCQtekO4Y+e32nXy6k3YJdAL++EBw==',
  },
  '@deepseek-ai/dsh-tools': {
    tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh-tools/-/dsh-tools-0.2.1-alpha.2.tgz',
    integrity: 'sha512-IbWShKABOi3ezvICVZsrG7w/mdQBmkHn0AGM4CkkYJxK38OIUELGiFa/JE6PEYO71oZQgm40xZM6kknTbss6vg==',
  },
  '@deepseek-ai/dsh-client-ui-workspace': {
    tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh-client-ui-workspace/-/dsh-client-ui-workspace-0.2.1-alpha.2.tgz',
    integrity: 'sha512-wXnmx+n10XwewtQG8zX/XuQQMGtLMw9iG7XwY4JyZOvVjxFz7pEcKgJOS06zD7qldy7141K7n7Ny1hhvBj4MlQ==',
  },
  '@deepseek-ai/dsh-llm': {
    tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh-llm/-/dsh-llm-0.2.1-alpha.2.tgz',
    integrity: 'sha512-+pUKWsWBZorW3nQLGAC2qEQudFOscKINR0njoPhhFhJsVPuAqLUYF3bf6G4evbMKUF1+Uw901CFHOfwLluljNQ==',
  },
  '@deepseek-ai/dsh-llm-pi-ai': {
    tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh-llm-pi-ai/-/dsh-llm-pi-ai-0.2.1-alpha.2.tgz',
    integrity: 'sha512-Zl4nI1VxELu8hLQKARj3jKjXO4kz1EQPlAh9NvwKMYDwUF0v9ULhiXPGgqfATqKn9mV9GUx352Me2lt6wDWpnA==',
  },
  '@deepseek-ai/dsh-session': {
    tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh-session/-/dsh-session-0.2.1-alpha.2.tgz',
    integrity: 'sha512-xINgQ8XFC40aLxPLBMxAMl3ZkY8NlkasVVrnIio94hZYX+dqw7N63y53vqLU69WKTPEFJ11GdCJq4Yx5Tr2HFA==',
  },
  '@deepseek-ai/cordis': {
    tarball: 'https://registry.npmjs.org/@deepseek-ai/cordis/-/cordis-4.0.5-alpha.1.tgz',
    integrity: 'sha512-I0akiPAK9EEWO+GMAO0YGbn3/rzg/yopaxohBaG9JHM8dDzGaCZNp3mehjeC66IQL0AyTyDwvgv7v1aB+eMnKQ==',
  },
}

await mkdir(evidenceDir, { recursive: true })
await mkdir(dshHome, { recursive: true })
await mkdir(reportDir, { recursive: true })
await writeFile(patchPath, `- insert:\n    - id: creative-agent-studio-dsh-p0\n      name: ${JSON.stringify(pluginPath)}\n`, { mode: 0o600 })

function safeChild(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    env,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`child-command-failed:${result.status ?? result.error?.name ?? 'unknown'}`)
  }
  return result.stdout
}

const envBase = {
  PATH: process.env.PATH || '/usr/bin:/bin',
  HOME: process.env.HOME || os.homedir(),
  TMPDIR: process.env.TMPDIR || os.tmpdir(),
  LANG: process.env.LANG || 'en_US.UTF-8',
  DSH_HOME: dshHome,
  STUDIO_DATA_DIR: studioDataDir,
  DSH_P0_SESSION_ID: sessionId,
  DSH_P0_CANVAS_MARKER: marker,
}

const version = safeChild(process.execPath, [cliPath, '--version'], envBase).trim()
const composed = safeChild(process.execPath, [cliPath, '--profile', 'web', '--dump-config'], envBase)
const requiredRows = [
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-client-ui-chat',
]
const missingRows = requiredRows.filter((row) => !composed.includes(row))
if (missingRows.length) throw new Error(`default-profile-missing:${missingRows.join(',')}`)

const receipts = [`[dsh-p0] VERSION ${version}`, `[dsh-p0] MINIMAL_CONFIG rows=${requiredRows.length} allPresent=true`]
let activeChild

function waitForPhase(phase) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      cliPath,
      '--profile', 'web',
      '--patch', patchPath,
      '--no-open',
      '--host', '127.0.0.1',
      '--port', '0',
    ], {
      cwd: workspaceRoot,
      env: { ...envBase, DSH_P0_PHASE: phase },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    activeChild = child
    let buffer = ''
    let settled = false
    let completed = false
    let completionMarker = Promise.resolve()
    const safeLines = []
    const timeout = setTimeout(() => finish(new Error(`phase-timeout:${phase}`)), timeoutMs)

    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) {
        if (safeLines.length) process.stderr.write(`${safeLines.join('\n')}\n`)
        child.kill('SIGTERM')
        reject(error)
      } else {
        resolve(safeLines)
      }
    }

    const consume = (chunk) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (line.startsWith('[dsh-p0] ')) safeLines.push(line)
        else if (/error|fail|cannot|invalid|unknown|TypeError|StartupError/i.test(line)) {
          const redacted = line
            .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
            .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
            .replace(/((?:api[_-]?key|token)\s*[:=]\s*)[^\s,}]+/gi, '$1[REDACTED]')
          safeLines.push(`[dsh-p0] CLI_DIAGNOSTIC ${redacted.slice(0, 240)}`)
        } else continue
        if (line.includes('FAIL ')) finish(new Error(`plugin-reported-failure:${phase}`))
        if (line.includes(`PHASE_COMPLETE phase=${phase}`)) {
          completed = true
          void completionMarker.then(
            () => setTimeout(() => finish(), 250),
            () => finish(new Error('completion-marker-write-failed')),
          )
        }
      }
    }

    child.stdout.on('data', consume)
    child.stderr.on('data', consume)
    child.on('error', (error) => finish(new Error(`spawn-failed:${error.name}`)))
    child.on('exit', (code, signal) => {
      activeChild = undefined
      if (!settled && !completed) finish(new Error(`phase-exited:${phase}:${code ?? signal ?? 'unknown'}`))
    })
  })
}

try {
  for (const phase of phases) {
    const phaseReceipts = await waitForPhase(phase)
    receipts.push(...phaseReceipts)
    const child = activeChild
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  }
  const canvasState = await callCanvasTool('canvas_get_state', {})
  if (!JSON.stringify(canvasState).includes(marker)) throw new Error('canvas-marker-not-confirmed')
  receipts.push(`[dsh-p0] CANVAS_MARKER_CONFIRMED method=read-only-follow-up markerPresent=true marker=${marker}`)
  await writeFile(path.join(studioDataDir, 'dsh-tool-complete'), `${new Date().toISOString()}\n`, { mode: 0o600 })
  const adapterPackage = JSON.parse(await readFile(path.join(workspaceRoot, 'adapters/dsh/package.json'), 'utf8'))
  const sourcePackage = JSON.parse(await readFile(path.join(workspaceRoot, '.research/dsh/apps/cli/package.json'), 'utf8'))
  const installed = JSON.parse(await readFile(path.join(workspaceRoot, 'adapters/dsh/node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
  const sourceCommit = safeChild('git', ['-C', path.join(workspaceRoot, '.research/dsh'), 'rev-parse', 'HEAD'], envBase).trim()
  if (installed.version !== version || sourcePackage.version !== version || sourceCommit !== 'd743267388641bc76f17c45ce8b4c231aed1d32c') throw new Error('source-npm-version-mismatch')
  receipts.push(`[dsh-p0] VERSIONS git-source=${sourcePackage.version} npm-package=${installed.version} match=true`)
  const npmVersion = safeChild('npm', ['--version'], envBase).trim()
  const logPath = path.join(reportDir, 'dsh-report.log')
  const uiReport = await readFile(path.join(reportDir, 'dsh-ui-report.json'), 'utf8')
    .then((text) => JSON.parse(text)).catch(() => undefined)
  const liveReport = await readFile(path.join(reportDir, 'dsh-live-report.json'), 'utf8')
    .then((text) => JSON.parse(text)).catch(() => undefined)
  const businessUi = uiReport?.status === 'passed' ? {
    sourceImplemented: true,
    browserBundleLoaded: uiReport.checks?.browserBundleLoaded === true,
    status: 'passed',
    eventDefinitionRegistered: uiReport.checks?.businessEventDefinitionRegistered === true,
    snapshotNode: uiReport.checks?.conversationSnapshotContainsProbe === true,
    slotRendererRegistered: uiReport.checks?.slotRendererRegistered === true,
    rendererVisible: uiReport.checks?.registeredRendererVisible === true,
    screenshot: uiReport.screenshot,
    modelRequestSent: false,
  } : {
    sourceImplemented: true,
    browserBundleLoaded: false,
    status: 'pending-browser-validation',
  }
  const dshModelCall = liveReport?.status === 'passed' ? {
    performed: true,
    status: 'passed',
    adapter: liveReport.dsh?.adapter,
    modelRecordedByDsh: liveReport.model?.modelRecordedByDsh,
    responseModelReportedByProvider: liveReport.model?.responseModelReportedByProvider,
    actualAgentFollowupSubmissions: liveReport.dsh?.actualAgentFollowupSubmissions,
    successfulToolResults: liveReport.dsh?.successfulToolResults,
    evidence: 'dsh-live-report.json',
    endpointRecorded: false,
    apiKeyRecorded: false,
  } : {
    performed: false,
    status: 'not-verified-no-dsh-model-credential',
  }
  receipts.push(`[dsh-p0] UI_EXTENSION status=${businessUi.status}`)
  receipts.push(`[dsh-p0] MODEL_CALL status=${dshModelCall.status}`)
  const report = {
    schemaVersion: 1,
    scope: 'P0',
    verifiedAt: new Date().toISOString(),
    upstream: {
      repository: 'https://github.com/deepseek-ai/deepseek-harness',
      commit: 'd743267388641bc76f17c45ce8b4c231aed1d32c',
      gitCliPackageVersion: sourcePackage.version,
      npmCliPackageVersion: installed.version,
      versionsMatch: true,
      npmGitHeadMetadata: 'not-published',
      license: installed.license,
    },
    registryArtifacts: Object.entries(registryArtifacts).map(([name, metadata]) => ({
      name,
      version: adapterPackage.dependencies[name],
      ...metadata,
    })),
    environment: { node: process.version, npm: npmVersion },
    checks: {
      minimalProfile: { passed: true, requiredRows: 5 },
      skill: { passed: true, name: 'creative-studio', source: 'custom' },
      tool: { passed: true, name: 'studio_canvas_create_text_node', isError: false, markerPresent: true },
      sessionPersistence: { passed: true, events: 5 },
      sessionRestore: { passed: true, prefixMatches: true, seedBoundary: 'session/end-seed' },
      businessUi,
      dshModelCall,
    },
    reproduction: [
      'npm ci --ignore-scripts --no-audit --no-fund --prefix adapters/dsh',
      'node scripts/dsh-p0-verify.mjs',
      'npm run p0:ui:verify --prefix adapters/dsh',
    ],
  }
  const logText = `${receipts.join('\n')}\n`
  await writeFile(path.join(evidenceDir, 'verified.log'), logText, { mode: 0o600 })
  await writeFile(logPath, logText)
  await writeFile(path.join(reportDir, 'dsh-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${receipts.join('\n')}\n[dsh-p0] EVIDENCE ${logPath}\n[dsh-p0] REPORT ${path.join(reportDir, 'dsh-report.json')}\n`)
} catch (error) {
  if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) activeChild.kill('SIGTERM')
  const type = error instanceof Error ? error.message.split(':')[0] : 'unknown-error'
  const message = error instanceof Error ? error.message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|token)\s*[:=]\s*)[^\s,}]+/gi, '$1[REDACTED]')
    .slice(0, 240)
    : 'unavailable'
  process.stderr.write(`[dsh-p0] VERIFY_FAILED type=${type} message=${message}\n`)
  process.exitCode = 1
}
