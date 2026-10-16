import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callCanvasTool, health, recoverImage } from '../canvas/client.mjs';
import { selectImage } from '../creative/executor.mjs';
import { readTask, readTaskUploadedImageBytes, requiredRevision, taskDirectory, isSheetAuthorized } from '../creative/tasks.mjs';
import { readCanvasOperationImage, runCanvasOperation } from '../creative/canvas-operations.mjs';
import { detectImageRegions } from '../creative/image-regions.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SUPERVISOR = path.join(REPO_ROOT, 'scripts/canvas-supervisor.mjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function canvasError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = 'CanvasError';
  error.code = code;
  error.safeMessage = message;
  return error;
}

function taskCanvasDirectory(root, taskId) {
  return path.join(root, 'canvas', taskId);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function stableCanvasNodeId(taskId, sourceId, fileOrder, sourceSha256) {
  const digest = createHash('sha256').update(`studio-canvas-import\0${taskId}\0${sourceId}\0${fileOrder}\0${sourceSha256}`).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function normalizeImageSettings(value) {
  const image = value?.image;
  if (!image || typeof image !== 'object') return null;
  const baseUrl = typeof image.baseUrl === 'string' ? image.baseUrl.trim() : '';
  const model = typeof image.model === 'string' ? image.model.trim() : '';
  const apiKey = typeof image.apiKey === 'string' ? image.apiKey : '';
  if (!baseUrl || !model || !apiKey) return null;
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw canvasError('ERR_CANVAS_IMAGE_CONFIG', '图片模型配置无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw canvasError('ERR_CANVAS_IMAGE_CONFIG', '图片模型配置无效');
  }
  if (baseUrl.length > 2000 || model.length > 300 || apiKey.length > 5000) {
    throw canvasError('ERR_CANVAS_IMAGE_CONFIG', '图片模型配置超出限制');
  }
  return { baseUrl, model, apiKey, apiFormat: 'openai' };
}

function studioAiConfig(image) {
  const model = image?.model || '';
  const channelModel = model ? `studio-image::${model}` : '';
  const channel = image ? [{
    id: 'studio-image', name: 'Studio 图片模型', baseUrl: image.baseUrl,
    apiKey: image.apiKey, apiFormat: 'openai', models: [{ name: model, capability: 'image' }],
  }] : [];
  return {
    channelMode: 'local', baseUrl: image?.baseUrl || '', apiKey: '', apiFormat: 'openai', channels: channel,
    model: channelModel, imageModel: channelModel, videoModel: '', textModel: '', audioModel: '',
    audioVoice: 'alloy', audioFormat: 'mp3', audioSpeed: '1', audioInstructions: '',
    videoSeconds: '6', vquality: '720', videoGenerateAudio: 'true', videoWatermark: 'false', videoMode: 'frames',
    systemPrompt: '', reasoningEffort: 'auto', models: channelModel ? [channelModel] : [],
    quality: 'auto', size: '1:1', background: '', count: '1', canvasImageCount: '1',
    proxyEnabled: false, proxyUrl: '', nodeRegenerateBehavior: 'new-node', autoFocusOnSelect: false,
  };
}

async function fileExists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function selectionEvidencePath(root, taskId) {
  return path.join(taskCanvasDirectory(root, taskId), 'canvas-selection-evidence.json');
}

async function writeSelectionEvidence(root, taskId, evidence) {
  const directory = taskCanvasDirectory(root, taskId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const file = selectionEvidencePath(root, taskId);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(evidence));
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function portAvailable(port) {
  const server = createNetServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    return true;
  } catch { return false; }
  finally { await new Promise((resolve) => server.close(() => resolve())); }
}

async function chooseWebPort(root, taskId, reserved) {
  const canvasRoot = path.join(root, 'canvas');
  const taskDir = taskCanvasDirectory(root, taskId);
  const existing = await readJson(path.join(taskDir, 'canvas-web-port.json'));
  const used = new Set();
  const entries = await fs.readdir(canvasRoot, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === taskId) continue;
    const saved = await readJson(path.join(canvasRoot, entry.name, 'canvas-web-port.json'));
    if (Number.isInteger(saved?.port)) used.add(saved.port);
  }
  if (Number.isInteger(existing?.port) && !used.has(existing.port) && !reserved.has(existing.port)) {
    reserved.add(existing.port);
    if (await portAvailable(existing.port)) return existing.port;
    reserved.delete(existing.port);
  }
  let port = 20_000 + (Number.parseInt(taskId.replaceAll('-', '').slice(0, 8), 16) % 40_000);
  for (let tries = 0; tries < 40_000; tries += 1) {
    if (!used.has(port) && !reserved.has(port)) {
      reserved.add(port);
      if (await portAvailable(port)) return port;
      reserved.delete(port);
    }
    port = port >= 59_999 ? 20_000 : port + 1;
  }
  throw canvasError('ERR_CANVAS_PORT_UNAVAILABLE', '无法为当前任务分配独立画布端口');
}

function limitedEnv(dataDir, taskId, webPort) {
  const env = {
    PATH: process.env.PATH || '', HOME: process.env.HOME || '', TMPDIR: process.env.TMPDIR || '',
    LANG: process.env.LANG || 'en_US.UTF-8', STUDIO_DATA_DIR: dataDir,
    STUDIO_PROJECT_ID: taskId, STUDIO_TASK_INSTANCE: '1', STUDIO_WEB_PORT: String(webPort),
  };
  for (const key of ['TMP', 'TEMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SYSTEMROOT', 'WINDIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  // The image proxy needs the same outbound proxy route as the workbench. Keep
  // this narrow: no other parent environment (which may contain credentials)
  // is copied into the Canvas supervisor.
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function supervisorNodeArgs() {
  const supportsEnvProxy = process.allowedNodeEnvironmentFlags?.has('--use-env-proxy') === true;
  const hasProxyEnvironment = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']
    .some((key) => Boolean(process.env[key]));
  const callerEnabledEnvProxy = process.execArgv.includes('--use-env-proxy');
  return supportsEnvProxy && (hasProxyEnvironment || callerEnabledEnvProxy) ? ['--use-env-proxy'] : [];
}

function assertUuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw canvasError('ERR_CANVAS_TASK_ID', '任务 ID 无效');
  }
}

function assertTaskVersion(task, version) {
  if (!Number.isInteger(version) || version < 1 || !isSheetAuthorized(task, version) || task.execution?.version !== version) {
    throw canvasError('ERR_CANVAS_VERSION_STALE', 'Canvas 结果不属于当前已确认的制作单版本');
  }
}

function candidateOutputs(task, snapshot, version) {
  assertTaskVersion(task, version);
  const nodes = new Map((snapshot.nodes || []).map((node) => [node.id, node]));
  const edges = new Map();
  for (const edge of snapshot.connections || []) {
    const values = edges.get(edge.fromNodeId) || [];
    values.push(edge.toNodeId);
    edges.set(edge.fromNodeId, values);
  }
  const result = [];
  for (const page of task.execution.pages || []) {
    if (page.status !== 'succeeded' && !page.submitted) continue;
    for (const nodeId of edges.get(page.nodeId) || []) {
      const node = nodes.get(nodeId);
      if (!node || node.type !== 'image' || node.metadata?.status !== 'success') continue;
      result.push({ page: page.page, nodeId, title: `第 ${page.page} 页图片`, width: Number(node.metadata?.naturalWidth) || null, height: Number(node.metadata?.naturalHeight) || null, status: 'success' });
    }
  }
  return result;
}

function instanceIdentity(instance, taskId) {
  return Boolean(instance && instance.projectId === taskId && typeof instance.instanceId === 'string'
    && typeof instance.token === 'string' && typeof instance.webUrl === 'string' && typeof instance.bridgeUrl === 'string');
}

/** Canvas supervisors, browser tickets, and image credentials are scoped to one task. */
export function createCanvasManager({ root, readConfig, canvasTool = callCanvasTool, bridgeHealth = health, regionDetector = detectImageRegions, detachedSupervisor = false } = {}) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('Canvas manager 需要数据根目录');
  if (typeof readConfig !== 'function') throw new Error('Canvas manager 需要 readConfig');
  if (typeof canvasTool !== 'function' || typeof bridgeHealth !== 'function') throw new Error('Canvas manager 需要有效的 Canvas bridge');
  if (typeof regionDetector !== 'function') throw new Error('Canvas manager 需要有效的本机图像区域检测器');
  const dataRoot = path.resolve(root);
  const instances = new Map();
  const starting = new Map();
  const reservedPorts = new Set();
  let stopped = false;

  async function configSnapshotFor(taskId) {
    const value = await readConfig({ root: dataRoot, taskId });
    return {
      imageConfig: normalizeImageSettings(value),
      configRevision: Number.isInteger(value?.revision) && value.revision > 0 ? value.revision : 1,
    };
  }

  async function configFor(taskId) {
    return (await configSnapshotFor(taskId)).imageConfig;
  }

  async function pushImageConfig(item, snapshot) {
    const response = await fetch(`${item.config.webUrl}/__studio/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-studio-token': item.config.token },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.ok === true && body.configRevision === snapshot.configRevision;
  }

  async function activeInstances() {
    const found = new Map(instances);
    let entries;
    try { entries = await fs.readdir(path.join(dataRoot, 'canvas'), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return [...found.values()]; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.name) || found.has(entry.name)) continue;
      try {
        const item = await loadInstance(entry.name);
        if (item) found.set(entry.name, item);
      } catch {
        // A stale or unreadable task directory is not an active supervisor.
      }
    }
    return [...found.values()];
  }

  async function syncImageConfig(record) {
    const configRevision = record?.revision;
    if (!Number.isInteger(configRevision) || configRevision < 1) {
      return { status: 'unsynced', updated: 0, active: 0, message: '图片配置版本无效，当前 Canvas 未同步。' };
    }
    let snapshot;
    try {
      snapshot = { configRevision, imageConfig: normalizeImageSettings({ image: record.image }) };
    } catch {
      return { status: 'unsynced', updated: 0, active: 0, message: '图片配置无法同步到当前 Canvas。' };
    }
    let items;
    try { items = await activeInstances(); }
    catch {
      return { status: 'unsynced', updated: 0, active: 0, message: '无法确认当前 Canvas 实例，图片配置未同步。' };
    }
    if (!items.length) return { status: 'no-active-canvas', updated: 0, active: 0, message: '当前没有已打开的 Canvas，新配置会在下次打开时应用。' };
    const results = await Promise.all(items.map(async (item) => {
      try { return await pushImageConfig(item, snapshot); }
      catch { return false; }
    }));
    const updated = results.filter(Boolean).length;
    if (updated !== items.length) {
      return { status: 'unsynced', updated, active: items.length, message: '部分或全部 Canvas 图片配置未同步，请在生成前重试同步。' };
    }
    return { status: 'synced', updated, active: items.length, message: '已同步到当前打开的 Canvas。' };
  }

  async function loadInstance(taskId) {
    const known = instances.get(taskId);
    if (known && (!known.child || known.child.exitCode == null)) return known;
    if (known) instances.delete(taskId);
    const file = path.join(taskCanvasDirectory(dataRoot, taskId), 'canvas-instance.json');
    const value = await readJson(file);
    if (!instanceIdentity(value, taskId)) return null;
    try {
      const response = await fetch(`${value.webUrl}/__studio/health`, { signal: AbortSignal.timeout(700) });
      const body = await response.json();
      if (!response.ok || body.instanceId !== value.instanceId || body.projectId !== taskId) return null;
      const item = { config: value, child: null };
      instances.set(taskId, item);
      return item;
    } catch { return null; }
  }

  async function startSupervisor(taskId) {
    if (stopped) throw canvasError('ERR_CANVAS_STOPPED', 'Canvas manager 已停止');
    if (starting.has(taskId)) return starting.get(taskId);
    const operation = (async () => {
      const current = await loadInstance(taskId);
      if (current) return current;
      if (stopped) throw canvasError('ERR_CANVAS_STOPPED', 'Canvas manager 已停止');
      const taskDir = taskCanvasDirectory(dataRoot, taskId);
      await fs.mkdir(taskDir, { recursive: true, mode: 0o700 });
      await fs.chmod(taskDir, 0o700);
      if (!(await fileExists(path.join(REPO_ROOT, 'third_party/canvas/web/dist/index.html')))) {
        throw canvasError('ERR_CANVAS_NOT_BUILT', '本地 Canvas 尚未构建');
      }
      let webPort;
      try {
        webPort = await chooseWebPort(dataRoot, taskId, reservedPorts);
        if (detachedSupervisor) {
          const child = spawn(process.execPath, [...supervisorNodeArgs(), SUPERVISOR], {
            cwd: REPO_ROOT, env: limitedEnv(taskDir, taskId, webPort), detached: true,
            stdio: 'ignore', windowsHide: true,
          });
          let spawnFailed = false;
          child.once('error', () => { spawnFailed = true; });
          child.unref();
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline && !spawnFailed) {
            const instance = await loadInstance(taskId);
            if (instance) return instance;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          child.kill('SIGTERM');
          throw canvasError(spawnFailed ? 'ERR_CANVAS_START_FAILED' : 'ERR_CANVAS_START_TIMEOUT',
            spawnFailed ? 'Canvas 启动失败' : 'Canvas 启动超时');
        }
        const child = spawn(process.execPath, [...supervisorNodeArgs(), SUPERVISOR], {
          cwd: REPO_ROOT, env: limitedEnv(taskDir, taskId, webPort), stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let ready = null;
        let finished = false;
        const startup = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(canvasError('ERR_CANVAS_START_TIMEOUT', 'Canvas 启动超时')), 20_000);
          const finish = (error, value) => {
            if (finished) return;
            finished = true; clearTimeout(timeout);
            error ? reject(error) : resolve(value);
          };
          child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
            if (stdout.length > 16_384) stdout = stdout.slice(-16_384);
            for (const line of stdout.split(/\r?\n/)) {
              try { const parsed = JSON.parse(line); if (parsed.ready && parsed.projectId === taskId) { ready = parsed; break; } } catch {}
            }
            if (ready) finish(null, ready);
          });
          // Supervisor and bridge diagnostics can contain local details; never forward or persist them here.
          child.stderr.on('data', () => {});
          child.once('error', () => finish(canvasError('ERR_CANVAS_START_FAILED', 'Canvas 启动失败')));
          child.once('exit', (code) => {
            if (!ready) finish(canvasError('ERR_CANVAS_START_FAILED', `Canvas 启动失败 (${code ?? 'stopped'})`));
          });
        });
        try { await startup; }
        catch (error) { child.kill('SIGTERM'); throw error; }
        const instance = await readJson(path.join(taskDir, 'canvas-instance.json'));
        if (!instanceIdentity(instance, taskId) || instance.instanceId !== ready.instanceId) {
          child.kill('SIGTERM');
          throw canvasError('ERR_CANVAS_INSTANCE_INVALID', 'Canvas 实例身份校验失败');
        }
        const item = { config: instance, child };
        instances.set(taskId, item);
        return item;
      } finally {
        if (webPort !== undefined) reservedPorts.delete(webPort);
      }
    })();
    starting.set(taskId, operation);
    try { return await operation; }
    finally { if (starting.get(taskId) === operation) starting.delete(taskId); }
  }

  async function requireTask(taskId) {
    assertUuid(taskId);
    try { return await readTask(taskId, dataRoot); }
    catch (error) { throw canvasError('ERR_CANVAS_TASK_NOT_FOUND', '任务不存在或无法读取', error); }
  }

  async function resolveTarget(taskId, instance, preferredClientId = null) {
    let current;
    try { current = await health(instance.config); }
    catch (error) { throw canvasError('ERR_CANVAS_DISCONNECTED', 'Canvas 绘图连接已断开，请重新打开该任务画布', error); }
    const targets = (current.targets || []).filter((target) => target.hasCanvas && target.projectId === taskId);
    if (targets.length === 0) throw canvasError('ERR_CANVAS_DISCONNECTED', 'Canvas 绘图页尚未连接，请打开该任务画布');
    const bound = typeof preferredClientId === 'string' && targets.find((target) => target.clientId === preferredClientId);
    if (bound) return { ...instance.config, clientId: bound.clientId };
    if (targets.length > 1) throw canvasError('ERR_CANVAS_AMBIGUOUS', '当前任务连接了多个画布标签页，且没有可恢复的原绑定；请只保留一个任务画布标签页后重试');
    return { ...instance.config, clientId: targets[0].clientId };
  }

  async function liveSnapshot(taskId, instance) {
    const config = await resolveTarget(taskId, instance);
    const snapshot = await callCanvasTool('canvas_get_state', {}, config);
    if (snapshot.projectId !== taskId) throw canvasError('ERR_CANVAS_PROJECT_MISMATCH', '当前 Canvas 项目与任务不匹配');
    return { config, snapshot };
  }

  async function readImageBytes(nodeId, config, tool = callCanvasTool) {
    let result;
    try { result = await tool('canvas_read_image', { nodeId }, config); }
    catch (error) { throw canvasError('ERR_CANVAS_IMAGE_UNAVAILABLE', '无法读取当前 Canvas 图片', error); }
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/.exec(result?.dataUrl || '');
    if (!match || !IMAGE_TYPES.has(match[1])) throw canvasError('ERR_CANVAS_IMAGE_UNAVAILABLE', 'Canvas 图片格式不受支持');
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw canvasError('ERR_CANVAS_IMAGE_SIZE', 'Canvas 图片大小无效');
    return { buffer, contentType: match[1], width: Number(result.width) || null, height: Number(result.height) || null, sha256: sha256(buffer) };
  }

  async function snapshotCandidates(task, snapshot, config, version) {
    const candidates = candidateOutputs(task, snapshot, version);
    const selectedByPage = new Map((task.execution.pages || []).map((page) => [page.page, page.imageNodeId]));
    return Promise.all(candidates.map(async (candidate) => {
      let current = null;
      try { current = await readImageBytes(candidate.nodeId, config); } catch {}
      return {
        ...candidate,
        width: current?.width || candidate.width,
        height: current?.height || candidate.height,
        sha256: current?.sha256 || null,
        selected: selectedByPage.get(candidate.page) === candidate.nodeId,
      };
    }));
  }

  async function issueOpenUrl(taskId, instance, projectTitle) {
    let snapshot;
    try { snapshot = await configSnapshotFor(taskId); }
    catch (error) { throw error?.code ? error : canvasError('ERR_CANVAS_IMAGE_CONFIG', '图片模型配置无法读取', error); }
    try {
      if (!(await pushImageConfig(instance, snapshot))) throw new Error('Canvas did not acknowledge configuration');
    } catch (error) {
      throw canvasError('ERR_CANVAS_CONFIG_SYNC', '图片配置未能同步到 Canvas，请在工作台设置中查看同步状态后重试', error);
    }
    let response;
    try {
      response = await fetch(`${instance.config.webUrl}/__studio/bootstrap/issue`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-token': instance.config.token },
        body: JSON.stringify({ projectTitle }), signal: AbortSignal.timeout(2_000),
      });
    } catch (error) { throw canvasError('ERR_CANVAS_BOOTSTRAP_FAILED', '无法为 Canvas 页面签发本地连接凭证', error); }
    if (!response.ok) throw canvasError('ERR_CANVAS_BOOTSTRAP_FAILED', '无法为 Canvas 页面签发本地连接凭证');
    let body;
    try { body = await response.json(); } catch { throw canvasError('ERR_CANVAS_BOOTSTRAP_FAILED', 'Canvas 页面连接凭证无效'); }
    if (typeof body.ticket !== 'string' || !/^[a-f0-9]{64}$/.test(body.ticket)) throw canvasError('ERR_CANVAS_BOOTSTRAP_FAILED', 'Canvas 页面连接凭证无效');
    const url = new URL('/canvas', instance.config.webUrl);
    url.searchParams.set('mode', 'recent');
    url.searchParams.set('projectId', taskId);
    url.hash = new URLSearchParams({ studioBootstrap: body.ticket }).toString();
    return url.toString();
  }

  async function ensure(taskId) {
    const task = await requireTask(taskId);
    const instance = await startSupervisor(taskId);
    const openUrl = await issueOpenUrl(taskId, instance, task.title);
    let clientConnected = false;
    try { await resolveTarget(taskId, instance); clientConnected = true; } catch {}
    return { projectId: taskId, webUrl: instance.config.webUrl, instanceId: instance.config.instanceId, openUrl, clientConnected };
  }

  async function state(taskId) {
    const task = await requireTask(taskId);
    const base = {
      state: 'stopped', projectId: taskId, webUrl: null, clientConnected: false, connectionError: null,
      images: [], task: {
        revision: task.revision, version: task.sheetVersion,
        pages: (task.execution?.pages || []).map((page) => ({ page: page.page, nodeId: page.nodeId, imageNodeId: page.imageNodeId || null, sha256: page.image?.sha256 || null, status: page.status })),
      },
    };
    const instance = await loadInstance(taskId);
    if (!instance) return base;
    base.state = 'disconnected'; base.webUrl = instance.config.webUrl;
    try {
      const target = await resolveTarget(taskId, instance);
      const snapshot = await callCanvasTool('canvas_get_state', {}, target);
      if (snapshot.projectId !== taskId) throw canvasError('ERR_CANVAS_PROJECT_MISMATCH', '当前 Canvas 项目与任务不匹配');
      base.state = 'ready'; base.clientConnected = true;
      if (task.sheetVersion > 0 && task.execution?.version === task.sheetVersion) {
        const candidates = await snapshotCandidates(task, snapshot, target, task.sheetVersion);
        const currentHashes = new Map(candidates.map((image) => [image.nodeId, image.sha256]));
        base.images = candidates;
        base.task.pages = base.task.pages.map((page) => ({ ...page, currentSha256: page.imageNodeId ? currentHashes.get(page.imageNodeId) ?? null : null }));
      }
    } catch (error) {
      if (!['ERR_CANVAS_DISCONNECTED', 'ERR_CANVAS_AMBIGUOUS'].includes(error?.code)) throw error;
      base.connectionError = error.code;
    }
    return base;
  }

  function safeNode(node) {
    const status = ['idle', 'loading', 'success', 'error'].includes(node.metadata?.status)
      ? node.metadata.status : null;
    const finiteSize = (width, height) => Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
      ? { width, height } : null;
    const naturalSize = finiteSize(Number(node.metadata?.naturalWidth), Number(node.metadata?.naturalHeight));
    const title = typeof node.title === 'string'
      ? node.title.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/https?:\/\/\S+/gi, '[已隐藏链接]').replace(/\b(?:bearer\s+)?[a-z0-9_-]{32,}\b/gi, '[已隐藏凭据]').slice(0, 120)
      : '';
    return {
      id: node.id,
      type: node.type,
      title,
      status,
      position: {
        x: Number.isFinite(node.position?.x) ? node.position.x : 0,
        y: Number.isFinite(node.position?.y) ? node.position.y : 0,
      },
      displaySize: finiteSize(Number(node.width), Number(node.height)),
      naturalSize,
    };
  }

  async function pinMechanicalTarget(taskId, instance, signal) {
    let current;
    try { current = await bridgeHealth(instance.config, { signal }); }
    catch (error) { throw canvasError('ERR_CANVAS_DISCONNECTED', 'Canvas 绘图连接已断开，请重新打开该任务画布', error); }
    if (current.instanceId !== instance.config.instanceId) throw canvasError('ERR_CANVAS_TARGET_CHANGED', 'Canvas 执行实例已变化；请重新读取画布状态');
    const targets = (current.targets || []).filter((target) => target.hasCanvas && target.projectId === taskId);
    if (!targets.length) throw canvasError('ERR_CANVAS_DISCONNECTED', 'Canvas 绘图页尚未连接，请打开该任务画布');
    if (targets.length > 1) throw canvasError('ERR_CANVAS_AMBIGUOUS', '当前任务连接了多个画布标签页，请只保留一个任务画布标签页后重试');
    const clientId = targets[0].clientId;
    if (typeof clientId !== 'string' || !clientId) throw canvasError('ERR_CANVAS_TARGET_CHANGED', 'Canvas 客户端身份无效；请重新读取画布状态');
    const config = { ...instance.config, projectId: taskId, clientId };
    const callPinned = async (name, input = {}, options = {}) => {
      const callOptions = options && typeof options === 'object' && Object.hasOwn(options, 'signal') ? options : {};
      let latest;
      try { latest = await bridgeHealth(config, { signal: callOptions.signal || signal }); }
      catch (error) { throw canvasError('ERR_CANVAS_OPERATION_UNKNOWN', 'Canvas 操作结果尚未确认；请读取当前画布状态，不要自动重提。', error); }
      if (latest.instanceId !== config.instanceId
        || !(latest.targets || []).some((target) => target.hasCanvas && target.projectId === taskId && target.clientId === clientId)) {
        throw canvasError('ERR_CANVAS_OPERATION_UNKNOWN', 'Canvas 执行目标已变化；请读取当前画布状态，不要自动重提');
      }
      return canvasTool(name, input, config, { ...callOptions, signal: callOptions.signal || signal });
    };
    return { config, clientId, call: callPinned };
  }

  function mechanicalInput(payload = {}) {
    const input = {};
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw canvasError('ERR_CANVAS_OPERATION_INPUT', '机械操作参数无效。');
    }
    const operation = payload.operation;
    const fields = {
      import: ['image'], stitch: ['nodeIds', 'direction', 'gap', 'background'], compose: ['nodeId', 'layers'],
      crop: ['nodeId', 'crop'], split: ['nodeId', 'rows', 'columns'], resample: ['nodeId', 'targetLongEdge', 'algorithm'],
      move: ['nodeId', 'x', 'y'], resize: ['nodeId', 'width', 'height'],
    }[operation];
    const identityFields = ['operation', 'expectedRevision', 'operationId', 'requestId', 'callId', 'userText', 'signal', 'expectedSourceHashes'];
    if (!fields || Object.keys(payload).some((key) => !new Set([...identityFields, ...fields]).has(key))) {
      throw canvasError('ERR_CANVAS_OPERATION_INPUT', '机械操作类型无效或包含不支持的参数。');
    }
    const finish = (sourceNodeId) => {
      let expectedSourceHashes = [];
      if (Object.hasOwn(payload, 'expectedSourceHashes')) {
        const bindings = payload.expectedSourceHashes;
        if (!Array.isArray(bindings) || bindings.length < 1 || bindings.length > 21
          || bindings.some((source) => !source || typeof source !== 'object' || Array.isArray(source)
            || Object.keys(source).length !== 2 || !Object.hasOwn(source, 'nodeId') || !Object.hasOwn(source, 'sha256')
            || typeof source.nodeId !== 'string' || !source.nodeId.trim() || source.nodeId.length > 300
            || !/^[a-f\d]{64}$/i.test(source.sha256 || ''))
          || new Set(bindings.map((source) => source.nodeId)).size !== bindings.length) {
          throw canvasError('ERR_CANVAS_OPERATION_INPUT', '已检测图像来源哈希清单无效。');
        }
        expectedSourceHashes = bindings.map((source) => ({ nodeId: source.nodeId, sha256: source.sha256.toLowerCase() }));
      }
      const sourceIds = operation === 'stitch' ? input.nodeIds
        : operation === 'compose' ? [input.nodeId, ...input.layers.map((layer) => layer.nodeId)]
          : operation === 'import' ? [] : [sourceNodeId];
      if (expectedSourceHashes.some((source) => !sourceIds.includes(source.nodeId))) {
        throw canvasError('ERR_CANVAS_OPERATION_INPUT', '已检测图像必须属于本次操作的真实来源。');
      }
      return { operation, nodeId: sourceNodeId, input, expectedSourceHashes };
    };
    const numeric = (value, label, { minimum = -1_000_000, maximum = 1_000_000 } = {}) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
        throw canvasError('ERR_CANVAS_OPERATION_INPUT', `${label}参数无效。`);
      }
      return value;
    };
    const integer = (value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) => {
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw canvasError('ERR_CANVAS_OPERATION_INPUT', `${label}必须是有效整数。`);
      }
      return value;
    };
    const nodeId = (value, label = 'Canvas 节点 ID') => {
      if (typeof value !== 'string' || !value.trim() || value.length > 300) {
        throw canvasError('ERR_CANVAS_OPERATION_INPUT', `${label}无效。`);
      }
      return value;
    };
    const color = (value, label) => {
      if (typeof value !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value)) {
        throw canvasError('ERR_CANVAS_OPERATION_INPUT', `${label}必须是 #RRGGBB 或 #RRGGBBAA。`);
      }
      return value;
    };

    if (operation === 'import') {
      if (!payload.image || typeof payload.image !== 'object' || Array.isArray(payload.image)
        || Object.keys(payload.image).some((key) => !['sourceId', 'fileOrder'].includes(key))) {
        throw canvasError('ERR_CANVAS_OPERATION_INPUT', '导入附件引用无效。');
      }
      const sourceId = nodeId(payload.image.sourceId, '任务附件来源 ID');
      const fileOrder = integer(payload.image.fileOrder, '任务附件顺序', { minimum: 1 });
      input.image = { sourceId, fileOrder };
      return finish(null);
    }

    if (operation === 'stitch') {
      if (!Array.isArray(payload.nodeIds) || payload.nodeIds.length < 2 || payload.nodeIds.length > 20) {
        throw canvasError('ERR_CANVAS_OPERATION_INPUT', '拼接需要 2 到 20 个图片节点。');
      }
      input.nodeIds = payload.nodeIds.map((id) => nodeId(id));
      if (!['horizontal', 'vertical'].includes(payload.direction)) throw canvasError('ERR_CANVAS_OPERATION_INPUT', '拼接方向无效。');
      input.direction = payload.direction;
      input.gap = payload.gap === undefined ? 0 : integer(payload.gap, '拼接间距');
      if (payload.background !== undefined) input.background = color(payload.background, '拼接背景色');
      return finish(input.nodeIds[0]);
    }

    if (operation === 'compose') {
      input.nodeId = nodeId(payload.nodeId);
      if (!Array.isArray(payload.layers) || payload.layers.length < 1 || payload.layers.length > 20) {
        throw canvasError('ERR_CANVAS_OPERATION_INPUT', '合成需要 1 到 20 个图片图层。');
      }
      input.layers = payload.layers.map((layer) => {
        if (!layer || typeof layer !== 'object' || Array.isArray(layer)
          || Object.keys(layer).some((key) => !['nodeId', 'x', 'y', 'width', 'height', 'fit', 'clear', 'smoothing'].includes(key))) {
          throw canvasError('ERR_CANVAS_OPERATION_INPUT', '合成图层参数无效。');
        }
        const normalized = {
          nodeId: nodeId(layer.nodeId, '合成图层节点 ID'),
          x: integer(layer.x, '合成图层 X 坐标'),
          y: integer(layer.y, '合成图层 Y 坐标'),
          width: integer(layer.width, '合成图层宽度', { minimum: 1 }),
          height: integer(layer.height, '合成图层高度', { minimum: 1 }),
          fit: layer.fit === undefined ? 'contain' : layer.fit,
          smoothing: layer.smoothing === undefined ? 'nearest' : layer.smoothing,
        };
        if (!['contain', 'cover', 'stretch'].includes(normalized.fit)) throw canvasError('ERR_CANVAS_OPERATION_INPUT', '合成图层 fit 无效。');
        if (!['nearest', 'smooth'].includes(normalized.smoothing)) throw canvasError('ERR_CANVAS_OPERATION_INPUT', '合成图层 smoothing 无效。');
        if (layer.clear !== undefined) normalized.clear = color(layer.clear, '合成图层清除色');
        return normalized;
      });
      return finish(input.nodeId);
    }

    const sourceNodeId = nodeId(payload.nodeId);
    if (operation === 'crop') {
      const crop = payload.crop;
      if (!crop || typeof crop !== 'object' || Array.isArray(crop) || Object.keys(crop).some((key) => !['x', 'y', 'width', 'height'].includes(key))) {
        throw canvasError('ERR_CANVAS_OPERATION_INPUT', '裁切范围无效。');
      }
      const x = numeric(crop.x, '裁切范围', { minimum: 0, maximum: 1 });
      const y = numeric(crop.y, '裁切范围', { minimum: 0, maximum: 1 });
      const width = numeric(crop.width, '裁切范围', { minimum: Number.EPSILON, maximum: 1 });
      const height = numeric(crop.height, '裁切范围', { minimum: Number.EPSILON, maximum: 1 });
      if (x + width > 1 + 1e-9 || y + height > 1 + 1e-9) throw canvasError('ERR_CANVAS_OPERATION_INPUT', '裁切范围超出图片边界。');
      input.crop = { x, y, width, height };
    } else if (operation === 'split') {
      const rows = payload.rows;
      const columns = payload.columns;
      if (!Number.isInteger(rows) || rows < 1 || rows > 25 || !Number.isInteger(columns) || columns < 1 || columns > 25
        || rows * columns < 2 || rows * columns > 25) {
        throw canvasError('ERR_CANVAS_OPERATION_INPUT', '切分行列数无效。');
      }
      input.rows = rows;
      input.columns = columns;
    } else if (operation === 'resample') {
      input.targetLongEdge = numeric(payload.targetLongEdge, '目标长边', { minimum: 1, maximum: 4096 });
      if (!['nearest', 'bilinear', 'high'].includes(payload.algorithm)) throw canvasError('ERR_CANVAS_OPERATION_INPUT', '缩放算法无效。');
      input.algorithm = payload.algorithm;
    } else if (operation === 'move') {
      if (payload.x === undefined && payload.y === undefined) throw canvasError('ERR_CANVAS_OPERATION_INPUT', '移动位置无效。');
      if (payload.x !== undefined) input.x = numeric(payload.x, '移动位置');
      if (payload.y !== undefined) input.y = numeric(payload.y, '移动位置');
    } else {
      input.width = numeric(payload.width, '节点宽度', { minimum: 1, maximum: 100_000 });
      input.height = numeric(payload.height, '节点高度', { minimum: 1, maximum: 100_000 });
    }
    return finish(sourceNodeId);
  }

  function sourceContentHash(node, actualImage) {
    if (node.type === 'image') return actualImage.sha256;
    if (node.type !== 'text' || typeof node.metadata?.content !== 'string') {
      throw canvasError('ERR_CANVAS_OPERATION_INPUT', '文本节点内容无效。');
    }
    return sha256(Buffer.from(JSON.stringify({ type: node.type, content: node.metadata.content }), 'utf8'));
  }

  async function locateSource(snapshot, nodeId, allowedTypes) {
    const matches = (snapshot.nodes || []).filter((node) => node.id === nodeId);
    if (matches.length !== 1 || !allowedTypes.includes(matches[0]?.type)) {
      throw canvasError('ERR_CANVAS_OPERATION_INPUT', '源节点必须是当前任务画布中的图片或文本节点。');
    }
    return matches[0];
  }

  async function sourceHash(node, target) {
    if (node.type !== 'image') return sourceContentHash(node, null);
    const actual = await readImageBytes(node.id, target.config, target.call);
    return sourceContentHash(node, actual);
  }

  function imageExtension(contentType) {
    return contentType === 'image/jpeg' ? '.jpg' : contentType === 'image/webp' ? '.webp' : '.png';
  }

  async function writeMechanicalImage(imagesDirectory, index, image) {
    await fs.mkdir(imagesDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(imagesDirectory, 0o700);
    const extension = imageExtension(image.contentType);
    const diskName = `image-${String(index + 1).padStart(3, '0')}${extension}`;
    const filePath = path.join(imagesDirectory, diskName);
    const handle = await fs.open(filePath, 'wx', 0o600);
    try {
      await handle.writeFile(image.buffer);
      await handle.sync();
    } finally { await handle.close(); }
    const name = `canvas-${image.operation}-${String(index + 1).padStart(2, '0')}${extension}`;
    return {
      nodeId: image.nodeId,
      width: image.width,
      height: image.height,
      sha256: image.sha256,
      name,
      mimeType: image.contentType,
      size: image.buffer.length,
      relativePath: `images/${diskName}`,
      fileUrl: image.fileUrl,
      downloadUrl: image.downloadUrl,
    };
  }

  async function agentState(taskId, { expectedRevision, signal } = {}) {
    requiredRevision({ expectedRevision });
    const task = await requireTask(taskId);
    if (task.revision !== expectedRevision) {
      const error = canvasError('ERR_TASK_REVISION_CONFLICT', '任务状态已变化，请读取最新任务状态后重试');
      error.expectedRevision = expectedRevision; error.actualRevision = task.revision; throw error;
    }
    const instance = await loadInstance(taskId);
    if (!instance) throw canvasError('ERR_CANVAS_DISCONNECTED', 'Canvas 尚未启动，请先打开该任务画布');
    const target = await pinMechanicalTarget(taskId, instance, signal);
    const snapshot = await target.call('canvas_get_state', {}, { signal });
    if (snapshot?.projectId !== taskId || (snapshot.clientId && snapshot.clientId !== target.clientId)) {
      throw canvasError('ERR_CANVAS_PROJECT_MISMATCH', 'Canvas 项目或客户端与当前任务不匹配');
    }
    const latest = await readTask(taskId, dataRoot);
    if (latest.revision !== expectedRevision) {
      const error = canvasError('ERR_TASK_REVISION_CONFLICT', '任务状态已变化，请读取最新任务状态后重试');
      error.expectedRevision = expectedRevision; error.actualRevision = latest.revision; throw error;
    }
    const nodes = (snapshot.nodes || []).filter((node) => ['image', 'text'].includes(node.type) && typeof node.id === 'string')
      .slice(0, 200).map(safeNode);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const selection = Array.isArray(snapshot.selectedNodeIds)
      ? [...new Set(snapshot.selectedNodeIds.filter((id) => typeof id === 'string' && nodeIds.has(id)))].slice(0, 200)
      : [];
    return { revision: latest.revision, nodes, selection, truncated: (snapshot.nodes || []).filter((node) => ['image', 'text'].includes(node.type)).length > nodes.length };
  }

  async function agentImage(taskId, { nodeId, expectedRevision, signal } = {}) {
    requiredRevision({ expectedRevision });
    if (typeof nodeId !== 'string' || !nodeId.trim() || nodeId.length > 300) {
      throw canvasError('ERR_CANVAS_OPERATION_INPUT', 'Canvas 图片节点 ID 无效。');
    }
    const task = await requireTask(taskId);
    if (task.revision !== expectedRevision) {
      const stale = canvasError('ERR_TASK_REVISION_CONFLICT', '任务状态已变化，请读取最新任务状态后重试');
      stale.expectedRevision = expectedRevision; stale.actualRevision = task.revision; throw stale;
    }
    const instance = await loadInstance(taskId);
    if (!instance) throw canvasError('ERR_CANVAS_DISCONNECTED', 'Canvas 尚未启动，请先打开该任务画布');
    const target = await pinMechanicalTarget(taskId, instance, signal);
    const before = await target.call('canvas_get_state', {}, { signal });
    if (before?.projectId !== taskId || (before.clientId && before.clientId !== target.clientId)) {
      throw canvasError('ERR_CANVAS_PROJECT_MISMATCH', 'Canvas 项目或客户端与当前任务不匹配');
    }
    await locateSource(before, nodeId, ['image']);
    const image = await readImageBytes(nodeId, target.config, target.call);
    const after = await target.call('canvas_get_state', {}, { signal });
    if (after?.projectId !== taskId || (after.clientId && after.clientId !== target.clientId)) {
      throw canvasError('ERR_CANVAS_TARGET_CHANGED', 'Canvas 执行目标已变化，请重新读取图片');
    }
    const sourceAfter = (after.nodes || []).filter((node) => node.id === nodeId && node.type === 'image');
    if (sourceAfter.length !== 1) throw canvasError('ERR_CANVAS_IMAGE_NOT_FOUND', 'Canvas 图片已不存在或不属于当前任务');
    const confirmed = await readImageBytes(nodeId, target.config, target.call);
    if (confirmed.sha256 !== image.sha256 || confirmed.width !== image.width || confirmed.height !== image.height) {
      throw canvasError('ERR_CANVAS_SOURCE_CHANGED', 'Canvas 图片在预览期间发生变化，请重新读取后再看图');
    }
    const latest = await readTask(taskId, dataRoot);
    if (latest.revision !== expectedRevision) {
      const stale = canvasError('ERR_TASK_REVISION_CONFLICT', '任务状态已变化，请读取最新任务状态后重试');
      stale.expectedRevision = expectedRevision; stale.actualRevision = latest.revision; throw stale;
    }
    return { bytes: image.buffer, mimeType: image.contentType, sha256: image.sha256, width: image.width, height: image.height };
  }

  async function agentRegions(taskId, { nodeId, kinds, expectedRevision, signal } = {}) {
    const image = await agentImage(taskId, { nodeId, expectedRevision, signal });
    let detected;
    try {
      detected = await regionDetector({ bytes: image.bytes, mimeType: image.mimeType, kinds, signal });
    } catch (cause) {
      if (cause?.code?.startsWith('ERR_IMAGE_REGIONS_')) throw cause;
      throw canvasError('ERR_IMAGE_REGIONS_FAILED', '本机图像区域检测未能完成。', cause);
    }
    if (!detected || detected.width !== image.width || detected.height !== image.height || !Array.isArray(detected.regions)
      || detected.regions.length > 100 || !Number.isSafeInteger(detected.totalDetected)
      || detected.totalDetected < detected.regions.length || typeof detected.truncated !== 'boolean') {
      throw canvasError('ERR_IMAGE_REGIONS_RESULT', '本机图像区域检测尺寸与 Canvas 图片不一致。');
    }
    const confirmed = await agentImage(taskId, { nodeId, expectedRevision, signal });
    if (confirmed.sha256 !== image.sha256 || confirmed.width !== image.width || confirmed.height !== image.height) {
      throw canvasError('ERR_CANVAS_SOURCE_CHANGED', 'Canvas 图片在区域检测期间发生变化，请重新读取后再看图。');
    }
    return {
      nodeId, sha256: image.sha256, width: image.width, height: image.height,
      regions: detected.regions, truncated: detected.truncated, totalDetected: detected.totalDetected,
    };
  }

  async function mechanicalOperation(taskId, payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw canvasError('ERR_CANVAS_OPERATION_INPUT', '机械操作参数无效。');
    }
    requiredRevision({ expectedRevision: payload.expectedRevision });
    const parsed = mechanicalInput(payload);
    const { operation, input, expectedSourceHashes } = parsed;
    let { nodeId } = parsed;
    if (typeof payload.operationId !== 'string' || typeof payload.requestId !== 'string'
      || typeof payload.callId !== 'string' || typeof payload.userText !== 'string') {
      throw canvasError('ERR_CANVAS_OPERATION_INPUT', '机械操作请求身份无效。');
    }
    let sourceBinding;
    if (operation === 'import') {
      if (!UUID.test(payload.operationId || '')) throw canvasError('ERR_CANVAS_OPERATION_INPUT', '导入操作标识无效。');
      const task = await requireTask(taskId);
      if (task.revision !== payload.expectedRevision) {
        const stale = canvasError('ERR_TASK_REVISION_CONFLICT', '任务状态已变化，请读取最新任务状态后重试。');
        stale.expectedRevision = payload.expectedRevision; stale.actualRevision = task.revision; throw stale;
      }
      let uploaded;
      try {
        uploaded = await readTaskUploadedImageBytes(taskId, input.image.sourceId, input.image.fileOrder, { sources: task.sources, root: dataRoot });
      } catch (cause) {
        throw canvasError('ERR_CANVAS_OPERATION_INPUT', '只能导入当前任务中未排除、哈希有效的图片附件。', cause);
      }
      if (uploaded.bytes.length > MAX_IMAGE_BYTES) throw canvasError('ERR_CANVAS_OPERATION_INPUT', '导入图片超过 Canvas 附件大小上限。');
      nodeId = stableCanvasNodeId(taskId, input.image.sourceId, input.image.fileOrder, uploaded.sha256);
      sourceBinding = { type: 'task-upload', sourceId: input.image.sourceId, fileOrder: input.image.fileOrder, sha256: uploaded.sha256 };
    }

    return runCanvasOperation({
      root: dataRoot,
      taskId,
      operationId: payload.operationId,
      requestId: payload.requestId,
      callId: payload.callId,
      userText: payload.userText,
      expectedRevision: payload.expectedRevision,
      operation,
      nodeId,
      input: expectedSourceHashes.length ? { ...input, expectedSourceHashes } : input,
      sourceBinding,
      run: async ({ task, markSubmitted, imagesDirectory }) => {
        if (task.id !== taskId || task.revision !== payload.expectedRevision) {
          throw canvasError('ERR_TASK_REVISION_CONFLICT', '任务状态已变化，请读取最新任务状态后重试');
        }
        const instance = await loadInstance(taskId);
        if (!instance) throw canvasError('ERR_CANVAS_DISCONNECTED', 'Canvas 尚未启动，请先打开该任务画布');
        const target = await pinMechanicalTarget(taskId, instance, payload.signal);
        const before = await target.call('canvas_get_state', {}, { signal: payload.signal });
        if (before?.projectId !== taskId || (before.clientId && before.clientId !== target.clientId)) {
          throw canvasError('ERR_CANVAS_PROJECT_MISMATCH', 'Canvas 项目或客户端与当前任务不匹配');
        }
        const uncertain = (message, cause) => {
          const failure = canvasError('ERR_CANVAS_OPERATION_UNKNOWN', message, cause);
          failure.canvasOutcomeUnknown = true;
          return failure;
        };
        const validatePixelDimensions = (width, height) => {
          if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
            throw canvasError('ERR_CANVAS_OPERATION_INPUT', '源图片像素尺寸无效。');
          }
        };
        const validatePixelBudget = (width, height) => {
          validatePixelDimensions(width, height);
          if (Math.max(width, height) > 16_384 || width * height > 32 * 1024 * 1024) {
            throw canvasError('ERR_CANVAS_OPERATION_INPUT', '像素合成结果不得超过长边 16384 或总像素 32M；请调整布局参数后重试。');
          }
        };
        const uniqueSourceIds = (ids) => [...new Set(ids)];
        const checkFreshTask = async (unknown = false) => {
          const latest = await readTask(taskId, dataRoot);
          if (latest.revision !== payload.expectedRevision) {
            const failure = canvasError('ERR_TASK_REVISION_CONFLICT', '任务状态已变化；请重新读取任务和 Canvas 后再继续。');
            failure.expectedRevision = payload.expectedRevision;
            failure.actualRevision = latest.revision;
            if (unknown) failure.canvasOutcomeUnknown = true;
            throw failure;
          }
        };
        const checkCanvasState = async (snapshot, unknown = false) => {
          if (snapshot?.projectId !== taskId || (snapshot.clientId && snapshot.clientId !== target.clientId)) {
            throw unknown
              ? uncertain('Canvas 执行目标已变化；请读取当前画布状态，不要自动重提')
              : canvasError('ERR_CANVAS_PROJECT_MISMATCH', 'Canvas 项目或客户端与当前任务不匹配');
          }
        };
        const readOutput = async (returned, after) => {
          const imageNode = (after.nodes || []).find((node) => node.id === returned.nodeId && node.type === 'image');
          if (!imageNode) throw uncertain('Canvas 返回的图片节点不在当前任务画布；请读取状态，不要自动重提');
          const actual = await readImageBytes(returned.nodeId, target.config, target.call);
          if (!Number.isSafeInteger(actual.width) || actual.width < 1 || !Number.isSafeInteger(actual.height) || actual.height < 1
            || actual.width !== returned.width || actual.height !== returned.height) {
            throw uncertain('Canvas 返回的图片尺寸与实际内容不一致；请读取状态，不要自动重提');
          }
          return actual;
        };
        const sourceIds = operation === 'stitch' ? input.nodeIds
          : operation === 'compose' ? [input.nodeId, ...input.layers.map((layer) => layer.nodeId)]
            : operation === 'import' ? [] : [nodeId];
        const uniqueSourceNodeIds = uniqueSourceIds(sourceIds);

        if (operation === 'import') {
          let uploaded;
          try {
            uploaded = await readTaskUploadedImageBytes(taskId, input.image.sourceId, input.image.fileOrder, { sources: task.sources, root: dataRoot });
          } catch (cause) {
            throw canvasError('ERR_CANVAS_OPERATION_INPUT', '只能导入当前任务中未排除、哈希有效的图片附件。', cause);
          }
          if (uploaded.bytes.length > MAX_IMAGE_BYTES) throw canvasError('ERR_CANVAS_OPERATION_INPUT', '导入图片超过 Canvas 附件大小上限。');
          if (uploaded.sha256 !== sourceBinding.sha256) {
            throw canvasError('ERR_CANVAS_SOURCE_CHANGED', '导入附件在准备期间发生变化；请重新读取任务附件后再试。');
          }
          const existing = (before.nodes || []).filter((node) => node.id === nodeId);
          if (existing.length) {
            if (existing.length !== 1 || existing[0].type !== 'image') {
              throw canvasError('ERR_CANVAS_OPERATION_INPUT', '稳定导入节点已被其他 Canvas 节点占用；未覆盖现有节点。');
            }
            const current = await readImageBytes(nodeId, target.config, target.call);
            if (current.sha256 !== uploaded.sha256) {
              throw canvasError('ERR_CANVAS_OPERATION_INPUT', '稳定导入节点内容与任务附件不一致；未覆盖现有节点。');
            }
            await checkFreshTask();
            return { result: { operation, sourceNodeId: nodeId, images: [{ nodeId, width: current.width, height: current.height }] }, attachments: [] };
          }
          await checkFreshTask();
          await markSubmitted({
            sourceSha256: uploaded.sha256,
            sourceBinding: { ...sourceBinding, sha256: uploaded.sha256 },
            canvasInstanceId: instance.config.instanceId,
            canvasClientId: target.clientId,
          });
          let bridgeResult;
          try {
            bridgeResult = await target.call('canvas_import_image', {
              nodeId,
              title: '导入的任务附件',
              dataUrl: `data:${uploaded.mimeType};base64,${uploaded.bytes.toString('base64')}`,
            }, { signal: payload.signal });
          } catch (cause) { throw uncertain('Canvas 导入结果尚未确认；请读取当前画布状态，不要自动重提', cause); }
          const after = await target.call('canvas_get_state', {}, { signal: payload.signal });
          await checkCanvasState(after, true);
          await checkFreshTask(true);
          let currentUpload;
          try {
            currentUpload = await readTaskUploadedImageBytes(taskId, input.image.sourceId, input.image.fileOrder, { sources: task.sources, root: dataRoot });
          } catch (cause) {
            const changed = canvasError('ERR_CANVAS_SOURCE_CHANGED', '导入附件在 Canvas 操作期间发生变化；请检查画布后再继续。', cause);
            changed.canvasOutcomeUnknown = true;
            throw changed;
          }
          if (currentUpload.sha256 !== uploaded.sha256) {
            const changed = canvasError('ERR_CANVAS_SOURCE_CHANGED', '导入附件在 Canvas 操作期间发生变化；请检查画布后再继续。');
            changed.canvasOutcomeUnknown = true;
            throw changed;
          }
          if (!bridgeResult || bridgeResult.operation !== 'import' || bridgeResult.sourceNodeId !== nodeId
            || !Array.isArray(bridgeResult.images) || bridgeResult.images.length !== 1
            || bridgeResult.images[0]?.nodeId !== nodeId) {
            throw uncertain('Canvas 未返回可核验的导入图片节点；请读取状态，不要自动重提');
          }
          const actual = await readOutput(bridgeResult.images[0], after);
          if (actual.sha256 !== uploaded.sha256) {
            const changed = canvasError('ERR_CANVAS_SOURCE_CHANGED', '导入到 Canvas 的图片内容与任务附件不一致；请检查画布后再继续。');
            changed.canvasOutcomeUnknown = true;
            throw changed;
          }
          return {
            result: { operation, sourceNodeId: nodeId, images: [{ nodeId, width: actual.width, height: actual.height }] },
            attachments: [],
          };
        }

        const expectedType = operation === 'move' || operation === 'resize' ? ['image', 'text'] : ['image'];
        const sourceNodes = new Map();
        const sourceImages = new Map();
        for (const id of uniqueSourceNodeIds) {
          const source = await locateSource(before, id, expectedType);
          sourceNodes.set(id, source);
          if (source.type === 'image') {
            const actual = await readImageBytes(id, target.config, target.call);
            sourceImages.set(id, actual);
          }
        }
        const beforeHashes = new Map([...sourceNodes].map(([id, source]) => [id, source.type === 'image'
          ? sourceImages.get(id).sha256 : sourceContentHash(source, null)]));
        for (const expected of expectedSourceHashes) {
          if (beforeHashes.get(expected.nodeId) !== expected.sha256) {
            throw canvasError('ERR_CANVAS_SOURCE_CHANGED', '区域检测后源图片发生变化，请重新读取图像区域后再合成。');
          }
        }

        let expectedOutputSize = null;
        if (operation === 'stitch') {
          for (const actual of sourceImages.values()) validatePixelBudget(actual.width, actual.height);
          const sizes = input.nodeIds.map((id) => {
            const actual = sourceImages.get(id);
            validatePixelDimensions(actual?.width, actual?.height);
            return { width: actual.width, height: actual.height };
          });
          const width = input.direction === 'horizontal'
            ? sizes.reduce((total, size) => total + size.width, 0) + input.gap * (sizes.length - 1)
            : Math.max(...sizes.map((size) => size.width));
          const height = input.direction === 'vertical'
            ? sizes.reduce((total, size) => total + size.height, 0) + input.gap * (sizes.length - 1)
            : Math.max(...sizes.map((size) => size.height));
          validatePixelBudget(width, height);
          expectedOutputSize = { width, height };
        } else if (operation === 'compose') {
          for (const actual of sourceImages.values()) validatePixelBudget(actual.width, actual.height);
          const base = sourceImages.get(input.nodeId);
          validatePixelBudget(base?.width, base?.height);
          for (const layer of input.layers) {
            const rectRight = layer.x + layer.width;
            const rectBottom = layer.y + layer.height;
            if (rectRight > base.width || rectBottom > base.height) {
              throw canvasError('ERR_CANVAS_OPERATION_INPUT', '合成图层矩形必须完整位于底图范围内。');
            }
          }
          expectedOutputSize = { width: base.width, height: base.height };
        }

        const source = sourceNodes.get(nodeId);
        const beforeHash = beforeHashes.get(nodeId);
        const beforePosition = {
          x: Number.isFinite(source.position?.x) ? source.position.x : 0,
          y: Number.isFinite(source.position?.y) ? source.position.y : 0,
        };
        const toolInput = operation === 'stitch'
          ? { ...input }
          : operation === 'compose' ? { ...input }
            : operation === 'crop' ? { nodeId, crop: input.crop }
              : operation === 'split' ? { nodeId, rows: input.rows, columns: input.columns }
                : operation === 'resample' ? { nodeId, targetLongEdge: input.targetLongEdge, algorithm: input.algorithm }
                  : operation === 'move' ? { items: [{ id: nodeId, x: input.x ?? beforePosition.x, y: input.y ?? beforePosition.y }] }
                    : { id: nodeId, width: input.width, height: input.height };
        const command = operation === 'stitch' ? 'canvas_stitch_images'
          : operation === 'compose' ? 'canvas_compose_images'
            : operation === 'crop' ? 'canvas_crop_image'
              : operation === 'split' ? 'canvas_split_image'
                : operation === 'resample' ? 'canvas_resample_image'
                  : operation === 'move' ? 'canvas_move_nodes' : 'canvas_resize_node';
        await checkFreshTask();
        await markSubmitted({
          sourceSha256: beforeHash,
          ...(uniqueSourceNodeIds.length > 1 || operation === 'stitch' || operation === 'compose'
            ? { sourceBindings: uniqueSourceNodeIds.map((id) => ({ nodeId: id, sha256: beforeHashes.get(id) })) } : {}),
          canvasInstanceId: instance.config.instanceId,
          canvasClientId: target.clientId,
        });
        let bridgeResult;
        try { bridgeResult = await target.call(command, toolInput, { signal: payload.signal }); }
        catch (cause) { throw uncertain('Canvas 操作结果尚未确认；请读取当前画布状态，不要自动重提', cause); }

        const after = await target.call('canvas_get_state', {}, { signal: payload.signal });
        await checkCanvasState(after, true);
        await checkFreshTask(true);
        for (const id of uniqueSourceNodeIds) {
          const original = sourceNodes.get(id);
          const latest = await locateSource(after, id, [original.type]).catch(() => null);
          const latestHash = latest ? await sourceHash(latest, target) : null;
          if (!latest || latestHash !== beforeHashes.get(id)) {
            const changed = canvasError('ERR_CANVAS_SOURCE_CHANGED', '源节点内容在机械操作期间发生变化；请检查画布后再继续');
            changed.canvasOutcomeUnknown = true;
            throw changed;
          }
        }

        if (operation === 'move') {
          const afterSource = sourceNodes.get(nodeId) && (after.nodes || []).find((node) => node.id === nodeId && node.type === source.type);
          const position = afterSource?.position || {};
          const expectedX = toolInput.items[0].x;
          const expectedY = toolInput.items[0].y;
          if (!Number.isFinite(position.x) || !Number.isFinite(position.y)
            || Math.abs(position.x - expectedX) > 0.01 || Math.abs(position.y - expectedY) > 0.01) {
            throw uncertain('Canvas 未能确认节点新位置；请读取当前画布状态，不要自动重提');
          }
          return { result: { operation, sourceNodeId: nodeId, position: { x: position.x, y: position.y } }, attachments: [] };
        }
        if (operation === 'resize') {
          const afterSource = (after.nodes || []).find((node) => node.id === nodeId && node.type === source.type);
          const actualWidth = Number(afterSource?.width);
          const actualHeight = Number(afterSource?.height);
          if (!Number.isFinite(actualWidth) || !Number.isFinite(actualHeight)
            || Math.abs(actualWidth - input.width) > 0.01 || Math.abs(actualHeight - input.height) > 0.01) {
            throw uncertain('Canvas 未能确认节点新尺寸；请读取当前画布状态，不要自动重提');
          }
          return { result: { operation, sourceNodeId: nodeId, displaySize: { width: afterSource.width, height: afterSource.height } }, attachments: [] };
        }

        const expectedImageCount = operation === 'split' ? input.rows * input.columns : 1;
        const expectedSources = operation === 'stitch' || operation === 'compose' ? uniqueSourceNodeIds : null;
        if (!bridgeResult || bridgeResult.operation !== operation || bridgeResult.sourceNodeId !== nodeId
          || (expectedSources && (!Array.isArray(bridgeResult.sourceNodeIds)
            || bridgeResult.sourceNodeIds.length !== expectedSources.length
            || bridgeResult.sourceNodeIds.some((id, index) => id !== expectedSources[index])))
          || !Array.isArray(bridgeResult.images) || bridgeResult.images.length !== expectedImageCount
          || bridgeResult.images.some((image) => typeof image?.nodeId !== 'string' || uniqueSourceNodeIds.includes(image.nodeId))
          || new Set(bridgeResult.images.map((image) => image.nodeId)).size !== bridgeResult.images.length) {
          throw uncertain('Canvas 未返回可核验的机械图片节点；请读取当前画布状态，不要自动重提');
        }
        const attachments = [];
        const resultImages = [];
        for (const [index, returned] of bridgeResult.images.entries()) {
          const actual = await readOutput(returned, after);
          if (expectedOutputSize && (actual.width !== expectedOutputSize.width || actual.height !== expectedOutputSize.height)) {
            throw uncertain('Canvas 合成结果尺寸与按原始像素计算的尺寸不一致；请读取状态，不要自动重提');
          }
          if (operation === 'stitch' || operation === 'compose') validatePixelBudget(actual.width, actual.height);
          const fileUrl = `/api/tasks/${encodeURIComponent(taskId)}/canvas-operations/${encodeURIComponent(payload.operationId)}/images/${index}`;
          const saved = await writeMechanicalImage(imagesDirectory, index, {
            ...actual,
            operation,
            nodeId: returned.nodeId,
            fileUrl,
            downloadUrl: `${fileUrl}?download=1`,
          });
          attachments.push(saved);
          resultImages.push({ nodeId: saved.nodeId, width: saved.width, height: saved.height, sha256: saved.sha256, name: saved.name, fileUrl: saved.fileUrl, downloadUrl: saved.downloadUrl });
        }
        const result = operation === 'stitch' || operation === 'compose'
          ? { operation, sourceNodeId: nodeId, sourceNodeIds: uniqueSourceNodeIds, images: resultImages }
          : { operation, sourceNodeId: nodeId, images: resultImages };
        return { result, attachments };
      },
    });
  }

  async function mechanicalImage(taskId, operationId, index) {
    return readCanvasOperationImage(taskId, operationId, index, { root: dataRoot });
  }

  async function sync(taskId, payload = {}) {
    const expectedRevision = requiredRevision(payload);
    const version = payload.version;
    const task = await requireTask(taskId);
    if (task.revision !== expectedRevision) {
      const error = canvasError('ERR_TASK_REVISION_CONFLICT', '任务状态已变化，请刷新后重试');
      error.expectedRevision = expectedRevision; error.actualRevision = task.revision; throw error;
    }
    assertTaskVersion(task, version);
    const instance = await loadInstance(taskId);
    if (!instance) throw canvasError('ERR_CANVAS_DISCONNECTED', 'Canvas 尚未启动，请先打开该任务画布');
    const { config, snapshot } = await liveSnapshot(taskId, instance);
    if (!Array.isArray(payload.selections)) {
      return {
        projectId: taskId, clientConnected: true, revision: task.revision, version, task,
        candidates: await snapshotCandidates(task, snapshot, config, version),
      };
    }
    const candidates = candidateOutputs(task, snapshot, version);
    if (!payload.selections.length) throw canvasError('ERR_CANVAS_SELECTION_REQUIRED', '至少选择一张当前任务的 Canvas 图片');
    const chosen = new Map();
    for (const value of payload.selections) {
      if (!value || !Number.isInteger(value.page) || typeof value.nodeId !== 'string') throw canvasError('ERR_CANVAS_SELECTION_INVALID', 'Canvas 图片选择无效');
      if (chosen.has(value.page)) throw canvasError('ERR_CANVAS_SELECTION_INVALID', '同一页只能选择一张 Canvas 图片');
      if (!candidates.some((candidate) => candidate.page === value.page && candidate.nodeId === value.nodeId)) {
        throw canvasError('ERR_CANVAS_SELECTION_INVALID', '所选图片不是当前任务生成节点的连接结果');
      }
      chosen.set(value.page, value.nodeId);
    }
    let revision = expectedRevision;
    for (const [page, nodeId] of chosen) {
      const updated = await selectImage(taskId, { version, page, nodeId, expectedRevision: revision, root: dataRoot, config });
      revision = updated.revision;
    }
    const latest = await readTask(taskId, dataRoot);
    const refreshed = await callCanvasTool('canvas_get_state', {}, config);
    let existing;
    try { existing = await readJson(selectionEvidencePath(dataRoot, taskId)); } catch {}
    const evidence = existing?.projectId === taskId && existing?.version === version && existing?.pages && typeof existing.pages === 'object'
      ? { ...existing, pages: { ...existing.pages } }
      : { projectId: taskId, version, pages: {} };
    const currentCandidates = candidateOutputs(latest, refreshed, version);
    for (const [page, nodeId] of chosen) {
      const record = latest.execution.pages.find((item) => item.page === page);
      const candidateNodeIds = currentCandidates.filter((item) => item.page === page).map((item) => item.nodeId).sort();
      if (!record || !candidateNodeIds.includes(nodeId)) throw canvasError('ERR_CANVAS_SYNC_REQUIRED', `第 ${page} 页 Canvas 候选图已变化，请刷新后重新选图`);
      const actual = await readImageBytes(nodeId, config);
      if (actual.sha256 !== record.image?.sha256) throw canvasError('ERR_CANVAS_IMAGE_CHANGED', `第 ${page} 页 Canvas 图片在同步时已改变，请重新同步`);
      evidence.pages[page] = { selectedNodeId: nodeId, candidateNodeIds, sha256: actual.sha256 };
    }
    await writeSelectionEvidence(dataRoot, taskId, evidence);
    return {
      projectId: taskId, clientConnected: true, revision: latest.revision, version,
      task: latest,
      candidates: await snapshotCandidates(latest, refreshed, config, version),
    };
  }

  async function candidateImage(taskId, { version, page, nodeId } = {}) {
    const task = await requireTask(taskId);
    assertTaskVersion(task, version);
    const instance = await loadInstance(taskId);
    if (!instance) throw canvasError('ERR_CANVAS_DISCONNECTED', 'Canvas 尚未启动，请先打开该任务画布');
    const { config, snapshot } = await liveSnapshot(taskId, instance);
    const candidate = candidateOutputs(task, snapshot, version).find((item) => item.page === page && item.nodeId === nodeId);
    if (!candidate) throw canvasError('ERR_CANVAS_IMAGE_NOT_FOUND', '所选图片已不存在或不属于当前任务');
    return readImageBytes(nodeId, config);
  }

  async function assertFresh(taskId, { expectedRevision, version, images } = {}) {
    requiredRevision({ expectedRevision });
    const task = await requireTask(taskId);
    if (task.revision !== expectedRevision) {
      const error = canvasError('ERR_TASK_REVISION_CONFLICT', '任务状态已变化，请刷新后重试');
      error.expectedRevision = expectedRevision; error.actualRevision = task.revision; throw error;
    }
    assertTaskVersion(task, version);
    const records = new Map((task.execution.pages || []).map((page) => [page.page, page]));
    const checks = images == null
      ? [...records.values()].filter((page) => page.status === 'succeeded').map((page) => ({ page: page.page, sha256: page.image?.sha256 }))
      : images;
    if (!Array.isArray(checks) || checks.length === 0) throw canvasError('ERR_CANVAS_FRESHNESS_INPUT', '必须指定需要核验的 Canvas 成品');
    for (const image of checks) {
      if (!image || !Number.isInteger(image.page) || typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(image.sha256)) {
        throw canvasError('ERR_CANVAS_FRESHNESS_INPUT', '成品哈希或页码无效');
      }
      const record = records.get(image.page);
      if (!record || record.status !== 'succeeded' || !record.image || record.imageNodeId == null) {
        throw canvasError('ERR_CANVAS_IMAGE_NOT_FOUND', `第 ${image.page} 页尚无可核验的 Canvas 成品`);
      }
      if (record.image.sha256 !== image.sha256.toLowerCase()) throw canvasError('ERR_CANVAS_IMAGE_CHANGED', `第 ${image.page} 页当前成品与提交哈希不一致，请重新同步并复审`);
      const taskDir = path.resolve(taskDirectory(taskId, dataRoot));
      const imagePath = path.resolve(record.image.path);
      if (!imagePath.startsWith(`${taskDir}${path.sep}`)) throw canvasError('ERR_CANVAS_IMAGE_PATH', '任务成品路径无效');
      let fileBytes;
      try { fileBytes = await fs.readFile(imagePath); } catch (error) { throw canvasError('ERR_CANVAS_IMAGE_CHANGED', `第 ${image.page} 页本地成品不可读取，请重新同步`, error); }
      if (sha256(fileBytes) !== record.image.sha256) throw canvasError('ERR_CANVAS_IMAGE_CHANGED', `第 ${image.page} 页本地成品已改变，请重新同步并复审`);
    }
    const instance = await loadInstance(taskId);
    if (!instance) throw canvasError('ERR_CANVAS_DISCONNECTED', 'Canvas 已关闭或未启动；不能确认当前选图是否仍与已审核成品一致');
    const { config, snapshot } = await liveSnapshot(taskId, instance);
    const liveCandidates = candidateOutputs(task, snapshot, version);
    let evidence;
    try { evidence = await readJson(selectionEvidencePath(dataRoot, taskId)); }
    catch (error) { throw canvasError('ERR_CANVAS_EVIDENCE_INVALID', 'Canvas 选图记录无法读取，请重新同步并选图', error); }
    if (evidence && (evidence.projectId !== taskId || evidence.version !== version || !evidence.pages || typeof evidence.pages !== 'object')) {
      evidence = null;
    }
    for (const image of checks) {
      const record = records.get(image.page);
      const candidateNodeIds = liveCandidates.filter((candidate) => candidate.page === image.page).map((candidate) => candidate.nodeId).sort();
      const selection = evidence?.pages?.[image.page];
      if (selection) {
        const savedIds = Array.isArray(selection.candidateNodeIds) ? [...selection.candidateNodeIds].sort() : [];
        if (selection.selectedNodeId !== record.imageNodeId || selection.sha256 !== record.image.sha256
          || savedIds.length !== candidateNodeIds.length || savedIds.some((id, index) => id !== candidateNodeIds[index])) {
          throw canvasError('ERR_CANVAS_SYNC_REQUIRED', `第 ${image.page} 页 Canvas 候选图集合已变化，请同步并重新选图`);
        }
      } else if (candidateNodeIds.length !== 1 || candidateNodeIds[0] !== record.imageNodeId) {
        throw canvasError('ERR_CANVAS_SYNC_REQUIRED', `第 ${image.page} 页有多个或已变化的 Canvas 候选图，请同步并明确选图`);
      }
      const actual = await readImageBytes(record.imageNodeId, config);
      if (actual.sha256 !== record.image.sha256) throw canvasError('ERR_CANVAS_IMAGE_CHANGED', `第 ${image.page} 页 Canvas 图片已改变，请重新同步并复审`);
    }
    return { ok: true, projectId: taskId, version, revision: task.revision, images: checks.map((image) => ({ page: image.page, sha256: image.sha256.toLowerCase() })) };
  }

  async function executionOptions(taskId, { target } = {}) {
    const task = await requireTask(taskId);
    const instance = await startSupervisor(taskId);
    const config = await resolveTarget(taskId, instance, target?.clientId || task.execution?.target?.clientId);
    const pinned = { ...config };
    const assertPinned = (candidate) => {
      if (candidate?.projectId !== taskId || candidate?.instanceId !== instance.config.instanceId || candidate?.clientId !== pinned.clientId) {
        throw canvasError('ERR_CANVAS_TARGET_CHANGED', 'Canvas 执行目标已变化；请读取任务状态后显式恢复');
      }
    };
    return {
      config: pinned,
      getHealth: async (candidate, options) => {
        assertPinned(candidate);
        return health(pinned, options);
      },
      tool: async (name, input, candidate, options) => {
        assertPinned(candidate);
        return callCanvasTool(name, input, pinned, options);
      },
      recover: async (nodeId, destination, candidate, options) => {
        assertPinned(candidate);
        const task = await requireTask(taskId);
        const snapshot = await callCanvasTool('canvas_get_state', {}, pinned, options);
        const allowed = candidateOutputs(task, snapshot, task.execution.version).some((image) => image.nodeId === nodeId);
        if (!allowed) throw canvasError('ERR_CANVAS_IMAGE_NOT_FOUND', '回收目标不是当前任务生成节点的图片结果');
        return recoverImage(nodeId, destination, pinned, options);
      },
    };
  }

  async function checkImageConfig() {
    const image = await configFor();
    return { configured: Boolean(image), provider: 'openai-compatible', model: image?.model || null, connectionTested: false };
  }

  async function stopOne(taskId, item) {
    try {
      await fetch(`${item.config.webUrl}/__studio/stop`, { method: 'POST', headers: { 'x-studio-token': item.config.token }, signal: AbortSignal.timeout(1500) });
    } catch {}
    if (item.child && item.child.exitCode == null) {
      await Promise.race([
        new Promise((resolve) => item.child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (item.child.exitCode == null) item.child.kill('SIGTERM');
    }
    instances.delete(taskId);
  }

  async function stop() {
    stopped = true;
    await Promise.allSettled([...starting.values()]);
    const active = await activeInstances();
    await Promise.all(active.map((item) => stopOne(item.config.projectId, item)));
  }

  return {
    ensure,
    state,
    sync,
    candidateImage,
    assertFresh,
    agentState,
    agentImage,
    agentRegions,
    mechanicalOperation,
    mechanicalImage,
    executionOptions,
    checkImageConfig,
    syncImageConfig,
    stop,
  };
}
