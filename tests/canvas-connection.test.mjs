import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const rootRequire = createRequire(new URL('../package.json', import.meta.url));
const esbuild = rootRequire('esbuild');
const helperPath = new URL('../third_party/canvas/web/src/lib/canvas/canvas-connection.ts', import.meta.url);
const helperSource = fs.readFileSync(helperPath, 'utf8');
const transformed = await esbuild.transform(helperSource, { loader: 'ts', format: 'esm', target: 'es2022' });
const helperModule = await import(`data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`);

class VirtualTimers {
  now = 0;
  nextId = 1;
  pending = new Map();

  setTimeout = (callback, delayMs) => {
    const id = this.nextId++;
    this.pending.set(id, { id, at: this.now + delayMs, callback });
    return id;
  };

  clearTimeout = (id) => this.pending.delete(id);

  async advance(durationMs) {
    const target = this.now + durationMs;
    while (true) {
      const next = [...this.pending.values()].filter(timer => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.pending.delete(next.id);
      this.now = next.at;
      next.callback();
      await flushMicrotasks();
    }
    this.now = target;
    await flushMicrotasks();
  }
}

async function flushMicrotasks() {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
}

class MockEventSource {
  readyState = 0;
  onerror = null;
  listeners = new Map();
  closeCount = 0;

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, data = '{}') {
    if (type === 'hello' || type === 'ping') this.readyState = 1;
    for (const listener of this.listeners.get(type) || []) listener({ data });
  }

  fail(readyState = this.readyState) {
    this.readyState = readyState;
    this.onerror?.({});
  }

  close() {
    this.closeCount += 1;
    this.readyState = 2;
  }
}

function makeVisibilityTarget() {
  return {
    visibilityState: 'visible',
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    removeEventListener(type) { this.listeners.delete(type); },
    emit(type) { this.listeners.get(type)?.(); },
  };
}

function makeFocusTarget() {
  return {
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    removeEventListener(type) { this.listeners.delete(type); },
    emit(type) { this.listeners.get(type)?.(); },
  };
}

function setup(overrides = {}) {
  const timers = new VirtualTimers();
  const sources = [];
  const statuses = [];
  const connectionErrors = [];
  let recovered = 0;
  let snapshot = { version: 1 };
  const connection = helperModule.createCanvasConnectionRecovery({
    createEventSource: () => {
      const source = new MockEventSource();
      sources.push(source);
      return source;
    },
    getSnapshot: () => snapshot,
    publishSnapshot: async () => {},
    onToolCall: () => {},
    onStatus: (connected, activity) => statuses.push({ connected, activity }),
    onConnectionError: message => connectionErrors.push(message),
    onConnectionRecovered: () => { recovered += 1; },
    timers: { now: () => timers.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    visibilityTarget: overrides.visibilityTarget ?? makeVisibilityTarget(),
    focusTarget: overrides.focusTarget ?? makeFocusTarget(),
    heartbeatCheckMs: 20,
    heartbeatTimeoutMs: 50,
    stateRetryBaseMs: 10,
    stateRetryMaxMs: 20,
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
    ...overrides,
  });
  return {
    connection, timers, sources, statuses, connectionErrors,
    get recovered() { return recovered; },
    setSnapshot(value) { snapshot = value; },
  };
}

test('hello is not connected until the read-only snapshot succeeds, then retries with bounded delay', async () => {
  let attempts = 0;
  const failed = setup({
    publishSnapshot: async () => {
      attempts += 1;
      if (attempts <= 3) throw new Error(`temporary state failure ${attempts}`);
    },
  });
  try {
    failed.sources[0].emit('hello');
    await flushMicrotasks();
    assert.equal(attempts, 1);
    assert.equal(failed.statuses.at(-1).connected, false);
    assert.equal(failed.connectionErrors.at(-1), 'temporary state failure 1');

    await failed.timers.advance(10);
    assert.equal(attempts, 2);
    assert.equal(failed.statuses.at(-1).connected, false);
    await failed.timers.advance(20);
    assert.equal(attempts, 3);
    assert.equal(failed.statuses.at(-1).connected, false);
    await failed.timers.advance(20);
    assert.equal(attempts, 4);
    assert.equal(failed.statuses.at(-1).connected, true);
    assert.equal(failed.connectionErrors.length, 3);
    assert.equal(failed.recovered, 1);
  } finally {
    failed.connection.dispose();
  }
});

test('a timed-out snapshot aborts and releases the queue so the next snapshot can recover', async () => {
  let attempts = 0;
  let firstSignal;
  const scenario = setup({
    stateRequestTimeoutMs: 10,
    publishSnapshot: (_snapshot, signal) => {
      attempts += 1;
      if (attempts === 1) {
        firstSignal = signal;
        return new Promise(() => {});
      }
      return Promise.resolve();
    },
  });
  try {
    scenario.sources[0].emit('hello');
    await flushMicrotasks();
    assert.equal(attempts, 1);
    assert.equal(firstSignal.aborted, false);

    await scenario.timers.advance(10);
    assert.equal(firstSignal.aborted, true);
    await scenario.timers.advance(10);
    assert.equal(attempts, 2);
    assert.equal(scenario.statuses.at(-1).connected, true);
  } finally {
    scenario.connection.dispose();
  }
});

test('a null canvas snapshot stays unready until a snapshot becomes available', async () => {
  let attempts = 0;
  const scenario = setup({
    heartbeatCheckMs: 1_000,
    heartbeatTimeoutMs: 3_000,
    publishSnapshot: async () => { attempts += 1; },
  });
  try {
    scenario.setSnapshot(null);
    scenario.sources[0].emit('hello');
    await flushMicrotasks();
    assert.equal(attempts, 0);
    assert.equal(scenario.statuses.at(-1).connected, false);

    scenario.setSnapshot({ version: 2 });
    scenario.connection.publishCurrentSnapshot();
    await flushMicrotasks();
    assert.equal(attempts, 1);
    assert.equal(scenario.statuses.at(-1).connected, true);
  } finally {
    scenario.connection.dispose();
  }
});

test('disposing aborts a pending state request and clears its timeout', async () => {
  let signal;
  const scenario = setup({
    stateRequestTimeoutMs: 1_000,
    publishSnapshot: (_snapshot, requestSignal) => {
      signal = requestSignal;
      return new Promise(() => {});
    },
  });
  scenario.sources[0].emit('hello');
  await flushMicrotasks();
  assert.equal(signal.aborted, false);

  scenario.connection.dispose();
  await flushMicrotasks();
  assert.equal(signal.aborted, true);
  assert.equal(scenario.timers.pending.size, 0);
});

test('snapshot updates serialize, and a completion for an older snapshot cannot mark the connection ready', async () => {
  let resolveFirst;
  const writes = [];
  let active = 0;
  let maxActive = 0;
  const scenario = setup({
    publishSnapshot: snapshot => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      writes.push(snapshot.version);
      if (writes.length === 1) return new Promise(resolve => {
        resolveFirst = () => { active -= 1; resolve(); };
      });
      active -= 1;
      return Promise.resolve();
    },
  });
  try {
    scenario.sources[0].emit('hello');
    await flushMicrotasks();
    scenario.setSnapshot({ version: 2 });
    scenario.connection.publishCurrentSnapshot();
    assert.equal(scenario.statuses.at(-1).connected, false);

    resolveFirst();
    await flushMicrotasks();
    assert.deepEqual(writes, [1, 2]);
    assert.equal(maxActive, 1);
    assert.equal(scenario.statuses.at(-1).connected, true);
  } finally {
    scenario.connection.dispose();
  }
});

