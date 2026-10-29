import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bridgeDiagnostic, createHttpApp, startHttpServer } from "./http.js";

import { CanvasSession } from "../canvas/session.js";

const config = {
    port: 0,
    url: "http://127.0.0.1:0",
    token: "test-token",
    instanceId: "instance-1",
    dataDir: path.resolve(os.tmpdir(), "canvas-bridge-test"),
    origin: "http://localhost:3000",
};

test("HTTP API guards tokens and config is not pinned to a project", async (t) => {
    const { server, baseUrl } = await startApp();
    t.after(() => closeServer(server));

    const health = await fetch(`${baseUrl}/health`).then((response) => response.json()) as Record<string, unknown>;
    assert.equal(health.instanceId, "instance-1");
    assert.equal(Object.hasOwn(health, "projectId"), false);
    const bridgeConfig = await fetch(`${baseUrl}/config`).then((response) => response.json()) as Record<string, unknown>;
    assert.equal(Object.hasOwn(bridgeConfig, "projectId"), false);

    const blockedOrigin = await fetch(`${baseUrl}/health`, { headers: { Origin: "http://other.local" } });
    assert.equal(blockedOrigin.status, 403);

    const unauthorized = await fetch(`${baseUrl}/canvas/activate?projectId=project-1&clientId=client-1`);
    assert.equal(unauthorized.status, 401);

    const unconnectedTarget = await fetch(`${baseUrl}/canvas/activate?projectId=project-2&clientId=client-1`, { method: "POST", headers: headers() });
    assert.equal(unconnectedTarget.status, 409);
});

test("multiple actual projects register independently and tool results must match the original pair", async (t) => {
    const { server, baseUrl } = await startApp();
    t.after(() => closeServer(server));
    const firstController = new AbortController();
    const secondController = new AbortController();
    t.after(() => { firstController.abort(); secondController.abort(); });
    const firstConnection = await connectEvents(baseUrl, "project-1", "client-1", firstController.signal);
    const secondConnection = await connectEvents(baseUrl, "project-2", "client-2", secondController.signal);
    assert.equal(firstConnection.hello.projectId, "project-1");
    assert.equal(secondConnection.hello.projectId, "project-2");

    const stateResponse = await fetch(`${baseUrl}/canvas/state?projectId=project-1&clientId=client-1`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ projectId: "project-1", nodes: [], connections: [], selectedNodeIds: [] }),
    });
    assert.equal(stateResponse.status, 200);

    const secondState = await fetch(`${baseUrl}/canvas/state?projectId=project-2&clientId=client-2`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ projectId: "project-2", clientId: "client-2", nodes: [], connections: [], selectedNodeIds: [] }),
    });
    assert.equal(secondState.status, 200);
    const mismatchedState = await fetch(`${baseUrl}/canvas/state?projectId=project-1&clientId=client-1`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ projectId: "project-2", clientId: "client-1", nodes: [] }),
    });
    assert.equal(mismatchedState.status, 403);

    const activated = await fetch(`${baseUrl}/canvas/activate?projectId=project-1&clientId=client-1`, {
        method: "POST",
        headers: headers(),
    });
    assert.equal(activated.status, 200);
    const health = await fetch(`${baseUrl}/health`).then((response) => response.json()) as { targets: Array<Record<string, unknown>> };
    assert.deepEqual(health.targets, [
        { clientId: "client-1", projectId: "project-1", hasCanvas: true, active: true },
        { clientId: "client-2", projectId: "project-2", hasCanvas: true, active: false },
    ]);

    const requestPromise = fetch(`${baseUrl}/api/tools`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ name: "canvas_read_image", input: { nodeId: "image-1" }, projectId: "project-1", clientId: "client-1" }),
    });
    const call = await readEvent(firstConnection.reader, "tool_call");
    assert.equal(call.name, "canvas_read_image");
    assert.deepEqual(call.input, { nodeId: "image-1" });

    const wrongTargetCall = await fetch(`${baseUrl}/api/tools`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ name: "canvas_read_image", input: { nodeId: "image-1" }, projectId: "project-2", clientId: "client-1" }),
    });
    assert.equal(wrongTargetCall.status, 409);

    const wrongResult = await fetch(`${baseUrl}/canvas/result?projectId=project-2&clientId=client-1`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ requestId: call.requestId, result: { wrong: true } }),
    });
    assert.equal(wrongResult.status, 409);
    const result = await fetch(`${baseUrl}/canvas/result?projectId=project-1&clientId=client-1`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ requestId: call.requestId, result: { dataUrl: "data:image/png;base64,aW1hZ2U=", naturalWidth: 900, naturalHeight: 600 } }),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(await requestPromise.then((response) => response.json()), {
        ok: true,
        result: { dataUrl: "data:image/png;base64,aW1hZ2U=", naturalWidth: 900, naturalHeight: 600 },
    });
});

