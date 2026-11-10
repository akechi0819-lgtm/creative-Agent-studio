import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertNoCredentials, requiredRevision, taskDirectory, withTask, readTask } from './tasks.mjs';

const SHA256 = /^[0-9a-f]{64}$/i;
const HUMAN_ACTOR = /^(?:(?:codex|dsh)(?:[\s_-]+(?:agent|assistant|bot))?|(?:ai|agent|assistant|model)(?:[\s_-]+(?:agent|assistant|bot|model))?|(?:ai|agent|assistant|model)(?:模型|机器人|智能体)|模型|自动|机器人|智能体)$/iu;
const VIDEO_MODEL = 'studio-video::minimax_h3';
const VIDEO_RATIOS = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
const VIDEO_RESOLUTIONS = new Set(['768', '1080p', '2K', '4K']);
const now = () => new Date().toISOString();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function requiredText(value, label, maxLength = 20000) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
  const result = value.trim();
  if (result.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return result;
}

function humanActor(value, label) {
  const actor = requiredText(value, label, 300);
  assertNoCredentials(actor, label);
  if (HUMAN_ACTOR.test(actor)) throw new Error(`${label}必须记录实际人工姓名或身份`);
  return actor;
}

function note(value, label) {
  const result = requiredText(value, label, 10000);
  assertNoCredentials(result, label);
  return result;
}

