import { afterAll, expect, test } from "bun:test";
import axios from "axios";
import { createServer } from "node:http";

const values = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    },
});
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { defaultConfig, useConfigStore } = await import("../src/stores/use-config-store");
const { createVideoGenerationTask, pollVideoGenerationTask } = await import("../src/services/api/video");

test("MiniMax H3 sends the verified JSON text request through the task video proxy", async () => {
    const upstreamRequests: Array<{ method: string; path: string; authorization: string; body: string }> = [];
    const proxyRequests: Array<{ method: string; target: string; browserAuthorization: string }> = [];
    const mp4 = Buffer.from("fixture-video-content");
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        if (request.url?.startsWith("/__studio/video-proxy/")) {
            const target = decodeURIComponent(request.url.slice("/__studio/video-proxy/".length));
            proxyRequests.push({ method: request.method || "GET", target, browserAuthorization: request.headers.authorization || "" });
            const parsed = new URL(target);
            if (parsed.origin !== "https://api.osodm.com") {
                response.writeHead(403).end();
                return;
            }
            const upstream = await fetch(`http://127.0.0.1:${server.address().port}${parsed.pathname}`, {
                method: request.method,
                headers: {
                    authorization: "Bearer fixture-h3-key",
                    ...(request.headers["content-type"] ? { "content-type": request.headers["content-type"] } : {}),
                },
                ...(body.length ? { body } : {}),
            });
            response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
            response.end(Buffer.from(await upstream.arrayBuffer()));
            return;
        }
        const path = request.url || "";
        upstreamRequests.push({ method: request.method || "GET", path, authorization: request.headers.authorization || "", body: body.toString("utf8") });
        if (path === "/v1/videos" && request.method === "POST") {
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "task-fixture", status: "queued" }));
        } else if (path === "/v1/videos/task-fixture" && request.method === "GET") {
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "task-fixture", status: "completed" }));
        } else if (path === "/v1/videos/task-fixture/content" && request.method === "GET") {
            response.writeHead(200, { "content-type": "video/mp4" }).end(mp4);
        } else {
            response.writeHead(404).end();
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("fake video proxy did not bind a TCP port");
        const proxyOrigin = `http://127.0.0.1:${address.port}`;
        const config = {
            ...defaultConfig,
            model: "studio-image::fixture-image",
            imageModel: "studio-image::fixture-image",
            videoModel: "studio-video::minimax_h3",
            videoSeconds: "4",
            size: "16:9",
            vquality: "768",
            videoGenerateAudio: "true",
            videoWatermark: "false",
            proxyEnabled: true,
            proxyUrl: `${proxyOrigin}/__studio/image-proxy`,
            channels: [
                { id: "studio-image", name: "Studio Image", baseUrl: "https://images.example.invalid", apiKey: "fixture-image-key", apiFormat: "openai" as const, models: [{ name: "fixture-image", capability: "image" as const }] },
                { id: "studio-video", name: "Studio Video", baseUrl: "https://api.osodm.com", apiKey: "fixture-h3-key", apiFormat: "openai" as const, models: [{ name: "minimax_h3", capability: "video" as const }] },
            ],
        };
        useConfigStore.setState({ config });

        const task = await createVideoGenerationTask(config, "A quiet sunrise over a lake");
        expect(task).toEqual({ id: "task-fixture", provider: "openai", model: "studio-video::minimax_h3" });
        const created = upstreamRequests.find((item) => item.path === "/v1/videos");
        expect(created?.method).toBe("POST");
        expect(created?.authorization).toBe("Bearer fixture-h3-key");
        expect(JSON.parse(created?.body || "{}")).toEqual({
            version: "video.v1",
            model: "minimax_h3",
            operation: "text_to_video",
            prompt: "A quiet sunrise over a lake",
            duration_seconds: 4,
            resolution: "768",
            aspect_ratio: "16:9",
        });
        expect(proxyRequests[0]?.target).toBe("https://api.osodm.com/v1/videos");
        expect(proxyRequests.every((item) => !item.browserAuthorization)).toBe(true);

        const originalGet = axios.get.bind(axios);
        axios.get = (async (url, options) => {
            if (options?.responseType !== "blob") return originalGet(url, options);
            const response = await originalGet(url, { ...options, responseType: "arraybuffer" });
            return {
                ...response,
                data: new Blob([response.data], { type: response.headers["content-type"] || "video/mp4" }),
            };
        }) as typeof axios.get;
        let state;
        try { state = await pollVideoGenerationTask(config, task); }
        finally { axios.get = originalGet; }
        expect(state.status).toBe("completed");
        if (state.status !== "completed" || !state.result.blob) throw new Error("video content was not returned");
        expect(Buffer.from(await state.result.blob.arrayBuffer())).toEqual(mp4);
        expect(proxyRequests.map((item) => item.target)).toEqual([
            "https://api.osodm.com/v1/videos",
            "https://api.osodm.com/v1/videos/task-fixture",
            "https://api.osodm.com/v1/videos/task-fixture/content",
        ]);
        expect(upstreamRequests.map((item) => item.path)).toEqual([
            "/v1/videos",
            "/v1/videos/task-fixture",
            "/v1/videos/task-fixture/content",
        ]);
        expect(upstreamRequests.every((item) => item.authorization === "Bearer fixture-h3-key")).toBe(true);

        await expect(createVideoGenerationTask(config, "text only contract", [{ id: "ref", name: "reference", dataUrl: "data:image/png;base64,AA==" } as never]))
            .rejects.toThrow(/参考图/u);

        const wrongProvider = {
            ...config,
            channels: config.channels.map((channel) => channel.id === "studio-video" ? { ...channel, baseUrl: "https://wrong.example.invalid" } : channel),
        };
        useConfigStore.setState({ config: wrongProvider });
        await expect(createVideoGenerationTask(wrongProvider, "reject wrong provider")).rejects.toThrow(/同源视频代理/u);
        const noProxy = { ...config, proxyEnabled: false };
        useConfigStore.setState({ config: noProxy });
        await expect(createVideoGenerationTask(noProxy, "reject direct key transport")).rejects.toThrow(/同源视频代理/u);
        expect(upstreamRequests).toHaveLength(3);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
