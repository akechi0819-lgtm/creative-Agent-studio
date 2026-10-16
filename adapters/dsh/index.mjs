import { defineTool } from '@deepseek-ai/dsh-tools'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { callCanvasTool, root as workspaceRoot } from '../../src/canvas/client.mjs'
import path from 'node:path'

const TOOL_NAME = 'studio_canvas_create_text_node'
const SESSION_ID = process.env.DSH_P0_SESSION_ID
const MARKER = process.env.DSH_P0_CANVAS_MARKER

function errorType(error) {
  return error instanceof Error ? error.name : 'UnknownError'
}

function safeMessage(message) {
  return String(message || '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|token)\s*[:=]\s*)[^\s,}]+/gi, '$1[REDACTED]')
    .slice(0, 180)
}

async function loadStudioSkill(ctx) {
  await ctx.plugin(skillFilesystem, {
    providerName: 'dsh-p0-filesystem',
    includeDefaultRoots: false,
    customSkillDirs: [path.join(workspaceRoot, '.agents/skills')],
    watch: false,
  })
  const catalog = await ctx.skills.list({ cwd: workspaceRoot })
  const summary = catalog.find((entry) => entry.name === 'creative-studio')
  console.log(`[dsh-p0] SKILL_CATALOG name=creative-studio found=${Boolean(summary)} source=${summary?.source || 'none'}`)
  const skill = await ctx.skills.get('creative-studio', { cwd: workspaceRoot })
  if (!skill) throw Object.assign(new Error('skill-not-found'), { stage: 'skill-not-found' })
  if (!skill.content.includes('DSH 适配调用同一函数')) {
    throw Object.assign(new Error('skill-content-check-failed'), { stage: 'skill-content-check' })
  }
  console.log(`[dsh-p0] SKILL_LOADED name=${skill.name} source=${skill.source}`)
}

function registerCanvasTool(ctx) {
  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: 'P0 验证：在独立 Canvas 创建一个纯文本节点。',
    parameters: {
      text: { type: 'string', required: true, description: '节点文本' },
      x: { type: 'number', description: '水平位置' },
      y: { type: 'number', description: '垂直位置' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const before = await callCanvasTool('canvas_get_state', {})
      if (JSON.stringify(before).includes(args.text)) return { alreadyPresent: true }
      return callCanvasTool('canvas_create_text_node', args)
    },
  }))
  if (!ctx.tools.get(TOOL_NAME) || !ctx.tools.schemas().some((item) => item.name === TOOL_NAME)) {
    throw Object.assign(new Error('tool-registration-failed'), { stage: 'tool-registration' })
  }
  console.log(`[dsh-p0] TOOL_REGISTERED name=${TOOL_NAME}`)
}

async function runCanvasProbe(ctx) {
  const result = await ctx.tools.execute({
    callId: 'dsh-p0-canvas-probe',
    name: TOOL_NAME,
    arguments: { text: MARKER, x: 96, y: 96 },
    signal: new AbortController().signal,
  })
  if (result.isError) {
    const detail = result.error?.message || result.content?.find((block) => block.type === 'text')?.text || 'unavailable'
    throw Object.assign(new Error(`tool-execution-failed:${safeMessage(detail)}`), { stage: 'tool-execution' })
  }
  let markerPresent = false
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const after = await callCanvasTool('canvas_get_state', {})
    markerPresent = JSON.stringify(after).includes(MARKER)
    if (markerPresent) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!markerPresent) {
    throw Object.assign(new Error('canvas-node-not-visible'), { stage: 'canvas-confirmation' })
  }
  console.log(`[dsh-p0] TOOL_EXECUTED name=${TOOL_NAME} isError=false markerPresent=true alreadyPresent=${Boolean(result.value?.alreadyPresent)}`)
}

async function runSessionWrite(ctx) {
  if (!SESSION_ID) throw Object.assign(new Error('missing-session-id'), { stage: 'session-write' })
  const session = ctx.sessions.create(SESSION_ID, { meta: { cwd: workspaceRoot } })
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const handle = await ctx.sessionPersistence.create(session.header)
  try {
    await handle.append(session.snapshotEvents())
    await handle.flush()
  } finally {
    await handle.close()
  }
  console.log(`[dsh-p0] SESSION_PERSISTED id=${SESSION_ID} events=${session.snapshotEvents().length}`)
}

async function runSessionRestore(ctx) {
  if (!SESSION_ID) throw Object.assign(new Error('missing-session-id'), { stage: 'session-restore' })
  const handle = await ctx.sessionPersistence.open(SESSION_ID, 'read')
  let stored
  try {
    stored = await handle.read()
    const restored = ctx.sessions.get(SESSION_ID) || ctx.sessions.create(SESSION_ID, {
        seed: [...stored.events],
        meta: {
          cwd: handle.header.cwd,
          createdAt: handle.header.createdAt,
          isSeeded: handle.header.isSeeded,
        },
      })
    const restoredEvents = restored.snapshotEvents()
    const types = restoredEvents.map((event) => event.type)
    const storedTypes = stored.events.map((event) => event.type)
    const prefixMatches = stored.events.every((event, index) =>
      JSON.stringify(event) === JSON.stringify(restoredEvents[index]))
    const tail = restoredEvents.slice(stored.events.length)
    const validSeedBoundary = tail.length === 0 || (
      tail.length === 1 && tail[0].type === 'session/end-seed'
    )
    console.log(`[dsh-p0] SESSION_TYPES stored=${storedTypes.join(',')} restored=${types.join(',')} prefixMatches=${prefixMatches} seedBoundary=${tail.at(-1)?.type || 'none'}`)
    if (!prefixMatches || !validSeedBoundary) {
      throw Object.assign(new Error('session-replay-mismatch'), { stage: 'session-restore' })
    }
  } finally {
    await handle.close()
  }
  console.log(`[dsh-p0] SESSION_RESTORED id=${SESSION_ID} events=${stored.events.length}`)
}

export const name = 'creative-agent-studio-dsh-p0'
export const inject = ['tools', 'skills', 'sessions', 'sessionPersistence']

export function apply(ctx) {
  ctx.effect(async () => {
    const phase = process.env.DSH_P0_PHASE || 'session-write'
    let stage = 'skill'
    try {
      await loadStudioSkill(ctx)
      stage = 'tool-registration'
      registerCanvasTool(ctx)
      if (phase === 'canvas') {
        stage = 'tool-execution'
        await runCanvasProbe(ctx)
      } else if (phase === 'session-restore') {
        stage = 'session-restore'
        await runSessionRestore(ctx)
      } else if (phase === 'session-write') {
        stage = 'session-write'
        await runSessionWrite(ctx)
      } else {
        throw Object.assign(new Error('unknown-phase'), { stage: 'phase' })
      }
      console.log(`[dsh-p0] PHASE_COMPLETE phase=${phase}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      console.error(`[dsh-p0] FAIL stage=${error?.stage || stage} errorType=${errorType(error)} message=${safeMessage(message) || 'unavailable'}`)
    }
    return () => {}
  }, 'dsh-p0-probe')
}
