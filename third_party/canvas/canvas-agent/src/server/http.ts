import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";

import { CanvasSession, BridgeError, PROTOCOL_VERSION } from "../canvas/session.js";
import { isToolName } from "../canvas/tools.js";
import { loadConfig, type BridgeConfig } from "../config.js";

/** 创建仅供当前项目网页使用的绘图桥接 HTTP API。 */
export function createHttpApp(config: BridgeConfig) {
    const app = express();
    const session = new CanvasSession(config.projectId, config.instanceId);
    app.disable("x-powered-by");
    app.use((_req, res, next) => {
        res.locals.requestId = randomUUID();
        res.setHeader("x-canvas-request-id", res.locals.requestId);
        next();
    });
    app.use(express.json({ limit: "30mb" }));
    app.use((req, res, next) => {
        if (!setCors(req, res, config)) return void res.status(403).json({ ok: false, error: "origin not allowed" });
        if (req.method === "OPTIONS") return void res.json({});
        next();
    });

    app.get("/health", (_req, res) => res.json(session.health()));
    app.get("/config", (_req, res) => res.json({
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        url: config.url,
        projectId: config.projectId,
        instanceId: config.instanceId,
        hasToken: true,
    }));

    app.use((req, res, next) => {
        if (validToken(req, requestUrl(req), config.token)) return next();
        res.status(401).json({ ok: false, error: "invalid token" });
    });

    app.get("/events", (req, res) => {
        session.openEvents(requestUrl(req), res);
    });
    app.post("/canvas/state", (req, res) => {
        res.json(session.updateState(req.query.projectId, req.query.clientId, req.body));
    });
    app.post("/canvas/activate", (req, res) => {
        res.json(session.activateClient(req.query.projectId, req.query.clientId));
    });
    app.post("/canvas/result", (req, res) => {
        const ok = session.resolveResult(req.query.projectId, req.query.clientId, req.body || {});
        res.status(ok ? 200 : 409).json({ ok });
    });
    app.post("/api/tools", route(async (req, res) => {
        const result = await session.callTool(req.body?.name, req.body?.input ?? {}, {
            projectId: req.body?.projectId,
            clientId: req.body?.clientId,
        });
        res.json({ ok: true, result });
    }));

    app.use((_req, res) => res.status(404).json({ ok: false, error: "not found" }));
    app.use((error: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
        const status = error instanceof BridgeError ? error.statusCode : Number(error.status) || 500;
        const requestId = res.locals.requestId;
        if (status >= 500) console.error(JSON.stringify(bridgeDiagnostic(error, _req, requestId, status)));
        // Unknown errors may contain prompts, API credentials or local paths. Only known
        // protocol errors are returned verbatim; correlate other failures by request ID.
        res.status(status).json({ ok: false, error: error instanceof BridgeError ? error.message : "Canvas bridge request failed", requestId });
    });
    return app;
}

/** 启动本机单实例绘图桥接服务，并持有 launcher 指定的数据目录锁。 */
export function startHttpServer(config: BridgeConfig = loadConfig()): Server {
    const releaseLock = acquireInstanceLock(config);
    const server = createHttpApp(config).listen(config.port, "127.0.0.1", () => {
        console.log(`Canvas bridge ready: ${config.url}`);
        console.log(`Instance: ${config.instanceId}`);
        console.log(`Project: ${config.projectId}`);
    });
    server.once("error", (error) => {
        releaseLock();
        console.error("Canvas bridge failed to start", error.message);
        process.exitCode = 1;
    });
    server.once("close", releaseLock);
    process.once("exit", releaseLock);
    return server;
}

function route(handler: (req: Request, res: Response) => Promise<unknown>) {
    return (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);
}

function requestUrl(req: Request) {
    return new URL(req.originalUrl || req.url || "/", "http://127.0.0.1");
}

function setCors(req: Request, res: Response, config: BridgeConfig) {
    const origin = req.headers.origin;
    if (origin && origin !== config.origin) return false;
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type,x-canvas-agent-token");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (origin) res.setHeader("Vary", "Origin");
    return true;
}

function validToken(req: Request, url: URL, token: string) {
    const header = req.headers["x-canvas-agent-token"];
    return url.searchParams.get("token") === token || header === token || (Array.isArray(header) && header.includes(token));
}

function acquireInstanceLock(config: BridgeConfig) {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(fs.realpathSync(config.dataDir), "canvas-agent.lock");
    let descriptor: number;
    try {
        descriptor = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const current = readLock(lockPath);
        if (current && processIsAlive(current.pid)) throw new Error(`Canvas bridge instance is already running (${current.instanceId})`);
        fs.rmSync(lockPath, { force: true });
        descriptor = fs.openSync(lockPath, "wx", 0o600);
    }
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, instanceId: config.instanceId }));
    fs.closeSync(descriptor);

    let released = false;
    return () => {
        if (released) return;
        released = true;
        const current = readLock(lockPath);
        if (current?.pid === process.pid && current.instanceId === config.instanceId) fs.rmSync(lockPath, { force: true });
    };
}

function readLock(filePath: string): { pid: number; instanceId: string } | null {
    try {
        const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as { pid?: unknown; instanceId?: unknown };
        return typeof value.pid === "number" && typeof value.instanceId === "string" ? { pid: value.pid, instanceId: value.instanceId } : null;
    } catch {
        return null;
    }
}

function processIsAlive(pid: number) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** Only static route/tool names and stack source locations enter the diagnostic log. */
export function bridgeDiagnostic(error: Error, req: Pick<Request, "path" | "method" | "body">, requestId: string, status: number) {
    const routes = new Set(["/health", "/config", "/events", "/canvas/state", "/canvas/activate", "/canvas/result", "/api/tools"]);
    const frames = String(error.stack || "").split("\n").filter(line => /^\s+at /.test(line)).slice(0, 16).map(line => {
        // Keep only a filename and line/column, never function names or absolute paths.
        const match = line.match(/(?:[/\\])([A-Za-z0-9_.-]+\.[cm]?[jt]s):(\d+):(\d+)\)?$/);
        return match ? `${match[1]}:${match[2]}:${match[3]}` : "[frame omitted]";
    });
    return {
        time: new Date().toISOString(), event: "canvas_request_failed", requestId, status,
        route: routes.has(req.path) ? req.path : "other",
        method: ["GET", "POST", "OPTIONS"].includes(req.method) ? req.method : "other",
        tool: req.path === "/api/tools" && isToolName(req.body?.name) ? req.body.name : null,
        error: error instanceof RangeError ? "RangeError" : error instanceof TypeError ? "TypeError" : "Error",
        reason: error instanceof RangeError && error.message === "Maximum call stack size exceeded" ? "stack_overflow" : "request_failed",
        frames,
    };
}
