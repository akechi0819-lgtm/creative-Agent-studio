import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { callCanvasTool, connection, health, root } from "../src/canvas/client.mjs";

const projectId = "p0-controls";
const instanceDataDir = path.join(root, ".p0-state/controls");
const instanceConfigPath = path.join(instanceDataDir, "canvas-instance.json");
const supervisorLockPath = path.join(instanceDataDir, "supervisor.lock");
const browserProfileDir = path.join(instanceDataDir, "test-browser");
const evidenceDir = path.join(root, "docs/evidence/p0");
const screenshotPath = path.join(evidenceDir, "controls.png");
const reportPath = path.join(evidenceDir, "controls-report.json");
process.env.STUDIO_DATA_DIR = instanceDataDir;
process.env.STUDIO_PROJECT_ID = projectId;

const report = {
    date: new Date().toISOString(),
    projectId,
    instanceId: null,
    instances: [],
    tests: [],
    rejection: null,
    acceptedNode: null,
    browser: {
        persistentContext: true,
        profile: ".p0-state/controls/test-browser",
        agentRequests: [],
        pageErrors: [],
        consoleErrors: [],
    },
    restart: null,
    cleanup: { browserClosed: false, firstBrowserClosed: false, ownInstanceStopped: false, stoppedInstanceIds: [] },
};
let browser;
let page;
let config;
const ownedInstanceIds = new Set();
let activeOwnedInstanceId = null;
let failed = false;
let failureText = "";

function runCanvas(action) {
    return spawnSync(process.execPath, [path.join(root, "scripts/canvas.mjs"), action], {
        cwd: root,
        env: { ...process.env, STUDIO_DATA_DIR: instanceDataDir, STUDIO_PROJECT_ID: projectId },
        encoding: "utf8",
        timeout: 20000,
    });
}

