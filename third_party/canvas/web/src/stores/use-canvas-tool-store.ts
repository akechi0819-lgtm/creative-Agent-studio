import { create } from "zustand";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasImageOperationRequest, CanvasImageOperationResult } from "@/lib/canvas/canvas-image-operations";
export type CanvasToolContext = {
    snapshot: CanvasAgentSnapshot;
    getSnapshot: () => CanvasAgentSnapshot;
    applyOps: (ops?: CanvasAgentOp[]) => CanvasAgentSnapshot;
    persistCurrentSnapshot: () => Promise<void>;
    runImageOperation: (request: CanvasImageOperationRequest) => Promise<CanvasImageOperationResult>;
    undoOps: () => CanvasAgentSnapshot | null;
    canUndo: boolean;
};
type ToolStore = {
    panelOpen: boolean; url: string; token: string; connected: boolean; enabled: boolean;
    fragmentBootstrap: boolean; studioManaged: boolean; activity: string; canvasContext: CanvasToolContext | null;
    setAgentState: (patch: Partial<ToolStore>) => void;
    setCanvasContext: (context: CanvasToolContext | null) => void;
    togglePanel: () => void; openPanel: () => void; connectAgent: (options?: {silent?: boolean}) => void;
};
export const useCanvasToolStore = create<ToolStore>((set) => ({
    panelOpen: false, url: "", token: "", connected: false, enabled: false,
    fragmentBootstrap: false, studioManaged: false, activity: "绘图工具未连接", canvasContext: null,
    setAgentState: (patch) => set(patch), setCanvasContext: (canvasContext) => set({canvasContext}),
    togglePanel: () => set(s => ({panelOpen: !s.panelOpen})), openPanel: () => set({panelOpen: true}),
    connectAgent: () => set({enabled: true}),
}));
