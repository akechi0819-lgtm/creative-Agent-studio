import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, Download, Image as ImageIcon, Pencil, Trash2, X } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Input } from "antd";
import { useTranslation } from "react-i18next";

import { flushCanvasStore, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { hasAgentUrlBootstrap } from "@/lib/agent/agent-url-bootstrap";
import { ensureImagePreview, previewUrlFor, resolveImageUrl, subscribeImagePreviews } from "@/services/image-storage";
import { CanvasNodeType } from "@/types/canvas";

export function CanvasProjectCard({ project }: { project: CanvasProject }) {
    const { message } = App.useApp();
    const { i18n, t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const renameProject = useCanvasStore((state) => state.renameProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const editingId = useCanvasUiStore((state) => state.editingProjectId);
    const editingTitle = useCanvasUiStore((state) => state.editingProjectTitle);
    const startEditing = useCanvasUiStore((state) => state.startEditingProject);
    const setEditingTitle = useCanvasUiStore((state) => state.setEditingProjectTitle);
    const stopEditing = useCanvasUiStore((state) => state.stopEditingProject);
    const toggleSelected = useCanvasUiStore((state) => state.toggleSelectedProjectId);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const editing = editingId === project.id;
    const selected = selectedIds.includes(project.id);
    const previewSource = project.nodes.reduce<{ storageKey?: string; content: string } | undefined>((source, node) => {
        if (source || node.type !== CanvasNodeType.Image) return source;
        const generatedImage = node.metadata?.images?.find((image) => image.status === "success" && (image.storageKey || image.content));
        if (generatedImage) return { storageKey: generatedImage.storageKey, content: generatedImage.content };
        if (node.metadata?.status === "success" && (node.metadata.storageKey || node.metadata.content)) {
            return { storageKey: node.metadata.storageKey, content: node.metadata.content || "" };
        }
        return undefined;
    }, undefined);
    const previewStorageKey = previewSource?.storageKey;
    const previewUrl = useSyncExternalStore(subscribeImagePreviews, () => previewUrlFor(previewStorageKey), () => undefined);
    const [originalUrl, setOriginalUrl] = useState<string>();
    useEffect(() => {
        let active = true;
        setOriginalUrl(undefined);
        if (previewSource) {
            void resolveImageUrl(previewSource.storageKey, previewSource.content).then((url) => {
                if (active) setOriginalUrl(url || undefined);
            });
            if (previewSource.storageKey) void ensureImagePreview(previewSource.storageKey);
        }
        return () => { active = false; };
    }, [previewSource?.content, previewSource?.storageKey]);
    const imageUrl = previewUrl || originalUrl;
    const open = () => {
        const agentHash = hasAgentUrlBootstrap(window.location.hash) ? window.location.hash : "";
        const path = `/canvas/${project.id}${searchParams.toString() ? `?${searchParams.toString()}` : ""}${agentHash}`;
        void flushCanvasStore().then(() => navigate(path, { replace: Boolean(agentHash) })).catch(() => message.error("无法保存画布历史状态，请稍后重试。"));
    };
    const saveTitle = () => {
        renameProject(project.id, editingTitle);
        stopEditing();
    };

    return (
        <article className="group flex min-h-44 cursor-pointer flex-col justify-between rounded-2xl bg-[#f1eee8] p-5 transition hover:bg-[#ebe6dc] dark:bg-white/5 dark:hover:bg-white/10" onClick={() => !editing && open()}>
            <div className="mb-4 flex h-36 items-center justify-center overflow-hidden rounded-xl bg-white/60 dark:bg-black/20">
                {imageUrl ? <img src={imageUrl} alt="" loading="lazy" decoding="async" className="size-full object-cover" /> : <ImageIcon className="size-6 text-stone-400" aria-hidden="true" />}
            </div>
            <div className="flex items-start gap-3">
                <input
                    type="checkbox"
                    checked={selected}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => toggleSelected(project.id, event.target.checked)}
                    className="mt-1 size-4 accent-stone-950 dark:accent-stone-100"
                    aria-label={t("canvas.project.select", { name: project.title })}
                />
                {editing ? (
                    <Input className="min-w-0" value={editingTitle} onClick={(event) => event.stopPropagation()} onChange={(event) => setEditingTitle(event.target.value)} onKeyDown={(event) => event.key === "Enter" && saveTitle()} autoFocus />
                ) : (
                    <button
                        type="button"
                        className="min-w-0 cursor-pointer text-left"
                        onClick={(event) => {
                            event.stopPropagation();
                            open();
                        }}
                    >
                        <h2 className="truncate text-xl font-semibold">{project.title}</h2>
                        <p className="mt-3 text-sm leading-6 text-stone-600 dark:text-stone-400">
                            {t("canvas.project.stats", { nodes: project.nodes.length, connections: project.connections.length })}
                        </p>
                    </button>
                )}
            </div>
            <div className="mt-8 flex items-end justify-between gap-3">
                <p className="text-xs text-stone-500">{t("canvas.project.updated", { date: new Date(project.updatedAt).toLocaleString(i18n.resolvedLanguage, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) })}</p>
                <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
                    {editing ? (
                        <>
                            <Button type="text" size="small" shape="circle" icon={<Check className="size-4" />} onClick={saveTitle} aria-label={t("canvas.project.saveName")} />
                            <Button type="text" size="small" shape="circle" icon={<X className="size-4" />} onClick={stopEditing} aria-label={t("canvas.project.cancelRename")} />
                        </>
                    ) : (
                        <>
                            <Button type="text" size="small" shape="circle" icon={<Download className="size-4" />} onClick={() => void exportCanvasProjects([project], project.title || t("canvas.title"))} aria-label={t("canvas.project.export")} />
                            <Button type="text" size="small" shape="circle" icon={<Pencil className="size-4" />} onClick={() => startEditing(project.id, project.title)} aria-label={t("canvas.project.rename")} />
                            <Button type="text" size="small" shape="circle" icon={<Trash2 className="size-4" />} onClick={() => setDeleteIds([project.id])} aria-label={t("canvas.project.delete")} />
                        </>
                    )}
                </div>
            </div>
        </article>
    );
}
