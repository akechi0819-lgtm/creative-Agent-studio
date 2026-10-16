import { useCallback, useLayoutEffect, useMemo, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import i18n from "@/i18n";
import { nanoid } from "nanoid";
import { useCanvasToolStore } from "@/stores/use-canvas-tool-store";
import { applyCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { composeDataUrls, getDataUrlDimensions, stitchDataUrls, type ImageComposeLayer, type PixelImageSource } from "@/lib/canvas/canvas-image-data";
import { transformCanvasImageData, type CanvasImageOperationRequest, type CanvasImageOperationResult } from "@/lib/canvas/canvas-image-operations";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { deleteStoredImages, imageToDataUrl, uploadImage } from "@/services/image-storage";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type ContextMenuState, type ViewportTransform } from "@/types/canvas";

type GenerateNodeRef = MutableRefObject<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => Promise<void>) | null>;

type AgentBridgeParams = {
    projectLoaded: boolean;
    projectId: string;
    title: string | undefined;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: Set<string>;
    viewport: ViewportTransform;
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    selectedNodeIdsRef: MutableRefObject<Set<string>>;
    viewportRef: MutableRefObject<ViewportTransform>;
    generateNodeRef: GenerateNodeRef;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
    setViewport: Dispatch<SetStateAction<ViewportTransform>>;
    setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
};

/**
 * Bridge between the canvas and the local drawing tools: publish the current snapshot and apply/undo
 * capabilities to the drawing-tool store. All members except applyAgentOps are internal.
 */
