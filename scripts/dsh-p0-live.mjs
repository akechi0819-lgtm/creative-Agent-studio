import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { callCanvasTool, connection, health } from '../src/canvas/client.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.resolve(process.env.STUDIO_DATA_DIR || path.join(root, '.p0-state/runtime'))
process.env.STUDIO_DATA_DIR = dataDir

const liveRoot = path.join(root, '.p0-state/dsh-live')
const dshHome = path.join(liveRoot, 'home')
const pluginPath = path.join(root, 'adapters/dsh/live-plugin.mjs')
const cliPath = path.join(root, 'adapters/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
const patchPath = path.join(liveRoot, 'live.cordis.patch.yml')
const credentialPath = path.join(root, '.p0-state/model-credentials.json')
const visionReferencePath = path.join(root, '.p0-state/vision-reference.json')
const reportPath = path.join(root, 'docs/evidence/p0/dsh-live-report.json')
const completionPath = path.join(dataDir, 'dsh-live-complete')
const modelKeyEnv = 'STUDIO_DSH_LIVE_API_KEY'
let requestedModel
const marker = `DSH-LIVE-P0-${Date.now()}-${process.pid}`
const sessionId = `dsh-live-p0-${Date.now()}-${process.pid}`

function fail(message) {
  throw new Error(message)
}

function safeError(error, apiKey = '') {
  let message = error instanceof Error ? error.message : String(error || 'unknown error')
  if (apiKey) message = message.split(apiKey).join('[REDACTED]')
  message = message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s)]+/gi, '[URL]')
    .slice(0, 300)
  return message
}

function textNodes(state) {
  return Array.isArray(state?.nodes) ? state.nodes.filter((node) => node.type === 'text') : []
}

async function runDsh(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--use-env-proxy', cliPath,
      '--profile', 'web',
      '--patch', patchPath,
      '--no-open',
      '--host', '127.0.0.1',
      '--port', '0',
    ], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffer = ''
    let outcome
    let settled = false
    let killTimer
    const timeout = setTimeout(() => {
      outcome = { kind: 'timeout' }
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
    }, 240_000)

    const consume = (chunk) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (line.startsWith('[dsh-live] RESULT ')) {
          try {
            outcome = { kind: 'result', value: JSON.parse(line.slice('[dsh-live] RESULT '.length)) }
          } catch {
            outcome = { kind: 'invalid-result' }
          }
          child.kill('SIGTERM')
          killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
        } else if (line.startsWith('[dsh-live] FAIL ')) {
          try {
            outcome = { kind: 'failure', value: JSON.parse(line.slice('[dsh-live] FAIL '.length)) }
          } catch {
            outcome = { kind: 'failure', value: { stage: 'plugin', message: 'unparseable failure receipt' } }
          }
          child.kill('SIGTERM')
          killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
        }
      }
    }

    child.stdout.on('data', consume)
    child.stderr.on('data', consume)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(killTimer)
      reject(new Error(`DSH child start failed (${error.name})`))
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(killTimer)
      if (outcome?.kind === 'result') resolve(outcome.value)
      else if (outcome?.kind === 'failure') {
        const where = outcome.value.stage || 'plugin'
        const detail = outcome.value.message || 'unavailable'
        reject(new Error(`DSH ${where} failed: ${detail}`))
      } else if (outcome?.kind === 'timeout') reject(new Error('DSH live model turn timed out after 240 seconds'))
      else reject(new Error(`DSH exited before a completion receipt (code=${code ?? 'none'}, signal=${signal ?? 'none'})`))
    })
  })
}

