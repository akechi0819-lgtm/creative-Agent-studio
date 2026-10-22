export function createCanvasWindowManager({
  windowObject,
  api,
  wait = (milliseconds) => new Promise((resolve) => windowObject.setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
}) {
  const windowsByTask = new Map();

  function isClosed(child) {
    try { return !child || child.closed; } catch { return true; }
  }

  function focus(entry) {
    try { entry.window.focus(); } catch {}
  }

  function closeUnusedEntry(taskId, entry) {
    if (!entry.navigated) {
      try { entry.window.close(); } catch {}
      if (!entry.openPromise && !entry.ensurePromise && windowsByTask.get(taskId) === entry) windowsByTask.delete(taskId);
    }
  }

  function forgetClosedEntry(taskId, entry) {
    if (isClosed(entry.window) && !entry.openPromise && !entry.ensurePromise && windowsByTask.get(taskId) === entry) {
      windowsByTask.delete(taskId);
    }
  }

  // Called before the first await so browsers still recognize a user gesture.
  function acquire(taskId) {
    let entry = windowsByTask.get(taskId);
    if (entry && isClosed(entry.window)) {
      if (!entry.openPromise && !entry.ensurePromise) {
        windowsByTask.delete(taskId);
        entry = null;
      }
    }
    if (entry) {
      focus(entry);
      return entry;
    }

    const child = windowObject.open('about:blank', '_blank');
    if (!child) throw new Error('浏览器阻止了 Canvas 新标签页，请允许本地工作台打开 Canvas 后重试。');
    entry = { window: child, navigated: false, openPromise: null, ensurePromise: null, lastOpenResponse: null };
    windowsByTask.set(taskId, entry);
    return entry;
  }

  function navigate(entry, openUrl) {
    if (entry.navigated) return;
    entry.window.opener = null;
    entry.window.location.replace(openUrl);
    entry.navigated = true;
  }

  function validateOpenResponse(opened) {
    if (!opened?.openUrl) throw new Error('Canvas 服务没有返回可打开的任务页面。');
    return opened;
  }

  function reusedWindowResult(promise) {
    return Promise.resolve(promise).then((result) => ({ ...result, reusedWindow: true }));
  }

  async function open(taskId) {
    const entry = acquire(taskId);
    if (entry.ensurePromise) return reusedWindowResult(entry.ensurePromise);
    if (entry.openPromise) return reusedWindowResult(entry.openPromise);
    if (entry.navigated) return { ...entry.lastOpenResponse, reusedWindow: true };

    let promise;
    promise = (async () => {
      try {
        const opened = validateOpenResponse(await api.canvasOpen(taskId));
        entry.lastOpenResponse = opened;
        if (opened.clientConnected) {
          closeUnusedEntry(taskId, entry);
          return opened;
        }
        navigate(entry, opened.openUrl);
        return opened;
      } catch (cause) {
        closeUnusedEntry(taskId, entry);
        throw cause;
      } finally {
        if (entry.openPromise === promise) entry.openPromise = null;
        forgetClosedEntry(taskId, entry);
      }
    })();
    entry.openPromise = promise;
    return promise;
  }

  async function ensureConnected(taskId, { onConnecting = () => {} } = {}) {
    const entry = acquire(taskId);
    if (entry.ensurePromise) return entry.ensurePromise;

    let promise;
    promise = (async () => {
      try {
        if (entry.openPromise) {
          await entry.openPromise;
          if (entry.lastOpenResponse?.clientConnected) return entry.lastOpenResponse;
        }

        const opened = validateOpenResponse(await api.canvasOpen(taskId));
        entry.lastOpenResponse = opened;
        if (opened.clientConnected) {
          closeUnusedEntry(taskId, entry);
          return opened;
        }

        // A known tab may still be loading after an earlier open. Do not replace
        // its document while it is connecting; poll the task-scoped connection.
        navigate(entry, opened.openUrl);
        onConnecting();
        const deadline = now() + 30000;
        while (now() < deadline) {
          await wait(400);
          const current = await api.task(taskId);
          if (current.canvas?.clientConnected && current.canvas.projectId === opened.projectId) return opened;
        }
        throw new Error('Canvas 标签页已打开，但尚未连接到当前任务。请等画布加载完成后重试绘图。');
      } catch (cause) {
        closeUnusedEntry(taskId, entry);
        throw cause;
      } finally {
        if (entry.ensurePromise === promise) entry.ensurePromise = null;
        forgetClosedEntry(taskId, entry);
      }
    })();
    entry.ensurePromise = promise;
    return promise;
  }

  return { open, ensureConnected };
}
