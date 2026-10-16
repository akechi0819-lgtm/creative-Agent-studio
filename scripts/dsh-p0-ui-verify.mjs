import { spawn, spawnSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const workspaceRoot = path.resolve(scriptDir, '..')
const adapterRoot = path.join(workspaceRoot, 'adapters/dsh')
const evidenceDir = path.join(workspaceRoot, '.research/dsh/.p0-evidence')
const profileHome = path.join(evidenceDir, 'profile-home-ui')
const reportDir = path.join(workspaceRoot, 'docs/evidence/p0')
const cliPath = path.join(adapterRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const hostPlugin = path.join(adapterRoot, 'ui-host.mjs')
const patchPath = path.join(evidenceDir, 'ui.cordis.yml')
const screenshotPath = path.join(reportDir, 'dsh-ui-probe.png')
const reportPath = path.join(reportDir, 'dsh-ui-report.json')
const reportLogPath = path.join(reportDir, 'dsh-report.log')
let port
let baseUrl
const timeoutMs = 30_000
let server
let browser
let page
let stdoutBuffer = ''
let authenticatedLaunchUrl
let bootGraph
const safeLines = []

function safeMessage(message) {
  return String(message || '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|token)\s*[:=]\s*)[^\s,}]+/gi, '$1[REDACTED]')
    .slice(0, 240)
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer()
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address()
      const allocated = typeof address === 'object' && address ? address.port : undefined
      listener.close((error) => error ? reject(error) : resolve(allocated))
    })
  })
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const poll = async () => {
      if (Date.now() >= deadline) return reject(new Error('web-server-timeout'))
      if (server?.exitCode !== null && server?.exitCode !== undefined) {
        return reject(new Error(`web-server-exited:${server.exitCode}`))
      }
      try {
        const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })
        if (response.status < 500) return resolve()
      } catch {}
      await wait(250)
      void poll()
    }
    void poll()
  })
}

async function closeServer() {
  if (!server) return
  const signalOwnedGroup = (signal) => {
    if (process.platform !== 'win32') {
      try {
        // The DSH CLI owns this detached process group; never target unrelated process names.
        process.kill(-server.pid, signal)
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error
      }
    } else if (server.exitCode === null && server.signalCode === null) {
      server.kill(signal)
    }
  }
  const groupExists = () => {
    if (process.platform === 'win32') return server.exitCode === null && server.signalCode === null
    try {
      process.kill(-server.pid, 0)
      return true
    } catch (error) {
      return error?.code !== 'ESRCH'
    }
  }
  signalOwnedGroup('SIGTERM')
  const deadline = Date.now() + 5000
  while (groupExists() && Date.now() < deadline) await wait(100)
  if (groupExists()) signalOwnedGroup('SIGKILL')
}

