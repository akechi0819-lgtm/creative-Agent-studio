import { useConfigStore } from "@/stores/use-config-store";
import { useCanvasToolStore } from "@/stores/use-canvas-tool-store";

type StudioSession = {
    ok?: boolean;
    projectId?: string;
    projectTitle?: string;
    configRevision?: number;
    bridgeUrl?: string;
    bridgeToken?: string;
    imageConfig?: { baseUrl?: string; model?: string; apiKey?: string; apiFormat?: "openai" | "gemini" } | null;
};

const isRemoteCanvasDeployment = __STUDIO_CANVAS_DEPLOYMENT__ === "remote";

let studioProjectId: string | null = null;
let appliedConfigRevision = 0;
let refreshListenersInstalled = false;

function taskProjectId() {
    const routeId = /^\/canvas\/([^/]+)\/?$/.exec(window.location.pathname)?.[1];
    return routeId || new URLSearchParams(window.location.search).get("projectId");
}

function imageAiConfig(image: StudioSession["imageConfig"]) {
    const model = image?.model?.trim() || "";
    const baseUrl = image?.baseUrl?.trim() || "";
    const apiKey = image?.apiKey || "";
    const selected = model ? `studio-image::${model}` : "";
    const channels = model && baseUrl && apiKey ? [{
        id: "studio-image",
        name: "Studio 图片模型",
        baseUrl,
        apiKey,
        apiFormat: image?.apiFormat === "gemini" ? "gemini" as const : "openai" as const,
        models: [{ name: model, capability: "image" as const }],
    }] : [];
    const current = useConfigStore.getState().config;
    return {
        ...current,
        channelMode: "local" as const,
        baseUrl,
        apiKey: "",
        apiFormat: image?.apiFormat === "gemini" ? "gemini" as const : "openai" as const,
        channels,
        model: selected,
        imageModel: selected,
        models: selected ? [selected] : [],
        proxyEnabled: true,
        proxyUrl: `${window.location.origin}/__studio/image-proxy`,
        canvasImageCount: "1",
    };
}

function imageChannelConfig(image: StudioSession["imageConfig"]) {
    const model = image?.model?.trim() || "";
    const baseUrl = image?.baseUrl?.trim() || "";
    const apiKey = image?.apiKey || "";
    const selected = model ? `studio-image::${model}` : "";
    const channels = model && baseUrl && apiKey ? [{
        id: "studio-image",
        name: "Studio 图片模型",
        baseUrl,
        apiKey,
        apiFormat: image?.apiFormat === "gemini" ? "gemini" as const : "openai" as const,
        models: [{ name: model, capability: "image" as const }],
    }] : [];
    return {
        channelMode: "local" as const,
        baseUrl,
        apiKey: "",
        apiFormat: image?.apiFormat === "gemini" ? "gemini" as const : "openai" as const,
        channels,
        model: selected,
        imageModel: selected,
        models: selected ? [selected] : [],
        proxyEnabled: true,
        proxyUrl: `${window.location.origin}/__studio/image-proxy`,
    };
}

function applyStudioSession(session: StudioSession) {
    const projectId = taskProjectId();
    if (!session.ok || !session.projectId || !session.bridgeUrl || !session.bridgeToken
        || session.projectId !== projectId || !Number.isInteger(session.configRevision) || session.configRevision! < 1) return false;
    if (studioProjectId && studioProjectId !== session.projectId) return false;
    if (session.configRevision! > appliedConfigRevision) {
        const current = useConfigStore.getState().config;
        useConfigStore.setState({ config: { ...current, ...imageChannelConfig(session.imageConfig) } });
        appliedConfigRevision = session.configRevision!;
    }
    if (!studioProjectId) {
        useConfigStore.setState({ config: imageAiConfig(session.imageConfig) });
        studioProjectId = session.projectId;
        appliedConfigRevision = session.configRevision!;
        useCanvasToolStore.setState({
            url: session.bridgeUrl,
            token: session.bridgeToken,
            enabled: true,
            connected: false,
            fragmentBootstrap: true,
            studioManaged: true,
            studioProjectTitle: session.projectTitle || "Creative Studio Canvas",
            activity: "正在连接当前任务画布",
        });
    }
    return true;
}

/** Read the same-origin private session and apply only a newer image-config revision. */
export async function refreshStudioCanvasConfig() {
    if (isRemoteCanvasDeployment) return false;
    if (!window.location.pathname.startsWith("/canvas")) return false;
    let response: Response;
    try {
        response = await fetch("/__studio/session", { cache: "no-store", credentials: "same-origin" });
    } catch {
        if (studioProjectId) throw new Error("图片配置同步检查失败，本次生成已停止；请检查工作台同步状态后重试。");
        return false;
    }
    if (!response.ok) {
        if (studioProjectId) throw new Error("无法确认当前图片配置，本次生成已停止；请重新连接任务画布后重试。");
        return false;
    }
    let session: StudioSession;
    try { session = await response.json() as StudioSession; }
    catch {
        if (studioProjectId) throw new Error("图片配置响应无效，本次生成已停止；请重试。");
        return false;
    }
    if (!applyStudioSession(session)) {
        if (studioProjectId) throw new Error("任务画布配置不匹配，本次生成已停止；请重新打开当前任务画布。");
        return false;
    }
    return true;
}

