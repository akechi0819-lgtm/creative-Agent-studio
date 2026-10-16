import { createElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionEventLike } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ConversationLocation,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'

declare const __DSH_P0_CWD__: string

interface StudioProbeEvent {
  readonly id: string
  readonly title: string
  readonly turn: number
  readonly step: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'studio/probe': StudioProbeEvent
  }
}

interface StudioProbeChatData {
  readonly title: string
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'studio-p0-probe': StudioProbeChatData
  }
}

interface StudioProbeState extends StudioProbeChatData {
  readonly turn: number
  readonly step: number
}

function locationOf(context: ConversationNodeContext): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

const studioProbeDefinition: ConversationNodeDefinition<StudioProbeState> = {
  kind: 'studio-p0-probe',
  target: 'chat',
  match: (event: SessionEventLike) => event.type === 'studio/probe'
    ? { id: event.data.id, role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'studio/probe') throw new Error('studio/probe start event required')
    return {
      title: match.event.data.title,
      turn: match.event.data.turn,
      step: match.event.data.step,
    }
  },
  update: (_context, match) => {
    if (match.event.type !== 'studio/probe') throw new Error('unexpected studio probe event')
    return {
      title: match.event.data.title,
      turn: match.event.data.turn,
      step: match.event.data.step,
    }
  },
  buildLocationData: (context, scope) => scope === 'step' && context.state
    ? {
        kind: 'step',
        turn: context.state.turn,
        step: context.state.step,
        key: 'studio-p0-probe',
        value: { title: context.state.title },
      }
    : null,
  buildViewNode: (context) => context.state
    ? {
        key: context.key,
        kind: 'studio-p0-probe',
        id: context.id,
        target: 'chat',
        anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
        location: locationOf(context),
        visibility: 'visible',
        data: { title: context.state.title },
      }
    : null,
}

function StudioProbeView({ node }: ChatNodeViewProps<'studio-p0-probe'>) {
  return createElement('aside', {
    'data-studio-p0-probe': true,
    style: {
      padding: '16px 20px',
      border: '1px solid #91caff',
      borderRadius: '12px',
      background: '#f0f7ff',
      color: '#102a43',
      font: '14px/1.5 system-ui, sans-serif',
      boxShadow: '0 8px 24px rgba(16,42,67,.12)',
    },
  }, node.data.title)
}

export const inject = ['uiConversation', 'slots', 'sessions', 'uiWorkspace']

