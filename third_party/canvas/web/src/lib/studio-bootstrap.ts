import { useConfigStore } from "@/stores/use-config-store";
import { useCanvasToolStore } from "@/stores/use-canvas-tool-store";

type StudioSession = {
    ok?: boolean;
    workspaceId?: string;
    instanceId?: string;
    configRevision?: number;
    bridgeUrl?: string;
    bridgeToken?: string;
    imageConfig?: { baseUrl?: string; model?: string; apiKey?: string; apiFormat?: "openai" | "gemini" } | null;
};

let studioSessionIdentity: string | null = null;
let appliedConfigRevision = 0;
let refreshListenersInstalled = false;

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
    if (session.ok !== true || session.workspaceId !== "company-lite" || !session.instanceId?.trim()
        || !session.bridgeUrl?.trim() || !session.bridgeToken?.trim()
        || !Number.isInteger(session.configRevision) || session.configRevision! < 1) return false;
    const identity = `${session.workspaceId}:${session.instanceId}`;
    const instanceChanged = studioSessionIdentity !== identity;
    if (instanceChanged) {
        useConfigStore.setState({ config: imageAiConfig(session.imageConfig) });
        appliedConfigRevision = session.configRevision!;
        studioSessionIdentity = identity;
        useCanvasToolStore.setState({
            url: session.bridgeUrl,
            token: session.bridgeToken,
            enabled: true,
            connected: false,
            fragmentBootstrap: true,
            studioManaged: true,
            activity: "正在连接共享画布",
        });
    } else if (session.configRevision! > appliedConfigRevision) {
        const current = useConfigStore.getState().config;
        useConfigStore.setState({ config: { ...current, ...imageChannelConfig(session.imageConfig) } });
        appliedConfigRevision = session.configRevision!;
    }
    const toolStore = useCanvasToolStore.getState();
    if (toolStore.url !== session.bridgeUrl || toolStore.token !== session.bridgeToken || !toolStore.studioManaged) {
        useCanvasToolStore.setState({
            url: session.bridgeUrl,
            token: session.bridgeToken,
            enabled: true,
            connected: false,
            fragmentBootstrap: true,
            studioManaged: true,
            activity: "正在连接共享画布",
        });
    }
    return true;
}

/** Read the same-origin private session and apply only a newer image-config revision. */
export async function refreshStudioCanvasConfig() {
    if (!window.location.pathname.startsWith("/canvas")) return false;
    let response: Response;
    try {
        response = await fetch("/__studio/session", { cache: "no-store", credentials: "same-origin" });
    } catch {
        if (studioSessionIdentity) throw new Error("图片配置同步检查失败，本次生成已停止；请检查共享画布状态后重试。");
        return false;
    }
    if (!response.ok) {
        if (studioSessionIdentity) throw new Error("无法确认当前图片配置，本次生成已停止；请检查共享画布连接后重试。");
        return false;
    }
    let session: StudioSession;
    try { session = await response.json() as StudioSession; }
    catch {
        if (studioSessionIdentity) throw new Error("图片配置响应无效，本次生成已停止；请重试。");
        return false;
    }
    if (!applyStudioSession(session)) {
        if (studioSessionIdentity) throw new Error("共享画布配置不匹配，本次生成已停止；请检查工作台连接后重试。");
        return false;
    }
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
