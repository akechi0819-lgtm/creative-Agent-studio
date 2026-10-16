import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStudioAgent } from '../adapters/dsh/runtime.mjs';
import { listenStudioServer } from '../src/web/server.mjs';
import { readDna } from '../src/dna/profile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const credentialPath = path.join(repo, '.p0-state', 'model-credentials.json');
const evidencePath = path.join(repo, 'docs', 'evidence', 'p3', 'live-dna.json');
const timeoutMs = 12 * 60 * 1000;
const verifiedAt = new Date();
const dnaContent = [
  '表达语气：简洁、清晰。',
  '视觉与品牌偏好：整组采用墨绿与暖白配色。',
  '常用内容要求：文字简短、清楚，适合手机阅读。',
  '必须出现的元素：与阅读主题相关的简洁视觉元素。',
  '避免出现的元素：不要二维码；避免细小字体。',
  '其他偏好：不要添加未经提供依据的事实。',
].join('\n');
const updatedDnaContent = [
  '表达语气：简洁。',
  '视觉与品牌偏好：采用群青与银灰配色。',
  '常用内容要求：清晰易读。',
  '必须出现的元素：与主题相关的视觉元素。',
  '避免出现的元素：不要使用墨绿色。',
  '其他偏好：不添加未经提供依据的事实。',
].join('\n');

if (!process.argv.includes('--live')) {
  console.log('仅执行真实 DSH 验证时运行：node --use-env-proxy scripts/verify-p3-live-dna.mjs --live');
  process.exit(process.argv.includes('--help') ? 0 : 2);
}

const report = {
  schemaVersion: 1,
  date: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(verifiedAt),
  verifiedAt: verifiedAt.toISOString(),
  scope: '临时数据根中的真实 DSH DNA 整理、快照、单页制作单与确认失效；不执行 Canvas 生图',
  status: 'running',
  runtime: 'adapters/dsh/runtime.mjs + src/web/server.mjs',
  credentialSource: '.p0-state/model-credentials.json (0600, in-memory only)',
  credentialCopiedToDisk: false,
  temporaryDataRootRemoved: false,
  imageGenerationRequests: 0,
  checks: [],
};

