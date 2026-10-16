export type ImageCropRect = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type ImageAngleTransform = {
    horizontalAngle: number;
    pitchAngle: number;
    cameraDistance: number;
    wideAngle: boolean;
};

export type ImageUpscaleAlgorithm = "nearest" | "bilinear" | "high";

export const MAX_UPSCALE_LONG_EDGE = 4096;

export type ImageUpscaleParams = {
    targetLongEdge: number;
    algorithm: ImageUpscaleAlgorithm;
};

export type ImageSplitParams = {
    rows: number;
    columns: number;
    horizontalLines?: number[];
    verticalLines?: number[];
};

export type ImageSplitPiece = {
    row: number;
    column: number;
    dataUrl: string;
};

export type PixelImageSource = { dataUrl: string; width: number; height: number };
export type ImageStitchParams = { direction: "horizontal" | "vertical"; gap?: number; background?: string };
export type ImageComposeLayer = {
    source: PixelImageSource;
    x: number;
    y: number;
    width: number;
    height: number;
    fit?: "contain" | "cover" | "stretch";
    clear?: string;
    smoothing?: "nearest" | "smooth";
};

const MAX_PIXEL_OPERATION_LONG_EDGE = 16384;
const MAX_PIXEL_OPERATION_PIXELS = 32 * 1024 * 1024;

/** 拼接源图的原始像素，超出输出画布上限时直接拒绝。 */
export async function stitchDataUrls(sources: PixelImageSource[], params: ImageStitchParams) {
    if (sources.length < 2 || sources.length > 20) throw new Error("拼接图片数量必须为 2–20 张");
    if (params.direction !== "horizontal" && params.direction !== "vertical") throw new Error("拼接方向必须是 horizontal 或 vertical");
    const gap = params.gap ?? 0;
    if (!Number.isSafeInteger(gap) || gap < 0) throw new Error("gap 必须是大于等于 0 的整数");
    if (params.background !== undefined) parsePixelColor(params.background);

    const width = params.direction === "horizontal"
        ? sources.reduce((sum, source) => sum + source.width, gap * (sources.length - 1))
        : Math.max(...sources.map((source) => source.width));
    const height = params.direction === "vertical"
        ? sources.reduce((sum, source) => sum + source.height, gap * (sources.length - 1))
        : Math.max(...sources.map((source) => source.height));
    assertPixelOutputSize(width, height);
    const images = await Promise.all(sources.map(loadExpectedImage));

    const { canvas, context } = createPixelCanvas(width, height, params.background);
    let x = 0;
    let y = 0;
    images.forEach((image) => {
        context.drawImage(image, x, y);
        if (params.direction === "horizontal") x += image.naturalWidth + gap;
        else y += image.naturalHeight + gap;
    });
    return canvas.toDataURL("image/png");
}

