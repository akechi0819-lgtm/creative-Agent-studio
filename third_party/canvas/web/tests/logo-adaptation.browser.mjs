import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    root: webRoot,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let browser;
try {
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Vite test server did not bind TCP");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: "domcontentloaded" });
    const result = await page.evaluate(async () => {
        const { adaptLogoDataUrl } = await import("/src/lib/canvas/canvas-image-data.ts");
        const source = document.createElement("canvas");
        source.width = 3;
        source.height = 3;
        const sourceContext = source.getContext("2d");
        if (!sourceContext) throw new Error("Canvas2D unavailable");
        sourceContext.fillStyle = "#20aa44";
        sourceContext.fillRect(1, 1, 1, 1);
        const sourceUrl = source.toDataURL("image/png");
        const adapted = await adaptLogoDataUrl(sourceUrl, { foreground: "#00ff00", outline: { color: "#ffffff", width: 2 } });
        const adaptedImage = new Image();
        adaptedImage.src = adapted.dataUrl;
        await adaptedImage.decode();
        const adaptedCanvas = document.createElement("canvas");
        adaptedCanvas.width = adapted.width;
        adaptedCanvas.height = adapted.height;
        const adaptedContext = adaptedCanvas.getContext("2d", { willReadFrequently: true });
        if (!adaptedContext) throw new Error("Canvas2D unavailable");
        adaptedContext.drawImage(adaptedImage, 0, 0);
        const center = [...adaptedContext.getImageData(3, 3, 1, 1).data];
        const outline = [...adaptedContext.getImageData(2, 3, 1, 1).data];
        const outsideCorner = [...adaptedContext.getImageData(0, 0, 1, 1).data];

        const plate = await adaptLogoDataUrl(sourceUrl, { plate: { color: "#00ff0080", padding: 2, radius: 3 } });
        const plateImage = new Image();
        plateImage.src = plate.dataUrl;
        await plateImage.decode();
        const plateCanvas = document.createElement("canvas");
        plateCanvas.width = plate.width;
        plateCanvas.height = plate.height;
        const plateContext = plateCanvas.getContext("2d", { willReadFrequently: true });
        if (!plateContext) throw new Error("Canvas2D unavailable");
        plateContext.drawImage(plateImage, 0, 0);
        const plateCorner = [...plateContext.getImageData(0, 0, 1, 1).data];
        const plateTopCenter = [...plateContext.getImageData(3, 0, 1, 1).data];

        const opaque = document.createElement("canvas");
        opaque.width = 1;
        opaque.height = 1;
        const opaqueContext = opaque.getContext("2d");
        if (!opaqueContext) throw new Error("Canvas2D unavailable");
        opaqueContext.fillStyle = "white";
        opaqueContext.fillRect(0, 0, 1, 1);
        let opaqueRejected = false;
        try { await adaptLogoDataUrl(opaque.toDataURL("image/png"), { foreground: "#00ff00" }); }
        catch (error) { opaqueRejected = error instanceof Error && error.message.includes("透明原件"); }
        return {
            adapted: { width: adapted.width, height: adapted.height, padding: adapted.padding, center, outline, outsideCorner },
            plate: { width: plate.width, height: plate.height, padding: plate.padding, plateCorner, plateTopCenter },
            opaqueRejected,
        };
    });

    assert.deepEqual(result.adapted, {
        width: 7, height: 7, padding: 2,
        center: [0, 255, 0, 255],
        outline: [255, 255, 255, 255],
        outsideCorner: [0, 0, 0, 0],
    });
    assert.equal(result.plate.width, 7);
    assert.equal(result.plate.height, 7);
    assert.equal(result.plate.padding, 2);
    assert.ok(result.plate.plateCorner[3] < 32, "rounded plate corners remain transparent apart from edge antialiasing");
    assert.deepEqual(result.plate.plateTopCenter, [0, 255, 0, 128]);
    assert.equal(result.opaqueRejected, true);
    console.log("Canvas logo adaptation pixel smoke passed");
} finally {
    await browser?.close();
    await vite.close();
}
