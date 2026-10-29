import { createBrowserRouter, Navigate } from "react-router-dom";

import UserLayout from "@/layouts/user-layout";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";

function HostCanvasNotice() {
    return <main className="grid h-dvh place-items-center bg-background px-6 text-center text-sm text-foreground">请回到宿主智能体打开本地 Canvas</main>;
}

export const router = createBrowserRouter([
    { path: "/", element: <Navigate to="/canvas" replace /> },
    {
        path: "/canvas",
        element: (
            <UserLayout>
                <CanvasPage />
            </UserLayout>
        ),
    },
    {
        path: "/canvas/:id",
        element: (
            <UserLayout>
                <CanvasProjectPage />
            </UserLayout>
        ),
    },
    { path: "*", element: <HostCanvasNotice /> },
]);
