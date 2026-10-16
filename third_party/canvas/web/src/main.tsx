import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "./styles/globals.css";
import "@/i18n";
import { initAnalytics } from "@/lib/analytics";
import { bootstrapStudioCanvas } from "@/lib/studio-bootstrap";

void (async () => {
    await bootstrapStudioCanvas();
    // Persisted stores are created by the router/provider module graph. Import it only
    // after Studio has issued the task-scoped browser session used by the storage API.
    const [{ RouterProvider }, { AppProviders }, { router }] = await Promise.all([
        import("react-router-dom"),
        import("@/components/layout/app-providers"),
        import("@/router"),
    ]);
    initAnalytics();
    document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';
    createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
            <AppProviders>
                <RouterProvider router={router} />
            </AppProviders>
        </React.StrictMode>,
    );
})();
