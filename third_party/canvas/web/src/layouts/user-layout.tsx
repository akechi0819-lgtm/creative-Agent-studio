import type { ReactNode } from "react";

import { CanvasToolPanel } from "@/components/canvas/canvas-tool-panel";

export default function UserLayout({ children }: { children: ReactNode }) {
    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
            <CanvasToolPanel />
        </div>
    );
}
