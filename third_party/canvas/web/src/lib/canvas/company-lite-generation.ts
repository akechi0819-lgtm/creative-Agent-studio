export function isCompanyLiteGenerationModeSupported(mode: unknown): boolean {
    return mode === "image" || mode === "video";
}

export function isCompanyLiteGenerationAllowed(mode: unknown, model: string, h3VideoModel: string) {
    if (mode === undefined || mode === "image") return true;
    return mode === "video" && model === h3VideoModel;
}
