import { toolInputSchemas, toolNames, type ToolName } from "./schemas.js";
import { createHash } from "node:crypto";
import type { CanvasNode, CanvasSnapshot } from "./types.js";

/** 判断传入名称是否为已注册的画布工具。 */
export function isToolName(name: unknown): name is ToolName {
    return typeof name === "string" && toolNames.includes(name as ToolName);
}

/** 按工具名称校验并解析调用参数。 */
export function parseToolInput(name: ToolName, input: unknown) {
    return toolInputSchemas[name].parse(input ?? {});
}

/** 压缩画布快照，避免向工具调用方返回过长的节点内容。 */
export function compactCanvasState(state: CanvasSnapshot | null) {
    if (!state) throw new Error("当前没有已连接画布");
    return { ...state, nodes: (state.nodes || []).map(compactNode) };
}

/** 压缩单个画布节点的元数据内容。 */
export function compactNode(node: CanvasNode) {
    const metadata = { ...(node.metadata || {}) };
    if (typeof metadata.content === "string") {
        metadata.contentSha256 = createHash("sha256").update(metadata.content).digest("hex");
        if (metadata.content.length > 240) metadata.content = `${metadata.content.slice(0, 120)}...`;
    }
    return { id: node.id, type: node.type, title: node.title, position: node.position, width: node.width, height: node.height, metadata };
}

/** 计算新节点在当前画布右侧的默认横坐标。 */
export function nextCanvasX(state: CanvasSnapshot | null) {
    const nodes = state?.nodes || [];
    return nodes.length ? nodes.reduce((right, node) => Math.max(right, node.position.x + node.width), -Infinity) + 80 : 0;
}
