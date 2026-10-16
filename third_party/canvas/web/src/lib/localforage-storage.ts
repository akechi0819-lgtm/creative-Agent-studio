import type { StateStorage } from "zustand/middleware";

import { createStudioStorage } from "@/lib/studio-storage";

const store = createStudioStorage("app_state");

export const localForageStorage: StateStorage = {
    getItem: async (name) => store.getItem<string>(name),
    setItem: async (name, value) => {
        await store.setItem(name, value);
    },
    removeItem: async (name) => store.removeItem(name),
};
