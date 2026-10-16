import { WhaleCharacter } from './WhaleCharacter.jsx';
import { WhaleAvatar } from './WhaleAvatar.jsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, jobFromResponse } from './api.js';
import { Workbench, ChatComposer } from './Workbench.jsx';
import { Library } from './Library.jsx';
import { DnaSettings, ModelSettings } from './Settings.jsx';

const NAV = [
  { id: 'workbench', label: '创作工作台', mark: '✳' },
  { id: 'library', label: '素材库', mark: '▣' },
  { id: 'dna', label: 'DNA', mark: '⌘' },
  { id: 'config', label: '模型与服务', mark: '◇' },
];

function taskLabel(task) {
  const labels = {
    '已完成': '可交付',
    '执行失败': '执行失败',
    '已暂停': '已停止',
    '执行中': '绘图中',
    '待审核': '待审核',
    '待执行': '待绘图',
    '待确认制作单': '待确认制作单',
    '待补充需求': '待确认需求',
  };
  if (labels[task?.status]) return labels[task.status];
  if (task?.status === 'unreadable') return '无法读取';
  if (task?.finalApproved) return '可交付';
  if (task?.executionStatus === 'running') return '绘图中';
  if (task?.executionStatus === 'failed') return '执行失败';
  if (task?.executionStatus === 'cancelled') return '已停止';
  if (task?.sheetConfirmed) return '待绘图';
  if (task?.sheetVersion) return '待确认制作单';
  if (task?.inputConfirmed) return '需求已确认';
  return '待确认需求';
}

function taskStatusClass(task) {
  if (task?.finalApproved) return 'status-good';
  if (task?.executionStatus === 'failed') return 'status-bad';
  if (task?.executionStatus === 'running') return 'status-live';
  return 'status-wait';
}

function jobLabel(kind) {
  return ({
    chat: 'Agent 对话',
    review: '图片读图审核',
    execute: '逐页绘图',
    resume: '继续绘图',
    'asset-clean': '素材清洗',
    'dna-organize': 'DNA 草稿整理',
  })[kind] || kind;
}

function mergePendingChats(conversation = [], pending = []) {
  const pendingByRequestId = new Map(pending.filter((message) => message.requestId).map((message) => [message.requestId, message]));
  const durableRequestIds = new Set();
  const reconciled = conversation.map((message) => {
    if (!message.requestId) return message;
    durableRequestIds.add(message.requestId);
    const clientMessage = pendingByRequestId.get(message.requestId);
    return clientMessage?.attachments?.length && !message.attachments?.length
      ? { ...message, attachments: clientMessage.attachments, ...(message.attachmentSourceIds?.length ? {} : clientMessage.sourceId ? { attachmentSourceIds: [clientMessage.sourceId] } : {}) }
      : message;
  });
  return [...reconciled, ...pending.filter((message) => !durableRequestIds.has(message.requestId))];
}