export function apply(ctx: ClientContext): void {
  ctx.uiConversation.events.register(studioProbeDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'studio-p0-probe',
  }, StudioProbeView))

  const probeEnabled = new URLSearchParams(location.search).get('dshP0UiProbe') === '1'
  console.info(`[dsh-p0-ui] CLIENT_APPLY probeFlag=${probeEnabled}`)
  if (!probeEnabled) return

  ctx.effect(async () => {
    console.info('[dsh-p0-ui] CLIENT_EFFECT_STARTED')
    let reference: ReturnType<typeof ctx.sessions.retain> | undefined
    let settled = false
    const status = document.createElement('output')
    status.dataset.dshP0UiStatus = 'running'
    status.textContent = 'DSH UI probe: loading…'
    Object.assign(status.style, {
      position: 'fixed',
      right: '24px',
      bottom: '24px',
      zIndex: '2147483647',
    })
    document.body.append(status)

    const finish = (ok: boolean, message: string, checks: Record<string, boolean>) => {
      if (settled) return
      settled = true
      status.dataset.dshP0UiStatus = ok ? 'success' : 'failed'
      status.dataset.dshP0UiChecks = JSON.stringify(checks)
      status.textContent = message
    }

    const emptyChecks = {
      businessEventDefinitionRegistered: false,
      chatViewRegistered: false,
      slotRendererRegistered: false,
      eventAppended: false,
      conversationSnapshotContainsProbe: false,
      registeredRendererVisible: false,
    }
    try {
      const sessionId = await ctx.sessions.create({ cwd: __DSH_P0_CWD__ })
      reference = ctx.sessions.retain(sessionId, { source: 'mainView' })
      await reference.ready
      await new Promise((resolve) => setTimeout(resolve, 50))
      const checks = { ...emptyChecks }
      checks.businessEventDefinitionRegistered = ctx.uiConversation.events.entries()
        .some((definition) => definition.kind === 'studio-p0-probe')
      checks.chatViewRegistered = ctx.uiConversation.views.entries()
        .some((definition) => definition.target === 'chat')
      checks.slotRendererRegistered = ctx.slots.entriesOfSlot('conversation.chat.node')
        .some((entry) => entry.options.key === 'studio-p0-probe')
      if (!checks.chatViewRegistered) throw new Error('chat-view-not-registered')
      const feed = reference.binding.eventSource as typeof reference.binding.eventSource & {
        append(entry: { type: 'event'; event: { type: 'studio/probe'; seq: number; time: number; data: StudioProbeEvent } }): void
      }
      const current = feed.getSnapshot().entries
      const lastSeq = current.reduce((maximum, entry) => Math.max(maximum, entry.event.seq), 0)
      const seq = lastSeq + 1
      const binding = ctx.uiConversation.binding(reference.binding)
      binding.activate('chat')
      feed.append({
        type: 'event',
        event: {
          type: 'studio/probe',
          seq,
          time: Date.now(),
          data: { id: 'dsh-p0-ui-probe', title: 'DSH 业务节点 UI 探针已渲染', turn: 1, step: 1 },
        },
      })
      checks.eventAppended = feed.getSnapshot().entries.some((entry) => entry.event.type === 'studio/probe' && entry.event.seq === seq)
      const chat = binding.target('chat').getSnapshot() as { nodes?: { values(): readonly { kind: string; data: StudioProbeChatData }[] } } | undefined
      const deadline = Date.now() + 5_000
      let probe = chat?.nodes?.values().find((node) => node.kind === 'studio-p0-probe')
      while (!probe && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        const next = binding.target('chat').getSnapshot() as typeof chat
        probe = next?.nodes?.values().find((node) => node.kind === 'studio-p0-probe')
      }
      if (!probe) throw new Error('business-node-snapshot-missing')
      checks.conversationSnapshotContainsProbe = true
      const workspace = ctx.uiWorkspace as UiWorkspace
      workspace.openSession(sessionId)
      const visibleDeadline = Date.now() + 5_000
      while (Date.now() < visibleDeadline) {
        const rendered = document.querySelector('[data-studio-p0-probe]')
        if (rendered?.textContent === probe.data.title) {
          checks.registeredRendererVisible = checks.slotRendererRegistered
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      if (!checks.registeredRendererVisible) throw new Error('registered-chat-node-renderer-not-visible')
      console.info(`[dsh-p0-ui] BUSINESS_NODE snapshot=true slotRegistered=${checks.slotRendererRegistered} rendererVisible=${checks.registeredRendererVisible} seq=${seq}`)
      finish(true, 'DSH 业务节点与注册 renderer 已通过', checks)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown-error'
      const checks = { ...emptyChecks }
      try {
        checks.businessEventDefinitionRegistered = ctx.uiConversation.events.entries()
          .some((definition) => definition.kind === 'studio-p0-probe')
        checks.chatViewRegistered = ctx.uiConversation.views.entries()
          .some((definition) => definition.target === 'chat')
        checks.slotRendererRegistered = ctx.slots.entriesOfSlot('conversation.chat.node')
          .some((entry) => entry.options.key === 'studio-p0-probe')
      } catch {}
      finish(false, `DSH UI probe failed · ${message.slice(0, 140)}`, checks)
    }

    return () => {
      status.remove()
      reference?.release()
    }
  }, 'dsh-p0-ui-probe')
}
