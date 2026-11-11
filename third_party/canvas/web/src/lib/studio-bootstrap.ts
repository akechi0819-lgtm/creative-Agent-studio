import { STUDIO_H3_VIDEO_DEFAULTS, STUDIO_H3_VIDEO_MODEL, useConfigStore } from "@/stores/use-config-store";
import { useCanvasToolStore } from "@/stores/use-canvas-tool-store";

type StudioSession = {
    ok?: boolean;
    workspaceId?: string;
    instanceId?: string;
    configRevision?: number;
    bridgeUrl?: string;
    bridgeToken?: string;
    imageConfig?: { baseUrl?: string; model?: string; apiKey?: string; apiFormat?: "openai" | "gemini" } | null;
    videoConfig?: { baseUrl?: string; model?: string; apiKey?: string; apiKeyConfigured?: boolean; apiFormat?: "openai" | "gemini" } | null;
};

let studioSessionIdentity: string | null = null;
let appliedConfigRevision = 0;
let refreshListenersInstalled = false;

function studioAiConfig(session: StudioSession, current: ReturnType<typeof useConfigStore.getState>["config"], isNewSession = false) {
    const image = session.imageConfig;
    const video = session.videoConfig;
    const model = image?.model?.trim() || "";
    const videoModel = video?.model?.trim() || "";
    const baseUrl = image?.baseUrl?.trim() || "";
    const videoBaseUrl = video?.baseUrl?.trim() || "";
    const apiKey = image?.apiKey || "";
    const imageSelected = model && baseUrl && apiKey ? `studio-image::${model}` : "";
    const videoSelected = videoModel && videoBaseUrl && video?.apiKeyConfigured ? `studio-video::${videoModel}` : "";
    const channels = [
        imageSelected ? {
            id: "studio-image",
            name: "Studio 图片模型",
            baseUrl,
            apiKey,
            apiFormat: image?.apiFormat === "gemini" ? "gemini" as const : "openai" as const,
            models: [{ name: model, capability: "image" as const }],
        } : null,
        videoSelected ? {
            id: "studio-video",
            name: "Studio H3 视频模型",
            baseUrl: videoBaseUrl,
            apiKey: "local-session",
            apiFormat: "openai" as const,
            models: [{ name: videoModel, capability: "video" as const }],
        } : null,
    ].filter((channel): channel is NonNullable<typeof channel> => channel !== null);
    const modelOptions = channels.flatMap((channel) => channel.models.map((item) => `${channel.id}::${item.name}`));
    const imageSelection = imageSelected && modelOptions.includes(current.imageModel) ? current.imageModel : imageSelected;
    const videoSelection = videoSelected && modelOptions.includes(current.videoModel) ? current.videoModel : videoSelected;
    const newlySelectedH3Video = videoSelection === STUDIO_H3_VIDEO_MODEL && current.videoModel !== STUDIO_H3_VIDEO_MODEL;
    const selectedModel = modelOptions.includes(current.model) ? current.model : imageSelection || videoSelection;
    return {
        ...current,
        channelMode: "local" as const,
        baseUrl: baseUrl || videoBaseUrl,
        apiKey: "",
        apiFormat: "openai" as const,
        channels,
        model: selectedModel,
        imageModel: imageSelection,
        videoModel: videoSelection,
        ...(newlySelectedH3Video ? {
            size: STUDIO_H3_VIDEO_DEFAULTS.size,
            vquality: STUDIO_H3_VIDEO_DEFAULTS.vquality,
            videoSeconds: STUDIO_H3_VIDEO_DEFAULTS.videoSeconds,
        } : {}),
        models: modelOptions,
        proxyEnabled: true,
        proxyUrl: `${window.location.origin}/__studio/image-proxy`,
        ...(isNewSession ? { canvasImageCount: "1" } : {}),
    };
}

function applyStudioSession(session: StudioSession) {
    if (session.ok !== true || session.workspaceId !== "company-lite" || !session.instanceId?.trim()
        || !session.bridgeUrl?.trim() || !session.bridgeToken?.trim()
        || !Number.isInteger(session.configRevision) || session.configRevision! < 1) return false;
    const identity = `${session.workspaceId}:${session.instanceId}`;
    const instanceChanged = studioSessionIdentity !== identity;
    if (instanceChanged) {
        useConfigStore.setState({ config: studioAiConfig(session, useConfigStore.getState().config, true) });
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
        useConfigStore.setState({ config: studioAiConfig(session, useConfigStore.getState().config) });
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