test("library connection works without canvas state only for navigation and project listing", async (t) => {
    const { server, baseUrl } = await startApp();
    t.after(() => closeServer(server));
    const controller = new AbortController();
    t.after(() => controller.abort());
    const { reader } = await connectEvents(baseUrl, "library", "library", controller.signal);
    const before = await fetch(`${baseUrl}/health`).then((response) => response.json()) as { hasCanvas: boolean; targets: Array<Record<string, unknown>> };
    assert.equal(before.hasCanvas, false);
    assert.deepEqual(before.targets, [{ clientId: "library", projectId: "library", hasCanvas: false, active: false }]);

    for (const [name, input] of [["site_navigate", { path: "/canvas" }], ["canvas_list_projects", {}]] as const) {
        const request = fetch(`${baseUrl}/api/tools`, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({ name, input, projectId: "library", clientId: "library" }),
        });
        const call = await readEvent(reader, "tool_call");
        assert.equal(call.name, name);
        const result = await fetch(`${baseUrl}/canvas/result?projectId=library&clientId=library`, {
            method: "POST", headers: headers(), body: JSON.stringify({ requestId: call.requestId, result: { ok: true } }),
        });
        assert.equal(result.status, 200);
        assert.deepEqual(await request.then((response) => response.json()), { ok: true, result: { ok: true } });
    }
    const blocked = await fetch(`${baseUrl}/api/tools`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ name: "canvas_read_image", input: { nodeId: "image-1" }, projectId: "library", clientId: "library" }),
    });
    assert.equal(blocked.status, 409);
});

test("launcher data directory rejects a second live service instance", async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-bridge-lock-test-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const instanceConfig = { ...config, port: 0, dataDir };
    const server = startHttpServer(instanceConfig);
    t.after(() => closeServer(server));
    await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    const lockPath = path.join(dataDir, "canvas-agent.lock");
    assert.equal(fs.existsSync(lockPath), true);
    assert.throws(() => startHttpServer(instanceConfig), /already running/);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    assert.equal(fs.existsSync(lockPath), false);
});

test("SIGTERM closes active SSE connections and releases the instance lock", {
    skip: process.platform === "win32" ? "Windows terminates the child on SIGTERM instead of exercising POSIX graceful-shutdown behavior" : false,
}, async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-bridge-signal-test-"));
    const port = await freePort();
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
        cwd: packageRoot,
        env: {
            ...process.env,
            PORT: String(port),
            CANVAS_AGENT_TOKEN: "signal-test-token",
            CANVAS_AGENT_INSTANCE_ID: "signal-test-instance",
            CANVAS_AGENT_DATA_DIR: dataDir,
            CANVAS_AGENT_ORIGIN: "http://localhost:3000",
        },
        stdio: "ignore",
    });
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    void exitPromise.catch(() => {});
    const lockPath = path.join(dataDir, "canvas-agent.lock");
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exitPromise.catch(() => {});
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, child);
    const controller = new AbortController();
    t.after(() => controller.abort());
    const events = await fetch(`${baseUrl}/events?token=signal-test-token&projectId=signal-test-project&clientId=signal-test-client`, { signal: controller.signal });
    assert.equal(events.status, 200);
    const reader = events.body!.getReader();
    await readEvent(reader, "hello");
    assert.equal(fs.existsSync(lockPath), true);

    const sseClose = reader.read().then(() => "closed", () => "closed");
    child.kill("SIGTERM");
    const exit = await Promise.race([
        exitPromise,
        new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Canvas bridge did not exit after SIGTERM")), 5000);
            timer.unref();
        }),
    ]);
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(await Promise.race([sseClose, new Promise((resolve) => {
        const timer = setTimeout(() => resolve("open"), 1000);
        timer.unref();
    })]), "closed");
    assert.equal(fs.existsSync(lockPath), false);
});

