import crypto from "node:crypto";
import type { ServerResponse } from "node:http";
import { ZodError } from "zod";

import { buildCanvasToolRequest } from "./operations.js";
import type { ToolName } from "./schemas.js";
import { compactCanvasState, compactNode, isToolName, parseToolInput } from "./tools.js";
import type { CanvasSnapshot } from "./types.js";

type ClientTarget = { projectId: string; clientId: string };
type ClientConnection = ClientTarget & { response: ServerResponse };
type PendingRequest = { targetKey: string; resolve: (value: unknown) => void; reject: (error: Error) => void };
type ToolTarget = { projectId: unknown; clientId: unknown };

export const PROTOCOL_VERSION = 1;

/** 带 HTTP 状态码的桥接请求错误。 */
export class BridgeError extends Error {
    constructor(message: string, readonly statusCode: number) {
        super(message);
    }
}

const SITE_TOOLS = new Set<ToolName>([
    "site_navigate",
    "canvas_list_projects",
    "workbench_image_get_config",
    "workbench_image_generate",
    "workbench_video_get_config",
    "workbench_video_generate",
    "prompts_search",
    "assets_list",
    "assets_add",
    "generation_get_status",
]);

const DIRECT_CANVAS_TOOLS = new Set<ToolName>([
    "canvas_read_image",
    "canvas_crop_image",
    "canvas_split_image",
    "canvas_resample_image",
    "canvas_stitch_images",
    "canvas_compose_images",
    "canvas_import_image",
]);

/** 管理共享本机工作空间中的多个网页项目连接和绘图工具请求。 */
export class CanvasSession {
    private clients = new Map<string, ClientConnection>();
    private canvasStates = new Map<string, CanvasSnapshot>();
    private pending = new Map<string, PendingRequest>();
    private activeTargetKey: string | null = null;

    constructor(readonly instanceId: string) {}

    health() {
        return {
            ok: true,
            protocolVersion: PROTOCOL_VERSION,
            instanceId: this.instanceId,
            hasCanvas: [...this.canvasStates.keys()].some((targetKey) => this.clients.has(targetKey)),
            clients: this.clients.size,
            targets: [...this.clients.entries()].map(([targetKey, target]) => ({
                clientId: target.clientId,
                projectId: target.projectId,
                hasCanvas: this.canvasStates.has(targetKey),
                active: targetKey === this.activeTargetKey,
            })),
        };
    }

    /** 建立指定实际项目的网页 SSE 连接，并发送连接身份。 */
    openEvents(url: URL, res: ServerResponse) {
        const projectId = this.assertProject(url.searchParams.get("projectId"));
        const clientId = url.searchParams.get("clientId")?.trim() || crypto.randomUUID();
        const targetKey = clientTargetKey(projectId, clientId);
        const old = this.clients.get(targetKey);
        if (old && old.response !== res) {
            this.removeClient(targetKey, old.response);
            old.response.end();
        }

        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        this.clients.set(targetKey, { projectId, clientId, response: res });
        sendEvent(res, "hello", {
            ok: true,
            instanceId: this.instanceId,
            projectId,
            clientId,
        });

        const timer = setInterval(() => sendEvent(res, "ping", { time: Date.now() }), 15000);
        res.on("close", () => {
            clearInterval(timer);
            this.removeClient(targetKey, res);
        });
        return clientId;
    }

    /** 保存指定项目与客户端上报的状态，并校验二者都匹配连接。 */
    updateState(projectId: unknown, clientId: unknown, body: unknown) {
        const targetProjectId = this.assertProject(projectId);
        const targetClientId = this.assertClient(clientId);
        const targetKey = clientTargetKey(targetProjectId, targetClientId);
        if (!this.clients.has(targetKey)) throw new BridgeError("目标 projectId/clientId 未连接", 409);
        const record = objectValue(body);
        if (this.assertProject(record.projectId) !== targetProjectId) throw new BridgeError("state projectId 与网页连接不匹配", 403);
        if (record.clientId !== undefined && record.clientId !== targetClientId) throw new BridgeError("clientId 不匹配", 403);
        this.canvasStates.set(targetKey, { ...record, projectId: targetProjectId, clientId: targetClientId } as CanvasSnapshot);
        return { ok: true };
    }

