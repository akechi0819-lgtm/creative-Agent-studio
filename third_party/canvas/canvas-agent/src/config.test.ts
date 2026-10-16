import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";

const env = {
    PORT: "17371",
    CANVAS_AGENT_TOKEN: "instance-token",
    CANVAS_AGENT_PROJECT_ID: "project-1",
    CANVAS_AGENT_INSTANCE_ID: "instance-1",
    CANVAS_AGENT_DATA_DIR: "/tmp/canvas-bridge-instance-1",
    CANVAS_AGENT_ORIGIN: "http://localhost:3000",
};

test("loadConfig accepts launcher-provided instance settings", () => {
    assert.deepEqual(loadConfig(env), {
        port: 17371,
        url: "http://127.0.0.1:17371",
        token: "instance-token",
        projectId: "project-1",
        instanceId: "instance-1",
        dataDir: "/tmp/canvas-bridge-instance-1",
        origin: "http://localhost:3000",
    });
});

test("loadConfig rejects missing instance identity and malformed origin", () => {
    assert.throws(() => loadConfig({ ...env, CANVAS_AGENT_PROJECT_ID: "" }), /CANVAS_AGENT_PROJECT_ID 未设置/);
    assert.throws(() => loadConfig({ ...env, CANVAS_AGENT_ORIGIN: "http://localhost:3000/canvas" }), /不含路径/);
    assert.throws(() => loadConfig({ ...env, PORT: "0" }), /PORT 必须/);
});
