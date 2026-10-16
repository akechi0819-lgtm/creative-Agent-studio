/**
 * Preserve the first per-image failure on aggregate nodes when every image fails.
 *
 * @param {{ hasSuccess: boolean, firstError: string, fallback: string }} outcome
 * @returns {string | undefined}
 */
export function finalImageGenerationErrorDetails({ hasSuccess, firstError, fallback }) {
    if (hasSuccess) return undefined;
    return typeof firstError === "string" && firstError.trim() ? firstError : fallback;
}