function headers() {
    return { "content-type": "application/json", "x-canvas-agent-token": config.token, Origin: config.origin };
}

async function connectEvents(baseUrl: string, projectId: string, clientId: string, signal: AbortSignal) {
    const query = new URLSearchParams({ token: config.token, projectId, clientId });
    const response = await fetch(`${baseUrl}/events?${query}`, { headers: { Origin: config.origin }, signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const hello = await readEvent(reader, "hello");
    return { reader, hello };
}

async function startApp() {
    const server = createHttpApp(config).listen(0, "127.0.0.1") as Server;
    await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function closeServer(server: Server) {
    if (!server.listening) return Promise.resolve();
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function freePort() {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return address.port;
}

async function waitForHealth(baseUrl: string, child: ReturnType<typeof spawn>) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error("Canvas bridge exited before becoming ready");
        try {
            const response = await fetch(`${baseUrl}/health`);
            if (response.ok) return;
        } catch {
            // The child may still be starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Canvas bridge did not become ready");
}

async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>, type: string) {
    let buffer = "";
    while (true) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`SSE closed before ${type}`);
        buffer += new TextDecoder().decode(value);
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        for (const frame of frames) {
            const event = frame.match(/^event: (.+)$/m)?.[1];
            const data = frame.match(/^data: (.+)$/m)?.[1];
            if (event === type && data) return JSON.parse(data) as Record<string, unknown>;
        }
    }
}


test("unexpected bridge failures expose a correlation ID without leaking payloads or credentials", async (t) => {
    const lines: string[] = [];
    t.mock.method(console, "error", (line: string) => lines.push(line));
    t.mock.method(CanvasSession.prototype, "callTool", async () => {
        const error = new RangeError("Maximum call stack size exceeded");
        error.stack = "RangeError: secret-token private-prompt\n    at secretFunction (/Users/employee/project/session.ts:144:23)";
        throw error;
    });
    const { server, baseUrl } = await startApp();
    t.after(() => closeServer(server));
    const response = await fetch(`${baseUrl}/api/tools?token=secret-query`, {
        method: "POST", headers: headers(),
        body: JSON.stringify({ name: "canvas_get_state", input: { private: "private-prompt" } }),
    });
    assert.equal(response.status, 500);
    const body = await response.json() as { requestId: string; error: string };
    assert.equal(body.requestId, response.headers.get("x-canvas-request-id"));
    const diagnostic = JSON.parse(lines[0]);
    assert.equal(diagnostic.requestId, body.requestId);
    assert.equal(diagnostic.reason, "stack_overflow");
    assert.equal(diagnostic.tool, "canvas_get_state");
    assert.deepEqual(diagnostic.frames, ["session.ts:144:23"]);
    assert.doesNotMatch(JSON.stringify({ body, diagnostic }), /secret|private-prompt|employee/);
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
});

test("diagnostics omit unknown routes and arbitrary error messages", () => {
    const result = bridgeDiagnostic(new Error("API key and user image"), {path: "/secret-token", method: "GET", body: {}}, "test", 500);
    assert.equal(result.route, "other");
    assert.doesNotMatch(JSON.stringify(result), /secret-token|API key|user image/);
});