/** 在底图副本上按顺序合成矩形贴图，不改动任何输入图。 */
export async function composeDataUrls(base: PixelImageSource, layers: ImageComposeLayer[]) {
    if (layers.length < 1 || layers.length > 20) throw new Error("贴图数量必须为 1–20 张");
    const image = await loadExpectedImage(base);
    assertPixelOutputSize(image.naturalWidth, image.naturalHeight);
    layers.forEach((layer) => {
        assertPixelRect(layer, image.naturalWidth, image.naturalHeight);
        if (layer.clear !== undefined) parsePixelColor(layer.clear);
        if (layer.fit !== undefined && layer.fit !== "contain" && layer.fit !== "cover" && layer.fit !== "stretch") throw new Error("贴图 fit 必须是 contain、cover 或 stretch");
        if (layer.smoothing !== undefined && layer.smoothing !== "nearest" && layer.smoothing !== "smooth") throw new Error("贴图 smoothing 必须是 nearest 或 smooth");
    });
    const layerImages = await Promise.all(layers.map(async (layer) => ({ layer, image: await loadExpectedImage(layer.source) })));
    const { canvas, context } = createPixelCanvas(image.naturalWidth, image.naturalHeight);
    context.drawImage(image, 0, 0);

    for (const { layer, image: overlay } of layerImages) {
        const fit = layer.fit ?? "contain";
        const smoothing = layer.smoothing ?? "nearest";
        context.imageSmoothingEnabled = smoothing === "smooth";
        context.imageSmoothingQuality = "high";

        if (layer.clear !== undefined) {
            const [red, green, blue, alpha] = parsePixelColor(layer.clear);
            context.clearRect(layer.x, layer.y, layer.width, layer.height);
            context.fillStyle = `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
            context.fillRect(layer.x, layer.y, layer.width, layer.height);
        }
        drawFittedImage(context, overlay, layer, fit);
    }
    return canvas.toDataURL("image/png");
}

export async function getDataUrlDimensions(dataUrl: string) {
    const image = await loadImage(dataUrl);
    return { width: image.naturalWidth, height: image.naturalHeight };
}

function drawFittedImage(context: CanvasRenderingContext2D, image: HTMLImageElement, layer: ImageComposeLayer, fit: "contain" | "cover" | "stretch") {
    const { x, y, width, height } = layer;
    if (fit === "stretch") {
        context.drawImage(image, x, y, width, height);
        return;
    }

    const sourceRatio = image.naturalWidth / image.naturalHeight;
    const targetRatio = width / height;
    if (fit === "contain") {
        const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
        const drawWidth = image.naturalWidth * scale;
        const drawHeight = image.naturalHeight * scale;
        context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
        return;
    }

    if (sourceRatio > targetRatio) {
        const sourceWidth = image.naturalHeight * targetRatio;
        context.drawImage(image, (image.naturalWidth - sourceWidth) / 2, 0, sourceWidth, image.naturalHeight, x, y, width, height);
    } else {
        const sourceHeight = image.naturalWidth / targetRatio;
        context.drawImage(image, 0, (image.naturalHeight - sourceHeight) / 2, image.naturalWidth, sourceHeight, x, y, width, height);
    }
}

function assertPixelRect(rect: Pick<ImageComposeLayer, "x" | "y" | "width" | "height">, canvasWidth: number, canvasHeight: number) {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > canvasWidth || rect.y + rect.height > canvasHeight) {
        throw new Error("贴图矩形必须是整数像素且完整位于底图范围内");
    }
}

function parsePixelColor(color: string): [number, number, number, number] {
    const match = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(color);
    if (!match) throw new Error("颜色必须是 #RRGGBB 或 #RRGGBBAA");
    const hex = match[1];
    return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16), match[2] ? Number.parseInt(match[2], 16) : 255];
}

function assertPixelOutputSize(width: number, height: number) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new Error("合成图片尺寸无效");
    if (Math.max(width, height) > MAX_PIXEL_OPERATION_LONG_EDGE || width * height > MAX_PIXEL_OPERATION_PIXELS) {
        throw new Error("合成图片超出上限：长边最多 16384 像素，总像素最多 32×1024×1024；不会自动缩小");
    }
}

function createPixelCanvas(width: number, height: number, background?: string) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建 Canvas2D 绘图上下文");
    context.clearRect(0, 0, width, height);
    if (background !== undefined) {
        const [red, green, blue, alpha] = parsePixelColor(background);
        context.fillStyle = `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
        context.fillRect(0, 0, width, height);
    }
    return { canvas, context };
}

async function loadExpectedImage(source: PixelImageSource) {
    if (!Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height) || source.width <= 0 || source.height <= 0) throw new Error("图片 naturalWidth/naturalHeight 元数据无效");
    const image = await loadImage(source.dataUrl);
    if (image.naturalWidth !== source.width || image.naturalHeight !== source.height) throw new Error("图片实际尺寸与节点 naturalWidth/naturalHeight 元数据不一致");
    return image;
}

export async function cropDataUrl(dataUrl: string, crop?: ImageCropRect) {
    const image = await loadImage(dataUrl);
    if (crop) {
        return drawCrop(image, Math.floor(crop.x * image.width), Math.floor(crop.y * image.height), Math.ceil(crop.width * image.width), Math.ceil(crop.height * image.height));
    }
    const size = Math.min(image.width, image.height);
    const sx = Math.max(0, Math.floor((image.width - size) / 2));
    const sy = Math.max(0, Math.floor((image.height - size) / 2));
    return drawCrop(image, sx, sy, size, size);
}

export async function splitDataUrl(dataUrl: string, params: ImageSplitParams): Promise<ImageSplitPiece[]> {
    const image = await loadImage(dataUrl);
    const xCuts = buildSplitCuts(params.verticalLines, image.width, Math.max(1, Math.floor(params.columns)));
    const yCuts = buildSplitCuts(params.horizontalLines, image.height, Math.max(1, Math.floor(params.rows)));
    const pieces: ImageSplitPiece[] = [];

    for (let row = 0; row < yCuts.length - 1; row += 1) {
        const sy = yCuts[row];
        const sh = yCuts[row + 1] - sy;
        for (let column = 0; column < xCuts.length - 1; column += 1) {
            const sx = xCuts[column];
            const sw = xCuts[column + 1] - sx;
            pieces.push({ row, column, dataUrl: drawCrop(image, sx, sy, sw, sh) });
        }
    }

    return pieces;
}

