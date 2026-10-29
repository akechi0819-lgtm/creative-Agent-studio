import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";
import { createHash } from "node:crypto";
import { compactNode } from "./tools.js";

import { BridgeError, CanvasSession } from "./session.js";

test("compact node hashes the full original content before truncating it", () => {
    const content = "需要完整校验的画面说明。".repeat(80);
    const node = compactNode({ id: "text-long", type: "text", title: "测试", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content, contentSha256: "untrusted" } });
    assert.equal(node.metadata?.content, content.slice(0, 120) + "...");
    assert.equal(node.metadata?.contentSha256, createHash("sha256").update(content).digest("hex"));
});

test("hello announces the client-registered actual project", (t) => {
    const session = new CanvasSession("instance-1");
    const client = connect(session, "client-1");
    t.after(() => client.close());

    assert.deepEqual(client.event("hello"), {
        ok: true,
        instanceId: "instance-1",
        projectId: "project-1",
        clientId: "client-1",
    });
});

test("canvas state requires a matching connected project-client pair", (t) => {
    const session = new CanvasSession("instance-1");
    const client = connect(session, "client-1");
    t.after(() => client.close());

    assert.throws(() => session.updateState("project-2", "client-1", { projectId: "project-2" }), (error) => error instanceof BridgeError && error.statusCode === 409);
    assert.throws(() => session.updateState("project-1", "missing", { projectId: "project-1" }), (error) => error instanceof BridgeError && error.statusCode === 409);
    assert.throws(() => session.updateState("project-1", "client-1", { projectId: "project-2" }), (error) => error instanceof BridgeError && error.statusCode === 403);
    assert.throws(() => session.updateState("project-1", "client-1", { projectId: "project-1", clientId: "other-client" }), (error) => error instanceof BridgeError && error.statusCode === 403);

    session.updateState("project-1", "client-1", { projectId: "project-1", nodes: [], connections: [], selectedNodeIds: [] });
    assert.equal(session.health().hasCanvas, true);
    assert.equal(Object.hasOwn(session.health(), "projectId"), false);
    assert.deepEqual(session.health().targets, [{ clientId: "client-1", projectId: "project-1", hasCanvas: true, active: false }]);
});

test("multiple project-client pairs are independent; only navigation and project listing work without canvas state", async (t) => {
    const session = new CanvasSession("instance-1");
    const canvas = connect(session, "shared-client", "actual-project-1");
    const library = connect(session, "library", "library");
    t.after(() => { canvas.close(); library.close(); });
    session.updateState("actual-project-1", "shared-client", { projectId: "actual-project-1", clientId: "shared-client", nodes: [], connections: [], selectedNodeIds: [] });

    assert.deepEqual(session.health().targets, [
        { clientId: "shared-client", projectId: "actual-project-1", hasCanvas: true, active: false },
        { clientId: "library", projectId: "library", hasCanvas: false, active: false },
    ]);

    for (const [name, input] of [["site_navigate", { path: "/canvas" }], ["canvas_list_projects", {}]] as const) {
        const result = session.callTool(name, input, { projectId: "library", clientId: "library" });
        const call = library.events.filter((event) => event.type === "tool_call").at(-1)?.data;
        assert.equal(call?.name, name);
        assert.equal(canvas.event("tool_call"), undefined);
        assert.equal(session.resolveResult("library", "library", { requestId: call?.requestId as string, result: { ok: true } }), true);
        assert.deepEqual(await result, { ok: true });
    }
    const libraryToolCalls = library.events.filter((event) => event.type === "tool_call").length;
    await assert.rejects(session.callTool("canvas_read_image", { nodeId: "image-1" }, { projectId: "library", clientId: "library" }), (error) => error instanceof BridgeError && error.statusCode === 409);
    await assert.rejects(session.callTool("canvas_get_state", {}, { projectId: "wrong-project", clientId: "shared-client" }), (error) => error instanceof BridgeError && error.statusCode === 409);
    assert.equal(library.events.filter((event) => event.type === "tool_call").length, libraryToolCalls, "an unconnected target never falls through to another project");
});

