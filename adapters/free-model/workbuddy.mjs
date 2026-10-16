import path from 'node:path'
import { Worker } from 'node:worker_threads'

const EXPECTED_PROVIDERS = ['buddy', 'workbuddy']

/**
 * 启动隔离的 Buddy / WorkBuddy 渠道实例。
 * 每次调用创建独立 Worker 与独立 dataDir，避免上游模块状态跨实例串账号。
 */
export async function createWorkBuddy({ dataDir, logger = console } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) {
    throw new TypeError('WorkBuddy dataDir 必须是绝对路径')
  }
  const worker = new Worker(new URL('./workbuddy-worker.mjs', import.meta.url), {
    workerData: { dataDir },
    execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')),
  })
  const pending = new Map()
  let sequence = 0
  let closed = false
  let failed
  let closing
  let finishClose
  let resolveReady
  let rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })

  const rejectAll = error => {
    failed = error
    rejectReady(error)
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }
  worker.on('error', rejectAll)
  worker.on('exit', code => {
    if (!closed) rejectAll(new Error(`WorkBuddy worker 已退出（${code}）`))
    finishClose?.()
  })
  worker.on('message', message => {
    if (message.type === 'ready') {
      if (JSON.stringify(message.providers) !== JSON.stringify(EXPECTED_PROVIDERS)) {
        rejectAll(new Error(`WorkBuddy provider 注册异常：${(message.providers ?? []).join(',')}`))
        return
      }
      resolveReady()
      return
    }
    if (message.type === 'startup-error') {
      rejectAll(new Error(message.message || 'WorkBuddy worker 初始化失败'))
      return
    }
    if (message.type === 'log') {
      logger?.[message.level]?.(message.message)
      return
    }
    if (message.type === 'closed') {
      finishClose?.()
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    if (message.type === 'chunk') {
      try { entry.onChunk?.(message.chunk) }
      catch (error) {
        entry.reject(error)
        worker.postMessage({ type: 'cancel-request', id: message.id })
      }
    } else if (message.type === 'error') {
      entry.reject(Object.assign(new Error(message.message), { statusCode: message.statusCode }))
    } else if (message.type === 'result') {
      entry.resolve(message.value)
    }
  })

  function call(type, payload = {}, signal, onChunk, timeoutMs = 30 * 60_000) {
    if (closed || failed) return Promise.reject(failed ?? new Error('WorkBuddy 已停止'))
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('WorkBuddy 请求已取消'))
    const id = ++sequence
    return new Promise((resolve, reject) => {
      let timer
      const finish = fn => value => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        pending.delete(id)
        fn(value)
      }
      const abort = () => {
        worker.postMessage({ type: 'cancel-request', id })
        pending.get(id)?.reject(signal?.reason ?? new Error('WorkBuddy 请求已取消'))
      }
      const entry = { resolve: finish(resolve), reject: finish(reject), onChunk }
      pending.set(id, entry)
      timer = setTimeout(() => {
        worker.postMessage({ type: 'cancel-request', id })
        entry.reject(new Error('WorkBuddy 请求超时'))
      }, timeoutMs)
      timer.unref?.()
      signal?.addEventListener('abort', abort, { once: true })
      worker.postMessage({ type, id, ...payload })
    })
  }

  async function close() {
    if (closing) return closing
    closed = true
    const stopped = new Error('WorkBuddy 正在停止')
    for (const entry of pending.values()) entry.reject(stopped)
    pending.clear()
    closing = (async () => {
      let timer
      await new Promise(resolve => {
        finishClose = resolve
        worker.postMessage({ type: 'close' })
        timer = setTimeout(resolve, 2000)
      })
      clearTimeout(timer)
      await worker.terminate()
    })()
    return closing
  }

  try {
    const timeout = setTimeout(() => rejectReady(new Error('WorkBuddy worker 初始化超时')), 30_000)
    try { await ready } finally { clearTimeout(timeout) }
  } catch (error) {
    await close()
    throw error
  }

  return {
    status: () => call('status'),
    login: region => call('login', { region }, undefined, undefined, 30_000),
    cancel: () => call('cancel', {}, undefined, undefined, 15_000),
    logout: account => call('logout', { account }),
    models: () => call('models', {}, undefined, undefined, 90_000),
    async complete(request, onChunk) {
      const { signal, ...wire } = request ?? {}
      return call('complete', { request: wire }, signal, onChunk, 30 * 60_000)
    },
    close,
  }
}