export function useAgentBridge(params: AgentBridgeParams) {
    const { projectLoaded, projectId, title, nodes, connections, selectedNodeIds, viewport, nodesRef, connectionsRef, selectedNodeIdsRef, viewportRef, generateNodeRef, setNodes, setConnections, setSelectedNodeIds, setSelectedConnectionId, setViewport, setContextMenu } =
        params;
    const setAgentCanvasContext = useCanvasToolStore((state) => state.setCanvasContext);
    const [agentUndoSnapshot, setAgentUndoSnapshot] = useState<CanvasAgentSnapshot | null>(null);
    const projectTitle = title || i18n.t("canvas.project.untitled");

    const agentSnapshot = useMemo<CanvasAgentSnapshot>(() => ({ projectId, title: projectTitle, nodes, connections, selectedNodeIds: Array.from(selectedNodeIds), viewport }), [connections, projectTitle, nodes, projectId, selectedNodeIds, viewport]);
    const applyAgentOps = useCallback(
        (ops?: CanvasAgentOp[]) => {
            const safeOps = Array.isArray(ops) ? ops.filter((op) => op?.type) : [];
            const before = { projectId, title: projectTitle, nodes: nodesRef.current, connections: connectionsRef.current, selectedNodeIds: Array.from(selectedNodeIdsRef.current), viewport: viewportRef.current };
            const generationOps = safeOps.filter((op): op is Extract<CanvasAgentOp, { type: "run_generation" }> => op.type === "run_generation" && Boolean(op.nodeId));
            const next = applyCanvasAgentOps(
                before,
                safeOps.filter((op) => op.type !== "run_generation"),
            );
            nodesRef.current = next.nodes;
            connectionsRef.current = next.connections;
            selectedNodeIdsRef.current = new Set(next.selectedNodeIds);
            viewportRef.current = next.viewport;
            setAgentUndoSnapshot(before);
            setNodes(next.nodes);
            setConnections(next.connections);
            setSelectedNodeIds(new Set(next.selectedNodeIds));
            setSelectedConnectionId(null);
            setViewport(next.viewport);
            setContextMenu(null);
            if (generationOps.length) {
                queueMicrotask(() =>
                    generationOps.forEach((op) => {
                        const target = nodesRef.current.find((node) => node.id === op.nodeId);
                        const prompt = op.prompt?.trim() ? op.prompt : (target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                        void generateNodeRef.current?.(op.nodeId, op.mode || target?.metadata?.generationMode || "image", prompt);
                    }),
                );
            }
            return { ...next, projectId, title: projectTitle };
        },
        [projectTitle, projectId],
    );
    const getAgentSnapshot = useCallback((): CanvasAgentSnapshot => ({
        projectId,
        title: projectTitle,
        nodes: nodesRef.current,
        connections: connectionsRef.current,
        selectedNodeIds: Array.from(selectedNodeIdsRef.current),
        viewport: viewportRef.current,
    }), [projectTitle, projectId]);
    const runImageOperation = useCallback(async (request: CanvasImageOperationRequest): Promise<CanvasImageOperationResult> => {
        assertImageOperationRequest(request);
        if (request.operation === "import") return importCanvasImage(request, nodesRef, applyAgentOps);

        const sourceNodeIds = request.operation === "stitch"
            ? request.nodeIds
            : request.operation === "compose"
                ? [request.nodeId, ...request.layers.map((layer) => layer.nodeId)]
                : [request.nodeId];
        const inputs = await readCanvasImageInputs(sourceNodeIds, nodesRef);
        await assertCanvasImageInputsUnchanged(inputs, nodesRef);

        let pieces: Array<{ dataUrl: string; row?: number; column?: number }>;
        if (request.operation === "stitch") {
            const sources = request.nodeIds.map((nodeId) => toPixelImageSource(inputs.get(nodeId)!));
            pieces = [{ dataUrl: await stitchDataUrls(sources, request) }];
        } else if (request.operation === "compose") {
            const base = toPixelImageSource(inputs.get(request.nodeId)!);
            const layers: ImageComposeLayer[] = request.layers.map(({ nodeId, ...layer }) => ({
                ...layer,
                source: toPixelImageSource(inputs.get(nodeId)!),
            }));
            pieces = [{ dataUrl: await composeDataUrls(base, layers) }];
        } else {
            const source = inputs.get(request.nodeId)!;
            const operation = request.operation === "crop"
                ? { operation: "crop" as const, crop: request.crop }
                : request.operation === "split"
                    ? { operation: "split" as const, rows: request.rows, columns: request.columns }
                    : { operation: "resample" as const, targetLongEdge: request.targetLongEdge, algorithm: request.algorithm };
            pieces = await transformCanvasImageData(source.dataUrl, operation);
        }
        const uploads = await Promise.allSettled(pieces.map((piece) => uploadImage(piece.dataUrl)));
        const uploadedImages = uploads.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
        const failedUpload = uploads.find((item): item is PromiseRejectedResult => item.status === "rejected");
        const storedKeys = uploadedImages.map((image) => image.storageKey).filter((key): key is string => Boolean(key));
        if (failedUpload) {
            await deleteStoredImages(storedKeys);
            throw failedUpload.reason;
        }

        try {
            await assertCanvasImageInputsUnchanged(inputs, nodesRef);
            const sourceNodes = sourceNodeIds.map((id) => nodesRef.current.find((node) => node.id === id)!);
            const primarySource = sourceNodes[0];
            const maxRight = Math.max(...sourceNodes.map((node) => node.position.x + node.width));
            const baseX = maxRight + 96;
            const gridWidth = request.operation === "split" ? primarySource.width / request.columns : primarySource.width;
            const gridHeight = request.operation === "split" ? primarySource.height / request.rows : primarySource.height;
            const addNodeOps: CanvasAgentOp[] = uploadedImages.map((image, index) => {
                const piece = pieces[index];
                const id = nanoid();
                const position = request.operation === "split"
                    ? { x: baseX + (piece.column || 0) * (gridWidth + 16), y: primarySource.position.y + (piece.row || 0) * (gridHeight + 16) }
                    : { x: baseX, y: primarySource.position.y };
                const dimensions = request.operation === "crop"
                    ? (() => {
                        const width = Math.min(primarySource.width, Math.max(220, image.width));
                        return { width, height: width * (image.height / image.width) };
                    })()
                    : request.operation === "split"
                        ? { width: gridWidth, height: gridHeight }
                        : fitNodeSize(image.width, image.height);
                const title = request.operation === "crop"
                    ? "Cropped Image"
                    : request.operation === "split"
                        ? `Split Image ${Number(piece.row) + 1}-${Number(piece.column) + 1}`
                        : request.operation === "resample"
                            ? "Resampled Image"
                            : request.operation === "stitch"
                                ? "Stitched Image"
                                : "Composed Image";
                return { type: "add_node", id, nodeType: CanvasNodeType.Image, title, position, ...dimensions, metadata: imageMetadata(image) };
            });
            const childNodeIds = addNodeOps.map((op) => op.type === "add_node" ? op.id : undefined).filter((id): id is string => Boolean(id));
            const uniqueSourceNodeIds = [...new Set(sourceNodeIds)];
            const ops: CanvasAgentOp[] = [
                ...addNodeOps,
                ...uniqueSourceNodeIds.flatMap((sourceNodeId) => childNodeIds.map((id) => ({ type: "connect_nodes" as const, fromNodeId: sourceNodeId, toNodeId: id }))),
                { type: "select_nodes", ids: childNodeIds },
            ];
            applyAgentOps(ops);
            const resultImages = uploadedImages.map((image, index) => ({ nodeId: childNodeIds[index], width: image.width, height: image.height }));
            if (request.operation === "stitch" || request.operation === "compose") {
                return { operation: request.operation, sourceNodeId: request.operation === "stitch" ? request.nodeIds[0] : request.nodeId, sourceNodeIds: uniqueSourceNodeIds, images: resultImages };
            }
            return { operation: request.operation, sourceNodeId: request.nodeId, images: resultImages };
        } catch (error) {
            await deleteStoredImages(storedKeys);
            throw error;
        }
    }, [applyAgentOps]);
    const undoAgentOps = useCallback(() => {
        if (!agentUndoSnapshot) return null;
        nodesRef.current = agentUndoSnapshot.nodes;
        connectionsRef.current = agentUndoSnapshot.connections;
        selectedNodeIdsRef.current = new Set(agentUndoSnapshot.selectedNodeIds);
        viewportRef.current = agentUndoSnapshot.viewport;
        setNodes(agentUndoSnapshot.nodes);
        setConnections(agentUndoSnapshot.connections);
        setSelectedNodeIds(new Set(agentUndoSnapshot.selectedNodeIds));
        setSelectedConnectionId(null);
        setViewport(agentUndoSnapshot.viewport);
        setContextMenu(null);
        setAgentUndoSnapshot(null);
        return { ...agentUndoSnapshot, projectId, title: projectTitle };
    }, [agentUndoSnapshot, projectTitle, projectId]);

    useLayoutEffect(() => {
        if (!projectLoaded) {
            setAgentCanvasContext(null);
            return;
        }
        setAgentCanvasContext({ snapshot: agentSnapshot, getSnapshot: getAgentSnapshot, applyOps: applyAgentOps, runImageOperation, undoOps: undoAgentOps, canUndo: Boolean(agentUndoSnapshot) });
        return () => setAgentCanvasContext(null);
    }, [agentSnapshot, applyAgentOps, getAgentSnapshot, runImageOperation, agentUndoSnapshot, projectLoaded, setAgentCanvasContext, undoAgentOps]);

    return { applyAgentOps };
}

function assertImageOperationRequest(request: CanvasImageOperationRequest) {
    if (request.operation === "stitch") {
        if (request.nodeIds.length < 2 || request.nodeIds.length > 20 || request.nodeIds.some((id) => !id.trim())) throw new Error("nodeIds 必须包含 2–20 个图片节点 ID");
        if (request.direction !== "horizontal" && request.direction !== "vertical") throw new Error("拼接方向必须是 horizontal 或 vertical");
        if (request.gap !== undefined && (!Number.isSafeInteger(request.gap) || request.gap < 0)) throw new Error("gap 必须是大于等于 0 的整数");
        if (request.background !== undefined) assertPixelColor(request.background);
        return;
    }
    if (!request.nodeId.trim()) throw new Error("nodeId 必填");
    if (request.operation === "import") {
        if (!request.title.trim()) throw new Error("title 必填");
        if (!/^data:image\/(?:png|jpeg|webp);base64,(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.dataUrl)) {
            throw new Error("dataUrl 仅允许非空 PNG、JPEG 或 WebP base64 data URL");
        }
    } else if (request.operation === "compose") {
        if (request.layers.length < 1 || request.layers.length > 20) throw new Error("layers 必须包含 1–20 个贴图");
        for (const layer of request.layers) {
            if (!layer.nodeId.trim()) throw new Error("每个贴图 nodeId 都必填");
            if (![layer.x, layer.y, layer.width, layer.height].every(Number.isSafeInteger) || layer.x < 0 || layer.y < 0 || layer.width <= 0 || layer.height <= 0) {
                throw new Error("贴图坐标和尺寸必须是非负/正整数像素");
            }
            if (layer.fit !== undefined && !["contain", "cover", "stretch"].includes(layer.fit)) throw new Error("贴图 fit 必须是 contain、cover 或 stretch");
            if (layer.smoothing !== undefined && !["nearest", "smooth"].includes(layer.smoothing)) throw new Error("贴图 smoothing 必须是 nearest 或 smooth");
            if (layer.clear !== undefined) assertPixelColor(layer.clear);
        }
    } else if (request.operation === "crop") {
        const { x, y, width, height } = request.crop;
        if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
            throw new Error("裁切区域必须为归一化 0..1 坐标且完全位于图片范围内");
        }
    } else if (request.operation === "split") {
        if (!Number.isInteger(request.rows) || !Number.isInteger(request.columns) || request.rows <= 0 || request.columns <= 0 || request.rows * request.columns > 25) {
            throw new Error("rows 和 columns 必须为正整数，且总格数不能超过 25");
        }
    } else if (request.operation === "resample" && (!Number.isFinite(request.targetLongEdge) || request.targetLongEdge <= 0 || request.targetLongEdge > 4096 || !["nearest", "bilinear", "high"].includes(request.algorithm))) {
        throw new Error("targetLongEdge 必须大于 0 且不超过 4096，algorithm 必须是 nearest、bilinear 或 high");
    }
}