try {
  await mkdir(evidenceDir, { recursive: true })
  await mkdir(profileHome, { recursive: true })
  await mkdir(reportDir, { recursive: true })
  port = await allocatePort()
  baseUrl = `http://127.0.0.1:${port}`
  authenticatedLaunchUrl = baseUrl

  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: profileHome,
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    LANG: process.env.LANG || 'en_US.UTF-8',
    DSH_HOME: profileHome,
  }
  const built = spawnSync(process.execPath, [path.join(scriptDir, 'dsh-p0-build-client.mjs')], {
    cwd: workspaceRoot,
    env,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  if (built.error || built.status !== 0) throw new Error(`client-build-failed:${built.status ?? built.error?.name}`)
  safeLines.push(...built.stdout.split(/\r?\n/).filter(Boolean))

  await writeFile(patchPath, `- insert:\n    - id: creative-agent-studio-dsh-p0\n      name: ${JSON.stringify(hostPlugin)}\n`, { mode: 0o600 })
  server = spawn(process.execPath, [
    cliPath,
    '--profile', 'web',
    '--patch', patchPath,
    '--no-open',
    '--host', '127.0.0.1',
    '--port', String(port),
  ], {
    cwd: workspaceRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  const collect = (chunk) => {
    stdoutBuffer += chunk.toString('utf8')
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() || ''
    for (const line of lines) {
      const launchMatch = line.match(/dsh web:\s+(https?:\/\/\S+)/)
      if (launchMatch) {
        try {
          const candidate = new URL(launchMatch[1])
          if (candidate.origin === baseUrl) authenticatedLaunchUrl = candidate.href
        } catch {}
        continue
      }
      if (/client-modules|dsh-p0|error|fail|invalid|warn|listen/i.test(line)) {
        const safe = safeMessage(line)
        if (!safeLines.includes(safe)) safeLines.push(safe.slice(0, 260))
      }
    }
  }
  server.stdout.on('data', collect)
  server.stderr.on('data', collect)
  await waitForServer()

  const { chromium } = await import('playwright')
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 })
  await page.addInitScript(() => {
    const probe = { registeredIds: [], materializedIds: [], system: undefined }
    Object.defineProperty(window, '__dshP0ModuleProbe', { configurable: false, value: probe })
    const wrapLoader = (target) => {
      if (!target || typeof target.load !== 'function' || target.load.__dshP0Wrapped) return
      const originalLoad = target.load
      const wrappedLoad = function (registration) {
        probe.registeredIds.push(registration.id)
        const originalFactory = registration.factory
        return originalLoad.call(this, {
          ...registration,
          factory(require) {
            probe.materializedIds.push(registration.id)
            return originalFactory(require)
          },
        })
      }
      Object.defineProperty(wrappedLoad, '__dshP0Wrapped', { value: true })
      target.load = wrappedLoad
    }
    let current
    Object.defineProperty(window, '__ModuleLoader__', {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (target) => {
        current = target
        if (!target || typeof target !== 'object') return
        wrapLoader(target)
        if (typeof target.create === 'function' && !target.create.__dshP0Wrapped) {
          const originalCreate = target.create
          const wrappedCreate = function (...args) {
            const system = originalCreate.apply(this, args)
            probe.system = system
            wrapLoader(this)
            return system
          }
          Object.defineProperty(wrappedCreate, '__dshP0Wrapped', { value: true })
          target.create = wrappedCreate
        }
      },
    })
  })
  page.on('console', (message) => {
    const line = message.text()
    if (line.startsWith('[dsh-p0-ui]')) safeLines.push(safeMessage(line))
    else if (message.type() === 'error') safeLines.push(`[dsh-p0-ui] CONSOLE_ERROR ${safeMessage(line)}`)
  })
  page.on('pageerror', (error) => safeLines.push(`[dsh-p0-ui] PAGE_ERROR ${safeMessage(error.message)}`))
  page.on('response', (response) => {
    const responseUrl = new URL(response.url())
    if (responseUrl.origin === baseUrl && responseUrl.pathname.startsWith('/plugins/')) {
      const responseHasProbe = response.url().includes('creative-agent-studio-dsh-p0')
      safeLines.push(`[dsh-p0-ui] PLUGIN_BUNDLE_HTTP status=${response.status()} path=${responseUrl.pathname} hasProbe=${responseHasProbe}`)
    } else if (response.status() >= 400 && responseUrl.origin === baseUrl) {
      safeLines.push(`[dsh-p0-ui] HTTP_ERROR status=${response.status()} path=${responseUrl.pathname}`)
    }
  })
  const pageUrl = new URL(authenticatedLaunchUrl)
  pageUrl.searchParams.set('dshP0UiProbe', '1')
  await page.goto(pageUrl.href, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  bootGraph = await page.evaluate(() => {
    const graph = window.__DSH_BOOT__
    return {
      present: Boolean(graph),
      entries: graph?.entries?.map((entry) => entry.id) ?? [],
      batchEntries: graph?.batches?.flatMap((batch) => batch.entries) ?? [],
    }
  }).catch((error) => ({ present: false, readError: safeMessage(error.message) }))
  safeLines.push(`[dsh-p0-ui] BOOT_GRAPH present=${bootGraph.present} entryCount=${bootGraph.entries?.length ?? 0} hasProbe=${Boolean(bootGraph.entries?.includes('creative-agent-studio-dsh-p0'))}`)
  await page.waitForFunction(() => {
    const bodyText = document.body?.innerText ?? ''
    return bodyText.includes('预览版说明')
      || bodyText.includes('添加一个 API Key 开始使用')
      || Boolean(document.querySelector('[data-dsh-p0-ui-status]'))
  }, null, { timeout: 20_000 }).catch((error) => safeLines.push(`[dsh-p0-ui] APP_HYDRATION_WAIT ${safeMessage(error.message)}`))
  const frames = page.frames()
  const frameDiagnostics = await Promise.all(frames.map(async (frame) => ({
    url: (() => { try { const url = new URL(frame.url()); return `${url.origin}${url.pathname}` } catch { return 'unavailable' } })(),
    headingCount: await frame.getByText('预览版说明', { exact: true }).count().catch(() => -1),
    headingVisible: await frame.getByText('预览版说明', { exact: true }).isVisible().catch(() => false),
    continueCount: await frame.getByRole('button', { name: '继续', exact: true }).count().catch(() => -1),
    visibleButtonNames: await frame.locator('button:visible').allInnerTexts().catch(() => []),
  })))
  safeLines.push(`[dsh-p0-ui] FRAME_DIAGNOSTICS ${safeMessage(JSON.stringify(frameDiagnostics))}`)
  let targetFrame = page.mainFrame()
  let previewHeading = targetFrame.getByText('预览版说明', { exact: true })
  let continueButton = targetFrame.getByRole('button', { name: '继续', exact: true })
  let continueCount = await continueButton.count()
  let previewVisible = await continueButton.isVisible().catch(() => false)
  // The predicate above returns a Promise; find the first exact accessible button explicitly.
  for (const frame of frames) {
    const candidate = frame.getByRole('button', { name: '继续', exact: true })
    const count = await candidate.count().catch(() => 0)
    if (count === 1) {
      targetFrame = frame
      previewHeading = frame.getByText('预览版说明', { exact: true })
      continueButton = candidate
      continueCount = count
      previewVisible = await continueButton.isVisible().catch(() => false)
      break
    }
  }
  safeLines.push(`[dsh-p0-ui] PREVIEW_DOM headingVisible=${previewVisible} continueButtonCount=${continueCount}`)
  if (previewVisible) {
    if (continueCount !== 1) throw new Error(`preview-continue-button-count:${continueCount}`)
    await continueButton.click({ timeout: 5000 })
    await continueButton.waitFor({ state: 'hidden', timeout: 10_000 })
    await previewHeading.waitFor({ state: 'hidden', timeout: 10_000 })
  }
  const previewDismissed = !await previewHeading.isVisible().catch(() => false)
    && !await continueButton.isVisible().catch(() => false)
  safeLines.push(`[dsh-p0-ui] PREVIEW_ACK visible=${previewVisible} dismissed=${previewDismissed}`)
  if (!previewDismissed) throw new Error('preview-modal-did-not-dismiss')
  await page.waitForFunction(() => {
    const bodyText = document.body?.innerText ?? ''
    return bodyText.includes('添加一个 API Key 开始使用') || Boolean(document.querySelector('[data-dsh-p0-ui-status]'))
  }, null, { timeout: 15_000 }).catch(() => {})
  const onboardingHeading = page.getByText('添加一个 API Key 开始使用', { exact: true })
  const onboardingVisible = await onboardingHeading.isVisible().catch(() => false)
  if (onboardingVisible) {
    const deferButton = page.getByRole('button', { name: '稍后配置', exact: true })
    const deferCount = await deferButton.count()
    safeLines.push(`[dsh-p0-ui] MODEL_ONBOARDING visible=true deferButtonCount=${deferCount} configured=false`)
    if (deferCount !== 1) throw new Error(`model-onboarding-defer-button-count:${deferCount}`)
    await deferButton.click({ timeout: 5000 })
    await deferButton.waitFor({ state: 'hidden', timeout: 10_000 })
    await onboardingHeading.waitFor({ state: 'hidden', timeout: 10_000 })
  }
  safeLines.push(`[dsh-p0-ui] MODEL_ONBOARDING skipped=${onboardingVisible} configured=false modelRequestSent=false`)
  let probeFlagPresent = await page.evaluate(() => new URLSearchParams(location.search).get('dshP0UiProbe') === '1').catch(() => false)
  if (!probeFlagPresent) {
    const probeUrl = new URL(baseUrl)
    probeUrl.searchParams.set('dshP0UiProbe', '1')
    safeLines.push('[dsh-p0-ui] AUTH_REDIRECT_DROPPED_PROBE_FLAG true; retrying same-origin route after cookie bootstrap')
    await page.goto(probeUrl.href, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForFunction(() => Boolean(window.__DSH_BOOT__), null, { timeout: 20_000 })
    bootGraph = await page.evaluate(() => {
      const graph = window.__DSH_BOOT__
      return {
        present: Boolean(graph),
        entries: graph?.entries?.map((entry) => entry.id) ?? [],
        batchEntries: graph?.batches?.flatMap((batch) => batch.entries) ?? [],
      }
    })
    probeFlagPresent = await page.evaluate(() => new URLSearchParams(location.search).get('dshP0UiProbe') === '1')
    const retryOnboarding = page.getByText('添加一个 API Key 开始使用', { exact: true })
    if (await retryOnboarding.isVisible().catch(() => false)) {
      const deferButton = page.getByRole('button', { name: '稍后配置', exact: true })
      if (await deferButton.count() !== 1) throw new Error('model-onboarding-defer-button-count-after-reload')
      await deferButton.click({ timeout: 5000 })
      await deferButton.waitFor({ state: 'hidden', timeout: 10_000 })
    }
  }
  safeLines.push(`[dsh-p0-ui] PROBE_FLAG present=${probeFlagPresent}`)
  if (!probeFlagPresent) throw new Error('probe-flag-not-preserved-after-auth-bootstrap')
  await page.waitForSelector('[data-dsh-p0-ui-status]', { timeout: timeoutMs })
  await page.waitForFunction(() => {
    const status = document.querySelector('[data-dsh-p0-ui-status]')
    return status?.getAttribute('data-dsh-p0-ui-status') !== 'running'
  }, null, { timeout: timeoutMs })
  const status = await page.locator('[data-dsh-p0-ui-status]').getAttribute('data-dsh-p0-ui-status')
  const message = await page.locator('[data-dsh-p0-ui-status]').innerText()
  let postOpenOnboardingDismissed = true
  const postOpenOnboarding = page.getByText('添加一个 API Key 开始使用', { exact: true })
  if (await postOpenOnboarding.isVisible().catch(() => false)) {
    const deferButton = page.getByRole('button', { name: '稍后配置', exact: true })
    const deferCount = await deferButton.count()
    safeLines.push(`[dsh-p0-ui] POST_OPEN_MODEL_ONBOARDING visible=true deferButtonCount=${deferCount} configured=false`)
    if (deferCount !== 1) throw new Error(`post-open-model-onboarding-defer-count:${deferCount}`)
    await deferButton.click({ timeout: 5000 })
    await deferButton.waitFor({ state: 'hidden', timeout: 10_000 })
    await postOpenOnboarding.waitFor({ state: 'hidden', timeout: 10_000 })
    postOpenOnboardingDismissed = !await postOpenOnboarding.isVisible().catch(() => false)
  }
  safeLines.push(`[dsh-p0-ui] POST_OPEN_MODEL_ONBOARDING dismissed=${postOpenOnboardingDismissed} configured=false modelRequestSent=false`)
  const probeNodeCount = await page.locator('[data-studio-p0-probe]').count()
  const probeNodeVisible = probeNodeCount === 1 && await page.locator('[data-studio-p0-probe]').isVisible()
  const uiChecks = await page.locator('[data-dsh-p0-ui-status]').getAttribute('data-dsh-p0-ui-checks')
    .then((value) => JSON.parse(value || '{}'))
    .catch(() => ({}))
  const moduleProbe = await page.evaluate(() => {
    const probe = window.__dshP0ModuleProbe
    const system = probe?.system
    const entryState = system?.entries?.state?.getSnapshot?.()
    const row = system?.manifest?.modules?.find((entry) => entry.id === 'creative-agent-studio-dsh-p0')
    const importError = system?.importError?.('creative-agent-studio-dsh-p0')
    return {
      registered: probe?.registeredIds?.includes('creative-agent-studio-dsh-p0') ?? false,
      materialized: probe?.materializedIds?.includes('creative-agent-studio-dsh-p0') ?? false,
      systemVersion: system?.version,
      loadCacheHasProbe: system?.loadCache?.has?.('creative-agent-studio-dsh-p0') ?? false,
      importError: importError instanceof Error ? importError.message : importError ? String(importError) : undefined,
      graphRow: row ? { id: row.id, inject: row.inject } : undefined,
      entryState: entryState ? { syncing: entryState.syncing, failures: entryState.failures } : undefined,
    }
  }).catch((error) => ({ error: safeMessage(error.message) }))
  const clientModuleLoaded = moduleProbe.registered === true && moduleProbe.materialized === true
  const success = status === 'success'
    && uiChecks.businessEventDefinitionRegistered === true
    && uiChecks.chatViewRegistered === true
    && uiChecks.slotRendererRegistered === true
    && uiChecks.eventAppended === true
    && uiChecks.conversationSnapshotContainsProbe === true
    && uiChecks.registeredRendererVisible === true
    && probeNodeVisible
    && postOpenOnboardingDismissed
    && clientModuleLoaded
  await page.locator('[data-dsh-p0-ui-status]').evaluate((element) => element.remove())
  await Promise.race([page.screenshot({ path: screenshotPath, fullPage: false }), wait(5000)])
  safeLines.push(`[dsh-p0-ui] WEB_PROFILE status=ready url=${baseUrl}`)
  safeLines.push(`[dsh-p0-ui] CLIENT_MODULE status=${clientModuleLoaded ? 'loaded' : 'check-failed'}`)
  safeLines.push(`[dsh-p0-ui] UI_CHECKS ${safeMessage(JSON.stringify(uiChecks))}`)
  safeLines.push(`[dsh-p0-ui] CONVERSATION_SNAPSHOT status=${uiChecks.conversationSnapshotContainsProbe ? 'business-node-present' : 'missing'} renderer=${probeNodeVisible ? 'visible' : 'missing'}`)
  safeLines.push(`[dsh-p0-ui] RESULT status=${success ? 'passed' : 'failed'} detail=${safeMessage(message)}`)

  const report = {
    schemaVersion: 1,
    scope: 'P0 business UI browser slice',
    verifiedAt: new Date().toISOString(),
    dshVersion: JSON.parse(await readFile(path.join(adapterRoot, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version,
    status: success ? 'passed' : 'failed',
    checks: {
      dshClientManifestDiscovered: bootGraph?.entries?.includes('creative-agent-studio-dsh-p0') === true,
      browserBundleLoaded: clientModuleLoaded,
      businessEventDefinitionRegistered: uiChecks.businessEventDefinitionRegistered === true,
      chatViewRegistered: uiChecks.chatViewRegistered === true,
      slotRendererRegistered: uiChecks.slotRendererRegistered === true,
      eventAppended: uiChecks.eventAppended === true,
      conversationSnapshotContainsProbe: uiChecks.conversationSnapshotContainsProbe === true,
      registeredRendererVisible: uiChecks.registeredRendererVisible === true && probeNodeVisible,
      postOpenOnboardingDismissed,
      modelRequestSent: false,
    },
    detail: safeMessage(message),
    diagnostics: { uiChecks, moduleProbe },
    screenshot: 'docs/evidence/p0/dsh-ui-probe.png',
    note: '探针在隔离的 DSH Web 页面内创建空白本地 session，通过 Conversation event source fixture 注入纯文本事件，并用 uiWorkspace.openSession 进入官方 ChatFlow/ChatNodeSeat；仅通过“稍后配置”关闭无凭据引导，不发起模型请求。',
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  await appendFile(reportLogPath, `${safeLines.join('\n')}\n`)

  const overallPath = path.join(reportDir, 'dsh-report.json')
  try {
    const overall = JSON.parse(await readFile(overallPath, 'utf8'))
    overall.checks.businessUi = {
      sourceImplemented: true,
      browserBundleLoaded: clientModuleLoaded,
      status: success ? 'passed' : 'failed',
      eventDefinitionRegistered: uiChecks.businessEventDefinitionRegistered === true,
      snapshotNode: uiChecks.conversationSnapshotContainsProbe === true,
      slotRendererRegistered: uiChecks.slotRendererRegistered === true,
      rendererVisible: uiChecks.registeredRendererVisible === true && probeNodeVisible,
      screenshot: 'dsh-ui-probe.png',
      modelRequestSent: false,
    }
    await writeFile(overallPath, `${JSON.stringify(overall, null, 2)}\n`)
  } catch {}

  process.stdout.write(`${safeLines.join('\n')}\n[dsh-p0-ui] REPORT ${reportPath}\n[dsh-p0-ui] SCREENSHOT ${screenshotPath}\n`)
  if (!success) process.exitCode = 1
} catch (error) {
  const message = safeMessage(error instanceof Error ? error.message : 'unknown-error')
  let pageDetails = {}
  if (page) {
    try {
      const pageUrl = new URL(page.url())
      const bodyText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')
      pageDetails = {
        pageUrl: `${pageUrl.origin}${pageUrl.pathname}`,
        title: safeMessage(await page.title().catch(() => '')),
        probeFlagPresent: await page.evaluate(() => new URLSearchParams(location.search).get('dshP0UiProbe') === '1').catch(() => false),
        body: safeMessage(bodyText),
        bodyLength: bodyText.length,
        hasPreviewHeading: bodyText.includes('预览版说明'),
        hasContinueText: bodyText.includes('继续'),
        hasProbeStatus: await page.locator('[data-dsh-p0-ui-status]').count().catch(() => -1),
        buttons: await page.locator('button').allInnerTexts().catch(() => []),
        moduleProbe: await page.evaluate(() => {
          const probe = window.__dshP0ModuleProbe
          const system = probe?.system
          const entryState = system?.entries?.state?.getSnapshot?.()
          const row = system?.manifest?.modules?.find((entry) => entry.id === 'creative-agent-studio-dsh-p0')
          const importError = system?.importError?.('creative-agent-studio-dsh-p0')
          return {
            registeredIds: probe?.registeredIds ?? [],
            materializedIds: probe?.materializedIds ?? [],
            probeFlagPresent: new URLSearchParams(location.search).get('dshP0UiProbe') === '1',
            systemVersion: system?.version,
            loadCacheHasProbe: system?.loadCache?.has?.('creative-agent-studio-dsh-p0') ?? false,
            importError: importError instanceof Error ? importError.message : importError ? String(importError) : undefined,
            graphRow: row ? { id: row.id, inject: row.inject, url: row.url } : undefined,
            entryState: entryState ? { syncing: entryState.syncing, failures: entryState.failures } : undefined,
          }
        }).catch((error) => ({ error: safeMessage(error.message) })),
      }
      await Promise.race([page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {}), wait(5000)])
    } catch {}
  }
  const failure = {
    schemaVersion: 1,
    scope: 'P0 business UI browser slice',
    verifiedAt: new Date().toISOString(),
    status: 'failed',
    detail: message,
    launchUrlCaptured: authenticatedLaunchUrl !== baseUrl,
    bootGraph,
    diagnostics: safeLines,
    page: pageDetails,
    screenshot: page ? 'docs/evidence/p0/dsh-ui-probe.png' : undefined,
    modelRequestSent: false,
  }
  await mkdir(reportDir, { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(failure, null, 2)}\n`)
  await appendFile(reportLogPath, `${safeLines.join('\n')}\n`)
  process.stderr.write(`[dsh-p0-ui] VERIFY_FAILED ${message}\n`)
  process.exitCode = 1
} finally {
  if (browser) {
    await Promise.race([browser.close().catch(() => {}), wait(5000)])
  }
  await closeServer().catch(() => {})
}