let phase = 'credential-preflight';
let temporaryRoot;
let server;
let baseUrl;
let activeJobId;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function request(endpoint, body, method = body === undefined ? 'GET' : 'POST') {
  let response;
  try {
    response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: { origin: baseUrl, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const failure = new Error('local-server-transport-failed');
    failure.code = error?.name === 'TimeoutError' ? 'ERR_LOCAL_REQUEST_TIMEOUT' : 'ERR_LOCAL_REQUEST';
    throw failure;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('studio-api-request-failed');
    error.code = payload?.error?.code || `ERR_HTTP_${response.status}`;
    throw error;
  }
  return payload;
}

async function waitForJob(jobId) {
  activeJobId = jobId;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { job } = await request(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (job.status === 'succeeded') {
      activeJobId = undefined;
      return job;
    }
    if (job.status === 'failed' || job.status === 'cancelled') {
      activeJobId = undefined;
      fail(`ERR_JOB_${String(job.status).toUpperCase()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  fail('ERR_JOB_TIMEOUT_NO_REPLAY');
}

async function startJob(endpoint, body) {
  const { job } = await request(endpoint, body);
  return waitForJob(job.id);
}

async function chat(task, text) {
  const job = await startJob(`/api/tasks/${encodeURIComponent(task.id)}/chat`, {
    requestId: crypto.randomUUID(),
    expectedRevision: task.revision,
    text,
  });
  if (typeof job.result?.text !== 'string' || !job.result.text.trim()) fail('ERR_DSH_EMPTY_REPLY');
  return { text: job.result.text, taskRevision: job.result.taskRevision };
}

async function readTask(taskId) {
  return (await request(`/api/tasks/${encodeURIComponent(taskId)}`)).task;
}

function promptChecks(prompt) {
  const text = String(prompt || '').toLowerCase();
  const green = /墨绿|深绿|墨绿色|dark green/.test(text);
  const warmWhite = /暖白|暖白色|warm white/.test(text);
  const qrAt = text.search(/二维码|qr code|qr-code/);
  const qrContext = qrAt < 0 ? '' : text.slice(Math.max(0, qrAt - 18), qrAt + 20);
  const noQr = qrAt >= 0 && /不要|禁止|避免|不使用|不得|不出现|no |without|exclude/.test(qrContext);
  const fineAt = text.search(/细小字体|细字|小字|小字号|tiny text|small text|fine print/);
  const fineContext = fineAt < 0 ? '' : text.slice(Math.max(0, fineAt - 18), fineAt + 24);
  const noFineText = fineAt >= 0 && /避免|不要|禁止|不得|不使用|不出现|no |without|avoid|exclude/.test(fineContext);
  return { green, warmWhite, noQr, noFineText };
}

try {
  const credentialStat = await fs.stat(credentialPath);
  if ((credentialStat.mode & 0o077) !== 0) fail('ERR_CREDENTIAL_FILE_PERMISSIONS');
  const savedCredentials = JSON.parse(await fs.readFile(credentialPath, 'utf8'));
  if (savedCredentials.model !== 'grok-4.7') fail('ERR_EXPECTED_GROK_47');
  if (typeof savedCredentials.baseUrl !== 'string' || typeof savedCredentials.apiKey !== 'string' || !savedCredentials.apiKey) {
    fail('ERR_CREDENTIAL_FIELDS');
  }
  const endpoint = new URL(savedCredentials.baseUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    fail('ERR_CREDENTIAL_ENDPOINT');
  }
  const configInMemory = {
    basic: { baseUrl: savedCredentials.baseUrl, model: savedCredentials.model, apiKey: savedCredentials.apiKey },
    image: { baseUrl: '', model: '', apiKey: '' },
  };
  report.requestedModel = configInMemory.basic.model;
  report.credentialFileModePrivate = true;
  delete savedCredentials.apiKey;

  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-p3-live-dna-'));
  await fs.chmod(temporaryRoot, 0o700);
  const readConfig = async () => structuredClone(configInMemory);
  const agent = createStudioAgent({ root: temporaryRoot, readConfig });
  server = await listenStudioServer({ root: temporaryRoot, agent, readConfig, port: 0 });
  baseUrl = `http://127.0.0.1:${server.address.port}`;

  phase = 'default-dna';
  const bootstrap = await request('/api/bootstrap');
  assert.equal(bootstrap.dna.enabled, false);
  assert.equal(bootstrap.dna.content, '');
  const initialDna = await readDna({ root: temporaryRoot });
  assert.deepEqual({ revision: initialDna.revision, enabled: initialDna.enabled, content: initialDna.content }, { revision: 1, enabled: false, content: '' });
  report.checks.push('default-dna-disabled-and-empty');

  phase = 'organize-draft-only';
  const organizeJob = await startJob('/api/dna/organize', {
    text: '品牌偏好是墨绿和暖白，不要二维码，避免细小字体；请整理成提示词草稿。',
  });
  const draft = organizeJob.result?.draft?.content;
  assert.equal(typeof draft, 'string');
  assert.ok(draft.trim().length > 0);
  const afterOrganize = await readDna({ root: temporaryRoot });
  assert.equal(afterOrganize.revision, 1);
  assert.equal(afterOrganize.enabled, false);
  assert.equal(afterOrganize.content, '');
  assert.equal(await exists(path.join(temporaryRoot, 'dna', 'profile.json')), false);
  report.organize = { status: 'succeeded', draftReturned: true, draftSha256: sha256(draft), profileUnchanged: true };
  report.checks.push('real-dsh-organize-returns-draft-without-saving');

  phase = 'explicit-dna-save';
  const savedProfile = (await request('/api/dna', {
    expectedRevision: afterOrganize.revision,
    enabled: true,
    content: dnaContent,
    by: '隔离验证执行人',
    note: '经明确授权的 P3 真实 DSH 验证，显式保存受控测试 DNA。',
  })).profile;
  assert.equal(savedProfile.enabled, true);
  assert.equal(savedProfile.content, dnaContent);
  report.dnaV1 = { revision: savedProfile.revision, enabled: true, contentSha256: sha256(dnaContent) };
  report.checks.push('explicit-human-save-enables-controlled-dna');

  phase = 'task-snapshot';
  let task = (await request('/api/tasks', {
    title: 'P3 隔离 DNA 与单页制作单验证',
    brief: {
      content: '为家长制作一页儿童阅读习惯科普海报，主题是每天阅读十分钟，文字简短，不引入未提供的统计或政策事实。',
      audience: '有学龄儿童的家长',
      goal: '介绍每天阅读十分钟的小习惯',
      style: '清晰、简洁、适合手机阅读',
      size: '3:4',
      pageCount: 1,
      format: 'poster',
    },
  })).task;
  const originalSnapshot = structuredClone(task.dna);
  assert.deepEqual(originalSnapshot, {
    revision: savedProfile.revision,
    enabled: true,
    content: dnaContent,
    savedAt: savedProfile.savedAt,
  });
  report.taskSnapshot = { dnaRevision: task.dna.revision, enabled: task.dna.enabled, contentSha256: sha256(task.dna.content) };
  report.checks.push('new-task-freezes-enabled-dna-snapshot');

  phase = 'global-dna-update-isolation';
  const updatedProfile = (await request('/api/dna', {
    expectedRevision: savedProfile.revision,
    enabled: true,
    content: updatedDnaContent,
    by: '隔离验证执行人',
    note: '验证全局 DNA 更新不会静默改写既有任务快照。',
  })).profile;
  task = await readTask(task.id);
  assert.deepEqual(task.dna, originalSnapshot);
  report.globalUpdate = {
    revision: updatedProfile.revision,
    contentSha256: sha256(updatedDnaContent),
    oldTaskSnapshotUnchanged: true,
  };
  report.checks.push('later-global-dna-update-leaves-old-task-unchanged');

  phase = 'real-chat-before-confirmation';
  const readOnlyChat = await chat(task, '请根据当前任务与已启用 DNA，简短说明本次主题和你会遵循的视觉要求。只做说明，不修改需求、参考或制作单。');
  task = await readTask(task.id);
  assert.equal(task.revision, readOnlyChat.taskRevision);
  assert.equal(task.inputConfirmation, null);
  assert.equal(task.sheets.length, 0);
  assert.deepEqual(task.dna, originalSnapshot);
  report.chat = {
    initialStatus: 'succeeded',
    initialReplySha256: sha256(readOnlyChat.text),
    noTaskMutation: true,
  };
  report.checks.push('real-dsh-task-chat-without-implicit-mutation');

  phase = 'confirm-inputs';
  task = (await request(`/api/tasks/${encodeURIComponent(task.id)}/confirm-inputs`, {
    expectedRevision: task.revision,
    revision: task.revision,
    by: '隔离验证执行人',
    note: '明确确认本次隔离验证需求与空参考。',
  })).task;
  assert.ok(task.inputConfirmation);

  phase = 'real-one-page-sheet';
  const sheetChat = await chat(task, [
    '当前需求与空参考已确认。请调用 studio_write_sheet 生成一页海报制作单，不要代替我确认制作单。',
    '主题：每天阅读十分钟。制作单的页 prompt 必须明确落实当前任务 DNA：使用墨绿与暖白配色，明确禁止二维码，并明确避免细小字体；文案应简短且适合手机阅读。',
    '只生成一页，sourceIds 为空，尺寸 3:4。请按工具要求填写 title、sourceIds、pages 中的 page、copy、prompt、size、sourceIds。',
  ].join('\n'));
  task = await readTask(task.id);
  assert.equal(task.revision, sheetChat.taskRevision);
  assert.equal(task.sheets.length, 1);
  assert.equal(task.sheets.at(-1).pages.length, 1);
  assert.equal(task.sheets.at(-1).inputs.dna.revision, originalSnapshot.revision);
  assert.equal(task.sheets.at(-1).inputs.dna.content, originalSnapshot.content);
  const sheetPrompt = task.sheets.at(-1).pages[0].prompt;
  const sheetChecks = promptChecks(sheetPrompt);
  report.sheet = {
    status: 'succeeded',
    version: task.sheetVersion,
    pageCount: task.sheets.at(-1).pages.length,
    promptSha256: sha256(sheetPrompt),
    promptAppliedDnaSnapshot: true,
    requirements: sheetChecks,
  };
  if (Object.values(sheetChecks).some((value) => !value)) fail('ERR_SHEET_PROMPT_DID_NOT_APPLY_DNA_REQUIREMENTS');
  report.checks.push('real-dsh-sheet-prompt-implements-green-warm-white-and-exclusions');

  phase = 'confirm-sheet';
  task = (await request(`/api/tasks/${encodeURIComponent(task.id)}/confirm-sheet`, {
    expectedRevision: task.revision,
    version: task.sheetVersion,
    by: '隔离验证执行人',
    note: '明确确认当前真实 DSH 生成的单页制作单。',
  })).task;
  assert.ok(task.sheetConfirmation);

  phase = 'real-chat-dna-conflict';
  const beforeConflict = structuredClone(task);
  const conflictChat = await chat(task, '本次临时想把海报改成明亮粉紫色，这与当前任务 DNA 的墨绿和暖白要求有冲突。请只向我说明冲突并询问应以哪项为准；不要调用任何写入工具，不要修改 DNA、需求或制作单。');
  task = await readTask(task.id);
  const conflictReported = /冲突|不一致|矛盾/.test(conflictChat.text)
    && /粉紫|粉色|紫色/.test(conflictChat.text)
    && /墨绿|暖白/.test(conflictChat.text);
  assert.equal(conflictReported, true);
  assert.equal(task.revision, beforeConflict.revision);
  assert.deepEqual(task.dna, beforeConflict.dna);
  assert.deepEqual(task.inputConfirmation, beforeConflict.inputConfirmation);
  assert.deepEqual(task.sheetConfirmation, beforeConflict.sheetConfirmation);
  assert.equal(task.sheetVersion, beforeConflict.sheetVersion);
  const stillCurrentGlobalDna = await readDna({ root: temporaryRoot });
  assert.equal(stillCurrentGlobalDna.revision, updatedProfile.revision);
  assert.equal(stillCurrentGlobalDna.content, updatedDnaContent);
  report.conflict = {
    status: 'succeeded',
    conflictReported,
    replySha256: sha256(conflictChat.text),
    taskAndDnaUnchanged: true,
  };
  report.checks.push('real-dsh-conflict-is-reported-without-mutation');

  phase = 'explicit-apply-dna-invalidation';
  task = (await request(`/api/tasks/${encodeURIComponent(task.id)}/apply-dna`, {
    expectedRevision: task.revision,
    dnaRevision: updatedProfile.revision,
  })).task;
  assert.equal(task.dna.revision, updatedProfile.revision);
  assert.equal(task.dna.content, updatedDnaContent);
  assert.equal(task.inputConfirmation, null);
  assert.equal(task.sheetConfirmation, null);
  assert.equal(task.sheets.at(-1).inputs.dna.content, dnaContent);
  report.applyDna = {
    status: 'succeeded',
    appliedRevision: task.dna.revision,
    oldInputConfirmationInvalidated: task.inputConfirmation === null,
    oldSheetConfirmationInvalidated: task.sheetConfirmation === null,
    historicalSheetSnapshotRetained: task.sheets.at(-1).inputs.dna.content === dnaContent,
  };
  report.checks.push('explicit-apply-dna-invalidates-input-and-sheet-confirmations');

  phase = 'credential-disk-check';
  assert.equal(await exists(path.join(temporaryRoot, 'config', 'studio.json')), false);
  report.checks.push('credential-not-written-to-temporary-config');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = { phase, code: /^[A-Z0-9_:-]{1,100}$/.test(error?.code || '') ? error.code : error?.name || 'Error' };
  process.exitCode = 1;
} finally {
  if (activeJobId && server) {
    await request(`/api/jobs/${encodeURIComponent(activeJobId)}`, {}, 'DELETE').catch(() => {});
  }
  await server?.close().catch(() => {});
  if (temporaryRoot) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
    report.temporaryDataRootRemoved = !(await exists(temporaryRoot));
  }
  await fs.mkdir(path.dirname(evidencePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

console.log(JSON.stringify({
  status: report.status,
  requestedModel: report.requestedModel || null,
  checks: report.checks,
  imageGenerationRequests: report.imageGenerationRequests,
  failure: report.failure || null,
}));
