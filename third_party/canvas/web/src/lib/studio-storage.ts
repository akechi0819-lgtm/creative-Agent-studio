const stores = new Set([
    "app_state",
    "image_files",
    "image_previews",
    "image_generation_logs",
    "video_generation_logs",
    "media_files",
]);
const JSON_CONTENT_TYPE = "application/vnd.creative-agent-studio.localforage+json";
const STRING_CONTENT_TYPE = "application/vnd.creative-agent-studio.localforage-string";

type EncodedValue = null | boolean | number | string | ["blob", string, string]
    | ["array", EncodedValue[]] | ["object", Array<[string, EncodedValue]>];

type IteratorCallback<T, R> = (value: T, key: string, iterationNumber: number) => R | void;

export type StudioStorage = {
    getItem<T = unknown>(key: string): Promise<T | null>;
    setItem<T>(key: string, value: T): Promise<T>;
    removeItem(key: string): Promise<void>;
    keys(): Promise<string[]>;
    clear(): Promise<void>;
    iterate<T, R = void>(iteratorCallback: IteratorCallback<T, R>): Promise<R | void>;
};

/** A localForage-shaped store backed by the task's same-origin private storage API. */
export function createStudioStorage(storeName: string): StudioStorage {
    if (!stores.has(storeName)) throw new Error(`Unsupported Studio storage store: ${storeName}`);

    const storeUrl = `/__studio/storage/${storeName}`;
    const keyUrl = (key: string) => `${storeUrl}/${encodeURIComponent(key)}`;

    async function request(url: string, init: RequestInit = {}) {
        const method = init.method || "GET";
        const response = await fetch(url, { ...init, cache: "no-store", credentials: "same-origin" });
        if (!response.ok) throw new Error(`Studio storage ${method} failed for ${storeName} (HTTP ${response.status}).`);
        return response;
    }

    async function readValue<T>(key: string): Promise<{ found: false } | { found: true; value: T }> {
        const response = await fetch(keyUrl(key), { cache: "no-store", credentials: "same-origin" });
        if (response.status === 404) return { found: false };
        if (!response.ok) throw new Error(`Studio storage GET failed for ${storeName} (HTTP ${response.status}).`);

        const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() || "application/octet-stream";
        if (contentType === JSON_CONTENT_TYPE) return { found: true, value: decodeValue(await response.json() as EncodedValue) as T };
        if (contentType === STRING_CONTENT_TYPE) return { found: true, value: await response.text() as T };
        return { found: true, value: await response.blob() as T };
    }

    return {
        async getItem<T>(key: string) {
            const result = await readValue<T>(key);
            return result.found ? result.value : null;
        },

        async setItem<T>(key: string, value: T) {
            let body: BodyInit;
            let contentType: string;
            if (value instanceof Blob) {
                body = value;
                contentType = value.type || "application/octet-stream";
            } else if (typeof value === "string") {
                body = value;
                contentType = STRING_CONTENT_TYPE;
            } else {
                body = JSON.stringify(await encodeValue(value));
                contentType = JSON_CONTENT_TYPE;
            }
            await request(keyUrl(key), { method: "PUT", headers: { "content-type": contentType }, body });
            return value;
        },

        async removeItem(key) {
            await request(keyUrl(key), { method: "DELETE" });
        },

        async keys() {
            const response = await request(storeUrl);
            const keys: unknown = await response.json();
            if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) {
                throw new Error(`Studio storage returned an invalid key list for ${storeName}.`);
            }
            return keys;
        },

        async clear() {
            for (const key of await this.keys()) await this.removeItem(key);
        },

        async iterate<T, R = void>(iteratorCallback: IteratorCallback<T, R>) {
            const keys = await this.keys();
            for (let index = 0; index < keys.length; index += 1) {
                const read = await readValue<T>(keys[index]);
                if (!read.found) continue;
                const result = iteratorCallback(read.value, keys[index], index + 1);
                if (result !== undefined) return result;
            }
            return undefined;
        },
    };
}

async function encodeValue(value: unknown): Promise<EncodedValue> {
    if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
    if (value instanceof Blob) {
        const bytes = await value.arrayBuffer();
        return ["blob", value.type, bytesToBase64(new Uint8Array(bytes))];
    }
    if (Array.isArray(value)) {
        const items: EncodedValue[] = [];
        for (const item of value) items.push(item === undefined ? null : await encodeValue(item));
        return ["array", items];
    }
    if (typeof value === "object") {
        const entries: Array<[string, EncodedValue]> = [];
        for (const [key, item] of Object.entries(value)) {
            if (item !== undefined) entries.push([key, await encodeValue(item)]);
        }
        return ["object", entries];
    }
    throw new Error(`Unsupported Studio storage value type: ${typeof value}`);
}

function decodeValue(value: EncodedValue): unknown {
    if (!Array.isArray(value)) return value;
    const [tag, payload, extra] = value as unknown as [string, unknown, unknown];
    if (tag === "blob") return new Blob([base64ToBytes(String(extra))], { type: String(payload) });
    if (tag === "array") return (payload as EncodedValue[]).map(decodeValue);
    if (tag === "object") return Object.fromEntries((payload as Array<[string, EncodedValue]>).map(([key, item]) => [key, decodeValue(item)]));
    throw new Error("Studio storage returned an invalid encoded value.");
}

function bytesToBase64(bytes: Uint8Array) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

function base64ToBytes(value: string) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}
