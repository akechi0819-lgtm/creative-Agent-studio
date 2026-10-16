import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import {
  BuddyAuth, CODEBUDDY, WORKBUDDY, registerBuddyLlm, configureDeadModelStore,
  makeReadImage, makeReadImageRequest, runBuddyLoginFlow,
  normalizeReasoningEffort, responsesReasoningEffort, normalizeMaxTokens,
  responsesMaxOutputTokens, toGenerateOptions, toResponsesGenerateOptions,
  markGatewayChannel, collectGatewayModels, collectGatewayEffortViews, toOpenAiModels,
} from '../../third_party/our-free-model/workbuddy/runtime.mjs'
import { attachments } from '../../third_party/our-free-model/workbuddy/images.mjs'
import { foldForwardOutcome } from '../../third_party/our-free-model/src/core/completion.js'

const SCHEMA = 'studio-workbuddy/v1'
const STATE_FILE = 'workbuddy-state.json'
const REGIONS = [
  { region: 'cn', provider: 'buddy', product: CODEBUDDY, fallbackName: 'CodeBuddy' },
  { region: 'intl', provider: 'workbuddy', product: WORKBUDDY, fallbackName: 'WorkBuddy' },
]
const REGION_BY_ID = new Map(REGIONS.map(row => [row.region, row]))
const REF_NAMES = new Set(REGIONS.map(row => row.product.defaultCredentialRef))

function abortError(message = '登录已取消') {
  return Object.assign(new Error(message), { name: 'AbortError' })
}

function validateDataDir(dataDir) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) {
    throw new TypeError('WorkBuddy dataDir 必须是绝对路径')
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(dataDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError('WorkBuddy dataDir 必须是普通目录')
  fs.chmodSync(dataDir, 0o700)
  return path.resolve(dataDir)
}

function validateState(value) {
  if (value?.schema !== SCHEMA || !Array.isArray(value.accounts)
    || !value.credentials || typeof value.credentials !== 'object' || Array.isArray(value.credentials)) {
    throw new Error('WorkBuddy 本地凭据文件格式错误')
  }
  const accounts = []
  for (const account of value.accounts) {
    const region = REGION_BY_ID.get(account?.region)
    if (!region || typeof account.id !== 'string' || account.id.length === 0
      || typeof account.name !== 'string' || account.name.length === 0) continue
    if (accounts.some(item => item.region === region.region)) continue
    accounts.push({ id: account.id, region: region.region, name: account.name })
  }
  const validRefs = new Set(accounts.map(account => REGION_BY_ID.get(account.region).product.defaultCredentialRef))
  const credentials = {}
  for (const [ref, credential] of Object.entries(value.credentials)) {
    if (REF_NAMES.has(ref) && validRefs.has(ref) && typeof credential === 'string') credentials[ref] = credential
  }
  const accountsWithCredentials = accounts.filter(account => {
    const ref = REGION_BY_ID.get(account.region).product.defaultCredentialRef
    return credentials[ref] !== undefined
  })
  return { schema: SCHEMA, accounts: accountsWithCredentials, credentials }
}

function createStateStore(dataDir) {
  const file = path.join(dataDir, STATE_FILE)
  let state = { schema: SCHEMA, accounts: [], credentials: {} }
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('WorkBuddy 本地凭据文件不是普通文件')
    fs.chmodSync(file, 0o600)
    try { state = validateState(JSON.parse(fs.readFileSync(file, 'utf8'))) }
    catch { throw new Error('WorkBuddy 本地凭据文件无法读取') }
  }

  function save(next) {
    const temp = path.join(dataDir, `.${STATE_FILE}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`)
    const fd = fs.openSync(temp, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify(next, null, 2), 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    try {
      fs.renameSync(temp, file)
      fs.chmodSync(file, 0o600)
      state = next
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp)
    }
  }

  return {
    get state() { return state },
    save,
    file,
  }
}

