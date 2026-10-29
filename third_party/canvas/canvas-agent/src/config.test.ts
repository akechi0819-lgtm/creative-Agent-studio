import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "./config.js";

const dataDir = path.resolve(os.tmpdir(), "canvas-bridge-instance-1");
const env = {
    PORT: "17371",
    CANVAS_AGENT_TOKEN: "instance-token",
    CANVAS_AGENT_INSTANCE_ID: "instance-1",
    CANVAS_AGENT_DATA_DIR: dataDir,
    CANVAS_AGENT_ORIGIN: "http://localhost:3000",
};

test("loadConfig accepts launcher-provided instance settings", () => {
    assert.deepEqual(loadConfig(env), {
        port: 17371,
        url: "http://127.0.0.1:17371",
        token: "instance-token",
        instanceId: "instance-1",
        dataDir,
        origin: "http://localhost:3000",
    });
});

test("loadConfig ignores project identity and rejects malformed origin", () => {
    assert.deepEqual(loadConfig({ ...env, CANVAS_AGENT_PROJECT_ID: "ignored-project" }), loadConfig(env));
    assert.throws(() => loadConfig({ ...env, CANVAS_AGENT_ORIGIN: "http://localhost:3000/canvas" }), /不含路径/);
    assert.throws(() => loadConfig({ ...env, PORT: "0" }), /PORT 必须/);
});