test('operation-owned state failures are not retried', async () => {
  let attempts = 0;
  const scenario = setup({
    publishSnapshot: async () => {
      attempts += 1;
      throw new Error('operation state failed');
    },
  });
  try {
    await assert.rejects(scenario.connection.writeState({ version: 'operation' }), /operation state failed/);
    await scenario.timers.advance(100);
    assert.equal(attempts, 1);
    assert.equal(scenario.sources.length, 1);
  } finally {
    scenario.connection.dispose();
  }
});

test('permanent snapshot response errors are surfaced without retrying', async () => {
  let attempts = 0;
  const scenario = setup({
    publishSnapshot: async () => {
      attempts += 1;
      throw Object.assign(new Error('invalid project identity'), { status: 400 });
    },
  });
  try {
    scenario.sources[0].emit('hello');
    await flushMicrotasks();
    await scenario.timers.advance(40);
    assert.equal(attempts, 1);
    assert.equal(scenario.statuses.at(-1).connected, false);
    assert.equal(scenario.connectionErrors.at(-1), 'invalid project identity');
  } finally {
    scenario.connection.dispose();
  }
});

test('pings keep an open connection alive; a stale open source is replaced', async () => {
  const scenario = setup();
  try {
    const first = scenario.sources[0];
    first.emit('hello');
    await flushMicrotasks();
    await scenario.timers.advance(30);
    first.emit('ping');
    await scenario.timers.advance(40);
    assert.equal(scenario.sources.length, 1);

    await scenario.timers.advance(40);
    assert.equal(scenario.sources.length, 2);
    assert.equal(first.closeCount, 1);
  } finally {
    scenario.connection.dispose();
  }
});

test('CONNECTING is left to EventSource; CLOSED reconnects, and hidden-tab throttling does not churn a live source', async () => {
  const visibilityTarget = makeVisibilityTarget();
  const scenario = setup({ visibilityTarget });
  try {
    const first = scenario.sources[0];
    first.emit('hello');
    await flushMicrotasks();

    first.fail(0);
    await scenario.timers.advance(100);
    assert.equal(scenario.sources.length, 1, 'native EventSource reconnect remains in control while CONNECTING');

    first.emit('hello');
    await flushMicrotasks();
    visibilityTarget.visibilityState = 'hidden';
    await scenario.timers.advance(200);
    assert.equal(scenario.sources.length, 1, 'hidden-tab timer throttling does not cause reconnect churn');

    visibilityTarget.visibilityState = 'visible';
    visibilityTarget.emit('visibilitychange');
    scenario.sources[0].fail(2);
    await scenario.timers.advance(10);
    assert.equal(scenario.sources.length, 2, 'a CLOSED source is explicitly reopened');
  } finally {
    scenario.connection.dispose();
  }
});