    /** 将指定网页设为显式激活目标。 */
    activateClient(projectId: unknown, clientId: unknown) {
        const targetKey = this.requireTarget(projectId, clientId);
        this.activeTargetKey = targetKey;
        return { ok: true };
    }

    /** 只接受原工具请求客户端返回的结果。 */
    resolveResult(projectId: unknown, clientId: unknown, body: { requestId?: string; error?: string; result?: unknown }) {
        const targetProjectId = this.assertProject(projectId);
        const targetClientId = this.assertClient(clientId);
        const targetKey = clientTargetKey(targetProjectId, targetClientId);
        if (!this.clients.has(targetKey)) return false;
        const item = body.requestId ? this.pending.get(body.requestId) : null;
        if (!item || item.targetKey !== targetKey) return false;
        this.pending.delete(body.requestId!);
        body.error ? item.reject(new Error(body.error)) : item.resolve(body.result);
        return true;
    }

    /** 校验工具参数，并将调用固定发送给请求指定的网页客户端。 */
    async callTool(name: unknown, rawInput: unknown, target: ToolTarget) {
        const targetKey = this.requireTarget(target.projectId, target.clientId);
        if (!isToolName(name)) throw new BridgeError(`未知工具：${String(name)}`, 400);

        const toolName = name;
        let input: Record<string, unknown>;
        try {
            input = parseToolInput(toolName, rawInput) as Record<string, unknown>;
        } catch (error) {
            if (error instanceof ZodError) throw new BridgeError(error.message, 400);
            throw error;
        }

        const state = this.canvasStates.get(targetKey) || null;
        if (!state && toolName !== "site_navigate" && toolName !== "canvas_list_projects") {
            throw new BridgeError("目标网页尚未上报画布状态", 409);
        }
        if (SITE_TOOLS.has(toolName) || DIRECT_CANVAS_TOOLS.has(toolName)) {
            return this.requestCanvasTool(targetKey, toolName, input);
        }
        if (toolName === "canvas_get_state" || toolName === "canvas_export_snapshot") return compactCanvasState(state);
        if (toolName === "canvas_get_selection") {
            const ids = new Set(state?.selectedNodeIds || []);
            return { nodes: (state?.nodes || []).filter((node) => ids.has(node.id)).map(compactNode) };
        }

        const request = buildCanvasToolRequest(toolName, input, state);
        return this.requestCanvasTool(targetKey, request.name, request.input);
    }

    private assertProject(value: unknown): string {
        if (typeof value !== "string" || !value.trim()) throw new BridgeError("projectId 必填", 400);
        return value.trim();
    }

    private assertClient(value: unknown): string {
        if (typeof value !== "string" || !value.trim()) throw new BridgeError("clientId 必填", 400);
        return value.trim();
    }

    private requireTarget(projectId: unknown, clientId: unknown) {
        const targetProjectId = this.assertProject(projectId);
        const targetClientId = this.assertClient(clientId);
        const targetKey = clientTargetKey(targetProjectId, targetClientId);
        if (!this.clients.has(targetKey)) throw new BridgeError("目标 projectId/clientId 未连接", 409);
        return targetKey;
    }

    private removeClient(targetKey: string, response: ServerResponse) {
        if (this.clients.get(targetKey)?.response !== response) return;
        this.clients.delete(targetKey);
        this.canvasStates.delete(targetKey);
        this.pending.forEach((item, requestId) => {
            if (item.targetKey !== targetKey) return;
            this.pending.delete(requestId);
            item.reject(new BridgeError("请求页面已断开", 409));
        });
        if (this.activeTargetKey === targetKey) this.activeTargetKey = null;
    }

    private requestCanvasTool(targetKey: string, name: ToolName, input: Record<string, unknown>) {
        const client = this.clients.get(targetKey);
        if (!client) throw new BridgeError("目标 projectId/clientId 未连接", 409);
        const requestId = crypto.randomUUID();
        sendEvent(client.response, "tool_call", { requestId, name, input });
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new BridgeError("画布操作超时", 504));
            }, 30000);
            this.pending.set(requestId, {
                targetKey,
                resolve: (value) => (clearTimeout(timer), resolve(value)),
                reject: (error) => (clearTimeout(timer), reject(error)),
            });
        });
    }
}

function clientTargetKey(projectId: string, clientId: string) {
    return JSON.stringify([projectId, clientId]);
}

function objectValue(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sendEvent(res: ServerResponse, type: string, payload: unknown) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}
