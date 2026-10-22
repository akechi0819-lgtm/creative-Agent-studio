type CanvasSnapshot = object;

type CanvasEventSource = Pick<EventSource, "readyState" | "addEventListener" | "close"> & {
    onerror: ((event: Event) => void) | null;
};

type TimerApi = {
    now: () => number;
    setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
};

type VisibilityTarget = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
type FocusTarget = Pick<Window, "addEventListener" | "removeEventListener">;

type CanvasConnectionOptions = {
    createEventSource: () => CanvasEventSource;
    getSnapshot: () => CanvasSnapshot | null;
    publishSnapshot: (snapshot: CanvasSnapshot, signal: AbortSignal) => Promise<void>;
    onToolCall: (event: MessageEvent, source: CanvasEventSource) => void;
    onStatus: (connected: boolean, activity: string) => void;
    onConnectionError: (message: string) => void;
    onConnectionRecovered: () => void;
    timers?: TimerApi;
    visibilityTarget?: VisibilityTarget | null;
    focusTarget?: FocusTarget | null;
    heartbeatCheckMs?: number;
    heartbeatTimeoutMs?: number;
    stateRequestTimeoutMs?: number;
    stateRetryBaseMs?: number;
    stateRetryMaxMs?: number;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
};

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;
const NO_SNAPSHOT = Symbol("no current canvas snapshot");

