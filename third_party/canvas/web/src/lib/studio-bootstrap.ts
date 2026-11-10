import { STUDIO_H3_VIDEO_DEFAULTS, STUDIO_H3_VIDEO_MODEL, useConfigStore } from "@/stores/use-config-store";
import { useCanvasToolStore } from "@/stores/use-canvas-tool-store";

type StudioSession = {
    ok?: boolean;
    projectId?: string;
    projectTitle?: string;
    configRevision?: number;
    bridgeUrl?: string;
    bridgeToken?: string;
    imageConfig?: { baseUrl?: string; model?: string; apiKey?: string; apiFormat?: "openai" | "gemini" } | null;
    videoConfig?: { baseUrl?: string; model?: string; apiKey?: string; apiFormat?: "openai" | "gemini" } | null;
};

let studioProjectId: string | null = null;
let appliedConfigRevision = 0;
let refreshListenersInstalled = false;

function taskProjectId() {
    const routeId = /^\/canvas\/([^/]+)\/?$/.exec(window.location.pathname)?.[1];
    return routeId || new URLSearchParams(window.location.search).get("projectId");
}

function studioChannelConfig(session: StudioSession, current: ReturnType<typeof useConfigStore.getState>["config"]) {
    const image = session.imageConfig;
    const video = session.videoConfig;
    const model = image?.model?.trim() || "";
    const videoModel = video?.model?.trim() || "";
    const imageBaseUrl = image?.baseUrl?.trim() || "";
    const videoBaseUrl = video?.baseUrl?.trim() || "";
    const imageSelected = model && imageBaseUrl && image?.apiKey ? `studio-image::${model}` : "";
    const videoSelected = videoModel && videoBaseUrl && video?.apiKey ? `studio-video::${videoModel}` : "";
    const channels = [
        imageSelected ? {
            id: "studio-image",
            name: "Studio 图片模型",
            baseUrl: imageBaseUrl,
            apiKey: image?.apiKey || "",
            apiFormat: image?.apiFormat === "gemini" ? "gemini" as const : "openai" as const,
            models: [{ name: model, capability: "image" as const }],
        } : null,
        videoSelected ? {
            id: "studio-video",
            name: "Studio 视频模型",
            baseUrl: videoBaseUrl,
            apiKey: video?.apiKey || "",
            apiFormat: video?.apiFormat === "gemini" ? "gemini" as const : "openai" as const,
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
        baseUrl: imageBaseUrl || videoBaseUrl,
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
        canvasImageCount: "1",
    };
}

function applyStudioSession(session: StudioSession) {
    const projectId = taskProjectId();
    if (!session.ok || !session.projectId || !session.bridgeUrl || !session.bridgeToken
        || session.projectId !== projectId || !Number.isInteger(session.configRevision) || session.configRevision! < 1) return false;
    if (studioProjectId && studioProjectId !== session.projectId) return false;
    if (session.configRevision! > appliedConfigRevision) {
        const current = useConfigStore.getState().config;
        useConfigStore.setState({ config: studioChannelConfig(session, current) });
        appliedConfigRevision = session.configRevision!;
    }
    if (!studioProjectId) {
        const current = useConfigStore.getState().config;
        useConfigStore.setState({ config: studioChannelConfig(session, current) });
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

/** Read the same-origin private session and apply only a newer image/video-config revision. */
export async function refreshStudioCanvasConfig() {
    if (!window.location.pathname.startsWith("/canvas")) return false;
    let response: Response;
    try {
        response = await fetch("/__studio/session", { cache: "no-store", credentials: "same-origin" });
    } catch {
        if (studioProjectId) throw new Error("模型配置同步检查失败，本次生成已停止；请检查工作台同步状态后重试。");
        return false;
    }
    if (!response.ok) {
        if (studioProjectId) throw new Error("无法确认当前模型配置，本次生成已停止；请重新连接任务画布后重试。");
        return false;
    }
    let session: StudioSession;
    try { session = await response.json() as StudioSession; }
    catch {
        if (studioProjectId) throw new Error("模型配置响应无效，本次生成已停止；请重试。");
        return false;
    }
    if (!applyStudioSession(session)) {
        if (studioProjectId) throw new Error("任务画布配置不匹配，本次生成已停止；请重新打开当前任务画布。");
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