type CanvasImageInput = PixelImageSource & { nodeId: string; metadataRevision: string };

async function readCanvasImageInputs(nodeIds: string[], nodesRef: MutableRefObject<CanvasNodeData[]>) {
    const inputs = new Map<string, CanvasImageInput>();
    const uniqueNodeIds = [...new Set(nodeIds)];
    await Promise.all(uniqueNodeIds.map(async (nodeId) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if (!node || node.type !== CanvasNodeType.Image) throw new Error(`图片节点不存在：${nodeId}`);
        const metadataRevision = imageContentRevision(node);
        const dataUrl = await imageToDataUrl({ storageKey: node.metadata?.storageKey, url: node.metadata?.content });
        if (!dataUrl) throw new Error(`图片节点没有可读取的图片内容：${nodeId}`);
        const current = nodesRef.current.find((item) => item.id === nodeId);
        if (!current || current.type !== CanvasNodeType.Image || imageContentRevision(current) !== metadataRevision) throw new Error(`读取期间图片节点已删除或元数据已更改：${nodeId}`);
        const dimensions = await getDataUrlDimensions(dataUrl);
        const latest = nodesRef.current.find((item) => item.id === nodeId);
        if (!latest || latest.type !== CanvasNodeType.Image || imageContentRevision(latest) !== metadataRevision) throw new Error(`读取期间图片节点已删除或元数据已更改：${nodeId}`);
        if (latest.metadata?.naturalWidth !== dimensions.width || latest.metadata?.naturalHeight !== dimensions.height) throw new Error(`图片实际尺寸与节点 naturalWidth/naturalHeight 元数据不一致：${nodeId}`);
        inputs.set(nodeId, { nodeId, dataUrl, width: dimensions.width, height: dimensions.height, metadataRevision });
    }));
    return inputs;
}

