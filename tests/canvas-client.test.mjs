import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { callCanvasTool, health, recoverImage } from "../src/canvas/client.mjs";

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startBridge(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function configFor(bridgeUrl) {
  return {
    bridgeUrl,
    token: "local-test-token",
    instanceId: "test-instance",
    projectId: "test-project",
    clientId: "test-client",
  };
}

function replyToHealth(response) {
  json(response, 200, {
    instanceId: "test-instance",
    targets: [{ clientId: "test-client", hasCanvas: true, projectId: "test-project" }],
  });
}

test("本地 HTTP 桥接错误会传回工具调用方", async () => {
  const bridge = await startBridge((request, response) => {
    if (request.url === "/health") return replyToHealth(response);
    if (request.url === "/api/tools") return json(response, 503, { ok: false, error: "local bridge failure" });
    json(response, 404, { error: "unexpected path" });
  });
  try {
    await assert.rejects(callCanvasTool("canvas_get_state", {}, configFor(bridge.url)), /canvas_get_state: local bridge failure/);
  } finally {
    await bridge.close();
  }
});

test("health 会取消在途的本地 HTTP 请求", async () => {
  let markStarted;
  const requestStarted = new Promise((resolve) => {
    markStarted = resolve;
  });
  const bridge = await startBridge((request, response) => {
    if (request.url === "/health") {
      markStarted();
      const timer = setTimeout(() => replyToHealth(response), 150);
      response.once("close", () => clearTimeout(timer));
      return;
    }
    json(response, 404, { error: "unexpected path" });
  });
  const controller = new AbortController();
  try {
    const request = health(configFor(bridge.url), { signal: controller.signal });
    await requestStarted;
    controller.abort();
    await assert.rejects(request, (error) => error.name === "AbortError");
  } finally {
    await bridge.close();
  }
});

test("recoverImage 会取消在途的本地 HTTP 请求", async () => {
  let markStarted;
  const requestStarted = new Promise((resolve) => {
    markStarted = resolve;
  });
  const bridge = await startBridge((request, response) => {
    if (request.url === "/health") return replyToHealth(response);
    if (request.url === "/api/tools") {
      markStarted();
      const timer = setTimeout(
        () => json(response, 200, { ok: true, result: { dataUrl: "data:image/png;base64,AA==", width: 1, height: 1 } }),
        150,
      );
      response.once("close", () => clearTimeout(timer));
      return;
    }
    json(response, 404, { error: "unexpected path" });
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-client-cancel-"));
  const destination = path.join(directory, "recovered.png");
  const controller = new AbortController();
  try {
    const request = recoverImage("local-node", destination, configFor(bridge.url), { signal: controller.signal });
    await requestStarted;
    controller.abort();
    await assert.rejects(request, (error) => error.name === "AbortError");
    await assert.rejects(stat(destination), { code: "ENOENT" });
  } finally {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});
