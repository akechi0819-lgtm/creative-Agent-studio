import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeWorkspaceFile } from './paths.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OFFICE_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python-helper.py');
const MAX_SCRIPT_CHARS = 32_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export function defaultPythonPath() {
  if (process.env.STUDIO_OCR_PYTHON) return process.env.STUDIO_OCR_PYTHON;
  return path.join(PROJECT_ROOT, '.venv-ocr', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
}

function safeOutput(value) {
  return String(value || '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|token)\s*[:=]\s*)[^\s,}]+/gi, '$1[REDACTED]');
}

function childEnvironment() {
  const env = {
    LANG: 'C.UTF-8',
    PYTHONUTF8: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
  };
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

function signalChild(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function runProcess(command, args, { cwd, input, signal, timeoutMs, maxOutputBytes = MAX_OUTPUT_BYTES } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let aborted = false;
    let outputTruncated = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    let killTimer;
    let settled = false;
    let child;
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const requestStop = (reason) => {
      if (!child || child.exitCode !== null || child.killed) return;
      if (reason === 'timeout') timedOut = true;
      if (reason === 'abort') aborted = true;
      signalChild(child, 'SIGTERM');
      killTimer = setTimeout(() => signalChild(child, 'SIGKILL'), 800);
      killTimer.unref?.();
    };
    const onAbort = () => requestStop('abort');
    const timeout = setTimeout(() => requestStop('timeout'), timeoutMs);
    timeout.unref?.();
    try {
      child = spawn(command, args, {
        cwd,
        env: childEnvironment(),
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      finishError(new Error('无法启动本机执行环境。'));
      return;
    }
    child.stdout.on('data', chunk => {
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes <= maxOutputBytes) stdout.push(bytes);
      else {
        const remaining = Math.max(0, maxOutputBytes - (stdoutBytes - bytes.length));
        if (remaining) stdout.push(bytes.subarray(0, remaining));
        outputTruncated = true;
      }
    });
    child.stderr.on('data', chunk => {
      const bytes = Buffer.from(chunk);
      stderrBytes += bytes.length;
      if (stderrBytes <= maxOutputBytes) stderr.push(bytes);
      else {
        const remaining = Math.max(0, maxOutputBytes - (stderrBytes - bytes.length));
        if (remaining) stderr.push(bytes.subarray(0, remaining));
        outputTruncated = true;
      }
    });
    child.once('error', () => finishError(new Error('无法启动本机执行环境。')));
    child.once('close', (code, closeSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (aborted || signal?.aborted) {
        reject(signal?.reason || new Error('执行已取消。'));
        return;
      }
      resolve({
        exitCode: Number.isInteger(code) ? code : null,
        signal: closeSignal || null,
        timedOut,
        truncated: outputTruncated,
        stdout: safeOutput(Buffer.concat(stdout).toString('utf8')),
        stderr: safeOutput(Buffer.concat(stderr).toString('utf8')),
      });
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function runOfficeHelper({ workspaceRoot, pythonPath, request, signal, timeoutMs = 20_000 }) {
  const executable = pythonPath || defaultPythonPath();
  try {
    await access(executable);
    await access(OFFICE_HELPER);
  } catch {
    throw new Error('Python Office 工具尚未准备。');
  }
  const result = await runProcess(executable, ['-I', '-X', 'utf8', OFFICE_HELPER], {
    cwd: workspaceRoot,
    input: JSON.stringify({ ...request, workspaceRoot }),
    signal,
    timeoutMs,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  if (result.timedOut) throw new Error('文件处理超时，未返回部分结果。');
  if (result.truncated) throw new Error('文件处理输出超过上限，未返回部分结果。');
  let payload;
  try { payload = JSON.parse(result.stdout); } catch { throw new Error('本机文件处理器返回了无效结果。'); }
  if (!payload?.ok || result.exitCode !== 0) {
    const code = typeof payload?.error === 'string' ? payload.error : 'office_processing_failed';
    throw new Error(`文件处理失败：${code}`);
  }
  return payload.result;
}

export async function runWorkspaceScript({ workspaceRoot, pythonPath, language, code, signal, timeoutSeconds = 10 }) {
  if (!['python', 'javascript'].includes(language)) throw new Error('脚本语言只支持 Python 或 JavaScript。');
  if (typeof code !== 'string' || !code.trim() || code.length > MAX_SCRIPT_CHARS) {
    throw new Error(`脚本必须是 1 到 ${MAX_SCRIPT_CHARS} 个字符。`);
  }
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 30) {
    throw new Error('脚本超时必须在 1 到 30 秒之间。');
  }
  const extension = language === 'python' ? 'py' : 'mjs';
  const relativePath = `.runtime/scripts/run-${randomUUID()}.${extension}`;
  const stored = await writeWorkspaceFile(workspaceRoot, relativePath, code, { allowInternal: true, mode: 0o600 });
  const python = pythonPath || defaultPythonPath();
  const command = language === 'python' ? python : process.execPath;
  const args = language === 'python' ? ['-I', '-X', 'utf8', stored.path] : [stored.path];
  try {
    if (language === 'python') {
      try { await access(command); } catch { throw new Error('Python 脚本运行环境尚未准备。'); }
    }
    return await runProcess(command, args, {
      cwd: await realpath(workspaceRoot),
      signal,
      timeoutMs: timeoutSeconds * 1000,
      maxOutputBytes: 32 * 1024,
    });
  } finally {
    await unlink(stored.path).catch(() => {});
  }
}