export function App() {
  const [section, setSection] = useState('workbench');
  const [bootstrap, setBootstrap] = useState(null);
  const [task, setTask] = useState(null);
  const [selectedTaskId, setSelectedTaskId] = useState(() => window.localStorage.getItem('studio.activeTask') || '');
  const selectedTaskRef = useRef(selectedTaskId);
  selectedTaskRef.current = selectedTaskId;
  const [job, setJob] = useState(null);
  const [pendingChatsByTask, setPendingChatsByTask] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeTone, setNoticeTone] = useState('success');
  const [createOpen, setCreateOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [jobBusy, setJobBusy] = useState(false);
  const [taskModelSelections, setTaskModelSelections] = useState({});
  const [availableBaseModels, setAvailableBaseModels] = useState([]);
  const [baseModelsLoaded, setBaseModelsLoaded] = useState(false);
  const [baseModelsLoading, setBaseModelsLoading] = useState(false);
  const [baseModelFetchError, setBaseModelFetchError] = useState('');
  const modelListRequest = useRef(0);
  const [canvasNeedsSyncTaskId, setCanvasNeedsSyncTaskId] = useState('');
  const polling = useRef(false);
  const referenceContinue = useRef(false);
  const canvasReturnCheck = useRef({ selectedTaskId: '', inFlight: false, pendingTaskId: '', lastStartedAt: 0, timer: null });
  canvasReturnCheck.current.selectedTaskId = selectedTaskId;
  const notify = (message, tone = 'success') => { setNoticeTone(tone); setNotice(message); };
  const defaultBaseModel = bootstrap?.config?.base?.model || '';
  const selectedBaseModel = task?.id ? (taskModelSelections[task.id] ?? defaultBaseModel) : defaultBaseModel;

  useEffect(() => {
    modelListRequest.current += 1;
    setAvailableBaseModels([]); setBaseModelsLoaded(false); setBaseModelFetchError(''); setBaseModelsLoading(false);
  }, [bootstrap?.config?.revision]);

  async function loadBaseModels() {
    const requestId = ++modelListRequest.current;
    setBaseModelsLoading(true); setBaseModelFetchError('');
    try {
      const result = await api.models({ kind: 'base' });
      if (requestId !== modelListRequest.current) return;
      const entries = Array.isArray(result?.models) ? result.models : [];
      const seen = new Set();
      const valid = entries.filter((entry) => {
        if (!entry || typeof entry.id !== 'string' || !entry.id.trim() || seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      });
      setAvailableBaseModels(valid); setBaseModelsLoaded(true);
    } catch (cause) {
      if (requestId !== modelListRequest.current) return;
      setAvailableBaseModels([]); setBaseModelsLoaded(false);
      setBaseModelFetchError(cause.message || '获取基础模型列表失败。');
    } finally {
      if (requestId === modelListRequest.current) setBaseModelsLoading(false);
    }
  }

  const refreshBootstrap = useCallback(async ({ preserveError = false } = {}) => {
    try {
      const next = await api.bootstrap();
      setBootstrap(next);
      if (!preserveError) setError('');
      return next;
    } catch (cause) {
      setError(cause.message || '无法读取工作区数据。');
      throw cause;
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshTask = useCallback(async (id = selectedTaskId) => {
    if (!id) {
      setTask(null);
      return null;
    }
    const next = await api.task(id);
    const current = { ...next.task, conversation: next.conversation, operations: next.operations, job: next.job, canvas: next.canvas };
    if (selectedTaskRef.current === id) {
      setTask(current);
      setJob((currentJob) => next.job || (currentJob && currentJob.taskId !== id ? currentJob : null));
      setPendingChatsByTask((all) => {
        const durable = new Set((next.conversation || []).map((message) => message.requestId).filter(Boolean));
        const pending = all[id] || [];
        const remaining = pending.filter((message) => !durable.has(message.requestId));
        return remaining.length === pending.length ? all : { ...all, [id]: remaining };
      });
      window.localStorage.setItem('studio.activeTask', current.id);
      setError('');
    }
    return next;
  }, [selectedTaskId]);

  useEffect(() => { refreshBootstrap().catch(() => {}); }, [refreshBootstrap]);

  useEffect(() => {
    if (!bootstrap || !selectedTaskId) return;
    let active = true;
    api.task(selectedTaskId)
      .then((next) => { if (active && selectedTaskRef.current === selectedTaskId) { setTask({ ...next.task, conversation: next.conversation, operations: next.operations, job: next.job, canvas: next.canvas }); setJob((currentJob) => next.job || (currentJob && currentJob.taskId !== selectedTaskId ? currentJob : null)); setPendingChatsByTask((all) => { const durable = new Set((next.conversation || []).map((message) => message.requestId).filter(Boolean)); const pending = all[selectedTaskId] || []; const remaining = pending.filter((message) => !durable.has(message.requestId)); return remaining.length === pending.length ? all : { ...all, [selectedTaskId]: remaining }; }); } })
      .catch((cause) => { if (active) { setTask(null); setError(cause.message || '无法打开该任务。'); } });
    return () => { active = false; };
  }, [bootstrap, selectedTaskId]);

  useEffect(() => {
    const state = canvasReturnCheck.current;
    let debounceTimer = null;
    let retryTimer = null;
    const activeJob = Boolean(job && ['queued', 'running'].includes(job.status));

    const checkCanvas = async (attempt = 0) => {
      if (state.inFlight || !selectedTaskId || state.selectedTaskId !== selectedTaskId) return;
      if (jobBusy || activeJob) {
        state.pendingTaskId = selectedTaskId;
        notify('当前操作仍在进行，完成后再检查画布结果。', 'warning');
        return;
      }
      state.inFlight = true;
      state.pendingTaskId = '';
      state.lastStartedAt = Date.now();
      try {
        const detail = await refreshTask(selectedTaskId);
        if (state.selectedTaskId !== selectedTaskId || !detail?.task) return;
        if (detail.job && ['queued', 'running'].includes(detail.job.status)) {
          state.pendingTaskId = selectedTaskId;
          notify('当前操作仍在进行，完成后再检查画布结果。', 'warning');
          return;
        }
        const hasImages = detail.task.execution?.pages?.some((page) => page.status === 'succeeded' && page.image && (page.image.sha256 || page.image.imageUrl));
        if (!hasImages) return;
        if (!detail.canvas?.clientConnected) {
          notify('Canvas 当前未连接，本次没有核对画布结果；现有复审和批准记录保持原状。', 'warning');
          return;
        }

        const result = await api.reconcileCanvas(selectedTaskId, { expectedRevision: detail.task.revision });
        if (state.selectedTaskId !== selectedTaskId) return;
        const needsSync = result.needsSync === true;
        setTask((current) => current?.id === selectedTaskId ? {
          ...current,
          ...result.task,
          ...(needsSync ? { finalApproval: null } : {}),
          canvas: result.canvas,
        } : current);
        if (needsSync) setCanvasNeedsSyncTaskId(selectedTaskId);
        await refreshBootstrap({ preserveError: true }).catch(() => {});
        if (result.needsSync == null || !result.canvas?.clientConnected) {
          notify('Canvas 在核对期间断开；本次未将画布结果视为已同步，现有复审和批准记录保持原状。', 'warning');
        } else if (needsSync) {
          const changedPages = (result.changedPages || []).map((item) => `第 ${item.page} 页`).join('、');
          notify(`画布结果已改变${changedPages ? `：${changedPages}` : ''}，请同步选图并复审后再批准。`, 'warning');
        }
      } catch (cause) {
        const retryable = ['ERR_TASK_BUSY', 'ERR_TASK_ENTRY_BUSY', 'ERR_TASK_REVISION_CONFLICT'].includes(cause.code);
        if (retryable) {
          const refreshed = await refreshTask(selectedTaskId).catch(() => null);
          await refreshBootstrap({ preserveError: true }).catch(() => {});
          const refreshedJobActive = Boolean(refreshed?.job && ['queued', 'running'].includes(refreshed.job.status));
          if (refreshedJobActive) {
            state.pendingTaskId = selectedTaskId;
            notify('当前操作仍在进行，完成后再检查画布结果。', 'warning');
          } else if (attempt === 0 && document.visibilityState !== 'hidden' && state.selectedTaskId === selectedTaskId) {
            notify('任务或画布状态正在变化；已重新读取，稍后会再次核对。', 'warning');
            retryTimer = window.setTimeout(() => checkCanvas(1), 1800);
          } else {
            notify('任务或画布状态仍在变化；本次未重放旧版本写入，请稍后重新检查。', 'warning');
          }
        } else {
          notify(cause.message || '无法核对画布结果，请稍后重试。', 'warning');
        }
      } finally {
        state.inFlight = false;
      }
    };

    const onReturn = () => {
      if (document.visibilityState === 'hidden' || !selectedTaskId) return;
      if (debounceTimer) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        if (Date.now() - state.lastStartedAt < 1000 || state.inFlight) return;
        checkCanvas();
      }, 160);
    };
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') onReturn(); };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onVisibilityChange);

    if (!jobBusy && !activeJob && state.pendingTaskId === selectedTaskId) {
      state.pendingTaskId = '';
      retryTimer = window.setTimeout(() => checkCanvas(), 350);
    }
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (debounceTimer) window.clearTimeout(debounceTimer);
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [job?.id, job?.status, jobBusy, refreshBootstrap, refreshTask, selectedTaskId]);

  useEffect(() => {
    if (!job?.id || ['succeeded', 'failed', 'cancelled'].includes(job.status)) return undefined;
    let active = true;
    const poll = async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        const next = await api.job(job.id);
        if (!active) return;
        setJob(next.job);
        if (next.job.taskId && next.job.taskId === selectedTaskRef.current) {
          await refreshTask(next.job.taskId).catch(() => {});
        }
        if (['succeeded', 'failed', 'cancelled'].includes(next.job.status)) {
          await refreshBootstrap({ preserveError: true }).catch(() => {});
          setRefreshKey((value) => value + 1);
        }
      } catch (cause) {
        if (active) setError(cause.message || '读取操作状态失败。');
      } finally {
        polling.current = false;
      }
    };
    const timer = window.setInterval(poll, 1200);
    poll();
    return () => { active = false; window.clearInterval(timer); };
  }, [job?.id, job?.status, refreshBootstrap, refreshTask]);

  const run = useCallback(async (operation, { refresh = true, success = '' } = {}) => {
    setError('');
    setNotice(''); setNoticeTone('success');
    try {
      const result = await operation();
      const pendingJob = jobFromResponse(result);
      if (pendingJob) {
        setJob(pendingJob);
        setJobBusy(false);
        if (pendingJob.taskId && pendingJob.taskId === selectedTaskId) {
          const detail = await refreshTask(selectedTaskId).catch(() => null);
          if (detail?.job && ['succeeded', 'failed', 'cancelled'].includes(detail.job.status)) {
            await refreshBootstrap({ preserveError: true });
            setRefreshKey((value) => value + 1);
          }
        }
        if (success) notify(success);
        return result;
      }
      if (refresh) {
        await refreshBootstrap({ preserveError: true });
        if (selectedTaskId) await refreshTask(selectedTaskId);
        setRefreshKey((value) => value + 1);
      }
      if (success) notify(success);
      return result;
    } catch (cause) {
      if (cause.status === 409) {
        if (cause.code === 'ERR_TASK_REVISION_CONFLICT' && selectedTaskId) await refreshTask(selectedTaskId).catch(() => {});
        await refreshBootstrap({ preserveError: true }).catch(() => {});
        setRefreshKey((value) => value + 1);
      }
      setError(cause.message || '操作没有完成。');
      throw cause;
    }
  }, [refreshBootstrap, refreshTask, selectedTaskId]);

  const startJob = useCallback(async (operation, { success = '' } = {}) => {
    setJobBusy(true);
    try { return await run(operation, { refresh: false, success }); }
    finally { setJobBusy(false); }
  }, [run]);

  const sendChat = useCallback(async ({ taskId, text, expectedRevision, model = '', answers, attachments = [], uploadCompleted = false, uploadRevision = null, sourceId = '', requestId = crypto.randomUUID() }) => {
    const instructionText = String(text || '').trim();
    const files = [...attachments];
    const attachmentNames = files.map((file) => file.name || '剪贴板图片');
    const chatText = instructionText || (files.length ? `[附件] ${attachmentNames.join('、')}` : '');
    if (!chatText) return null;
    const displayAttachments = files.map((file) => ({ name: file.name || '剪贴板图片', mimeType: file.type || '', size: file.size || 0 }));
    const optimistic = {
      id: `client:${requestId}`,
      requestId,
      taskId,
      role: 'user',
      text: chatText,
      ...(instructionText ? { instructions: instructionText } : {}),
      ...(displayAttachments.length ? { attachments: displayAttachments, attachmentFiles: files } : {}),
      ...(answers ? { answers } : {}),
      expectedRevision,
      uploadBaseRevision: expectedRevision,
      uploadCompleted,
      ...(uploadRevision != null ? { uploadRevision } : {}),
      ...(sourceId ? { sourceId } : {}),
      model,
      clientStatus: 'sending',
      createdAt: new Date().toISOString(),
    };
    setPendingChatsByTask((all) => {
      const messages = all[taskId] || [];
      const exists = messages.some((message) => message.requestId === requestId);
      return { ...all, [taskId]: exists ? messages.map((message) => message.requestId === requestId ? { ...optimistic, createdAt: message.createdAt } : message) : [...messages, optimistic] };
    });
    try {
      let chatRevision = uploadCompleted && uploadRevision != null ? uploadRevision : expectedRevision;
      let completedUpload = uploadCompleted;
      let completedUploadRevision = uploadRevision;
      let completedSourceId = sourceId;
      if (files.length && !completedUpload) {
        const form = new FormData();
        form.append('expectedRevision', String(expectedRevision));
        form.append('uploadId', requestId);
        form.append('instructions', instructionText);
        files.forEach((file) => form.append('files', file, file.name || 'clipboard-image.png'));
        const uploaded = await api.attachTaskFiles(taskId, form);
        completedUploadRevision = Number(uploaded.uploadRevision);
        completedUpload = true;
        completedSourceId = uploaded.sourceId || '';
        if (!Number.isSafeInteger(completedUploadRevision) || completedUploadRevision < 1) throw new Error('附件已处理，但服务没有返回可用于对话的任务版本。');
        setPendingChatsByTask((all) => ({
          ...all,
          [taskId]: (all[taskId] || []).map((message) => message.requestId === requestId ? {
            ...message,
            uploadCompleted: true,
            uploadRevision: completedUploadRevision,
            sourceId: completedSourceId,
            expectedRevision: completedUploadRevision,
          } : message),
        }));
        if (uploaded.task?.id === taskId && selectedTaskRef.current === taskId) {
          setTask((current) => current?.id === taskId ? { ...current, ...uploaded.task, conversation: current.conversation, operations: current.operations, job: current.job, canvas: current.canvas } : current);
        }
        if (Number(uploaded.task?.revision) !== completedUploadRevision) {
          await refreshTask(taskId).catch(() => {});
          const conflict = new Error('附件已保存，但任务在上传后又有更新。请先检查任务当前内容，再重新输入要发送的消息。');
          conflict.status = 409;
          conflict.code = 'ERR_TASK_CHANGED_AFTER_UPLOAD';
          conflict.uploadCompleted = true;
          throw conflict;
        }
        chatRevision = completedUploadRevision;
      }
      const result = await startJob(
        () => api.chat(taskId, chatText, chatRevision, requestId, { model, answers, ...(completedSourceId ? { attachmentSourceIds: [completedSourceId] } : {}) }),
        { refresh: false },
      );
      setPendingChatsByTask((all) => ({
        ...all,
        [taskId]: (all[taskId] || []).map((message) => message.requestId === requestId ? {
          ...message,
          clientStatus: 'accepted',
          expectedRevision: chatRevision,
          uploadCompleted: completedUpload,
          ...(completedUploadRevision != null ? { uploadRevision: completedUploadRevision } : {}),
          ...(completedSourceId ? { sourceId: completedSourceId } : {}),
        } : message),
      }));
      return result;
    } catch (cause) {
      const status = Number(cause.status);
      const clientStatus = status >= 400 && status < 500 ? 'failed' : 'uncertain';
      if (cause.status === 409) await refreshTask(taskId).catch(() => {});
      setPendingChatsByTask((all) => ({
        ...all,
        [taskId]: (all[taskId] || []).map((message) => message.requestId === requestId ? {
          ...message,
          clientStatus,
          clientError: cause.message || '网络请求未返回结果。',
          clientErrorCode: cause.code || '',
          clientCanRetry: cause.status !== 409,
          ...(cause.uploadCompleted ? { uploadCompleted: true } : {}),
        } : message),
      }));
      throw cause;
    }
  }, [refreshTask, startJob]);

  const retryChat = useCallback((message) => sendChat({
    taskId: message.taskId,
    text: message.instructions ?? message.text,
    expectedRevision: message.expectedRevision,
    model: message.model || '',
    attachments: message.attachmentFiles || [],
    uploadCompleted: message.uploadCompleted === true,
    ...(message.uploadRevision != null ? { uploadRevision: message.uploadRevision } : {}),
    ...(message.sourceId ? { sourceId: message.sourceId } : {}),
    ...(message.answers ? { answers: message.answers } : {}),
    requestId: message.requestId,
  }), [sendChat]);

  async function openTask(id) {
    setSection('workbench');
    setSidebarOpen(false);
    setError('');
    selectedTaskRef.current = id;
    setSelectedTaskId(id);
    setTask(null);
    try { await refreshTask(id); }
    catch (cause) { setError(cause.message || '无法打开该任务。'); }
  }

  async function createTask({ brief, attachments = [] }) {
    const content = brief.trim() || '请根据参考附件，先帮我明确创作需求。';
    const title = brief.trim().replace(/\s+/gu, ' ').slice(0, 30) || '参考图创作';
    const taskBrief = { content };
    try {
      const created = (await api.createTask({ title, brief: taskBrief })).task;
      selectedTaskRef.current = created.id;
      setSelectedTaskId(created.id);
      setTask(null);
      setSection('workbench');
      setCreateOpen(false);
      window.localStorage.setItem('studio.activeTask', created.id);
      const detail = await refreshTask(created.id);
      await refreshBootstrap({ preserveError: true });
      await sendChat({ taskId: created.id, text: content, attachments, expectedRevision: detail.task.revision, model: defaultBaseModel });
      notify('已创建任务并提交创作需求。');
    } catch (cause) {
      setError(cause.message || '创建任务失败。');
      throw cause;
    }
  }

  async function confirmReferencesAndContinue(expectedRevision) {
    if (referenceContinue.current) return;
    referenceContinue.current = true;
    setJobBusy(true); setError('');
    try {
      let current = task;
      if (!current || current.revision !== expectedRevision) throw new Error('任务已更新，请检查当前参考后再继续。');
      if (current.sources.some(source => source.decision === 'pending')) {
        const result = await api.setReferences(current.id, { expectedRevision: current.revision, items: current.sources.map(source => ({ kind: 'existing', id: source.id, decision: source.decision === 'pending' ? 'excluded' : source.decision, purpose: source.purpose, factBoundary: source.factBoundary })) });
        current = result.task;
      }
      if (!current.inputConfirmation) {
        const result = await api.taskAction(current.id, 'confirm-inputs', { revision: current.revision, expectedRevision: current.revision, by: '本机用户', note: `用户在 Web 确认需求与所选参考 v${current.revision} 并继续整理制作单` });
        current = result.task;
      }
      await sendChat({ taskId: current.id, text: '已确认当前需求和所选参考，请根据已保留的素材与本次 DNA 快照继续整理完整制作单，等待我审核；不要替我确认制作单或开始绘图。', expectedRevision: current.revision, model: selectedBaseModel });
    } catch (cause) {
      if (task?.id) await refreshTask(task.id).catch(() => {});
      setError(cause.message || '继续操作未完成；已保存的参考选择会保留。');
    } finally { referenceContinue.current = false; setJobBusy(false); }
  }

  async function cancelCurrentJob() {
    if (!job?.id) return;
    setError('');
    try {
      const next = await api.cancelJob(job.id);
      setJob(next.job);
      notify('已请求停止；已提交到 Canvas 的生成可能仍会返回。');
    } catch (cause) {
      setError(cause.message || '停止操作失败。');
    }
  }

  async function openCanvas(id) {
    const child = window.open('about:blank', '_blank');
    if (!child) { setError('浏览器阻止了新标签页，请允许此本地工作台打开 Canvas。'); return; }
    setError('');
    try {
      const result = await api.canvasOpen(id);
      if (!result?.openUrl) throw new Error('Canvas 服务没有返回可打开的任务页面。');
      child.opener = null;
      child.location.replace(result.openUrl);
    } catch (cause) {
      child.close();
      setError(cause.message || 'Canvas 暂时无法打开。');
    }
  }

  async function ensureCanvasConnected(id) {
    // Open the tab synchronously from the user's click so popup blockers allow it.
    const child = window.open('about:blank', '_blank');
    if (!child) throw new Error('浏览器阻止了 Canvas 新标签页，请允许本地工作台打开 Canvas 后重试。');
    let navigated = false;
    try {
      const opened = await api.canvasOpen(id);
      if (!opened.openUrl) throw new Error('Canvas 服务没有返回可打开的任务页面。');
      if (opened.clientConnected) {
        child.close();
        return;
      }
      child.opener = null;
      child.location.replace(opened.openUrl);
      navigated = true;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        const current = await api.task(id);
        if (current.canvas?.clientConnected && current.canvas.projectId === opened.projectId) return;
      }
      throw new Error('Canvas 标签页已打开，但尚未连接到当前任务。请等画布加载完成后重试绘图。');
    } catch (cause) {
      if (!navigated) child.close();
      throw cause;
    }
  }

  const activeTaskSummary = useMemo(
    () => bootstrap?.tasks?.find((item) => item.id === selectedTaskId),
    [bootstrap?.tasks, selectedTaskId],
  );
  const workbenchTask = useMemo(() => task ? {
    ...task,
    conversation: mergePendingChats(task.conversation || [], pendingChatsByTask[task.id] || []),
  } : null, [task, pendingChatsByTask]);
  const clientSendBusy = Boolean(task?.id && (pendingChatsByTask[task.id] || []).some((message) => message.clientStatus === 'sending'));
  const jobIsActive = Boolean(job && ['queued', 'running'].includes(job.status));
  const detachedTerminalJob = job && !jobIsActive && job.taskId !== selectedTaskId ? job : null;

  if (loading && !bootstrap) {
    return <main className="boot-screen"><span className="brand-mark"><WhaleAvatar decorative /></span><p>正在读取本地工作区…</p></main>;
  }

  if (!bootstrap) {
    return <main className="boot-screen"><span className="brand-mark"><WhaleAvatar decorative /></span><h1>工作区暂时无法打开</h1><p role="alert">{error}</p><button className="button primary" onClick={() => { setLoading(true); refreshBootstrap().catch(() => {}); }}>重新连接</button></main>;
  }

  return (
    <div className={`studio-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${section === 'workbench' ? 'workbench-mode' : ''}`}>
      <button className={`sidebar-scrim ${sidebarOpen ? 'shown' : ''}`} aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''} ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-top-row">
          <div className="brand-lockup"><span className="brand-mark"><WhaleAvatar decorative /></span><div><strong>Creative Studio</strong><small>大肥鱼绘图助手</small></div></div>
          <button type="button" className="sidebar-collapse-toggle" aria-label={sidebarCollapsed ? '展开导航栏' : '收起导航栏'} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed ? '展开导航栏' : '收起导航栏'} onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}>{sidebarCollapsed ? '›' : '‹'}</button>
        </div>
        <button className="button primary create-button" aria-label="新建创作" title="新建创作" onClick={() => { setCreateOpen(true); setSidebarOpen(false); }}><span aria-hidden="true">＋</span><span className="create-button-label">新建创作</span></button>
        <nav className="main-nav" aria-label="主导航">
          {NAV.map((item) => <button key={item.id} className={`nav-item ${section === item.id ? 'active' : ''}`} aria-label={item.label} title={item.label} onClick={() => { setSection(item.id); setSidebarOpen(false); }}><span className="nav-mark" aria-hidden="true">{item.mark}</span><span className="nav-label">{item.label}</span></button>)}
        </nav>
        <div className="sidebar-rule" />
        <div className="sidebar-heading"><span>最近任务</span><span className="count-label">{bootstrap.tasks?.length || 0}</span></div>
        <div className="task-list" aria-label="最近任务">
          {bootstrap.tasks?.length ? bootstrap.tasks.map((item) => (
            <button key={item.id} className={`task-list-item ${selectedTaskId === item.id ? 'active' : ''}`} aria-label={item.title} title={item.title} onClick={() => openTask(item.id)}>
              <span className="task-icon" aria-hidden="true">▤</span>
              <span className="task-summary"><strong>{item.title}</strong><small><i className={taskStatusClass(item)} />{taskLabel(item)}{item.totalPages ? ` · ${item.completedPages}/${item.totalPages} 页` : ''}</small></span>
            </button>
          )) : <div className="sidebar-empty">还没有创作任务</div>}
        </div>
        <div className="sidebar-footer">
          <div className="studio-companion"><WhaleCharacter /><div><strong>灵感，准备落笔</strong><p>说说你的想法，<br />一起把它画出来。</p></div></div>
          <button className="footer-card" aria-label={`DNA ${bootstrap.dna?.enabled ? '已启用' : '未启用'}`} title="DNA 设置" onClick={() => setSection('dna')}><span className="footer-icon">⌘</span><span><strong>DNA {bootstrap.dna?.enabled ? '已启用' : '未启用'}</strong><small>{bootstrap.dna?.enabled ? `版本 ${bootstrap.dna.revision}` : '开启后按你的风格生成'}</small></span><span className="chevron">›</span></button>
          <button className="footer-card" aria-label="模型与服务设置" title="模型与服务" onClick={() => setSection('config')}><span className="footer-icon">◇</span><span><strong>模型与服务</strong><small>{bootstrap.config?.base?.apiKeyConfigured ? '基础模型已配置' : '查看连接配置'}</small></span><span className="chevron">›</span></button>
        </div>
      </aside>

      <main className={`main-area ${section === 'workbench' ? 'workbench-main' : ''}`}>
        <header className="mobile-topbar"><button className="icon-button" aria-label="打开导航" onClick={() => setSidebarOpen(true)}>☰</button><span>Creative Studio</span><button className="button small primary" onClick={() => setCreateOpen(true)}>＋ 新建</button></header>
        {(error || notice) && <div className={`global-message ${error ? 'error' : noticeTone}`} role={error ? 'alert' : 'status'}><span>{error || notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => { setError(''); setNotice(''); setNoticeTone('success'); }}>×</button></div>}
        {detachedTerminalJob && <div className={`job-status-summary ${detachedTerminalJob.status}`} role={detachedTerminalJob.status === 'failed' ? 'alert' : 'status'}>
          <span><strong>{detachedTerminalJob.status === 'succeeded' ? '操作已完成' : detachedTerminalJob.status === 'cancelled' ? '操作已停止' : '操作失败'} · {jobLabel(detachedTerminalJob.kind)}</strong>{detachedTerminalJob.error?.message || detachedTerminalJob.result?.message || ''}</span>
          <button className="icon-button" onClick={() => setJob(null)} aria-label="收起操作结果">×</button>
        </div>}
        {section === 'workbench' && <Workbench
          task={workbenchTask}
          canvasNeedsSync={canvasNeedsSyncTaskId === task?.id}
          summary={activeTaskSummary}
          onCreate={() => setCreateOpen(true)}
          job={job?.taskId === task?.id ? job : null}
          jobBusy={jobBusy || clientSendBusy}
          model={selectedBaseModel}
          models={availableBaseModels}
          modelsLoaded={baseModelsLoaded}
          modelsLoading={baseModelsLoading}
          modelError={baseModelFetchError}
          modelBusy={Boolean((job?.taskId === task?.id && ['queued', 'running'].includes(job?.status)) || jobBusy || clientSendBusy)}
          onModelChange={(model) => setTaskModelSelections((current) => ({ ...current, [task.id]: model }))}
          onLoadModels={loadBaseModels}
          onAction={async (action, payload) => {
            const result = await run(async () => {
              if (action === 'execute' || action === 'resume') await ensureCanvasConnected(task.id);
              const request = action === 'review' && selectedBaseModel ? { ...payload, model: selectedBaseModel } : payload;
              return api.taskAction(task.id, action, request);
            }, { refresh: true });
            if (action === 'canvas-sync' && payload.selections?.length) setCanvasNeedsSyncTaskId((current) => current === task.id ? '' : current);
            return result;
          }}
          onConfirmReferencesAndContinue={confirmReferencesAndContinue}
          onSetReferences={(payload) => run(() => api.setReferences(task.id, payload), { refresh: true })}
          onChat={(message, answers, attachments) => sendChat({ taskId: task.id, text: message, expectedRevision: task.revision, model: selectedBaseModel, ...(answers ? { answers } : {}), ...(attachments?.length ? { attachments } : {}) })}
          onDraftSheet={() => startJob(() => api.chat(task.id, '请根据已确认的需求、保留的参考素材与本次 DNA 快照，整理一份完整制作单。请提供连续页码、准确页面文案、画面要求、尺寸，以及实际引用的来源 ID；不要替我确认。', task.revision, undefined, { model: selectedBaseModel }))}
          onCanvasSync={async (payload) => {
            return run(() => api.taskAction(task.id, 'canvas-sync', payload), { refresh: true });
          }}
          onOpenCanvas={() => openCanvas(task.id)}
          onCancelJob={cancelCurrentJob}
          onSearchAssets={(filters) => api.assets({ ...filters, confirmedOnly: true })}
          onRefresh={() => refreshTask()}
          onRetryChat={retryChat}
        />}
        <div hidden={section !== 'library'}>
          <Library
          tags={bootstrap.tags || { revision: 1, tags: [] }}
          refreshKey={refreshKey}
          onRun={run}
          onStartJob={startJob}
          job={job}
          />
        </div>
        {section === 'dna' && <DnaSettings
          initial={bootstrap.dna || { revision: 1, enabled: false, content: '' }}
          task={task}
          job={job}
          refreshKey={refreshKey}
          onRun={run}
          onApplyToTask={(payload) => run(() => api.taskAction(task.id, 'apply-dna', payload), { refresh: true, success: '已将该 DNA 版本应用到当前任务，下游确认需要重新检查。' })}
        />}
        {section === 'config' && <ModelSettings
          initial={bootstrap.config || { revision: 1, base: {}, image: {} }}
          refreshKey={refreshKey}
          onRun={run}
        />}
      </main>

      {createOpen && <CreateTaskDialog onClose={() => setCreateOpen(false)} onCreate={createTask} />}
    </div>
  );
}

