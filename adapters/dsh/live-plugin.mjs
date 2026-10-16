import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { callCanvasTool, connection, health } from '../../src/canvas/client.mjs'

const TOOL_NAME = 'studio_probe_text'
const PROVIDER = 'studio-live'
const MODEL = process.env.DSH_LIVE_MODEL
const MARKER = process.env.DSH_LIVE_MARKER
const SESSION_ID = process.env.DSH_LIVE_SESSION_ID
const REFERENCE_NODE_ID = process.env.DSH_LIVE_REFERENCE_NODE_ID

function fail(message) {
  throw new Error(message)
}

function nodesOf(state) {
  return Array.isArray(state?.nodes) ? state.nodes : []
}

function canvasSignature(state) {
  return JSON.stringify(nodesOf(state).map((node) => ({
    id: node.id,
    type: node.type,
    content: node.metadata?.content,
  })))
}

function textOf(message) {
  return (message?.content || [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function sanitizeError(error) {
  let message = error instanceof Error ? error.message : String(error || 'unknown error')
  const key = process.env.STUDIO_DSH_LIVE_API_KEY
  if (key) message = message.split(key).join('[REDACTED]')
  message = message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s)]+/gi, '[URL]')
    .slice(0, 260)
  return { name: error instanceof Error ? error.name : 'Error', message }
}

function registerTextTool(ctx, canvas) {
  let successfulCalls = 0
  const definition = defineTool({
    name: TOOL_NAME,
    description: '根据用户附带的画布图片创建一个纯文本节点，记录你看到的简短描述。',
    parameters: {
      text: { type: 'string', required: true, description: '以本轮唯一验证标记开头的中文图片描述' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          created: { type: 'boolean' },
          nodeId: { type: 'string' },
          text: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error('tool execution aborted before Canvas submission')
      if (successfulCalls > 0) throw new Error('only one text tool call is allowed in this verification')
      if (typeof args.text !== 'string' || !args.text.startsWith(`${MARKER} `) || args.text.length > 200) {
        throw new Error('text must start with the verification marker and stay within 200 characters')
      }
      successfulCalls += 1
      await callCanvasTool('canvas_create_text_node', {
        text: args.text,
        title: 'DSH P0 视觉验证',
        x: 96,
        y: 96,
      }, canvas, { signal: exec.signal })
      const state = await callCanvasTool('canvas_get_state', {}, canvas, { signal: exec.signal })
      const node = nodesOf(state).find((item) => item.type === 'text' && item.metadata?.content === args.text)
      if (!node?.id) throw new Error('Canvas tool returned without a matching text node in state')
      return { created: true, nodeId: node.id, text: args.text }
    },
  })
  ctx.tools.register(definition)
  return { definition, successfulCalls: () => successfulCalls }
}

async function prepareCanvas(attachments) {
  const config = await connection()
  if (config.instanceId !== process.env.DSH_LIVE_INSTANCE_ID) fail('Canvas instance changed before DSH run')
  if (config.projectId !== process.env.STUDIO_PROJECT_ID) fail('Canvas project does not match the selected project')
  const current = await health(config)
  const targets = (current.targets || []).filter((target) => target.projectId === config.projectId && target.hasCanvas)
  const clientId = process.env.DSH_LIVE_CLIENT_ID
  if (targets.length !== 1 || targets[0].clientId !== clientId) fail('Canvas client target is missing or ambiguous')
  const canvas = { ...config, clientId }

  const reference = await callCanvasTool('canvas_read_image', { nodeId: REFERENCE_NODE_ID }, canvas)
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([\s\S]+)$/.exec(reference?.dataUrl || '')
  if (!match) fail('canvas_read_image did not return an image data URL')
  const data = Buffer.from(match[2], 'base64')
  if (!data.length) fail('canvas_read_image returned an empty image')
  const attachment = await attachments.saveImage({
    data: new Uint8Array(data),
    mediaType: match[1],
    name: 'canvas-p0-reference',
  })

  const beforeWrongProject = await callCanvasTool('canvas_get_state', {}, canvas)
  const wrongProjectResponse = await fetch(`${config.bridgeUrl}/api/tools`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-canvas-agent-token': config.token },
    body: JSON.stringify({
      name: 'canvas_get_state',
      input: {},
      projectId: `${config.projectId}-wrong-target`,
      clientId,
    }),
  })
  const wrongProjectBody = await wrongProjectResponse.json().catch(() => ({}))
  const afterWrongProject = await callCanvasTool('canvas_get_state', {}, canvas)
  if (wrongProjectResponse.status !== 403 || wrongProjectBody.ok !== false || canvasSignature(beforeWrongProject) !== canvasSignature(afterWrongProject)) {
    fail('wrong-project HTTP tool request was not rejected without changing Canvas state')
  }

  const beforeAbort = await callCanvasTool('canvas_get_state', {}, canvas)
  return {
    canvas,
    attachment,
    image: {
      bytes: data.length,
      mediaType: match[1],
      width: Number(reference.naturalWidth || reference.width || 0),
      height: Number(reference.naturalHeight || reference.height || 0),
    },
    stateBeforeAbort: beforeAbort,
    wrongProjectRejected: true,
  }
}