let apiKey = ''
let childEnvironment
try {
  const credentialStat = await stat(credentialPath)
  if ((credentialStat.mode & 0o077) !== 0) fail('authorized model credential file permissions must remain 0600')
  const credentials = JSON.parse(await readFile(credentialPath, 'utf8'))
  if (typeof credentials.model !== 'string' || !credentials.model.trim()) fail('model config is missing its model id')
  requestedModel = credentials.model.trim()
  if (typeof credentials.baseUrl !== 'string' || typeof credentials.apiKey !== 'string' || !credentials.apiKey) {
    fail('authorized model credential file is missing required fields')
  }
  const endpoint = new URL(credentials.baseUrl)
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) fail('configured model endpoint is invalid')
  apiKey = credentials.apiKey

  const canvas = await connection()
  const current = await health(canvas)
  if (process.env.STUDIO_PROJECT_ID && process.env.STUDIO_PROJECT_ID !== canvas.projectId) fail('configured STUDIO_PROJECT_ID does not match the running Canvas instance')
  process.env.STUDIO_PROJECT_ID = canvas.projectId
  const targets = (current.targets || []).filter((target) => target.projectId === canvas.projectId && target.hasCanvas)
  if (targets.length !== 1) fail(`expected one connected Canvas target for this project, found ${targets.length}`)

  const visionReference = JSON.parse(await readFile(visionReferencePath, 'utf8'))
  if (visionReference.instanceId !== canvas.instanceId || !visionReference.nodeId) fail('vision reference does not belong to the running Canvas instance')
  const before = await callCanvasTool('canvas_get_state', {}, { ...canvas, clientId: targets[0].clientId })
  const sourceNode = Array.isArray(before?.nodes) && before.nodes.find((node) => node.id === visionReference.nodeId && node.type === 'image')
  if (!sourceNode) fail('the existing reference image node is not present in the selected Canvas')

  await mkdir(dshHome, { recursive: true, mode: 0o700 })
  await chmod(dshHome, 0o700)
  await mkdir(path.dirname(reportPath), { recursive: true })
  await unlink(completionPath).catch(() => {})
  const pluginYaml = JSON.stringify(pluginPath)
  const baseUrlYaml = JSON.stringify(credentials.baseUrl)
  const modelYaml = JSON.stringify(requestedModel)
  const patchText = [
    '- insert:',
    '    - id: creative-agent-studio-dsh-live-p0',
    `      name: ${pluginYaml}`,
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      studio-live:',
    `        apiKeyEnv: ${modelKeyEnv}`,
    '        api: openai-completions',
    `        baseURL: ${baseUrlYaml}`,
    '        models:',
    `          - id: ${modelYaml}`,
    '            input: [text, image]',
    '',
  ].join('\n')
  await writeFile(patchPath, patchText, { mode: 0o600 })

  childEnvironment = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || '/Users/akechi',
    TMPDIR: process.env.TMPDIR || '/tmp',
    LANG: process.env.LANG || 'en_US.UTF-8',
    DSH_HOME: dshHome,
    STUDIO_DATA_DIR: dataDir,
    STUDIO_PROJECT_ID: canvas.projectId,
    [modelKeyEnv]: apiKey,
    DSH_LIVE_MODEL: requestedModel,
    DSH_LIVE_MARKER: marker,
    DSH_LIVE_SESSION_ID: sessionId,
    DSH_LIVE_REFERENCE_NODE_ID: visionReference.nodeId,
    DSH_LIVE_INSTANCE_ID: canvas.instanceId,
    DSH_LIVE_CLIENT_ID: targets[0].clientId,
  }
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    if (process.env[name]) childEnvironment[name] = process.env[name]
  }

  const dshResult = await runDsh(childEnvironment)
  if (dshResult.status !== 'passed') fail('DSH plugin returned an unsuccessful status')
  if (dshResult.requestedModel !== requestedModel || dshResult.reportedProvider !== 'studio-live') fail('DSH result does not match the selected model route')
  if (dshResult.instanceId !== canvas.instanceId || dshResult.projectId !== canvas.projectId || dshResult.clientId !== targets[0].clientId) fail('DSH used a different Canvas target')
  if (dshResult.referenceNodeId !== visionReference.nodeId || !dshResult.imageAttachedToAgentMessage) fail('DSH agent turn did not receive the existing image attachment')
  if (dshResult.tool?.name !== 'studio_probe_text' || dshResult.tool.callCount !== 1 || dshResult.tool.resultCount !== 1 || dshResult.tool.isError) fail('the actual DSH tool round trip did not complete exactly once')
  if (!dshResult.agentTurn?.followupSubmitted || !dshResult.agentTurn?.idleReached) fail('DSH agent turn lifecycle was not confirmed')
  if (!dshResult.finalText || !dshResult.tool.arguments?.text?.startsWith(`${marker} `)) fail('model output is missing from the DSH tool or final response')

  const after = await callCanvasTool('canvas_get_state', {}, { ...canvas, clientId: targets[0].clientId })
  const createdNodes = textNodes(after).filter((node) => node.metadata?.content === dshResult.tool.arguments.text)
  const markerNodes = textNodes(after).filter((node) => String(node.metadata?.content || '').startsWith(marker))
  if (createdNodes.length !== 1 || markerNodes.length !== 1 || createdNodes[0].id !== dshResult.tool.nodeId) fail('the agent-created text node is not uniquely present in Canvas state')

  const report = {
    schemaVersion: 1,
    scope: 'P0 real DSH model turn and Canvas text tool',
    status: 'passed',
    verifiedAt: new Date().toISOString(),
    dependencies: {
      adapter: '@deepseek-ai/dsh-llm-pi-ai (installed in adapters/dsh; no package changes)',
      modelAdapter: 'openai-completions',
      node: process.version,
    },
    model: {
      requested: dshResult.requestedModel,
      modelFromDshMessage: dshResult.reportedApiModel,
      returnedResponseModel: dshResult.returnedResponseModel,
      returnedResponseModelSource: dshResult.returnedResponseModel ? 'assistant/message.source.replayState.response.responseModel' : 'not reported',
      internalEngineIdentity: 'not independently verifiable from the provider response',
      providerReportedByDshMessage: dshResult.reportedProvider,
      endpointValueRecorded: false,
      apiKeyRecorded: false,
    },
    canvas: {
      instanceId: canvas.instanceId,
      projectId: canvas.projectId,
      clientId: targets[0].clientId,
      referenceNodeId: visionReference.nodeId,
      image: dshResult.image,
      imageReadTool: 'canvas_read_image',
      attachedToUserMessage: true,
      textNodeId: createdNodes[0].id,
      textNode: dshResult.tool.arguments.text,
    },
    dsh: {
      sessionId: dshResult.sessionId,
      actualAgentFollowup: dshResult.agentTurn.followupSubmitted,
      agentReachedIdle: dshResult.agentTurn.idleReached,
      requestAccounting: {
        userFollowupSubmissions: 1,
        userMessageEvents: dshResult.agentTurn.userMessageEvents,
        assistantMessageEvents: dshResult.agentTurn.assistantMessageEvents,
        sessionTitleLlmRequestEvents: dshResult.agentTurn.sessionTitleLlmRequestEvents,
        providerHttpRequestCount: null,
        providerHttpRequestCountNote: 'not independently instrumented; counts above come from durable DSH session events',
      },
      eventTypes: dshResult.agentTurn.eventTypes,
      toolName: dshResult.tool.name,
      modelToolCalls: dshResult.tool.callCount,
      successfulToolResults: dshResult.tool.resultCount,
      toolResultText: dshResult.tool.resultText,
      finalAssistantText: dshResult.finalText,
    },
    boundaries: {
      wrongProjectHttpRequest: { passed: dshResult.checks.wrongProjectRejected, status: 403, canvasMutation: false },
      preDispatchAbort: { passed: dshResult.checks.preDispatchAbortRejected, canvasMutation: false },
      inFlightModelCancellation: 'not tested',
      upstreamApiError: 'not tested',
    },
    imageGeneration: 'not run; the existing Canvas image node was read and attached to the model request',
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 })
  await writeFile(completionPath, `${new Date().toISOString()}\n`, { mode: 0o600 })
  process.stdout.write(`[dsh-live-p0] PASS requestedModel=${requestedModel} returnedModel=${dshResult.returnedResponseModel || 'unavailable'} toolCalls=1 textNode=${createdNodes[0].id}\n`)
  process.stdout.write(`[dsh-live-p0] REPORT ${reportPath}\n`)
} catch (error) {
  const message = safeError(error, apiKey)
  const failureReport = {
    schemaVersion: 1,
    scope: 'P0 real DSH model turn and Canvas text tool',
    status: 'failed',
    verifiedAt: new Date().toISOString(),
    stageError: message,
    endpointValueRecorded: false,
    apiKeyRecorded: false,
  }
  await mkdir(path.dirname(reportPath), { recursive: true }).catch(() => {})
  await writeFile(reportPath, `${JSON.stringify(failureReport, null, 2)}\n`, { mode: 0o644 }).catch(() => {})
  process.stderr.write(`[dsh-live-p0] FAILED ${message}\n`)
  process.exitCode = 1
} finally {
  if (childEnvironment) childEnvironment[modelKeyEnv] = ''
  apiKey = ''
}
