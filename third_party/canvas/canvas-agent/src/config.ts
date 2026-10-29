import path from "node:path";

export type BridgeConfig = {
    port: number;
    url: string;
    token: string;
    instanceId: string;
    dataDir: string;
    origin: string;
};

/** 读取本机共享画布桥接服务配置。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
    const portText = env.PORT || "";
    const port = Number(portText);
    if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT 必须是 1 到 65535 之间的整数");

    const token = required(env.CANVAS_AGENT_TOKEN, "CANVAS_AGENT_TOKEN");
    const instanceId = required(env.CANVAS_AGENT_INSTANCE_ID, "CANVAS_AGENT_INSTANCE_ID");
    const dataDir = path.resolve(required(env.CANVAS_AGENT_DATA_DIR, "CANVAS_AGENT_DATA_DIR"));
    const originValue = required(env.CANVAS_AGENT_ORIGIN, "CANVAS_AGENT_ORIGIN");
    const originUrl = new URL(originValue);
    if ((originUrl.protocol !== "http:" && originUrl.protocol !== "https:") || originUrl.origin !== originValue) {
        throw new Error("CANVAS_AGENT_ORIGIN 必须是完整的 http(s) origin，不含路径");
    }

    return { port, url: `http://127.0.0.1:${port}`, token, instanceId, dataDir, origin: originUrl.origin };
}

function required(value: string | undefined, name: string) {
    const result = value?.trim();
    if (!result) throw new Error(`${name} 未设置`);
    return result;
}