test("same client IDs are isolated by actual project ID", async (t) => {
    const session = new CanvasSession("instance-1");
    const first = connect(session, "same-client", "project-a");
    const second = connect(session, "same-client", "project-b");
    t.after(() => { first.close(); second.close(); });

    const result = session.callTool("site_navigate", { path: "/image" }, { projectId: "project-b", clientId: "same-client" });
    const call = second.event("tool_call");
    assert.equal(first.event("tool_call"), undefined);
    assert.ok(call?.requestId);
    assert.equal(session.resolveResult("project-a", "same-client", { requestId: call?.requestId, result: { wrong: true } }), false);
    assert.equal(session.resolveResult("project-b", "same-client", { requestId: call?.requestId, result: { ok: true } }), true);
    assert.deepEqual(await result, { ok: true });
    assert.deepEqual(session.health().targets.map(({ projectId }) => projectId), ["project-a", "project-b"]);
});

test("disconnecting the active target clears activation instead of selecting another project", (t) => {
    const session = new CanvasSession("instance-1");
    const active = connect(session, "client-a", "project-a");
    const other = connect(session, "client-b", "project-b");
    t.after(() => { active.close(); other.close(); });
    session.activateClient("project-a", "client-a");
    assert.deepEqual(session.health().targets.map((target) => target.active), [true, false]);

    active.close();
    assert.deepEqual(session.health().targets, [{ clientId: "client-b", projectId: "project-b", hasCanvas: false, active: false }]);
    assert.throws(() => session.activateClient("project-a", "client-a"), (error) => error instanceof BridgeError && error.statusCode === 409);
});

test("tool call targets its explicit client and canvas_read_image reaches the browser unchanged", async (t) => {
    const session = new CanvasSession("instance-1");
    const first = connect(session, "client-1");
    const second = connect(session, "client-2");
    t.after(() => {
        first.close();
        second.close();
    });
    session.updateState("project-1", "client-2", { projectId: "project-1", clientId: "client-2", nodes: [], connections: [], selectedNodeIds: [] });

    const result = session.callTool("canvas_read_image", { nodeId: "image-42" }, { projectId: "project-1", clientId: "client-2" });
    const call = second.event("tool_call");
    assert.equal(first.event("tool_call"), undefined);
    assert.equal(call?.name, "canvas_read_image");
    assert.deepEqual(call?.input, { nodeId: "image-42" });
    session.resolveResult("project-1", "client-2", { requestId: call?.requestId, result: { dataUrl: "data:image/png;base64,aW1hZ2U=", naturalWidth: 1200, naturalHeight: 600 } });
    assert.deepEqual(await result, { dataUrl: "data:image/png;base64,aW1hZ2U=", naturalWidth: 1200, naturalHeight: 600 });
});

