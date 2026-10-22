import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button, Checkbox, Input } from "antd";
import { useCanvasToolStore } from "@/stores/use-canvas-tool-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { isSiteTool, runSiteTool } from "@/lib/agent/agent-site-tools";
import { imageToDataUrl } from "@/services/image-storage";
import { createCanvasConnectionRecovery } from "@/lib/canvas/canvas-connection";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasImageOperationRequest } from "@/lib/canvas/canvas-image-operations";

type ToolCall = { requestId: string; name: string; input?: Record<string, unknown> & { ops?: CanvasAgentOp[] } };
export function CanvasToolPanel() {
    const { hash } = useLocation();
    const navigate = useNavigate();
    const { panelOpen, url, token, enabled, connected, activity, studioManaged, setAgentState } = useCanvasToolStore();
    const theme = canvasThemes[useThemeStore(s => s.theme)];
    const clientIdRef = useRef<string | null>(null);
    if (!clientIdRef.current) clientIdRef.current = crypto.randomUUID();
    const [confirm, setConfirm] = useState(false);
    const confirmRef = useRef(confirm); confirmRef.current = confirm;
    const [pending, setPending] = useState<ToolCall | null>(null);
    const pendingRef = useRef<ToolCall | null>(null);
    const runRef = useRef<((call: ToolCall, reject?: boolean) => Promise<void>) | null>(null);
    const [error, setError] = useState("");
    const [connectionError, setConnectionError] = useState("");
    const projectId = useCanvasToolStore(state => state.canvasContext?.snapshot.projectId)
        || new URLSearchParams(location.search).get("projectId")
        || "";
    useEffect(() => {
        const params = new URLSearchParams(hash.slice(1));
        const endpoint = params.get("agentUrl"), credential = params.get("agentToken");
        if (endpoint && credential) {
            setAgentState({url: endpoint, token: credential, enabled: true, fragmentBootstrap: true});
            params.delete("agentUrl"); params.delete("agentToken");
            history.replaceState(null, "", location.pathname + location.search + (params.size ? "#" + params.toString() : ""));
        }
    }, [hash, setAgentState]);
    useEffect(() => {
        if (!enabled || !url || !token || !projectId) return;
        const endpoint = url.replace(/\/$/, "");
        const clientId = clientIdRef.current!;
        let closed = false;
        const query = () => new URLSearchParams({token, clientId, projectId});
        const post = async (route: string, body: unknown, signal?: AbortSignal) => {
            const response = await fetch(endpoint + route + "?" + query(), {method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(body), signal});
            if (!response.ok) {
                const detail = await response.json().then(data => data.error).catch(() => "");
                const error = new Error(detail || "绘图桥接请求失败") as Error & {status: number};
                error.status = response.status;
                throw error;
            }
        };
        setAgentState({connected:false,activity:"纯绘图工具连接中"});
        const connection = createCanvasConnectionRecovery({
            createEventSource: () => new EventSource(endpoint + "/events?" + query()),
            getSnapshot: () => {
                const snapshot = useCanvasToolStore.getState().canvasContext?.getSnapshot();
                return snapshot?.projectId === projectId ? snapshot : null;
            },
            publishSnapshot: (snapshot, signal) => post("/canvas/state", snapshot, signal),
            onStatus: (isConnected, nextActivity) => setAgentState({connected:isConnected,activity:nextActivity}),
            onConnectionError: setConnectionError,
            onConnectionRecovered: () => setConnectionError(""),
            onToolCall: event => {
                const call = JSON.parse(event.data) as ToolCall;
                if (confirmRef.current && ["canvas_apply_ops", "canvas_crop_image", "canvas_split_image", "canvas_resample_image", "canvas_stitch_images", "canvas_compose_images", "canvas_import_image", "workbench_image_generate"].includes(call.name)) {
                    if (pendingRef.current) { void post("/canvas/result", {requestId:call.requestId,error:"已有待确认操作"}).catch(() => {}); return; }
                    pendingRef.current=call; setPending(call);
                } else void runRef.current?.(call);
            },
        });
        runRef.current = async (call, reject = false) => {
            try {
                if (reject) throw new Error("用户拒绝画布操作");
                const context = useCanvasToolStore.getState().canvasContext;
                if (!context) throw new Error("请先打开目标画布");
                if (context.getSnapshot().projectId !== projectId) throw new Error("画布项目已切换，请重新连接绘图工具");
                let result: unknown;
                if (isSiteTool(call.name)) result = await runSiteTool(call.name, call.input || {}, navigate, {canvasSnapshot:context.getSnapshot()});
                else if (call.name === "canvas_apply_ops") { context.applyOps(call.input?.ops); result = context.getSnapshot(); await connection.writeState(result as CanvasAgentSnapshot); }
                else if (call.name === "canvas_read_image") {
                    const node = context.getSnapshot().nodes.find(n => n.id === call.input?.nodeId);
                    if (!node || node.type !== "image") throw new Error("图片节点不存在");
                    const dataUrl = await imageToDataUrl({storageKey:node.metadata?.storageKey, url:node.metadata?.content});
                    result = {nodeId:node.id, dataUrl, width:node.metadata?.naturalWidth, height:node.metadata?.naturalHeight};
                } else if (call.name === "canvas_crop_image" || call.name === "canvas_split_image" || call.name === "canvas_resample_image" || call.name === "canvas_stitch_images" || call.name === "canvas_compose_images" || call.name === "canvas_import_image") {
                    result = await context.runImageOperation(toCanvasImageOperationRequest(call));
                    await connection.writeState(context.getSnapshot());
                } else throw new Error("未知绘图工具：" + call.name);
                if (closed) return;
                await post("/canvas/result", {requestId:call.requestId, result});
                if (!closed) setAgentState({activity:"绘图工具已完成"});
            } catch (e) {
                if (closed) return;
                const text = e instanceof Error ? e.message : String(e);
                setError(text);
                await post("/canvas/result", {requestId:call.requestId, error:text}).catch(() => {});
            } finally { if (!closed) { pendingRef.current = null; setPending(null); } }
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const unsubscribe = useCanvasToolStore.subscribe((state, previous) => {
            if (state.canvasContext === previous.canvasContext) return;
            if (timer) clearTimeout(timer);
            timer=setTimeout(() => connection.publishCurrentSnapshot(), 100);
        });
        return () => {
            closed=true;
            connection.dispose();
            unsubscribe();
            if (timer) clearTimeout(timer);
            runRef.current = null;
            setAgentState({connected:false});
        };
    }, [enabled, url, token, projectId, navigate, setAgentState]);
    if (!panelOpen && !pending) return null;
    return <aside data-canvas-shortcuts-ignore className="w-80 shrink-0 border-l p-4 overflow-auto" style={{background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke}}>
        <p>Canvas 绘图工具</p><p>{connected ? "已连接" : "未连接"} · {activity}</p>
        {studioManaged ? <p>当前任务连接由 Studio 管理。关闭后请从工作台重新打开任务画布。</p> : <>
            <Input aria-label="绘图服务地址" placeholder="本地绘图服务地址" value={url} onChange={e=>setAgentState({url:e.target.value,enabled:false})}/>
            <Input.Password aria-label="连接令牌" placeholder="连接令牌" value={token} onChange={e=>setAgentState({token:e.target.value,enabled:false})}/>
            <Button onClick={()=>setAgentState({enabled:!enabled})}>{enabled ? "断开" : "连接"}</Button>
        </>}
        <Checkbox checked={confirm} onChange={e=>setConfirm(e.target.checked)}>逐次确认绘图操作</Checkbox>
        {pending && <div><p>待确认：{pending.name}</p><pre className="overflow-auto">{JSON.stringify(confirmationInput(pending),null,2)}</pre><Button onClick={()=>void runRef.current?.(pending)}>执行</Button><Button onClick={()=>void runRef.current?.(pending,true)}>拒绝</Button></div>}
        {connectionError && <p role="alert">{connectionError}</p>}
        {error && <p role="alert">{error}</p>}
    </aside>;
}

function toCanvasImageOperationRequest(call: ToolCall): CanvasImageOperationRequest {
    const input = call.input || {};
    if (call.name === "canvas_crop_image") {
        return { operation: "crop", nodeId: String(input.nodeId || ""), crop: input.crop as Extract<CanvasImageOperationRequest, { operation: "crop" }>["crop"] };
    }
    if (call.name === "canvas_split_image") {
        return { operation: "split", nodeId: String(input.nodeId || ""), rows: Number(input.rows), columns: Number(input.columns) };
    }
    if (call.name === "canvas_resample_image") {
        return { operation: "resample", nodeId: String(input.nodeId || ""), targetLongEdge: Number(input.targetLongEdge), algorithm: input.algorithm as "nearest" | "bilinear" | "high" };
    }
    if (call.name === "canvas_stitch_images") {
        return { operation: "stitch", nodeIds: Array.isArray(input.nodeIds) ? input.nodeIds.map(String) : [], direction: input.direction as "horizontal" | "vertical", gap: input.gap === undefined ? undefined : Number(input.gap), background: typeof input.background === "string" ? input.background : undefined };
    }
    if (call.name === "canvas_compose_images") {
        return { operation: "compose", nodeId: String(input.nodeId || ""), layers: Array.isArray(input.layers) ? input.layers as Extract<CanvasImageOperationRequest, { operation: "compose" }>['layers'] : [] };
    }
    return { operation: "import", nodeId: String(input.nodeId || ""), title: String(input.title || ""), dataUrl: String(input.dataUrl || "") };
}

function confirmationInput(call: ToolCall) {
    if (call.name !== "canvas_import_image" || !call.input?.dataUrl) return call.input;
    return { ...call.input, dataUrl: "[base64 image payload omitted]" };
}
