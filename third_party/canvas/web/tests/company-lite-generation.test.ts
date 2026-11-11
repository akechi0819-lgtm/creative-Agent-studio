import { expect, test } from "bun:test";

import { isCompanyLiteGenerationAllowed, isCompanyLiteGenerationModeSupported } from "../src/lib/canvas/company-lite-generation";

const STUDIO_H3_VIDEO_MODEL = "studio-video::minimax_h3";

test("Company Lite permits image generation and only the configured H3 text-to-video model", () => {
    expect(isCompanyLiteGenerationModeSupported("image")).toBe(true);
    expect(isCompanyLiteGenerationModeSupported("video")).toBe(true);
    expect(isCompanyLiteGenerationModeSupported("text")).toBe(false);
    expect(isCompanyLiteGenerationModeSupported("audio")).toBe(false);
    expect(isCompanyLiteGenerationModeSupported("other")).toBe(false);
    expect(isCompanyLiteGenerationAllowed(undefined, "any-image-model", STUDIO_H3_VIDEO_MODEL)).toBe(true);
    expect(isCompanyLiteGenerationAllowed("image", "any-image-model", STUDIO_H3_VIDEO_MODEL)).toBe(true);
    expect(isCompanyLiteGenerationAllowed("video", STUDIO_H3_VIDEO_MODEL, STUDIO_H3_VIDEO_MODEL)).toBe(true);
    expect(isCompanyLiteGenerationAllowed("video", "default::grok-imagine-video", STUDIO_H3_VIDEO_MODEL)).toBe(false);
    expect(isCompanyLiteGenerationAllowed("video", "minimax_h3", STUDIO_H3_VIDEO_MODEL)).toBe(false);
    expect(isCompanyLiteGenerationAllowed("text", STUDIO_H3_VIDEO_MODEL, STUDIO_H3_VIDEO_MODEL)).toBe(false);
    expect(isCompanyLiteGenerationAllowed("audio", STUDIO_H3_VIDEO_MODEL, STUDIO_H3_VIDEO_MODEL)).toBe(false);
    expect(isCompanyLiteGenerationAllowed("image_edit", STUDIO_H3_VIDEO_MODEL, STUDIO_H3_VIDEO_MODEL)).toBe(false);
});