function credentialName(value, fallback) {
  try {
    const parsed = JSON.parse(value)
    const nickname = typeof parsed.nickname === 'string' ? parsed.nickname.trim() : ''
    const userId = typeof parsed.user_id === 'string' ? parsed.user_id.trim() : ''
    return (nickname || userId || fallback).slice(0, 120)
  } catch {
    return fallback
  }
}

function validateLoginUrl(value, product) {
  let url
  try { url = new URL(value) } catch { throw new Error('WorkBuddy 授权地址无效') }
  const productHost = new URL(product.endpoint).hostname
  if (url.protocol !== 'https:' || url.hostname !== productHost
    || url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443')) {
    throw new Error('WorkBuddy 授权地址无效')
  }
  return url.toString()
}

export function createWorkBuddyKernel({
  dataDir, logger = console, fetcher = fetch,
  loginTimeoutMs = undefined, loginPollIntervalMs = undefined,
} = {}) {
  const home = validateDataDir(dataDir)
  const store = createStateStore(home)
  const services = new Map()
  const cleanups = []
  const adapters = new Map()
  let closed = false
  let activeLogin
  let pendingAccountCommit
  let pendingAccountRemoval
  let loginState = { status: 'idle' }

  const secretValues = () => Object.values(store.state.credentials).flatMap(value => {
    const parts = [value]
    try {
      const credential = JSON.parse(value)
      for (const [key, item] of Object.entries(credential)) {
        if (typeof item === 'string' && /token|secret|key/i.test(key) && item.length > 4) parts.push(item)
      }
    } catch {}
    return parts
  }).sort((a, b) => b.length - a.length)
  const redact = value => {
    let message = String(value ?? '')
    for (const secret of secretValues()) message = message.split(secret).join('[redacted]')
    return message
  }
  const safeLogger = Object.fromEntries(['info', 'warn', 'error'].map(level => [
    level,
    message => logger?.[level]?.(redact(message)),
  ]))

  function writeState(next) {
    if (closed) throw new Error('WorkBuddy 已停止')
    store.save({ schema: SCHEMA, accounts: next.accounts, credentials: next.credentials })
  }

  const credentials = {
    async resolve(ref) {
      if (!REF_NAMES.has(ref)) return undefined
      const value = store.state.credentials[ref]
      return typeof value === 'string' ? { value, source: 'local' } : undefined
    },
    async describe(ref) {
      return { source: store.state.credentials[ref] === undefined ? undefined : 'local' }
    },
    async set(ref, value) {
      if (closed) throw new Error('WorkBuddy 已停止')
      if (!REF_NAMES.has(ref) || typeof value !== 'string') throw new TypeError('WorkBuddy 凭据无效')
      const credentialsNext = { ...store.state.credentials, [ref]: value }
      let accountsNext = store.state.accounts
      if (pendingAccountCommit?.ref === ref) {
        const account = pendingAccountCommit.account
        accountsNext = [...accountsNext.filter(row => row.region !== account.region), account]
      }
      writeState({ accounts: accountsNext, credentials: credentialsNext })
    },
    async unset(ref) {
      if (closed) return
      if (!REF_NAMES.has(ref)) return
      const credentialsNext = { ...store.state.credentials }
      delete credentialsNext[ref]
      let accountsNext = store.state.accounts
      if (pendingAccountRemoval?.ref === ref) {
        accountsNext = accountsNext.filter(row => row.id !== pendingAccountRemoval.id || row.region !== pendingAccountRemoval.region)
      }
      writeState({ accounts: accountsNext, credentials: credentialsNext })
    },
    dispose() { closed = true },
  }

  const ctx = {
    platform: { channelHome: home },
    credentials,
    attachments,
    logger: safeLogger,
    llm: {
      registerAdapter(providers, adapter) {
        for (const provider of providers) {
          if (!REGIONS.some(region => region.provider === provider)) throw new Error(`禁止注册 WorkBuddy 以外的渠道：${provider}`)
          if (adapters.has(provider)) throw new Error(`WorkBuddy 渠道重复注册：${provider}`)
          adapters.set(provider, adapter)
        }
      },
      listProviders() { return [...adapters.keys()].map(id => ({ id })) },
      async listModels(provider) { return await adapters.get(provider)?.listModels(provider) ?? [] },
      async resolveModel(provider, model, signal) {
        const adapter = adapters.get(provider)
        if (!adapter) throw Object.assign(new Error('WorkBuddy 渠道不存在'), { statusCode: 404 })
        return adapter.resolveModel(provider, model, signal)
      },
      async resolveModelInfo(provider, model, signal) { return this.resolveModel(provider, model, signal) },
      async *stream(options) {
        const adapter = adapters.get(options.provider)
        if (!adapter) throw Object.assign(new Error('WorkBuddy 渠道不存在'), { statusCode: 404 })
        const call = await adapter.prepareCall(options.provider, options.model, options.signal)
        yield* call.stream(options)
      },
    },
    get(name) { return this[name] },
    provide(name, value) {
      if (services.has(name)) throw new Error(`WorkBuddy 服务重复注册：${name}`)
      services.set(name, value)
    },
    effect(body) {
      const cleanup = body()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
    inject(names, body) { if (names.every(name => this[name] !== undefined)) return body(this) },
    emit() {},
  }

  configureDeadModelStore(ctx)
  const authByRegion = new Map()
  for (const region of REGIONS) {
    const auth = new BuddyAuth(ctx, { product: region.product, fetcher })
    authByRegion.set(region.region, auth)
    registerBuddyLlm(ctx, {
      product: region.product,
      fetchImpl: fetcher,
      fetcher,
      resolveCredential: async () => {
        const resolved = await credentials.resolve(region.product.defaultCredentialRef)
        if (!resolved) return undefined
        try { return JSON.parse(resolved.value) } catch { return undefined }
      },
      refresh: async () => {
        if (await credentials.resolve(region.product.defaultCredentialRef)) await auth.refresh()
      },
      fetchRemoteModels: () => auth.fetchModels(),
      readImage: makeReadImage(ctx),
      readImageRequest: makeReadImageRequest(ctx),
    })
  }

  function status() {
    return {
      accounts: store.state.accounts.map(({ id, region, name }) => ({ id, region, name })),
      login: { ...loginState },
    }
  }

  async function login(regionId, requestSignal) {
    if (closed) throw new Error('WorkBuddy 已停止')
    const region = REGION_BY_ID.get(regionId)
    if (!region) throw new TypeError('WorkBuddy region 必须是 cn 或 intl')
    if (requestSignal?.aborted) return status()
    if (activeLogin) {
      if (activeLogin.region === regionId) return status()
      throw new Error('另一个 WorkBuddy 登录流程正在进行，请先取消')
    }

    const controller = new AbortController()
    let releaseUrl
    let urlReady = false
    const opened = new Promise(resolve => { releaseUrl = resolve })
    const record = { region: regionId, controller, cancelled: false, promise: undefined }
    activeLogin = record
    loginState = { status: 'pending', message: '等待浏览器完成授权' }
    const cancelFromRequest = () => {
      if (activeLogin !== record) return
      record.cancelled = true
      loginState = { status: 'idle', message: '登录已取消' }
      controller.abort(requestSignal.reason ?? abortError())
      activeLogin = undefined
    }
    requestSignal?.addEventListener('abort', cancelFromRequest, { once: true })

    record.promise = (async () => {
      try {
        const flow = await runBuddyLoginFlow({
          product: region.product,
          fetcher,
          signal: controller.signal,
          ...(loginTimeoutMs === undefined ? {} : { timeoutMs: loginTimeoutMs }),
          ...(loginPollIntervalMs === undefined ? {} : { pollIntervalMs: loginPollIntervalMs }),
          openBrowser: async url => {
            if (record.cancelled || activeLogin !== record || controller.signal.aborted) throw abortError()
            const safeUrl = validateLoginUrl(url, region.product)
            loginState = { status: 'pending', url: safeUrl, message: '等待浏览器完成授权' }
            urlReady = true
            releaseUrl()
          },
        })
        if (record.cancelled || activeLogin !== record || controller.signal.aborted || closed) throw abortError()

        const previous = store.state.accounts.find(account => account.region === regionId)
        const account = {
          id: previous?.id ?? `${region.provider}-${crypto.randomUUID()}`,
          region: regionId,
          name: credentialName(flow.access, region.fallbackName),
        }
        pendingAccountCommit = { ref: region.product.defaultCredentialRef, account }
        try {
          await authByRegion.get(regionId).saveCredential(flow.access, region.product.defaultCredentialRef)
        } finally {
          pendingAccountCommit = undefined
        }
        if (record.cancelled || activeLogin !== record || closed) {
          // JavaScript callbacks do not interleave with the synchronous atomic write above.
          throw abortError()
        }
        loginState = { status: 'succeeded', message: '登录完成' }
      } catch (error) {
        if (!urlReady) releaseUrl()
        if (record.cancelled || controller.signal.aborted) {
          if (activeLogin === record) loginState = { status: 'idle', message: '登录已取消' }
        } else if (!closed) {
          loginState = { status: 'failed', message: '登录失败，请检查授权状态后重试' }
          safeLogger.warn(`[workbuddy] ${loginState.message}`)
        }
      } finally {
        if (activeLogin === record) activeLogin = undefined
      }
    })()

    try {
      await Promise.race([opened, record.promise])
      return status()
    } finally {
      requestSignal?.removeEventListener('abort', cancelFromRequest)
    }
  }

  async function cancel() {
    const record = activeLogin
    if (!record) return status()
    record.cancelled = true
    loginState = { status: 'idle', message: '登录已取消' }
    record.controller.abort(abortError())
    activeLogin = undefined
    await record.promise
    return status()
  }

  async function logout({ id, region: regionId } = {}) {
    if (closed) throw new Error('WorkBuddy 已停止')
    const region = REGION_BY_ID.get(regionId)
    const account = store.state.accounts.find(row => row.id === id && row.region === regionId)
    if (!region || !account) return status()
    if (activeLogin?.region === regionId) await cancel()
    const auth = authByRegion.get(regionId)
    auth.stop()
    pendingAccountRemoval = { id: account.id, region: regionId, ref: region.product.defaultCredentialRef }
    try { await auth.logout() } finally { pendingAccountRemoval = undefined }
    return status()
  }

  async function models() {
    const onError = (provider, error) => safeLogger.warn(`[workbuddy] ${provider} 模型目录读取失败：${redact(error?.message ?? error)}`)
    const groups = await collectGatewayModels(ctx.llm, onError)
    const effortViews = await collectGatewayEffortViews(ctx.llm, groups, onError)
    return toOpenAiModels(groups, effortViews).map(row => ({
      ...row,
      channel: row.owned_by,
      vision: row.input?.includes('image') === true,
    }))
  }

  async function complete(request, onChunk = () => {}, signal) {
    const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
    try {
      if (closed) throw Object.assign(new Error('WorkBuddy 已停止'), { statusCode: 503 })
      if (signal?.aborted) throw signal.reason ?? abortError()
      const slash = typeof request?.model === 'string' ? request.model.indexOf('/') : -1
      if (slash <= 0 || slash === request.model.length - 1) throw Object.assign(new Error('模型 ID 必须使用 provider/model 格式'), { statusCode: 400 })
      const provider = request.model.slice(0, slash)
      const model = request.model.slice(slash + 1)
      if (!adapters.has(provider)) throw Object.assign(new Error('模型不存在或已停用'), { statusCode: 404 })
      const body = { ...(request.openAi ?? {}), model: request.model }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        throw Object.assign(new Error('messages 必须是非空数组'), { statusCode: 400 })
      }
      if (!(await ctx.llm.listModels(provider)).some(row => row.id === model)) {
        throw Object.assign(new Error('模型不存在或已停用'), { statusCode: 404 })
      }
      if (signal?.aborted) throw signal.reason ?? abortError()
      const resolved = await ctx.llm.resolveModel(provider, model, signal)
      const effort = normalizeReasoningEffort(body.reasoning_effort, resolved, provider, model,
        notice => safeLogger.info(`[workbuddy] ${request.model}：思考档位 ${notice.requested} ${notice.applied ? `映射为 ${notice.applied}` : '使用模型默认'}`))
      const requestedTokens = body.max_completion_tokens ?? body.max_tokens
      const maxTokens = typeof requestedTokens === 'number' ? normalizeMaxTokens(requestedTokens, provider, model) : undefined
      const options = await (request.responses === true
        ? toResponsesGenerateOptions(body, signal, responsesReasoningEffort(body), responsesMaxOutputTokens(body), { bridge: attachments })
        : toGenerateOptions(body, signal, effort, maxTokens, { bridge: attachments }))
      options.sessionId = `workbuddy:${String(body.user ?? body.conversation ?? 'shared')}`
      for await (const chunk of ctx.llm.stream(markGatewayChannel(options))) {
        if (signal?.aborted) throw signal.reason ?? abortError()
        onChunk(chunk)
        foldForwardOutcome(outcome, chunk)
      }
    } catch (error) {
      outcome.error = redact(error?.message ?? error)
    }
    return outcome
  }

  async function close() {
    if (closed) return
    await cancel()
    closed = true
    for (const auth of authByRegion.values()) auth.stop()
    credentials.dispose()
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup() } catch {}
    }
  }

  return {
    providerIds: () => [...adapters.keys()],
    status,
    login,
    cancel,
    logout,
    models,
    complete,
    close,
  }
}