function parseLoopbackBridgeUrl(value: string): URL | null {
    let url: URL;
    try { url = new URL(value); } catch { return null; }
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (!loopback || url.protocol !== "http:" || !url.port || url.username || url.password
        || url.pathname !== "/" || url.search || url.hash) return null;
    return url;
}

function reportCompanyBootstrapFailure(bridgeUrl = "") {
    useCanvasToolStore.setState({
        url: bridgeUrl,
        token: "",
        clientId: "",
        enabled: false,
        connected: false,
        panelOpen: true,
        activity: "公司 Canvas 连接授权失败，请从工作台重新打开画布",
    });
}

async function bootstrapCompanyCanvasBridge() {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const bridgeValue = params.get("companyBridge")?.trim() || "";
    const ticket = params.get("companyTicket")?.trim() || "";
    if (!bridgeValue && !ticket) return false;

    // Tickets are one-use, short-lived authorization. Remove them from the visible URL
    // before network access and never persist them in browser storage.
    params.delete("companyBridge");
    params.delete("companyTicket");
    const remainingHash = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${remainingHash ? `#${remainingHash}` : ""}`);

    const bridge = parseLoopbackBridgeUrl(bridgeValue);
    if (!bridge || !ticket) {
        reportCompanyBootstrapFailure(bridge?.origin || "");
        return false;
    }

    let response: Response;
    try {
        response = await fetch(new URL("/__company/bootstrap", bridge).toString(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ticket }),
            cache: "no-store",
            credentials: "omit",
            mode: "cors",
            redirect: "error",
            referrerPolicy: "no-referrer",
            signal: AbortSignal.timeout(4_000),
        });
    } catch {
        reportCompanyBootstrapFailure(bridge.origin);
        return false;
    }
    if (!response.ok) {
        reportCompanyBootstrapFailure(bridge.origin);
        return false;
    }

    let payload: unknown;
    try { payload = await response.json(); } catch {
        reportCompanyBootstrapFailure(bridge.origin);
        return false;
    }
    if (!payload || typeof payload !== "object") {
        reportCompanyBootstrapFailure(bridge.origin);
        return false;
    }
    const session = payload as Record<string, unknown>;
    const returnedBridge = typeof session.bridgeUrl === "string" ? parseLoopbackBridgeUrl(session.bridgeUrl) : null;
    const requestedProjectId = taskProjectId();
    if (session.ok !== true || !returnedBridge || returnedBridge.origin !== bridge.origin
        || typeof session.token !== "string" || !session.token.trim()
        || typeof session.projectId !== "string" || !session.projectId.trim()
        || !requestedProjectId || requestedProjectId !== session.projectId
        || (session.clientId !== undefined && (typeof session.clientId !== "string" || !session.clientId.trim()))) {
        reportCompanyBootstrapFailure(bridge.origin);
        return false;
    }

    useCanvasToolStore.setState({
        url: returnedBridge.origin,
        token: session.token,
        clientId: typeof session.clientId === "string" ? session.clientId : "",
        enabled: true,
        connected: false,
        fragmentBootstrap: true,
        studioManaged: false,
        studioProjectTitle: "",
        activity: "正在连接公司绘图工具",
        panelOpen: true,
    });
    return true;
}

function installRefreshListeners() {
    if (refreshListenersInstalled) return;
    refreshListenersInstalled = true;
    const refreshQuietly = () => { void refreshStudioCanvasConfig().catch(() => {}); };
    window.addEventListener("focus", refreshQuietly);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") refreshQuietly();
    });
    window.setInterval(refreshQuietly, 5_000);
}

/** Consume the one-use local ticket before React renders or the Canvas navigation runs. */
export async function bootstrapStudioCanvas() {
    if (isRemoteCanvasDeployment) {
        await bootstrapCompanyCanvasBridge();
        return;
    }
    if (!window.location.pathname.startsWith("/canvas")) return;
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const ticket = hash.get("studioBootstrap");
    if (ticket) {
        hash.delete("studioBootstrap");
        const remaining = hash.toString();
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ""}`);
        try {
            const response = await fetch("/__studio/bootstrap", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ticket }),
                cache: "no-store",
            });
            if (!response.ok) return;
        } catch { return; }
    }
    try {
        if (await refreshStudioCanvasConfig()) installRefreshListeners();
    } catch {
        // A Canvas opened without a valid Studio session remains available for manual inspection.
    }
}