async function assertCanvasImageInputsUnchanged(inputs: Map<string, CanvasImageInput>, nodesRef: MutableRefObject<CanvasNodeData[]>) {
    await Promise.all([...inputs.values()].map(async (input) => {
        const beforeRead = nodesRef.current.find((node) => node.id === input.nodeId);
        if (!beforeRead || beforeRead.type !== CanvasNodeType.Image || imageContentRevision(beforeRead) !== input.metadataRevision) {
            throw new Error(`处理期间原图片已删除或元数据已更改：${input.nodeId}`);
        }
        const latestDataUrl = await imageToDataUrl({ storageKey: beforeRead.metadata?.storageKey, url: beforeRead.metadata?.content });
        const afterRead = nodesRef.current.find((node) => node.id === input.nodeId);
        if (!afterRead || afterRead.type !== CanvasNodeType.Image || imageContentRevision(afterRead) !== input.metadataRevision || !sameImageBytes(latestDataUrl, input.dataUrl)) {
            throw new Error(`处理期间原图片字节或元数据已更改，已取消发布结果：${input.nodeId}`);
        }
    }));
}

function toPixelImageSource(input: CanvasImageInput): PixelImageSource {
    return { dataUrl: input.dataUrl, width: input.width, height: input.height };
}

async function importCanvasImage(
    request: Extract<CanvasImageOperationRequest, { operation: "import" }>,
    nodesRef: MutableRefObject<CanvasNodeData[]>,
    applyAgentOps: (ops?: CanvasAgentOp[]) => CanvasAgentSnapshot,
): Promise<CanvasImageOperationResult> {
    const expectedBytes = decodeBase64Image(request.dataUrl);
    const dimensions = await getDataUrlDimensions(request.dataUrl);
    const existing = nodesRef.current.find((node) => node.id === request.nodeId);
    if (existing) return reuseExistingImportedImage(existing, request.nodeId, expectedBytes, nodesRef);

    const uploaded = await uploadImage(request.dataUrl);
    const storageKey = uploaded.storageKey;
    try {
        if (uploaded.width !== dimensions.width || uploaded.height !== dimensions.height) throw new Error("导入后图片尺寸与原始 dataUrl 不一致");
        const racedNode = nodesRef.current.find((node) => node.id === request.nodeId);
        if (racedNode) {
            await deleteStoredImages(storageKey ? [storageKey] : []);
            return await reuseExistingImportedImage(racedNode, request.nodeId, expectedBytes, nodesRef);
        }
        const id = request.nodeId;
        const x = nodesRef.current.length ? Math.max(...nodesRef.current.map((node) => node.position.x + node.width)) + 96 : 0;
        applyAgentOps([{
            type: "add_node",
            id,
            nodeType: CanvasNodeType.Image,
            title: request.title,
            position: { x, y: 0 },
            ...fitNodeSize(uploaded.width, uploaded.height),
            metadata: imageMetadata(uploaded),
        }]);
        return { operation: "import", sourceNodeId: id, images: [{ nodeId: id, width: dimensions.width, height: dimensions.height }] };
    } catch (error) {
        await deleteStoredImages(storageKey ? [storageKey] : []);
        throw error;
    }
}