function CreateTaskDialog({ onClose, onCreate }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const savingRef = useRef(saving);
  onCloseRef.current = onClose;
  savingRef.current = saving;

  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.querySelector('textarea')?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape' && !savingRef.current) onCloseRef.current();
      if (event.key !== 'Tab') return;
      const focusable = [...(dialogRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])') || [])];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus?.(); };
  }, []);

  async function submit(brief, attachments) {
    setSaving(true); setError('');
    try { await onCreate({ brief, attachments }); }
    catch (cause) { setError(cause.message || '任务创建失败。'); setSaving(false); throw cause; }
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <section className="modal create-modal" role="dialog" aria-modal="true" aria-labelledby="create-title" ref={dialogRef}>
      <div className="modal-head"><div><span className="eyebrow">新任务</span><h2 id="create-title">开始一项创作</h2></div><button className="icon-button" aria-label="关闭" onClick={onClose} disabled={saving}>×</button></div>
      <p className="create-dialog-intro">说说你想做什么。也可以先放一张参考图，让 Agent 和你一起确定内容、形式与张数。</p>
      <ChatComposer inputId="new-creation-message" label="你想做什么？" sendLabel="创建并开始沟通" placeholder="例如：给家长做一组 KET 学习海报，参考这张图的版式…" autoFocus disabled={saving} onSend={submit} />
      <p className="field-help">参考图可选；不上传也可以直接开始。张数与呈现形式在对话中确定。</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose} disabled={saving}>取消</button></div>
    </section>
  </div>;
}

