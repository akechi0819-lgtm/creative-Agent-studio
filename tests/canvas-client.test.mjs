import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { callCanvasTool, health, recoverImage } from "../src/canvas/client.mjs";
import { canvasImportErrorCodes, canvasImportFailureText } from "../src/canvas/import-errors.mjs";

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
    await assert.rejects(callCanvasTool("canvas_get_state", {}, configFor(bridge.url)), error => {
      assert.equal(error.code, "ERR_CANVAS_TOOL_FAILED");
      assert.equal(error.safeMessage, "Canvas 工具请求失败，请核对画布状态。");
      assert.doesNotMatch(error.message, /local bridge failure/);
      return true;
    });
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


test("桥接故障诊断编号传回调用方且不采用服务器任意错误内容", async () => {
  const requestId = "e8ee0961-a2a3-4d21-a770-9f1d54a0af17";
  const bridge = await startBridge((request, response) => {
    if (request.url === "/health") return replyToHealth(response);
    json(response, 500, {ok: false, requestId, error: "private prompt secret"});
  });
  try {
    await assert.rejects(callCanvasTool("canvas_get_state", {}, configFor(bridge.url)), error => {
      assert.equal(error.code, "ERR_CANVAS_TOOL_FAILED");
      assert.equal(error.requestId, requestId);
      assert.match(error.safeMessage, new RegExp(requestId));
      assert.doesNotMatch(error.message, /private|secret/);
      return true;
    });
  } finally { await bridge.close(); }
});

test("仅两类固定的 409 画布错误会传给宿主作为可执行提示", async () => {
  const cases = [
    ["图片服务尚未配置，请回到宿主智能体配置图片 API。", "ERR_CANVAS_IMAGE_API_UNCONFIGURED"],
    ["该节点正在生成图片，请先查询 generation_get_status，完成后再生成。", "ERR_CANVAS_NODE_BUSY"],
  ];
  for (const [message, code] of cases) {
    const bridge = await startBridge((request, response) => {
      if (request.url === "/health") return replyToHealth(response);
      json(response, 409, { ok: false, requestId: "e8ee0961-a2a3-4d21-a770-9f1d54a0af17", error: message });
    });
    try {
      await assert.rejects(callCanvasTool("canvas_run_generation", {}, configFor(bridge.url)), error => {
        assert.equal(error.code, code);
        assert.equal(error.status, 409);
        assert.equal(error.message, message);
        assert.equal(error.safeMessage, message);
        return true;
      });
    } finally {
      await bridge.close();
    }
  }
});

test("其他 409 上游错误内容仍保持隐藏", async () => {
  const bridge = await startBridge((request, response) => {
    if (request.url === "/health") return replyToHealth(response);
    json(response, 409, { ok: false, error: "private prompt secret" });
  });
  try {
    await assert.rejects(callCanvasTool("canvas_get_state", {}, configFor(bridge.url)), error => {
      assert.equal(error.code, "ERR_CANVAS_TOOL_FAILED");
      assert.doesNotMatch(error.message, /private|secret/);
      assert.doesNotMatch(error.safeMessage, /private|secret/);
      return true;
    });
  } finally {
    await bridge.close();
  }
});

test("canvas import classifies only evidenced bridge failures and returns its server request ID", async () => {
  const requestId = "e8ee0961-a2a3-4d21-a770-9f1d54a0af17";
  const cases = [
    [422, "导入图片无法解码，请确认原件是有效的 PNG、JPEG 或 WebP。", canvasImportErrorCodes.invalidImage, /图片无法解码/],
    [400, "invalid import parameters", canvasImportErrorCodes.invalidArguments, /title、nodeId/],
    [401, "invalid token", canvasImportErrorCodes.invalidConnection, /Canvas 连接凭证无效/],
    [409, "目标 projectId/clientId 未连接", canvasImportErrorCodes.disconnected, /打开目标画布/],
    [409, "目标网页尚未上报画布状态", canvasImportErrorCodes.statePending, /同步画布状态/],
    [409, "请求页面已断开", canvasImportErrorCodes.resultUnknown, /canvas_get_state/],
    [413, "request entity too large", canvasImportErrorCodes.payloadTooLarge, /不超过 20 MiB/],
    [504, "画布操作超时", canvasImportErrorCodes.resultUnknown, /canvas_get_state/],
    [500, "private prompt and API key", canvasImportErrorCodes.resultUnknown, /canvas_status/],
  ];
  for (const [status, message, expectedCode, expectedText] of cases) {
    const bridge = await startBridge((request, response) => {
      if (request.url === "/health") return replyToHealth(response);
      response.setHeader("x-canvas-request-id", requestId);
      return json(response, status, { ok: false, requestId, error: message });
    });
    try {
      await assert.rejects(callCanvasTool("canvas_import_image", { nodeId: "fixture", title: "Reference", dataUrl: "data:image/png;base64,aW1n" }, configFor(bridge.url)), error => {
        assert.equal(error.code, expectedCode);
        assert.equal(error.requestId, requestId);
        const text = canvasImportFailureText(error);
        assert.match(text, expectedText);
        assert.match(text, new RegExp(requestId));
        assert.doesNotMatch(text, /private prompt|API key|invalid import parameters/);
        if (status === 400) assert.doesNotMatch(text, /无法解码/);
        return true;
      });
    } finally {
      await bridge.close();
    }
  }
});

test("unknown import transport failures do not invent a bridge request ID", async () => {
  const bridge = await startBridge((_request, response) => response.end());
  await bridge.close();
  await assert.rejects(callCanvasTool("canvas_import_image", { nodeId: "fixture" }, configFor(bridge.url)), error => {
    assert.equal(error.code, canvasImportErrorCodes.bridgeUnavailable);
    assert.equal(error.requestId, undefined);
    const text = canvasImportFailureText(error);
    assert.match(text, /canvas_status/);
    assert.match(text, /脱敏 Canvas 日志/);
    assert.doesNotMatch(text, /诊断编号/);
    return true;
  });
});

test("a connected browser that has not published canvas state is reported as state-pending", async () => {
  let toolRequests = 0;
  const bridge = await startBridge((request, response) => {
    if (request.url === "/health") {
      return json(response, 200, {
        instanceId: "test-instance",
        targets: [{ clientId: "test-client", hasCanvas: false, projectId: "test-project" }],
      });
    }
    toolRequests += 1;
    return json(response, 404, {});
  });
  try {
    await assert.rejects(callCanvasTool("canvas_import_image", { nodeId: "fixture" }, configFor(bridge.url)), error => {
      assert.equal(error.code, canvasImportErrorCodes.statePending);
      assert.match(canvasImportFailureText(error), /等待 canvas_status 显示目标页面已连接/);
      assert.equal(toolRequests, 0, "a page without synced state is rejected before the import request");
      return true;
    });
  } finally {
    await bridge.close();
  }
});

test("an unknown import HTTP error without a bridge ID asks for the sanitized log time", async () => {
  const bridge = await startBridge((request, response) => {
    if (request.url === "/health") return replyToHealth(response);
    return json(response, 500, { ok: false, error: "private prompt, no correlation ID" });
  });
  try {
    await assert.rejects(callCanvasTool("canvas_import_image", { nodeId: "fixture" }, configFor(bridge.url)), error => {
      assert.equal(error.code, canvasImportErrorCodes.resultUnknown);
      assert.equal(error.requestId, undefined);
      const text = canvasImportFailureText(error);
      assert.match(text, /发生时间附近的本机脱敏 Canvas 日志/);
      assert.doesNotMatch(text, /private prompt|诊断编号/);
      return true;
    });
  } finally {
    await bridge.close();
  }
});