test("pixel tools validate inputs and forward only their bounded operation arguments", async (t) => {
    const session = new CanvasSession("instance-1");
    const client = connect(session, "client-1");
    t.after(() => client.close());
    session.updateState("project-1", "client-1", { projectId: "project-1", clientId: "client-1", nodes: [], connections: [], selectedNodeIds: [] });

    const calls = [
        { name: "canvas_crop_image", input: { nodeId: "image-1", crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 } } },
        { name: "canvas_split_image", input: { nodeId: "image-1", rows: 2, columns: 3 } },
        { name: "canvas_resample_image", input: { nodeId: "image-1", targetLongEdge: 2048, algorithm: "high" } },
        { name: "canvas_stitch_images", input: { nodeIds: ["image-1", "image-1", "image-2"], direction: "horizontal", gap: 12, background: "#ffffff80" } },
        { name: "canvas_compose_images", input: { nodeId: "image-1", layers: [{ nodeId: "image-2", x: 12, y: 18, width: 64, height: 32, fit: "contain", clear: "#00000000", smoothing: "nearest" }] } },
        { name: "canvas_import_image", input: { nodeId: "host-image-1", title: "宿主附件", dataUrl: "data:image/png;base64,aW1n" } },
    ] as const;

    for (const { name, input } of calls) {
        const result = session.callTool(name, input, { projectId: "project-1", clientId: "client-1" });
        const call = client.events.filter((event) => event.type === "tool_call").at(-1)?.data;
        assert.equal(call?.name, name);
        assert.deepEqual(call?.input, input);
        const operationResult = name === "canvas_stitch_images"
            ? { operation: "stitch", sourceNodeId: "image-1", sourceNodeIds: ["image-1", "image-2"], images: [{ nodeId: "child-1", width: 20, height: 30 }] }
            : name === "canvas_compose_images"
                ? { operation: "compose", sourceNodeId: "image-1", sourceNodeIds: ["image-1", "image-2"], images: [{ nodeId: "child-1", width: 20, height: 30 }] }
                : name === "canvas_import_image"
                    ? { operation: "import", sourceNodeId: "host-image-1", images: [{ nodeId: "host-image-1", width: 20, height: 30 }] }
                    : { operation: name.replace("canvas_", "").replace("_image", ""), sourceNodeId: "image-1", images: [{ nodeId: "child-1", width: 20, height: 30 }] };
        assert.equal(session.resolveResult("project-1", "client-1", { requestId: call?.requestId as string, result: operationResult }), true);
        assert.deepEqual(await result, operationResult);
    }

    const toolCallCount = client.events.filter((event) => event.type === "tool_call").length;
    const invalid = [
        ["canvas_crop_image", { nodeId: "image-1", crop: { x: 0.8, y: 0, width: 0.3, height: 1 } }],
        ["canvas_split_image", { nodeId: "image-1", rows: 5, columns: 6 }],
        ["canvas_split_image", { nodeId: "image-1", rows: 1.5, columns: 2 }],
        ["canvas_resample_image", { nodeId: "image-1", targetLongEdge: 4097, algorithm: "high" }],
        ["canvas_stitch_images", { nodeIds: ["image-1"], direction: "horizontal" }],
        ["canvas_stitch_images", { nodeIds: ["image-1", "image-2"], direction: "vertical", gap: -1 }],
        ["canvas_compose_images", { nodeId: "image-1", layers: [{ nodeId: "image-2", x: 0, y: 0, width: 0, height: 3 }] }],
        ["canvas_import_image", { nodeId: "host-image-1", title: "附件", dataUrl: "https://example.test/image.png" }],
    ] as const;

    for (const [name, input] of invalid) {
        await assert.rejects(session.callTool(name, input, { projectId: "project-1", clientId: "client-1" }), (error) => error instanceof BridgeError && error.statusCode === 400);
    }
    assert.equal(client.events.filter((event) => event.type === "tool_call").length, toolCallCount);
});

test("drawing tools reuse canvas operation conversion and reject wrong project targets", async (t) => {
    const session = new CanvasSession("instance-1");
    const client = connect(session, "client-1");
    t.after(() => client.close());
    session.updateState("project-1", "client-1", { projectId: "project-1", nodes: [], connections: [], selectedNodeIds: [] });

    const result = session.callTool("canvas_create_text_node", { text: "hello" }, { projectId: "project-1", clientId: "client-1" });
    const call = client.event("tool_call");
    assert.equal(call?.name, "canvas_apply_ops");
    assert.deepEqual((call?.input as { ops: Array<Record<string, unknown>> }).ops[0], {
        type: "add_node",
        nodeType: "text",
        position: { x: 0, y: 0 },
        metadata: { content: "hello", status: "success", fontSize: 14 },
    });
    session.resolveResult("project-1", "client-1", { requestId: call?.requestId, result: { ok: true } });
    assert.deepEqual(await result, { ok: true });

    await assert.rejects(
        session.callTool("canvas_get_state", {}, { projectId: "project-2", clientId: "client-1" }),
        (error) => error instanceof BridgeError && error.statusCode === 409,
    );
});

test("tool results are accepted only from the requesting client", async (t) => {
    const session = new CanvasSession("instance-1");
    const first = connect(session, "client-1");
    const second = connect(session, "client-2");
    t.after(() => {
        first.close();
        second.close();
    });

    const result = session.callTool("site_navigate", { path: "/canvas" }, { projectId: "project-1", clientId: "client-1" });
    const requestId = first.event("tool_call")?.requestId;
    assert.equal(session.resolveResult("project-1", "client-2", { requestId, result: { ok: false } }), false);
    assert.equal(session.resolveResult("project-1", "client-1", { requestId, result: { ok: true } }), true);
    assert.deepEqual(await result, { ok: true });
});