async function reuseExistingImportedImage(
    node: CanvasNodeData,
    nodeId: string,
    expectedBytes: Uint8Array,
    nodesRef: MutableRefObject<CanvasNodeData[]>,
): Promise<CanvasImageOperationResult> {
    if (node.type !== CanvasNodeType.Image) throw new Error(`nodeId 已存在且不是图片节点：${nodeId}`);
    const metadataRevision = imageContentRevision(node);
    const actualDataUrl = await imageToDataUrl({ storageKey: node.metadata?.storageKey, url: node.metadata?.content });
    const current = nodesRef.current.find((item) => item.id === nodeId);
    if (!current || current.type !== CanvasNodeType.Image || imageContentRevision(current) !== metadataRevision) throw new Error(`检查重复 nodeId 时节点已删除或元数据已更改：${nodeId}`);
    if (!sameImageBytes(actualDataUrl, expectedBytes)) throw new Error(`nodeId 已存在，但图片字节不同：${nodeId}`);
    const dimensions = await getDataUrlDimensions(actualDataUrl);
    const latest = nodesRef.current.find((item) => item.id === nodeId);
    if (!latest || latest.type !== CanvasNodeType.Image || imageContentRevision(latest) !== metadataRevision) throw new Error(`读取重复 nodeId 图片期间节点已删除或元数据已更改：${nodeId}`);
    return { operation: "import", sourceNodeId: nodeId, images: [{ nodeId, width: dimensions.width, height: dimensions.height }] };
}

function decodeBase64Image(dataUrl: string) {
    const match = /^data:image\/(?:png|jpeg|webp);base64,((?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/.exec(dataUrl);
    if (!match) throw new Error("dataUrl 仅允许非空 PNG、JPEG 或 WebP base64 data URL");
    const binary = atob(match[1]);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function sameImageBytes(dataUrl: string | undefined, expected: string | Uint8Array) {
    if (!dataUrl) return false;
    let actual: Uint8Array;
    try {
        actual = decodeBase64Image(dataUrl);
    } catch {
        if (typeof expected === "string") return dataUrl === expected;
        return false;
    }
    const expectedBytes = typeof expected === "string" ? (() => {
        try { return decodeBase64Image(expected); } catch { return undefined; }
    })() : expected;
    return Boolean(expectedBytes && actual.length === expectedBytes.length && actual.every((byte, index) => byte === expectedBytes[index]));
}

function assertPixelColor(color: string) {
    if (!/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(color)) throw new Error("颜色必须是 #RRGGBB 或 #RRGGBBAA");
}

function imageContentRevision(node: CanvasNodeData) {
    return JSON.stringify(node.metadata || {});
}