if (parentPort) {
  let kernel
  const controllers = new Map()
  let closed = false
  let sequence = 0
  const send = message => parentPort.postMessage(message)

  async function start() {
    kernel = createWorkBuddyKernel({
      dataDir: workerData.dataDir,
      logger: Object.fromEntries(['info', 'warn', 'error'].map(level => [
        level,
        message => send({ type: 'log', level, message: String(message) }),
      ])),
    })
    const providers = kernel.providerIds()
    if (providers.length !== 2 || providers[0] !== 'buddy' || providers[1] !== 'workbuddy') {
      throw new Error(`WorkBuddy worker 渠道注册异常：${providers.join(',')}`)
    }
    send({ type: 'ready', providers })
  }

  parentPort.on('message', async message => {
    if (message.type === 'cancel-request') {
      controllers.get(message.id)?.abort(abortError())
      return
    }
    if (message.type === 'close') {
      if (closed) return
      closed = true
      for (const controller of controllers.values()) controller.abort(abortError('WorkBuddy 已停止'))
      try { await kernel?.close() } finally { send({ type: 'closed' }) }
      return
    }
    const { id, type } = message
    const controller = new AbortController()
    controllers.set(id, controller)
    try {
      if (closed || !kernel) throw new Error('WorkBuddy worker 未就绪')
      let value
      if (type === 'status') value = kernel.status()
      else if (type === 'login') value = await kernel.login(message.region, controller.signal)
      else if (type === 'cancel') value = await kernel.cancel()
      else if (type === 'logout') value = await kernel.logout(message.account)
      else if (type === 'models') value = await kernel.models()
      else if (type === 'complete') value = await kernel.complete(message.request, chunk => send({ type: 'chunk', id, chunk }), controller.signal)
      else throw new Error('未知 WorkBuddy 操作')
      send({ type: 'result', id, value })
    } catch (error) {
      send({ type: 'error', id, message: String(error?.message ?? error), statusCode: error?.statusCode })
    } finally {
      controllers.delete(id)
    }
  })

  void start().catch(error => send({ type: 'startup-error', message: String(error?.message ?? error) }))
}