test("replacing a same-client connection invalidates its old state and pending calls", async (t) => {
    const session = new CanvasSession("instance-1");
    const oldClient = connect(session, "client-1");
    const target = { projectId: "project-1", clientId: "client-1" };
    session.updateState("project-1", "client-1", {
        projectId: "project-1",
        nodes: [{ id: "old-node", type: "text", position: { x: 0, y: 0 }, width: 100, height: 40 }],
        connections: [],
        selectedNodeIds: [],
    });

    const oldToolResult = session.callTool("site_navigate", { path: "/canvas" }, target);
    let oldSettlements = 0;
    const oldOutcome = oldToolResult.then(
        () => {
            oldSettlements += 1;
            return null;
        },
        (error: unknown) => {
            oldSettlements += 1;
            return error;
        },
    );
    const oldRequestId = oldClient.event("tool_call")?.requestId as string;

    const newClient = connect(session, "client-1");
    t.after(() => {
        oldClient.close();
        newClient.close();
    });

    assert.equal(oldClient.ended, true);
    assert.equal(newClient.event("tool_call"), undefined, "the pending old call is not replayed to the replacement connection");
    assert.equal(session.health().clients, 1);
    assert.equal(session.health().hasCanvas, false, "the replaced connection's snapshot is invalidated immediately");
    assert.equal(session.health().targets[0]?.hasCanvas, false);
    assert.equal(
        await session.callTool("canvas_get_state", {}, target).then(() => false, (error: unknown) => error instanceof BridgeError && error.statusCode === 409),
        true,
    );
    const oldError = await oldOutcome;
    assert.ok(oldError instanceof BridgeError);
    assert.equal(oldError.statusCode, 409);
    assert.equal(oldSettlements, 1, "replacing the connection rejects its pending call once");

    session.updateState("project-1", "client-1", {
        projectId: "project-1",
        nodes: [{ id: "new-node", type: "text", position: { x: 0, y: 0 }, width: 100, height: 40 }],
        connections: [],
        selectedNodeIds: [],
    });
    oldClient.close();
    assert.equal(session.health().clients, 1, "the old stream's late close cannot remove the new connection");
    assert.equal(session.health().hasCanvas, true, "the old stream's late close cannot remove the new snapshot");
    const snapshot = await session.callTool("canvas_get_state", {}, target) as { nodes: Array<{ id: string }> };
    assert.equal(snapshot.nodes[0]?.id, "new-node");

    let newSettlements = 0;
    const newToolResult = session.callTool("site_navigate", { path: "/image" }, target);
    newToolResult.then(() => { newSettlements += 1; }, () => { newSettlements += 1; });
    const newRequestId = newClient.event("tool_call")?.requestId as string;
    assert.equal(session.resolveResult("project-1", "client-1", { requestId: oldRequestId, result: { stale: true } }), false);
    assert.equal(newSettlements, 0, "a late old result cannot resolve the new connection's pending call");
    assert.equal(session.resolveResult("project-1", "client-1", { requestId: newRequestId, result: { ok: true } }), true);
    assert.deepEqual(await newToolResult, { ok: true });
    assert.equal(newSettlements, 1);
    assert.equal(oldSettlements, 1, "a late old result cannot settle the rejected call a second time");
});

function connect(session: CanvasSession, clientId: string, projectId = "project-1") {
    const response = new FakeResponse();
    const query = new URLSearchParams({ projectId, clientId });
    session.openEvents(new URL(`http://localhost/events?${query}`), response as unknown as ServerResponse);
    return response;
}

class FakeResponse extends EventEmitter {
    readonly events: Array<{ type: string; data: Record<string, unknown> }> = [];
    ended = false;
    writeHead() {}
    write(chunk: string) {
        const match = chunk.match(/^event: ([^\n]+)\ndata: (.+)\n\n$/);
        if (match) this.events.push({ type: match[1], data: JSON.parse(match[2]) as Record<string, unknown> });
        return true;
    }
    end() {
        this.ended = true;
        return this;
    }
    close() {
        this.emit("close");
    }
    event(type: string) {
        return this.events.find((event) => event.type === type)?.data;
    }
}