function safeError(error) {
    let value = error instanceof Error ? error.message : String(error);
    if (config?.token) value = value.split(config.token).join("[redacted]");
    value = value.replace(/([#&?]agentToken=)[^&\s]+/g, "$1[redacted]");
    return value;
}

async function waitForCanvasTarget(page) {
    for (let attempt = 0; attempt < 120; attempt++) {
        const current = await health(config);
        const targets = current.targets.filter((target) => target.projectId === projectId && target.hasCanvas);
        if (targets.length) {
            assert.equal(targets.length, 1, "只允许一个 p0-controls 画布网页连接");
            return targets[0];
        }
        await page.waitForTimeout(100);
    }
    throw new Error("独立绘图工具面板未连接到 p0-controls 画布");
}

async function waitForPending(page) {
    await page.getByText("待确认：canvas_apply_ops", { exact: true }).waitFor({ timeout: 10000 });
}

async function waitForInstanceStopped(instanceId) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (!existsSync(instanceConfigPath)) {
            if (!existsSync(supervisorLockPath)) return true;
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
        }
        try {
            const current = JSON.parse(await readFile(instanceConfigPath, "utf8"));
            if (current.instanceId !== instanceId || current.projectId !== projectId) return false;
        } catch {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
}

function parseStartedInstance(started) {
    if (started.status !== 0) throw new Error(`独立 Canvas 启动失败：${started.stderr.trim() || started.stdout.trim()}`);
    const line = started.stdout.trim().split(/\r?\n/).at(-1);
    const payload = JSON.parse(line);
    assert.equal(payload.started, true, "启动命令应返回已启动实例信息");
    assert.equal(payload.projectId, projectId, "启动命令返回的项目必须是本次指定项目");
    ownedInstanceIds.add(payload.instanceId);
    activeOwnedInstanceId = payload.instanceId;
    return payload;
}

async function startOwnInstance() {
    const started = parseStartedInstance(runCanvas("start"));
    config = await connection();
    const currentHealth = await health(config);
    assert.equal(config.projectId, projectId);
    assert.equal(config.instanceId, started.instanceId);
    assert.equal(currentHealth.projectId, projectId);
    assert.equal(currentHealth.instanceId, config.instanceId);
    report.instances.push({ instanceId: config.instanceId, webUrl: config.webUrl });
    return config;
}

async function stopOwnInstance(expected) {
    const current = await connection();
    assert.equal(current.instanceId, expected.instanceId, "只停止本脚本启动的预期实例");
    assert.equal(current.projectId, projectId, "只停止 p0-controls 项目实例");
    assert.ok(ownedInstanceIds.has(current.instanceId), "拒绝停止未由本脚本启动的实例");
    const stopped = runCanvas("stop");
    if (stopped.status !== 0) throw new Error(`停止独立 Canvas 失败：${stopped.stderr.trim() || stopped.stdout.trim()}`);
    const released = await waitForInstanceStopped(expected.instanceId);
    if (!released) throw new Error("停止后实例配置或锁仍存在，或实例身份发生变化");
    report.cleanup.stoppedInstanceIds.push(expected.instanceId);
    activeOwnedInstanceId = null;
}

function attachBrowserChecks(targetPage) {
    targetPage.on("pageerror", (error) => report.browser.pageErrors.push(error.message));
    targetPage.on("console", (message) => {
        if (message.type() === "error") report.browser.consoleErrors.push(message.text());
    });
    targetPage.on("request", (request) => {
        try {
            const url = new URL(request.url());
            if (url.pathname.startsWith("/agent/")) report.browser.agentRequests.push(url.pathname);
        } catch {
            // Ignore non-URL request values from the browser adapter.
        }
    });
}

async function openPersistentBrowser(url) {
    browser = await chromium.launchPersistentContext(browserProfileDir, {
        channel: "chrome",
        headless: true,
        viewport: { width: 1440, height: 1000 },
    });
    page = browser.pages()[0] || await browser.newPage();
    attachBrowserChecks(page);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return page;
}

async function closeBrowser() {
    if (!browser) return;
    await browser.close();
    browser = null;
    page = null;
    report.cleanup.browserClosed = true;
}

async function openToolsPanel(targetPage) {
    const panelTitle = targetPage.getByText("Canvas 绘图工具", { exact: true });
    if (!(await panelTitle.isVisible().catch(() => false))) {
        await targetPage.getByRole("button", { name: "绘图工具", exact: true }).click();
    }
    await panelTitle.waitFor({ state: "visible", timeout: 10000 });
    await targetPage.getByText("已连接 · 纯绘图工具已连接", { exact: true }).waitFor({ timeout: 10000 });
    return targetPage.locator('aside[data-canvas-shortcuts-ignore]');
}

async function waitForNode(text) {
    for (let attempt = 0; attempt < 60; attempt++) {
        const state = await callCanvasTool("canvas_get_state", {}, config);
        const node = state.nodes.find((item) => item.type === "text" && item.metadata.content.includes(text));
        if (node) return { state, node };
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`等待画布中的持久化文本节点超时：${text}`);
}

async function cleanupActiveOwnInstance() {
    if (activeOwnedInstanceId) {
        const current = await connection();
        if (current.instanceId !== activeOwnedInstanceId || current.projectId !== projectId || !ownedInstanceIds.has(current.instanceId)) {
            throw new Error("当前实例身份不属于本脚本，拒绝停止");
        }
        await stopOwnInstance(current);
    }
    report.cleanup.ownInstanceStopped = [...ownedInstanceIds].every((id) => report.cleanup.stoppedInstanceIds.includes(id));
}

try {
    await mkdir(evidenceDir, { recursive: true });
    if (existsSync(instanceConfigPath) || existsSync(supervisorLockPath)) {
        throw new Error(".p0-state/controls 已有实例状态；为避免影响非本次实例，拒绝启动或停止");
    }

    // This dedicated profile is used only by this repeatable P0 test. Keep it
    // through the service restart so IndexedDB/localStorage remain the same.
    await rm(browserProfileDir, { recursive: true, force: true });
    await mkdir(browserProfileDir, { recursive: true });

    const firstConfig = await startOwnInstance();
    report.instanceId = config.instanceId;
    report.tests.push("isolated-controls-instance");

    await openPersistentBrowser(firstConfig.browserUrl);
    const target = await waitForCanvasTarget(page);
    report.clientId = target.clientId;
    const toolPanel = await openToolsPanel(page);
    await page.getByLabel("逐次确认绘图操作").check();
    report.tests.push("independent-tool-panel-connected", "per-operation-confirmation-enabled");

    const before = await callCanvasTool("canvas_get_state", {}, config);
    assert.equal(before.nodes.length, 0, "隔离项目初始画布应为空");
    const rejectedText = "P0 controls rejected text";
    const rejectedRequest = callCanvasTool("canvas_create_text_node", {
        text: rejectedText,
        title: "P0 拒绝验证",
        x: 0,
        y: 0,
    }, config).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: safeError(error) }));
    await waitForPending(page);
    const stateBeforeDecision = await callCanvasTool("canvas_get_state", {}, config);
    assert.equal(stateBeforeDecision.nodes.some((node) => node.type === "text" && node.metadata.content.includes(rejectedText)), false);
    report.confirmationUi = {
        text: await toolPanel.innerText(),
        buttons: await toolPanel.locator("button").allTextContents(),
    };
    report.tests.push("confirmation-waits-before-canvas-mutation");
    const rejectButton = toolPanel.locator("button").filter({ hasText: /拒\s*绝/ });
    assert.equal(await rejectButton.count(), 1, "工具面板应显示一个拒绝按钮");
    await rejectButton.click();
    const rejected = await rejectedRequest;
    assert.equal(rejected.ok, false, "拒绝操作应向共享工具调用返回错误");
    assert.match(rejected.error, /用户拒绝画布操作/);
    const afterReject = await callCanvasTool("canvas_get_state", {}, config);
    assert.equal(afterReject.nodes.some((node) => node.type === "text" && node.metadata.content.includes(rejectedText)), false);
    report.rejection = { returnedError: true, canvasChanged: false };
    report.tests.push("rejection-returns-error-without-canvas-mutation");

    const acceptedText = "P0 controls accepted text";
    const acceptedRequest = callCanvasTool("canvas_create_text_node", {
        text: acceptedText,
        title: "P0 接受验证",
        x: 0,
        y: 0,
    }, config).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: safeError(error) }));
    await waitForPending(page);
    const stateBeforeApproval = await callCanvasTool("canvas_get_state", {}, config);
    assert.equal(stateBeforeApproval.nodes.some((node) => node.type === "text" && node.metadata.content.includes(acceptedText)), false);
    await toolPanel.locator("button").filter({ hasText: /执\s*行/ }).click();
    const accepted = await acceptedRequest;
    assert.equal(accepted.ok, true, `接受操作失败：${accepted.ok ? "" : accepted.error}`);
    const finalState = await callCanvasTool("canvas_get_state", {}, config);
    const created = finalState.nodes.find((node) => node.type === "text" && node.metadata.content.includes(acceptedText));
    assert.ok(created, "接受后画布状态中应包含新文本节点");
    report.acceptedNode = { id: created.id, type: created.type, text: acceptedText };
    report.tests.push("approval-creates-text-node");

    // Zustand persists the canvas through a 400ms debounce. Leave enough time
    // for the storage write to finish before closing the first browser.
    await page.waitForTimeout(900);
    await closeBrowser();
    report.cleanup.firstBrowserClosed = true;

    await stopOwnInstance(firstConfig);
    report.cleanup.firstInstanceStopped = true;
    report.tests.push("first-instance-stopped-before-restart");

    const restartedConfig = await startOwnInstance();
    assert.notEqual(restartedConfig.instanceId, firstConfig.instanceId, "重启后应创建新的实例 ID");
    assert.equal(restartedConfig.webUrl, firstConfig.webUrl, "相同数据目录重启应复用固定 web origin/port");
    assert.equal(restartedConfig.projectId, projectId);
    report.restart = {
        previousInstanceId: firstConfig.instanceId,
        instanceId: restartedConfig.instanceId,
        webUrl: restartedConfig.webUrl,
        instanceIdChanged: restartedConfig.instanceId !== firstConfig.instanceId,
        webUrlPreserved: restartedConfig.webUrl === firstConfig.webUrl,
    };
    report.tests.push("restart-uses-new-instance-id", "restart-preserves-web-url");

    await openPersistentBrowser(restartedConfig.browserUrl);
    const restoredTarget = await waitForCanvasTarget(page);
    report.restart.clientId = restoredTarget.clientId;
    await openToolsPanel(page);
    const restored = await waitForNode(acceptedText);
    assert.equal(restored.node.id, created.id, "恢复的节点 ID 应与重启前接受的节点一致");
    report.restart.restoredNode = { id: restored.node.id, type: restored.node.type, text: acceptedText };
    report.tests.push("persistent-profile-bootstrap-restores-canvas-node");

    // Leave the second run visible in the captured evidence.
    await page.screenshot({ path: screenshotPath, fullPage: true });

    assert.deepEqual(report.browser.agentRequests, [], "浏览器不得请求旧 /agent/* 路由");
    assert.deepEqual(report.browser.pageErrors, [], "浏览器运行时不得出现 pageerror");
    assert.deepEqual(report.browser.consoleErrors, [], "浏览器控制台不得出现 error");
    report.tests.push("no-agent-browser-requests", "no-browser-runtime-errors");
} catch (error) {
    failed = true;
    failureText = safeError(error);
} finally {
    if (browser) {
        try {
            await closeBrowser();
        } catch (error) {
            failed = true;
            failureText ||= `浏览器关闭失败：${safeError(error)}`;
        }
    }
    if (activeOwnedInstanceId) {
        try {
            await cleanupActiveOwnInstance();
            report.tests.push("own-controls-instances-stopped");
        } catch (error) {
            failed = true;
            failureText ||= `实例清理失败：${safeError(error)}`;
        }
    } else {
        report.cleanup.ownInstanceStopped = [...ownedInstanceIds].every((id) => report.cleanup.stoppedInstanceIds.includes(id));
    }
    if (failed) report.error = failureText;
    await writeFile(reportPath, JSON.stringify(report, null, 2));
}

if (failed) {
    console.error(report.error);
    process.exitCode = 1;
} else {
    console.log(JSON.stringify({
        projectId: report.projectId,
        instanceId: report.instanceId,
        instances: report.instances.map(({ instanceId, webUrl }) => ({ instanceId, webUrl })),
        restart: report.restart,
        tests: report.tests,
        rejection: report.rejection,
        acceptedNode: report.acceptedNode,
        browser: report.browser,
        cleanup: report.cleanup,
        screenshotPath,
        reportPath,
    }, null, 2));
}
