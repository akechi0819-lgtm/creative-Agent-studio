#!/usr/bin/env node
import { startHttpServer } from "./server/http.js";

const server = startHttpServer();
let shuttingDown = false;

function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close((error) => {
        if (error) {
            console.error("Canvas bridge shutdown failed", error.message);
            process.exitCode = 1;
        }
    });
    server.closeAllConnections();
}

function removeSignalHandlers() {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
server.once("close", removeSignalHandlers);
