import {
    cropDataUrl,
    splitDataUrl,
    upscaleDataUrl,
    type ImageCropRect,
    type ImageComposeLayer,
    type ImageStitchParams,
    type ImageSplitParams,
    type ImageUpscaleParams,
} from "@/lib/canvas/canvas-image-data";

export type CanvasImageOperationRequest =
    | { operation: "crop"; nodeId: string; crop: ImageCropRect }
    | ({ operation: "split"; nodeId: string } & ImageSplitParams)
    | ({ operation: "resample"; nodeId: string } & ImageUpscaleParams)
    | ({ operation: "stitch"; nodeIds: string[] } & ImageStitchParams)
    | { operation: "compose"; nodeId: string; layers: Array<Omit<ImageComposeLayer, "source"> & { nodeId: string }> }
    | { operation: "import"; nodeId: string; title: string; dataUrl: string };

export type CanvasImageOperationImage = { nodeId: string; width: number; height: number };
export type CanvasImageOperationResult =
    | { operation: "crop" | "split" | "resample"; sourceNodeId: string; images: CanvasImageOperationImage[] }
    | { operation: "stitch" | "compose"; sourceNodeId: string; sourceNodeIds: string[]; images: CanvasImageOperationImage[] }
    | { operation: "import"; sourceNodeId: string; images: CanvasImageOperationImage[] };

export type CanvasImageDataOperation =
    | { operation: "crop"; crop: ImageCropRect }
    | ({ operation: "split" } & ImageSplitParams)
    | ({ operation: "resample" } & ImageUpscaleParams);

export type CanvasImageDataPiece = { dataUrl: string; row?: number; column?: number };

/** Shared pixel-operation entry point for the manual editors and drawing bridge. */
export async function transformCanvasImageData(dataUrl: string, operation: CanvasImageDataOperation): Promise<CanvasImageDataPiece[]> {
    if (operation.operation === "crop") return [{ dataUrl: await cropDataUrl(dataUrl, operation.crop) }];
    if (operation.operation === "split") {
        const pieces = await splitDataUrl(dataUrl, operation);
        return pieces.map(({ dataUrl: pieceDataUrl, row, column }) => ({ dataUrl: pieceDataUrl, row, column }));
    }
    return [{ dataUrl: await upscaleDataUrl(dataUrl, operation) }];
}