function buildSplitCuts(lines: number[] | undefined, size: number, count: number) {
    if (!lines?.length) return Array.from({ length: count + 1 }, (_, index) => Math.floor((index * size) / count));
    return [0, ...lines.map((line) => Math.round(line * size)).filter((line) => line > 0 && line < size).sort((a, b) => a - b), size];
}

export async function transformAngleDataUrl(dataUrl: string, params: ImageAngleTransform) {
    const image = await loadImage(dataUrl);
    const canvas = document.createElement("canvas");
    const padding = Math.round(Math.max(image.width, image.height) * 0.18);
    canvas.width = image.width + padding * 2;
    canvas.height = image.height + padding * 2;
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;
    context.clearRect(0, 0, canvas.width, canvas.height);

    const horizontal = params.horizontalAngle / 60;
    const pitch = params.pitchAngle / 45;
    const distanceScale = 1.12 - params.cameraDistance * 0.035;
    const wideScale = params.wideAngle ? 0.88 : 1;
    const scale = Math.max(0.64, Math.min(1.1, distanceScale * wideScale));
    const width = image.width * scale * (1 - Math.abs(horizontal) * 0.28);
    const height = image.height * scale * (1 - Math.abs(pitch) * 0.18);
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const skewX = horizontal * image.width * 0.18;
    const skewY = pitch * image.height * 0.12;
    const x = cx - width / 2 + horizontal * padding * 0.5;
    const y = cy - height / 2 + pitch * padding * 0.45;

    context.save();
    context.setTransform(1, pitch * 0.08, horizontal * -0.1, 1, 0, 0);
    context.drawImage(image, x + skewX, y + skewY, width, height);
    context.restore();

    if (params.wideAngle) {
        const gradient = context.createRadialGradient(cx, cy, Math.min(canvas.width, canvas.height) * 0.2, cx, cy, Math.max(canvas.width, canvas.height) * 0.62);
        gradient.addColorStop(0, "rgba(255,255,255,0)");
        gradient.addColorStop(1, "rgba(0,0,0,0.18)");
        context.fillStyle = gradient;
        context.fillRect(0, 0, canvas.width, canvas.height);
    }

    return canvas.toDataURL("image/png");
}

export async function upscaleDataUrl(dataUrl: string, params: ImageUpscaleParams) {
    const image = await loadImage(dataUrl);
    const { width, height } = resolveUpscaleSize(image.width, image.height, params.targetLongEdge);
    return params.algorithm === "high" ? drawStepUpscale(image, width, height) : drawResize(image, image.width, image.height, width, height, params.algorithm);
}

export function resolveUpscaleSize(width: number, height: number, targetLongEdge: number) {
    const longEdge = Math.max(1, width, height);
    const target = Math.min(MAX_UPSCALE_LONG_EDGE, Math.max(1, Math.round(targetLongEdge)));
    const scale = target / longEdge;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function drawCrop(image: HTMLImageElement, sx: number, sy: number, sw: number, sh: number) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, sw);
    canvas.height = Math.max(1, sh);
    const context = canvas.getContext("2d");
    if (!context) return image.src;
    context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
}

function drawStepUpscale(image: HTMLImageElement, width: number, height: number) {
    let source: CanvasImageSource = image;
    let sourceWidth = image.width;
    let sourceHeight = image.height;

    while (sourceWidth * 2 < width && sourceHeight * 2 < height) {
        const nextWidth = sourceWidth * 2;
        const nextHeight = sourceHeight * 2;
        const next = drawResizeCanvas(source, sourceWidth, sourceHeight, nextWidth, nextHeight, "high");
        source = next;
        sourceWidth = nextWidth;
        sourceHeight = nextHeight;
    }

    return drawResize(source, sourceWidth, sourceHeight, width, height, "high");
}

function drawResize(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number, algorithm: ImageUpscaleAlgorithm) {
    return drawResizeCanvas(source, sourceWidth, sourceHeight, width, height, algorithm).toDataURL("image/png");
}

function drawResizeCanvas(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number, algorithm: ImageUpscaleAlgorithm) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return canvas;
    context.imageSmoothingEnabled = algorithm !== "nearest";
    context.imageSmoothingQuality = algorithm === "bilinear" ? "medium" : "high";
    context.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
    return canvas;
}

function loadImage(dataUrl: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("图片加载失败，无法读取像素数据"));
        image.src = dataUrl;
    });
}
