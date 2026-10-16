import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createWorkBuddyKernel } from '../adapters/free-model/workbuddy-worker.mjs'
import { createWorkBuddy } from '../adapters/free-model/workbuddy.mjs'

const tempDirs = new Set()

function dataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-fixture-'))
  tempDirs.add(dir)
  return dir
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(message)
}

test('worker manager starts only the two Buddy providers with local idle status', async () => {
  const dir = dataDir()
  const instance = await createWorkBuddy({ dataDir: dir, logger: {} })
  try {
    assert.deepEqual(await instance.status(), {
      accounts: [],
      login: { status: 'idle' },
    })
    const models = await instance.models()
    assert.ok(models.length > 0)
    assert.ok(models.every(model => /^(buddy|workbuddy)\//.test(model.id)))
    assert.ok(models.some(model => model.id.startsWith('buddy/')))
    assert.ok(models.some(model => model.id.startsWith('workbuddy/')))
    assert.equal(fs.existsSync(path.join(dir, 'workbuddy-state.json')), false)
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  } finally {
    await instance.close()
  }
  const statePath = path.join(dir, 'workbuddy-state.json')
  fs.writeFileSync(statePath, JSON.stringify({
    schema: 'studio-workbuddy/v1',
    accounts: [{ id: 'workbuddy-fixture', region: 'intl', name: 'Restored Fixture' }],
    credentials: {
      WORKBUDDY_ACCESS_TOKEN: JSON.stringify({ access_token: 'fixture-token', nickname: 'Restored Fixture' }),
    },
  }), { mode: 0o600 })
  const restored = await createWorkBuddy({ dataDir: dir, logger: {} })
  try {
    assert.deepEqual(await restored.status(), {
      accounts: [{ id: 'workbuddy-fixture', region: 'intl', name: 'Restored Fixture' }],
      login: { status: 'idle' },
    })
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600)
  } finally {
    await restored.close()
  }
})

test('cancel aborts pending OAuth polling and never writes credentials', async () => {
  const dir = dataDir()
  let tokenStartedResolve
  const tokenStarted = new Promise(resolve => { tokenStartedResolve = resolve })
  const fetcher = async (input, init = {}) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/v2/plugin/auth/state')) {
      return jsonResponse({ data: { state: 'cancel-state', authUrl: 'https://www.workbuddy.ai/authorize' } })
    }
    if (url.pathname.endsWith('/v2/plugin/auth/token')) {
      tokenStartedResolve()
      return new Promise((resolve, reject) => {
        const signal = init.signal
        const abort = () => reject(signal.reason ?? new Error('aborted'))
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
    }
    throw new Error(`unexpected request ${url}`)
  }
  const kernel = createWorkBuddyKernel({
    dataDir: dir,
    logger: {},
    fetcher,
    loginTimeoutMs: 5_000,
    loginPollIntervalMs: 1,
  })
  try {
    const keepAlive = setInterval(() => {}, 1_000)
    let cancelled
    try {
      const pending = await kernel.login('intl')
      assert.equal(pending.login.status, 'pending')
      assert.match(pending.login.url, /^https:\/\/www\.workbuddy\.ai\/authorize\?/)
      await tokenStarted
      cancelled = await kernel.cancel()
    } finally { clearInterval(keepAlive) }
    assert.equal(cancelled.login.status, 'idle')
    assert.deepEqual(cancelled.accounts, [])
    assert.equal(fs.existsSync(path.join(dir, 'workbuddy-state.json')), false)
  } finally {
    await kernel.close()
  }
})

test('login rejects non-product authorization hosts and hides upstream errors', async () => {
  const dir = dataDir()
  const kernel = createWorkBuddyKernel({
    dataDir: dir,
    logger: {},
    fetcher: async input => {
      const url = new URL(input)
      if (url.pathname.endsWith('/v2/plugin/auth/state')) {
        return jsonResponse({ data: {
          state: 'unsafe-state',
          authUrl: 'javascript:alert(1)?token=upstream-secret',
        } })
      }
      throw new Error(`unexpected request ${url}`)
    },
  })
  try {
    const result = await kernel.login('intl')
    assert.equal(result.login.status, 'failed')
    assert.equal(result.login.message, '登录失败，请检查授权状态后重试')
    assert.equal(JSON.stringify(result).includes('upstream-secret'), false)
    assert.equal(fs.existsSync(path.join(dir, 'workbuddy-state.json')), false)
  } finally {
    await kernel.close()
  }
})

test('login persists one private account, completion streams, status restores without network, and logout removes it', async () => {
  const dir = dataDir()
  const seen = []
  const fetcher = async (input, init = {}) => {
    const url = new URL(input)
    seen.push({ url: url.toString(), method: init.method ?? 'GET' })
    if (url.pathname.endsWith('/v2/plugin/auth/state')) {
      return jsonResponse({ data: { state: 'success-state', authUrl: 'https://www.workbuddy.ai/authorize' } })
    }
    if (url.pathname.endsWith('/v2/plugin/auth/token')) {
      return jsonResponse({ data: {
        accessToken: 'fixture-access-token',
        refreshToken: 'fixture-refresh-token',
        expiresIn: 3_600,
        domain: 'www.workbuddy.ai',
      } })
    }
    if (url.pathname.endsWith('/v2/plugin/login/account')) {
      return jsonResponse({ data: { uid: 'fixture-user', nickname: 'Fixture User' } })
    }
    if (url.pathname.startsWith('/console/enterprises/')) return jsonResponse({}, 404)
    if (url.pathname === '/v3/config') return jsonResponse({ data: { models: [] } })
    if (url.pathname === '/v2/chat/completions') {
      return new Response([
        'data: {"choices":[{"delta":{"content":"fixture answer"},"finish_reason":null}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } })
    }
    throw new Error(`unexpected request ${url}`)
  }
  const kernel = createWorkBuddyKernel({
    dataDir: dir,
    logger: {},
    fetcher,
    loginTimeoutMs: 5_000,
    loginPollIntervalMs: 1,
  })
  try {
    const pending = await kernel.login('intl')
    assert.equal(pending.login.status, 'pending')
    assert.match(pending.login.url, /loginSessionId=/)
    await waitFor(() => kernel.status().login.status === 'succeeded', 'OAuth fixture did not finish')

    const statePath = path.join(dir, 'workbuddy-state.json')
    const stateStat = fs.statSync(statePath)
    assert.equal(stateStat.mode & 0o777, 0o600)
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    assert.deepEqual(persisted.accounts.map(({ region, name }) => ({ region, name })), [
      { region: 'intl', name: 'Fixture User' },
    ])
    assert.match(persisted.credentials.WORKBUDDY_ACCESS_TOKEN, /fixture-access-token/)
    assert.equal(JSON.stringify(await kernel.status()).includes('fixture-access-token'), false)

    const models = await kernel.models()
    const selected = models.find(model => model.id.startsWith('workbuddy/'))
    assert.ok(selected, 'expected a WorkBuddy fallback model')
    const chunks = []
    const outcome = await kernel.complete({
      model: selected.id,
      openAi: { messages: [{ role: 'user', content: 'fixture prompt' }] },
    }, chunk => chunks.push(chunk))
    assert.equal(outcome.error, undefined)
    assert.equal(outcome.text, 'fixture answer')
    assert.ok(chunks.length > 0)
    assert.ok(seen.every(({ url }) => url.startsWith('https://www.workbuddy.ai/')))
    assert.ok(seen.some(({ url }) => url.endsWith('/v2/chat/completions')))

    await kernel.close()
    const restored = createWorkBuddyKernel({
      dataDir: dir,
      logger: {},
      fetcher: async url => { throw new Error(`status unexpectedly accessed network: ${url}`) },
    })
    try {
      const restoredStatus = await restored.status()
      assert.deepEqual(restoredStatus.accounts.map(({ region, name }) => ({ region, name })), [
        { region: 'intl', name: 'Fixture User' },
      ])
      assert.equal(restoredStatus.login.status, 'idle')
      const [{ id, region }] = restoredStatus.accounts
      const loggedOut = await restored.logout({ id, region })
      assert.deepEqual(loggedOut.accounts, [])
      const afterLogout = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      assert.deepEqual(afterLogout.credentials, {})
      assert.deepEqual(afterLogout.accounts, [])
    } finally {
      await restored.close()
    }
  } finally {
    await kernel.close()
  }
})
