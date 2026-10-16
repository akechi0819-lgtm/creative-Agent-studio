import { createStudioStorage } from "@/lib/studio-storage";

const stores = ["app_state", "image_files", "image_previews", "image_generation_logs", "video_generation_logs", "media_files"] as const;

export type StudioStoreUsage = { name: string; records: number };
export type LocalStorageUsage = {
    browserUsage: number | null;
    browserQuota: number | null;
    stores: StudioStoreUsage[];
};

export async function readLocalStorageUsage(): Promise<LocalStorageUsage> {
    const [estimate, storeCounts] = await Promise.all([
        readBrowserStorageEstimate(),
        Promise.all(stores.map(async (name) => ({ name, records: (await createStudioStorage(name).keys()).length }))),
    ]);
    return {
        browserUsage: estimate?.usage ?? null,
        browserQuota: estimate?.quota ?? null,
        stores: storeCounts,
    };
}

async function readBrowserStorageEstimate() {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
    try {
        return await navigator.storage.estimate();
    } catch {
        return null;
    }
}