function sha256(value, label = '视频 SHA-256') {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label}无效`);
  return value.toLowerCase();
}

function videoState(task, create = false) {
  if (!task.video && create) {
    task.video = {
      version: 0,
      plans: [],
      execution: null,
      executionHistory: [],
      reviews: [],
      approval: null,
      exports: [],
    };
  }
  if (!task.video) return null;
  return task.video;
}

function currentPlan(video) {
  return video?.plans?.find(plan => plan.version === video.version) || null;
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  const keys = Object.keys(value);
  const referenceKey = keys.find(key => /^(?:reference(?:s|[_-]images?|[_-]videos?|[_-]audios?)?|refs?|images?|videos?|audios?|image[_-]?url|video[_-]?url|audio[_-]?url|media[_-]?inputs?)$/i.test(key));
  if (referenceKey) throw new Error('当前 Studio 尚未接入公网参考素材 URL，本地文件不能直接传给此渠道');
  const unknown = keys.find(key => !allowed.has(key));
  if (unknown) throw new Error(`${label}含不支持字段：${unknown}`);
}

function normalizePlan(value) {
  exactKeys(value, new Set(['prompt', 'seconds', 'ratio', 'resolution']), '视频方案');
  const prompt = requiredText(value.prompt, '视频提示词');
  const seconds = value.seconds ?? 4;
  if (!Number.isInteger(seconds) || seconds < 4 || seconds > 15) throw new Error('视频时长必须是 4 到 15 秒的整数');
  const ratio = value.ratio ?? '16:9';
  if (typeof ratio !== 'string' || !VIDEO_RATIOS.has(ratio)) throw new Error('视频比例无效');
  const resolution = value.resolution ?? '768';
  if (typeof resolution !== 'string' || !VIDEO_RESOLUTIONS.has(resolution)) throw new Error('视频分辨率必须是 768、1080p、2K 或 4K');
  const plan = { prompt, seconds, ratio, resolution };
  assertNoCredentials(plan, '视频方案');
  return plan;
}

function normalizeProvider(model, providerFingerprint) {
  if (model !== VIDEO_MODEL) throw new Error(`当前视频核心仅支持 ${VIDEO_MODEL}`);
  if (typeof providerFingerprint !== 'string' || !SHA256.test(providerFingerprint)) throw new Error('视频渠道指纹无效');
  return { model, providerFingerprint: providerFingerprint.toLowerCase() };
}

function archiveCurrentExecution(video) {
  const execution = video.execution;
  if (execution && execution.version === video.version) video.executionHistory.push(structuredClone(execution));
}

function currentExecution(video) {
  const execution = video?.execution;
  if (!execution || execution.version !== video.version) throw new Error('当前视频方案缺少对应执行记录');
  return execution;
}

function isMp4(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 12 && bytes.readUInt32BE(0) >= 8 && bytes.toString('ascii', 4, 8) === 'ftyp';
}

function resolveVideoPath(taskId, relativePath, root) {
  if (typeof relativePath !== 'string' || !relativePath.startsWith('videos/')
    || relativePath.includes('\\') || path.isAbsolute(relativePath)) throw new Error('视频文件路径记录无效');
  const directory = taskDirectory(taskId, root);
  const file = path.resolve(directory, relativePath);
  const relative = path.relative(directory, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('视频文件路径越出任务目录');
  }
  return { directory, file };
}

async function readVerifiedOutput(taskId, execution, root) {
  if (execution?.status !== 'succeeded' || !execution.output) throw new Error('当前版本没有成功的视频成品');
  const { directory, file } = resolveVideoPath(taskId, execution.output.relativePath, root);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('视频成品必须是任务目录内的普通文件');
  const [realDirectory, realFile] = await Promise.all([fs.realpath(directory), fs.realpath(file)]);
  const relative = path.relative(realDirectory, realFile);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('视频成品真实路径越出任务目录');
  }
  const bytes = await fs.readFile(realFile);
  const actualSha = digest(bytes);
  if (actualSha !== execution.output.sha256) throw new Error('视频成品 SHA-256 已变化，需重新生成并复审');
  if (!isMp4(bytes) || execution.output.mimeType !== 'video/mp4') throw new Error('视频成品不是有效的 MP4 文件');
  if (execution.output.size !== bytes.length) throw new Error('视频成品大小记录与文件不一致');
  if (!Number.isInteger(execution.output.width) || execution.output.width < 1
    || !Number.isInteger(execution.output.height) || execution.output.height < 1
    || !Number.isFinite(execution.output.durationMs) || execution.output.durationMs <= 0) {
    throw new Error('视频成品缺少有效的尺寸或时长元数据');
  }
  return { path: realFile, bytes, sha256: actualSha, output: execution.output };
}

function validateTarget(config, providerFingerprint, plan) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('视频 Canvas 连接配置缺失');
  if (config.model !== plan.model || config.providerFingerprint !== plan.providerFingerprint
    || providerFingerprint !== plan.providerFingerprint) {
    throw new Error('视频渠道或模型与已确认方案不一致；请创建新方案并重新确认');
  }
  for (const key of ['projectId', 'instanceId', 'clientId']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error(`视频 Canvas ${key} 缺失`);
  }
  return { projectId: config.projectId, instanceId: config.instanceId, clientId: config.clientId };
}

function sameTarget(left, right) {
  return left && right && left.projectId === right.projectId
    && left.instanceId === right.instanceId && left.clientId === right.clientId;
}

function edgeList(state) {
  if (!Array.isArray(state?.nodes)) throw new Error('Canvas 状态缺少节点列表');
  const edges = Array.isArray(state.connections) && state.connections.length
    ? state.connections
    : Array.isArray(state.edges) ? state.edges : Array.isArray(state.connections) ? state.connections : null;
  if (!edges) throw new Error('Canvas 状态缺少连接列表');
  return edges;
}

function relatedVideoNodes(state, configNodeId) {
  const edges = edgeList(state);
  const childIds = new Set(edges.filter(edge => edge.fromNodeId === configNodeId).map(edge => edge.toNodeId));
  return state.nodes.filter(node => childIds.has(node.id) && node.type === 'video');
}

function validateVideoNodes(state, plan, execution, { requireChild = false } = {}) {
  const edges = edgeList(state);
  const textNode = state.nodes.find(node => node.id === execution.textNodeId);
  const configNode = state.nodes.find(node => node.id === execution.configNodeId);
  if (!textNode || textNode.type !== 'text' || textNode.metadata?.content !== plan.prompt) throw new Error('Canvas 视频文案节点与已确认方案不一致');
  if (!configNode || configNode.type !== 'config') throw new Error('Canvas 视频生成节点不存在或类型已改变');
  const expected = {
    generationMode: 'video',
    model: plan.model,
    composerContent: `@[node:${execution.textNodeId}]`,
    prompt: `@[node:${execution.textNodeId}]`,
    size: plan.ratio,
    seconds: String(plan.seconds),
    vquality: plan.resolution,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (configNode.metadata?.[key] !== value) throw new Error('Canvas 视频配置节点与已确认方案不一致');
  }
  const incoming = edges.filter(edge => edge.toNodeId === execution.configNodeId);
  if (incoming.length !== 1 || incoming[0].fromNodeId !== execution.textNodeId) {
    throw new Error('Canvas 视频节点存在未授权的参考或输入连接');
  }
  const children = relatedVideoNodes(state, execution.configNodeId);
  if (requireChild && children.length !== 1) throw new Error('Canvas 视频输出节点缺失或不唯一');
  return { configNode, children };
}

function nextCanvasX(nodes, gap = 160) {
  const rightmost = nodes.reduce((right, node) => {
    const x = Number.isFinite(node.position?.x) ? node.position.x : 0;
    const width = Number.isFinite(node.width) && node.width > 0 ? node.width : 340;
    return Math.max(right, x + width);
  }, 0);
  return rightmost + gap;
}

async function ensureVideoNodes(plan, execution, tool, config, signal) {
  let state = await tool('canvas_get_state', {}, config, { signal });
  edgeList(state);
  const textX = nextCanvasX(state.nodes);
  const configX = textX + 420;
  const textNode = state.nodes.find(node => node.id === execution.textNodeId);
  const configNode = state.nodes.find(node => node.id === execution.configNodeId);
  const operations = [];
  if (textNode && (textNode.type !== 'text' || textNode.metadata?.content !== plan.prompt)) {
    throw new Error('Canvas 文本节点 ID 冲突');
  }
  const configMetadata = {
    generationMode: 'video',
    model: plan.model,
    composerContent: `@[node:${execution.textNodeId}]`,
    prompt: `@[node:${execution.textNodeId}]`,
    status: 'idle',
    size: plan.ratio,
    seconds: String(plan.seconds),
    vquality: plan.resolution,
  };
  if (configNode) {
    if (configNode.type !== 'config') throw new Error('Canvas 生成节点 ID 冲突');
    for (const [key, value] of Object.entries(configMetadata)) {
      if (configNode.metadata?.[key] !== value) throw new Error('Canvas 配置节点与视频方案不一致');
    }
  }
  if (!textNode) operations.push({
    type: 'add_node', id: execution.textNodeId, nodeType: 'text', title: `视频方案 v${plan.version}`,
    position: { x: textX, y: 0 }, metadata: { content: plan.prompt, status: 'success' },
  });
  if (!configNode) operations.push({
    type: 'add_node', id: execution.configNodeId, nodeType: 'config', title: `视频生成 v${plan.version}`,
    position: { x: configX, y: 0 }, metadata: configMetadata,
  });
  const stateEdges = edgeList(state);
  if (!stateEdges.some(edge => edge.fromNodeId === execution.textNodeId && edge.toNodeId === execution.configNodeId)) {
    operations.push({ type: 'connect_nodes', fromNodeId: execution.textNodeId, toNodeId: execution.configNodeId });
  }
  if (operations.length) await tool('canvas_apply_ops', { ops: operations }, config, { signal });
  state = await tool('canvas_get_state', {}, config, { signal });
  validateVideoNodes(state, plan, execution);
  if (relatedVideoNodes(state, execution.configNodeId).length) {
    throw new Error('固定视频节点已存在生成结果，但任务没有提交意图；停止以避免重复收费');
  }
  return state;
}

export async function writeVideoPlan(id, requestedPlan, { root, expectedRevision, model, providerFingerprint } = {}) {
  requiredRevision({ expectedRevision });
  const plan = normalizePlan(requestedPlan);
  const provider = normalizeProvider(model, providerFingerprint);
  return withTask(id, task => {
    const video = videoState(task, true);
    if (video.execution?.submitted && !['succeeded', 'failed'].includes(video.execution.status)) {
      throw new Error('上一视频请求仍未确认结果；请恢复查询原节点后再创建新方案');
    }
    archiveCurrentExecution(video);
    const version = video.version + 1;
    const createdAt = now();
    video.version = version;
    video.plans.push({
      version,
      ...plan,
      ...provider,
      textNodeId: `video-text-${randomUUID()}`,
      configNodeId: `video-config-${randomUUID()}`,
      confirmedBy: null,
      confirmationNote: null,
      confirmedAt: null,
      createdAt,
    });
    video.execution = {
      version,
      status: 'pending',
      textNodeId: video.plans.at(-1).textNodeId,
      configNodeId: video.plans.at(-1).configNodeId,
      submitted: false,
      target: null,
      providerFingerprint: provider.providerFingerprint,
      model: provider.model,
      createdAt,
    };
    video.reviews = [];
    video.approval = null;
  }, { root, expectedRevision });
}

export async function confirmVideoPlan(id, { version, by, note: suppliedNote } = {}, opts = {}) {
  const expectedRevision = requiredRevision(opts);
  if (!Number.isInteger(version) || version < 1) throw new Error('确认视频方案必须指定正整数 version');
  const confirmer = humanActor(by, '确认人');
  const confirmationNote = note(suppliedNote, '视频方案确认说明');
  return withTask(id, task => {
    const video = videoState(task);
    const plan = currentPlan(video);
    if (!plan || version !== video.version) throw new Error('只能确认当前视频方案版本');
    if (plan.confirmedAt) throw new Error('当前视频方案已确认；如需修改，请新建方案版本');
    plan.confirmedBy = confirmer;
    plan.confirmationNote = confirmationNote;
    plan.confirmedAt = now();
  }, { ...opts, expectedRevision });
}

function assertExecutionDependencies({ config, providerFingerprint, getHealth, tool, recover }, plan, execution) {
  if (typeof getHealth !== 'function' || typeof tool !== 'function' || typeof recover !== 'function') {
    throw new Error('视频执行必须使用 Canvas manager 的 videoExecutionOptions');
  }
  const target = validateTarget(config, providerFingerprint, plan);
  if (execution.target && !sameTarget(execution.target, target)) throw new Error('恢复目标与原视频 Canvas 不一致；拒绝跨目标查询');
  return target;
}

async function verifyCanvasHealth(getHealth, config, target, signal) {
  signal?.throwIfAborted();
  const status = await getHealth(config, { signal });
  if (status?.instanceId !== target.instanceId) throw new Error('Canvas 实例身份变化，停止视频任务');
  const currentTarget = status.targets?.find(item => item.hasCanvas && item.projectId === target.projectId && item.clientId === target.clientId);
  if (!currentTarget) throw new Error('原视频 Canvas 目标未连接；状态未确认');
}

async function persistSafeError(execution, save, { uncertain, message }) {
  execution.status = uncertain ? 'uncertain' : 'pending';
  execution.error = message;
  await save();
}

export async function executeVideoTask(id, {
  version, expectedRevision, root, signal, pollMs = 1500, timeoutMs = 600000,
  ...managerOptions
} = {}) {
  requiredRevision({ expectedRevision });
  if (!Number.isInteger(version) || version < 1) throw new Error('视频执行必须指定已确认方案 version');
  if (!Number.isInteger(pollMs) || pollMs < 0 || !Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('视频状态轮询参数无效');
  return withTask(id, async (task, save) => {
    const video = videoState(task);
    const plan = currentPlan(video);
    if (!plan || plan.version !== version || video.version !== version) throw new Error('视频执行版本与当前方案不一致');
    if (!plan.confirmedAt) throw new Error('视频方案尚未获得人工确认');
    const execution = currentExecution(video);
    if (execution.status === 'succeeded') {
      await readVerifiedOutput(id, execution, root);
      return task;
    }
    if (execution.status === 'failed') throw new Error('本视频方案已明确失败；重试需新建方案并重新确认');
    const target = assertExecutionDependencies(managerOptions, plan, execution);
    const { config, providerFingerprint, getHealth, tool, recover } = managerOptions;
    let submitted = Boolean(execution.submissionIntentAt);
    let savedFailure = false;
    try {
      await verifyCanvasHealth(getHealth, config, target, signal);
      execution.target ||= target;
      execution.providerFingerprint = providerFingerprint;
      execution.status = submitted ? 'running' : 'preparing';
      execution.error = null;
      await save();

      const state = submitted
        ? await tool('canvas_get_state', {}, config, { signal })
        : await ensureVideoNodes(plan, execution, tool, config, signal);
      if (submitted) validateVideoNodes(state, plan, execution);

      if (!submitted) {
        execution.status = 'prepared';
        await save();
        signal?.throwIfAborted();
        execution.submissionIntentAt = now();
        execution.submitted = true;
        execution.status = 'submitting';
        await save();
        submitted = true;
        await tool('canvas_apply_ops', { ops: [{ type: 'run_generation', nodeId: execution.configNodeId, mode: 'video' }] }, config, { signal });
        execution.status = 'running';
        await save();
      }

      const deadline = Date.now() + timeoutMs;
      while (true) {
        signal?.throwIfAborted();
        const snapshot = await tool('canvas_get_state', {}, config, { signal });
        validateVideoNodes(snapshot, plan, execution);
        const children = relatedVideoNodes(snapshot, execution.configNodeId);
        if (children.length > 1) {
          execution.status = 'uncertain';
          execution.error = 'Canvas 存在多个关联视频结果，停止恢复以避免误选。';
          await save();
          throw new Error(execution.error);
        }
        const child = children[0];
        if (child) {
          const taskId = child.metadata?.videoTaskId;
          if (taskId != null && (typeof taskId !== 'string' || !taskId.trim())) {
            execution.status = 'uncertain';
            execution.error = 'Canvas 视频任务标识无效，停止自动恢复。';
            await save();
            throw new Error(execution.error);
          }
          if (typeof taskId === 'string' && taskId) {
            if (execution.videoTaskId && execution.videoTaskId !== taskId) {
              execution.status = 'uncertain';
              execution.error = 'Canvas 原视频任务标识变化，停止自动恢复。';
              await save();
              throw new Error(execution.error);
            }
            if (!execution.videoTaskId) {
              execution.videoTaskId = taskId;
              await save();
            }
          }
          const status = child.metadata?.status;
          if (status === 'error') {
            execution.status = 'failed';
            execution.error = '视频生成明确失败；如需重试，请新建方案版本并重新确认。';
            await save();
            savedFailure = true;
            throw new Error(execution.error);
          }
          const hasPlayableMedia = Boolean(child.metadata?.content && child.metadata?.storageKey);
          if (status === 'success' || (status === 'loading' && hasPlayableMedia)) {
            if (typeof taskId !== 'string' || !taskId || typeof child.metadata?.storageKey !== 'string' || !child.metadata.storageKey) {
              execution.status = 'uncertain';
              execution.error = 'Canvas 视频节点已成功但缺少可核验的任务 ID 或媒体文件，停止恢复。';
              await save();
              throw new Error(execution.error);
            }
            const destinationRelativePath = `videos/v${version}/video.mp4`;
            const { file: destination } = resolveVideoPath(id, destinationRelativePath, root);
            await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
            await fs.chmod(path.dirname(destination), 0o700);
            const recovered = await recover(child.id, destination, config, { signal });
            const bytes = await fs.readFile(destination);
            const actualSha = digest(bytes);
            if (recovered?.path !== destination || recovered.nodeId !== child.id || recovered.mimeType !== 'video/mp4'
              || recovered.bytes !== bytes.length
              || !isMp4(bytes) || recovered.sha256?.toLowerCase() !== actualSha
              || !Number.isInteger(recovered.width) || recovered.width < 1
              || !Number.isInteger(recovered.height) || recovered.height < 1
              || !Number.isFinite(recovered.durationMs) || recovered.durationMs <= 0) {
              throw new Error('Canvas 回收的视频文件或元数据无法核验');
            }
            execution.output = {
              relativePath: destinationRelativePath,
              sha256: actualSha,
              mimeType: recovered.mimeType,
              size: bytes.length,
              width: recovered.width,
              height: recovered.height,
              durationMs: recovered.durationMs,
              nodeId: child.id,
              videoTaskId: taskId,
              storageKey: child.metadata.storageKey,
            };
            execution.status = 'succeeded';
            execution.completedAt = now();
            execution.error = null;
            video.reviews = [];
            video.approval = null;
            await save();
            return task;
          }
        }
        const configNode = snapshot.nodes.find(node => node.id === execution.configNodeId);
        if (configNode?.metadata?.status === 'error') {
          execution.status = 'failed';
          execution.error = 'Canvas 视频生成明确失败；如需重试，请新建方案版本并重新确认。';
          await save();
          savedFailure = true;
          throw new Error(execution.error);
        }
        if (Date.now() >= deadline) {
          execution.status = 'uncertain';
          execution.error = '等待视频超时；已提交请求保留原节点，恢复时只查询状态。';
          await save();
          throw new Error(execution.error);
        }
        await delay(pollMs, undefined, { signal });
      }
    } catch (error) {
      if (!savedFailure && execution.status !== 'uncertain' && execution.status !== 'succeeded') {
        const uncertain = submitted || Boolean(execution.submissionIntentAt);
        await persistSafeError(execution, save, {
          uncertain,
          message: uncertain
            ? '视频提交结果未能确认；保留原节点，恢复时只查询状态。'
            : '视频提交前检查未完成；当前方案尚未提交生成。',
        });
      }
      if (error?.message === execution.error) throw error;
      throw new Error(execution.error || '视频执行未完成', { cause: error });
    }
  }, { root, expectedRevision });
}

export async function recordVideoReview(id, { sha256: suppliedSha, decision, reviewer, notes } = {}, opts = {}) {
  const expectedRevision = requiredRevision(opts);
  if (!['pass', 'revise'].includes(decision)) throw new Error('视频复审结论必须是 pass 或 revise');
  const reviewerName = humanActor(reviewer, '实际视频复审者');
  const reviewNotes = note(notes, '视频复审记录');
  const suppliedHash = sha256(suppliedSha);
  return withTask(id, async task => {
    const video = videoState(task);
    if (!video || video.execution?.version !== video.version) throw new Error('当前视频方案没有执行结果');
    const current = await readVerifiedOutput(id, currentExecution(video), opts.root);
    if (current.sha256 !== suppliedHash) throw new Error('视频复审 SHA-256 与当前成品不一致');
    video.reviews.push({
      version: video.version,
      sha256: suppliedHash,
      decision,
      reviewer: reviewerName,
      notes: reviewNotes,
      reviewedAt: now(),
    });
    video.approval = null;
  }, { ...opts, expectedRevision });
}

export async function approveVideo(id, { version, sha256: suppliedSha, by, note: suppliedNote } = {}, opts = {}) {
  const expectedRevision = requiredRevision(opts);
  if (!Number.isInteger(version) || version < 1) throw new Error('视频最终确认必须指定正整数 version');
  const confirmer = humanActor(by, '确认人');
  const approvalNote = note(suppliedNote, '视频最终确认说明');
  const suppliedHash = sha256(suppliedSha);
  return withTask(id, async task => {
    const video = videoState(task);
    if (!video || video.version !== version) throw new Error('只能确认当前视频方案版本');
    const execution = currentExecution(video);
    const current = await readVerifiedOutput(id, execution, opts.root);
    if (current.sha256 !== suppliedHash) throw new Error('视频最终确认 SHA-256 与当前成品不一致');
    const review = [...video.reviews].reverse().find(item => item.version === version && item.sha256 === suppliedHash);
    if (!review || review.decision !== 'pass') throw new Error('当前视频没有针对该 SHA-256 的 pass 人工复审');
    video.approval = {
      version,
      sha256: suppliedHash,
      by: confirmer,
      note: approvalNote,
      approvedAt: now(),
    };
  }, { ...opts, expectedRevision });
}

export async function exportVideoTask(id, opts = {}) {
  const expectedRevision = requiredRevision(opts);
  let exportRecord;
  const task = await withTask(id, async draft => {
    const video = videoState(draft);
    const execution = currentExecution(video);
    const approval = video.approval;
    if (!approval || approval.version !== video.version) throw new Error('当前视频方案尚未完成人工最终确认');
    const current = await readVerifiedOutput(id, execution, opts.root);
    if (approval.sha256 !== current.sha256) throw new Error('最终确认 SHA-256 与当前视频文件不一致');
    const review = [...video.reviews].reverse().find(item => item.version === video.version && item.sha256 === current.sha256);
    if (!review || review.decision !== 'pass') throw new Error('当前视频缺少针对现有文件哈希的 pass 复审');
    const plan = currentPlan(video);
    assertNoCredentials({ plan, review, approval }, '视频导出内容');
    const taskRoot = taskDirectory(id, opts.root);
    const exportParent = path.join(taskRoot, 'videos', 'exports');
    await fs.mkdir(exportParent, { recursive: true, mode: 0o700 });
    await fs.chmod(exportParent, 0o700);
    const sequence = (video.exports || []).reduce((maximum, item) => Math.max(maximum, item.sequence || 0), 0) + 1;
    const versionLabel = `export-${String(sequence).padStart(3, '0')}`;
    const destinationDirectory = path.join(exportParent, versionLabel);
    await fs.mkdir(destinationDirectory, { recursive: false, mode: 0o700 });
    const videoPath = path.join(destinationDirectory, 'video.mp4');
    const manifestPath = path.join(destinationDirectory, 'manifest.json');
    try {
      await fs.copyFile(current.path, videoPath, fsConstants.COPYFILE_EXCL);
      const exportedSha = digest(await fs.readFile(videoPath));
      if (exportedSha !== current.sha256) throw new Error('视频导出复制后 SHA-256 不一致');
      const manifest = {
        schemaVersion: 1,
        taskId: id,
        title: draft.title,
        exportVersion: versionLabel,
        videoVersion: video.version,
        generatedAt: now(),
        model: plan.model,
        providerFingerprint: plan.providerFingerprint,
        plan: {
          prompt: plan.prompt,
          seconds: plan.seconds,
          ratio: plan.ratio,
          resolution: plan.resolution,
        },
        output: {
          path: 'video.mp4',
          sha256: exportedSha,
          mimeType: current.output.mimeType,
          size: current.output.size,
          width: current.output.width,
          height: current.output.height,
          durationMs: current.output.durationMs,
        },
        review: structuredClone(review),
        approval: structuredClone(approval),
      };
      assertNoCredentials(manifest, '视频导出清单');
      const handle = await fs.open(manifestPath, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      exportRecord = {
        sequence,
        version: versionLabel,
        videoVersion: video.version,
        videoRelativePath: path.relative(taskRoot, videoPath).split(path.sep).join('/'),
        manifestRelativePath: path.relative(taskRoot, manifestPath).split(path.sep).join('/'),
        sha256: exportedSha,
        manifestSha256: digest(await fs.readFile(manifestPath)),
        generatedAt: manifest.generatedAt,
      };
      video.exports.push(exportRecord);
    } catch (error) {
      await fs.rm(destinationDirectory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }, { ...opts, expectedRevision });
  return { task, export: structuredClone(exportRecord) };
}

export async function readVideoOutput(id, { root } = {}) {
  const task = await readTask(id, root);
  const video = videoState(task);
  if (!video || video.execution?.version !== video.version) throw new Error('当前视频方案没有执行结果');
  const current = await readVerifiedOutput(id, currentExecution(video), root);
  return {
    path: current.path,
    bytes: current.bytes,
    sha256: current.sha256,
    mimeType: current.output.mimeType,
    width: current.output.width,
    height: current.output.height,
    durationMs: current.output.durationMs,
    size: current.bytes.length,
    version: video.version,
  };
}