/** Owns the EventSource lifecycle and retries only read-only canvas snapshots. */
export function createCanvasConnectionRecovery(options: CanvasConnectionOptions) {
    const timers = options.timers ?? {
        now: () => Date.now(),
        setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
        clearTimeout: (timer) => globalThis.clearTimeout(timer),
    };
    const visibilityTarget = options.visibilityTarget === undefined
        ? (typeof document === "undefined" ? null : document)
        : options.visibilityTarget;
    const focusTarget = options.focusTarget === undefined
        ? (typeof window === "undefined" ? null : window)
        : options.focusTarget;

    const heartbeatCheckMs = options.heartbeatCheckMs ?? 15_000;
    const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
    const stateRequestTimeoutMs = options.stateRequestTimeoutMs ?? 10_000;
    const stateRetryBaseMs = options.stateRetryBaseMs ?? 250;
    const stateRetryMaxMs = options.stateRetryMaxMs ?? 5_000;
    const reconnectBaseMs = options.reconnectBaseMs ?? 500;
    const reconnectMaxMs = options.reconnectMaxMs ?? 10_000;

    let disposed = false;
    let source: CanvasEventSource | null = null;
    let connectionGeneration = 0;
    let publishedGeneration = -1;
    let publishRevision = 0;
    let stateWriteTail: Promise<void> = Promise.resolve();
    let statePublishPromise: Promise<void> | null = null;
    const activeStateRequests = new Set<{
        controller: AbortController;
        timer: ReturnType<typeof setTimeout> | null;
        cancel: (error: Error) => void;
    }>();
    let stateRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stateRetryAttempt = 0;
    let reconnectAttempt = 0;
    let lastHeartbeatAt: number | null = null;

    const isCurrent = (candidate: CanvasEventSource) => !disposed && source === candidate;

    function enqueueStateWrite(write: () => Promise<void>): Promise<void> {
        const operation = stateWriteTail.then(write);
        stateWriteTail = operation.catch(() => {});
        return operation;
    }

    function publishStateWithTimeout(snapshot: CanvasSnapshot): Promise<void> {
        if (disposed) return Promise.resolve();

        const request = {
            controller: new AbortController(),
            timer: null as ReturnType<typeof setTimeout> | null,
            cancel: (_error: Error) => {},
        };
        activeStateRequests.add(request);

        const cancelled = new Promise<never>((_, reject) => { request.cancel = reject; });
        const timeout = new Promise<never>((_, reject) => {
            request.timer = timers.setTimeout(() => {
                request.controller.abort();
                reject(new Error("画布状态请求超时"));
            }, stateRequestTimeoutMs);
        });
        const fetchRequest = Promise.resolve().then(() => options.publishSnapshot(
            { ...snapshot, hasCanvas: true },
            request.controller.signal,
        ));

        return Promise.race([fetchRequest, timeout, cancelled]).finally(() => {
            if (request.timer !== null) timers.clearTimeout(request.timer);
            activeStateRequests.delete(request);
        });
    }

    function writeState(snapshot: CanvasSnapshot): Promise<void> {
        return enqueueStateWrite(() => disposed
            ? Promise.resolve()
            : publishStateWithTimeout(snapshot));
    }

    function clearStateRetry() {
        if (stateRetryTimer !== null) {
            timers.clearTimeout(stateRetryTimer);
            stateRetryTimer = null;
        }
    }

    function retryDelay(attempt: number, base: number, maximum: number) {
        return Math.min(base * 2 ** Math.min(attempt, 16), maximum);
    }

    function requestSnapshotPublish() {
        publishRevision += 1;
        publishedGeneration = -1;
        stateRetryAttempt = 0;
        clearStateRetry();
        if (source?.readyState === OPEN) options.onStatus(false, "正在同步画布状态");
        void pumpSnapshotPublish();
    }

    async function pumpSnapshotPublish() {
        if (disposed || statePublishPromise || !source || source.readyState !== OPEN) return;

        const activeSource = source;
        const generation = connectionGeneration;
        const revision = publishRevision;
        const snapshot = options.getSnapshot();
        if (!snapshot) {
            publishedGeneration = -1;
            options.onStatus(false, "等待画布状态同步");
            return;
        }

        statePublishPromise = enqueueStateWrite(() => {
            if (!isCurrent(activeSource) || generation !== connectionGeneration || revision !== publishRevision) return Promise.resolve();
            // Read again when this write reaches the head of the queue. A tool
            // operation may have changed the canvas while it was waiting.
            const currentSnapshot = options.getSnapshot();
            if (!currentSnapshot) {
                publishedGeneration = -1;
                options.onStatus(false, "等待画布状态同步");
                return Promise.reject(NO_SNAPSHOT);
            }
            return publishStateWithTimeout(currentSnapshot);
        }).then(() => {
            if (!isCurrent(activeSource) || generation !== connectionGeneration || activeSource.readyState !== OPEN) return;
            if (revision !== publishRevision) return;

            publishedGeneration = generation;
            stateRetryAttempt = 0;
            options.onConnectionRecovered();
            options.onStatus(true, "纯绘图工具已连接");
        }).catch((error: unknown) => {
            if (!isCurrent(activeSource) || generation !== connectionGeneration || revision !== publishRevision) return;
            if (error === NO_SNAPSHOT) return;

            const message = error instanceof Error ? error.message : String(error);
            options.onConnectionError(message);
            const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : null;
            const retryable = status === null || status === 408 || status === 425 || status === 429 || status >= 500;
            options.onStatus(false, retryable ? "画布状态同步失败，正在重试" : "画布状态同步失败");
            if (retryable) scheduleStateRetry(activeSource, generation);
        }).finally(() => {
            statePublishPromise = null;
            if (!disposed && source && source.readyState === OPEN && (generation !== connectionGeneration || revision !== publishRevision)) {
                void pumpSnapshotPublish();
            }
        });
    }

    function scheduleStateRetry(candidate: CanvasEventSource, generation: number) {
        if (stateRetryTimer !== null || !isCurrent(candidate)) return;
        const delayMs = retryDelay(stateRetryAttempt, stateRetryBaseMs, stateRetryMaxMs);
        stateRetryAttempt += 1;
        stateRetryTimer = timers.setTimeout(() => {
            stateRetryTimer = null;
            if (isCurrent(candidate) && generation === connectionGeneration && candidate.readyState === OPEN) {
                void pumpSnapshotPublish();
            }
        }, delayMs);
    }

    function setDisconnected(message: string, activity: string) {
        options.onConnectionError(message);
        options.onStatus(false, activity);
    }

    function scheduleReconnect(candidate: CanvasEventSource, message: string) {
        if (!isCurrent(candidate) || reconnectTimer !== null) return;
        publishedGeneration = -1;
        setDisconnected(message, "绘图工具断开，正在重连");
        candidate.close();
        const delayMs = retryDelay(reconnectAttempt, reconnectBaseMs, reconnectMaxMs);
        reconnectAttempt += 1;
        reconnectTimer = timers.setTimeout(() => {
            reconnectTimer = null;
            if (!disposed && source === candidate) openSource();
        }, delayMs);
    }

    function checkLiveness() {
        if (disposed || !source) return;
        if (visibilityTarget?.visibilityState === "hidden") return;

        const activeSource = source;
        if (activeSource.readyState === CLOSED) {
            scheduleReconnect(activeSource, "绘图服务连接已关闭，正在重连");
            return;
        }
        // CONNECTING is owned by EventSource's built-in reconnect behavior.
        if (activeSource.readyState === CONNECTING) return;
        if (activeSource.readyState !== OPEN) return;

        const heartbeatReference = lastHeartbeatAt;
        if (heartbeatReference !== null && timers.now() - heartbeatReference >= heartbeatTimeoutMs) {
            scheduleReconnect(activeSource, "绘图服务心跳超时，正在重连");
        }
    }

    function scheduleHeartbeatCheck() {
        if (disposed) return;
        heartbeatTimer = timers.setTimeout(() => {
            heartbeatTimer = null;
            checkLiveness();
            scheduleHeartbeatCheck();
        }, heartbeatCheckMs);
    }

    function openSource() {
        if (disposed) return;
        const nextSource = options.createEventSource();
        source = nextSource;
        lastHeartbeatAt = null;
        publishedGeneration = -1;
        clearStateRetry();

        nextSource.addEventListener("hello", () => {
            if (!isCurrent(nextSource) || nextSource.readyState !== OPEN) return;
            connectionGeneration += 1;
            reconnectAttempt = 0;
            stateRetryAttempt = 0;
            lastHeartbeatAt = timers.now();
            options.onStatus(false, "正在同步画布状态");
            requestSnapshotPublish();
        });
        nextSource.addEventListener("open", () => {
            if (isCurrent(nextSource)) lastHeartbeatAt = timers.now();
        });
        nextSource.addEventListener("ping", () => {
            if (!isCurrent(nextSource) || nextSource.readyState !== OPEN) return;
            lastHeartbeatAt = timers.now();
            if (publishedGeneration === connectionGeneration && connectionGeneration >= 0) {
                options.onConnectionRecovered();
                options.onStatus(true, "纯绘图工具已连接");
            }
        });
        nextSource.addEventListener("tool_call", (event) => {
            if (isCurrent(nextSource) && nextSource.readyState === OPEN) options.onToolCall(event as MessageEvent, nextSource);
        });
        nextSource.onerror = () => {
            if (!isCurrent(nextSource)) return;
            if (nextSource.readyState === CLOSED) {
                scheduleReconnect(nextSource, "绘图服务连接已关闭，正在重连");
                return;
            }
            setDisconnected("绘图服务连接中断，浏览器正在重连", "绘图工具断开，等待浏览器重连");
        };

        if (heartbeatTimer === null) scheduleHeartbeatCheck();
    }

    function onVisibilityChange() {
        if (visibilityTarget?.visibilityState === "hidden") return;
        // A throttled hidden-tab timer must not turn into an immediate false
        // stale alarm when the page becomes visible again.
        if (source?.readyState === OPEN) lastHeartbeatAt = timers.now();
        checkLiveness();
    }

    function onFocus() {
        checkLiveness();
    }

    visibilityTarget?.addEventListener("visibilitychange", onVisibilityChange);
    focusTarget?.addEventListener("focus", onFocus);
    openSource();

    return {
        /** Republish the latest snapshot after a hello or canvas-context change. */
        publishCurrentSnapshot: requestSnapshotPublish,
        /** Serialize operation-owned state writes without retrying uncertain work. */
        writeState,
        dispose() {
            if (disposed) return;
            disposed = true;
            source?.close();
            source = null;
            for (const request of activeStateRequests) {
                if (request.timer !== null) timers.clearTimeout(request.timer);
                request.controller.abort();
                request.cancel(new Error("Canvas connection disposed"));
            }
            clearStateRetry();
            if (heartbeatTimer !== null) timers.clearTimeout(heartbeatTimer);
            if (reconnectTimer !== null) timers.clearTimeout(reconnectTimer);
            heartbeatTimer = null;
            reconnectTimer = null;
            visibilityTarget?.removeEventListener("visibilitychange", onVisibilityChange);
            focusTarget?.removeEventListener("focus", onFocus);
        },
    };
}