export const name = 'creative-agent-studio-dsh-live-p0'
export const inject = ['tools', 'agents', 'attachments']

export function apply(ctx) {
  ctx.effect(async () => {
    let handle
    let stage = 'startup'
    let result
    let failure
    try {
      if (!MODEL || !MARKER || !SESSION_ID || !REFERENCE_NODE_ID) fail('missing DSH live verification parameters')
      stage = 'canvas-preflight'
      const canvasState = await prepareCanvas(ctx.attachments)
      const abortController = new AbortController()
      abortController.abort(new Error('pre-dispatch cancellation'))
      const toolBundle = registerTextTool(ctx, canvasState.canvas)
      let abortedToolRejected = false
      try {
        await toolBundle.definition.execute({ text: `${MARKER} cancelled before dispatch` }, { signal: abortController.signal })
      } catch (error) {
        abortedToolRejected = error instanceof Error && error.message.includes('aborted before Canvas submission')
      }
      const afterAbort = await callCanvasTool('canvas_get_state', {}, canvasState.canvas)
      if (!abortedToolRejected || canvasSignature(canvasState.stateBeforeAbort) !== canvasSignature(afterAbort)) {
        fail('pre-dispatch cancellation was not rejected without changing Canvas state')
      }

      stage = 'agent-create'
      handle = await ctx.agents.create({
        sessionId: SESSION_ID,
        meta: { cwd: process.cwd() },
        agentOptions: { provider: PROVIDER, model: MODEL, maxTokens: 1200 },
        setup(agentCtx) {
          agentCtx.tools.restrict({ allow: [TOOL_NAME] })
        },
      })
      stage = 'agent-turn'
      const prompt = [
        '请认真查看本消息附带的图片，说明图中的主体、主要颜色，以及是否有可见文字；只描述图中明确可见的内容，不要猜测来源或加入未见到的物体。',
        `调用 ${TOOL_NAME} 创建唯一一个文本节点；text 必须以字面标记「${MARKER}」开头，随后写一段简短中文视觉描述。`,
        '工具成功后，给出一句简洁中文总结。只调用一次工具。',
      ].join('\n')
      handle.agent.followup(createUserMessage({
        source: { kind: 'user' },
        content: [
          { type: 'text', text: prompt },
          { type: 'image', attachment: canvasState.attachment },
        ],
      }))
      await Promise.race([
        handle.agent.whenIdle(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('DSH agent turn timeout')), 150_000)),
      ])

      stage = 'session-check'
      const events = handle.agent.session.snapshotEvents()
      const calls = events.filter((event) => event.type === 'tool/call' && event.data.name === TOOL_NAME)
      const matchingResults = events.filter((event) => event.type === 'tool/result'
        && event.data.message?.toolCallId === calls[0]?.data.callId)
      const assistantMessages = events
        .filter((event) => event.type === 'assistant/message')
        .map((event) => textOf(event.data.message))
        .filter(Boolean)
      const finalText = assistantMessages.at(-1) || ''
      const assistantEvents = events.filter((event) => event.type === 'assistant/message')
      const lastAssistantEvent = assistantEvents.at(-1)
      const reportedSource = lastAssistantEvent?.data?.message?.source
      if (calls.length !== 1) fail(`expected one ${TOOL_NAME} model call, received ${calls.length}`)
      const callArguments = JSON.parse(calls[0].data.arguments)
      if (!callArguments.text?.startsWith(`${MARKER} `)) fail('model tool arguments omitted the unique verification marker')
      const matchingResult = matchingResults[0]
      if (!matchingResult || matchingResult.data.message?.isError) fail('model tool call has no successful tool/result')
      if (!finalText) fail('DSH agent produced no final assistant message')
      if (toolBundle.successfulCalls() !== 1) fail('Canvas text tool did not complete exactly once')
      const stateAfter = await callCanvasTool('canvas_get_state', {}, canvasState.canvas)
      const textNode = nodesOf(stateAfter).find((node) => node.type === 'text' && node.metadata?.content === callArguments.text)
      if (!textNode) fail('agent-created text node is absent from Canvas state')

      const sceneChecks = {
        mountain: /山|mountain|hill|峰/i.test(callArguments.text),
        lakeOrWater: /湖|湖泊|水面|水域|lake|water/i.test(callArguments.text),
        forest: /森林|树林|林木|forest|trees/i.test(callArguments.text),
        warmOrangeSky: /橙|暖色|夕阳|orange|warm|sunset/i.test(callArguments.text),
      }
      result = {
        status: 'passed',
        requestedModel: MODEL,
        reportedApiModel: reportedSource?.model || null,
        returnedResponseModel: reportedSource?.replayState?.response?.responseModel || null,
        reportedProvider: reportedSource?.provider || null,
        sessionId: SESSION_ID,
        projectId: canvasState.canvas.projectId,
        instanceId: canvasState.canvas.instanceId,
        clientId: canvasState.canvas.clientId,
        referenceNodeId: REFERENCE_NODE_ID,
        image: canvasState.image,
        imageAttachedToAgentMessage: true,
        agentTurn: {
          followupSubmitted: true,
          idleReached: true,
          eventTypes: events.map((event) => event.type),
          userMessageEvents: events.filter((event) => event.type === 'user/message').length,
          assistantMessageEvents: assistantEvents.length,
          sessionTitleLlmRequestEvents: events.filter((event) => event.type === 'session/title-llm-request').length,
        },
        tool: {
          name: TOOL_NAME,
          callCount: calls.length,
          resultCount: matchingResults.length,
          isError: false,
          arguments: callArguments,
          resultText: textOf(matchingResult.data.message),
          nodeId: textNode.id,
        },
        finalText,
        checks: {
          wrongProjectRejected: canvasState.wrongProjectRejected,
          preDispatchAbortRejected: abortedToolRejected,
          noCanvasMutationOnAbort: true,
          noCanvasMutationOnWrongProject: true,
          imageSceneTerms: sceneChecks,
        },
      }
    } catch (error) {
      failure = { stage, ...sanitizeError(error) }
    } finally {
      if (handle) await handle.dispose().catch(() => {})
    }
    if (failure) console.error(`[dsh-live] FAIL ${JSON.stringify(failure)}`)
    else console.log(`[dsh-live] RESULT ${JSON.stringify(result)}`)
    return () => {}
  }, 'dsh-live-p0')
}
