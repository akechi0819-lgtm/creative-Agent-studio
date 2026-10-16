import crypto from "node:crypto";
import type { ServerResponse } from "node:http";
import { ZodError } from "zod";

import { buildCanvasToolRequest } from "./operations.js";
import type { ToolName } from "./schemas.js";
import { compactCanvasState, compactNode, isToolName, parseToolInput } from "./tools.js";
import type { CanvasSnapshot } from "./types.js";

type PendingRequest = { clientId: string; resolve: (value: unknown) => void; reject: (error: Error) => void };
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

/** 管理单项目网页连接、画布快照和绘图工具请求。 */
export class CanvasSession {
    private clients = new Map<string, ServerResponse>();
    private canvasStates = new Map<string, CanvasSnapshot>();
    private pending = new Map<string, PendingRequest>();
    private activeClientId = "";

    constructor(readonly projectId: string, readonly instanceId: string) {}

    health() {
        return {
            ok: true,
            protocolVersion: PROTOCOL_VERSION,
            projectId: this.projectId,
            instanceId: this.instanceId,
            hasCanvas: [...this.canvasStates.keys()].some((clientId) => this.clients.has(clientId)),
            clients: this.clients.size,
            targets: [...this.clients.keys()].map((clientId) => ({ clientId, projectId: this.projectId, hasCanvas: this.canvasStates.has(clientId), active: clientId === this.activeClientId })),
        };
    }

    /** 建立网页 SSE 连接，并发送绘图工具面板使用的初始状态。 */
    openEvents(url: URL, res: ServerResponse) {
        this.assertProject(url.searchParams.get("projectId"));
        const clientId = url.searchParams.get("clientId")?.trim() || crypto.randomUUID();
        const old = this.clients.get(clientId);
        if (old && old !== res) old.end();

        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        this.clients.set(clientId, res);
        this.activeClientId ||= clientId;
        sendEvent(res, "hello", {
            ok: true,
            instanceId: this.instanceId,
            projectId: this.projectId,
            clientId,
        });

        const timer = setInterval(() => sendEvent(res, "ping", { time: Date.now() }), 15000);
        res.on("close", () => {
            clearInterval(timer);
            this.removeClient(clientId, res);
        });
        return clientId;
    }

    /** 保存指定网页上报的画布状态，并强制校验实例项目归属。 */
    updateState(projectId: unknown, clientId: unknown, body: unknown) {
        const targetProjectId = this.assertProject(projectId);
        const targetClientId = this.assertClient(clientId);
        const record = objectValue(body);
        this.assertProject(record.projectId);
        if (record.clientId !== undefined && record.clientId !== targetClientId) throw new BridgeError("clientId 不匹配", 403);
        this.canvasStates.set(targetClientId, { ...record, projectId: targetProjectId, clientId: targetClientId } as CanvasSnapshot);
        return { ok: true };
    }

    /** 将指定网页设为显式激活目标。 */
    activateClient(projectId: unknown, clientId: unknown) {
        this.assertProject(projectId);
        this.activeClientId = this.assertClient(clientId);
        return { ok: true };
    }

    /** 只接受原工具请求客户端返回的结果。 */
    resolveResult(projectId: unknown, clientId: unknown, body: { requestId?: string; error?: string; result?: unknown }) {
        const targetClientId = this.assertClient(clientId);
        this.assertProject(projectId);
        const item = body.requestId ? this.pending.get(body.requestId) : null;
        if (!item || item.clientId !== targetClientId) return false;
        this.pending.delete(body.requestId!);
        body.error ? item.reject(new Error(body.error)) : item.resolve(body.result);
        return true;
    }

    /** 校验工具参数，并将调用固定发送给请求指定的网页客户端。 */
    async callTool(name: unknown, rawInput: unknown, target: ToolTarget) {
        this.assertProject(target.projectId);
        const clientId = this.assertClient(target.clientId);
        if (!isToolName(name)) throw new BridgeError(`未知工具：${String(name)}`, 400);

        const toolName = name;
        let input: Record<string, unknown>;
        try {
            input = parseToolInput(toolName, rawInput) as Record<string, unknown>;
        } catch (error) {
            if (error instanceof ZodError) throw new BridgeError(error.message, 400);
            throw error;
        }

        const state = this.canvasStates.get(clientId) || null;
        if (["canvas_get_state", "canvas_get_selection", "canvas_export_snapshot"].includes(toolName) && !state) {
            throw new BridgeError("当前网页尚未上报画布状态", 409);
        }
        if (SITE_TOOLS.has(toolName) || DIRECT_CANVAS_TOOLS.has(toolName)) {
            return this.requestCanvasTool(clientId, toolName, input);
        }
        if (toolName === "canvas_get_state" || toolName === "canvas_export_snapshot") return compactCanvasState(state);
        if (toolName === "canvas_get_selection") {
            const ids = new Set(state?.selectedNodeIds || []);
            return { nodes: (state?.nodes || []).filter((node) => ids.has(node.id)).map(compactNode) };
        }

        const request = buildCanvasToolRequest(toolName, input, state);
        return this.requestCanvasTool(clientId, request.name, request.input);
    }

    private assertProject(value: unknown): string {
        if (typeof value !== "string" || !value.trim()) throw new BridgeError("projectId 必填", 400);
        if (value !== this.projectId) throw new BridgeError("projectId 与此服务实例不匹配", 403);
        return value;
    }

    private assertClient(value: unknown): string {
        if (typeof value !== "string" || !value.trim()) throw new BridgeError("clientId 必填", 400);
        if (!this.clients.has(value)) throw new BridgeError("clientId 未连接到此服务实例", 409);
        return value;
    }

    private removeClient(clientId: string, response: ServerResponse) {
        if (this.clients.get(clientId) !== response) return;
        this.clients.delete(clientId);
        this.canvasStates.delete(clientId);
        this.pending.forEach((item, requestId) => {
            if (item.clientId !== clientId) return;
            this.pending.delete(requestId);
            item.reject(new BridgeError("请求页面已断开", 409));
        });
        if (this.activeClientId === clientId) this.activeClientId = this.clients.keys().next().value || "";
    }

    private requestCanvasTool(clientId: string, name: ToolName, input: Record<string, unknown>) {
        const client = this.clients.get(clientId);
        if (!client) throw new BridgeError("clientId 未连接到此服务实例", 409);
        const requestId = crypto.randomUUID();
        sendEvent(client, "tool_call", { requestId, name, input });
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new BridgeError("画布操作超时", 504));
            }, 30000);
            this.pending.set(requestId, {
                clientId,
                resolve: (value) => (clearTimeout(timer), resolve(value)),
                reject: (error) => (clearTimeout(timer), reject(error)),
            });
        });
    }
}

function objectValue(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sendEvent(res: ServerResponse, type: string, payload: unknown) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}
