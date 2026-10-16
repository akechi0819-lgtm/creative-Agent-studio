import { WhaleCharacter } from './WhaleCharacter.jsx';
import { WhaleAvatar } from './WhaleAvatar.jsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { imageUrl as getImageUrl } from './api.js';

const TABS = [
  ['references', '参考素材'],
  ['sheet', '制作单'],
  ['review', '成品审核'],
];
const NO_ATTACHMENTS = [];

function briefText(brief) {
  if (typeof brief === 'string') return brief;
  if (!brief || typeof brief !== 'object') return '';
  return typeof brief.content === 'string' ? brief.content : JSON.stringify(brief, null, 2);
}

function currentSheet(task) {
  return task?.sheets?.find((sheet) => sheet.version === task.sheetVersion) || null;
}

function sheetAuthorized(task, version = task?.sheetVersion) {
  return Boolean(version && ((task.sheetAuthorized && version === task.sheetVersion) || task.sheetConfirmation?.version === version));
}

function imageForPage(task, pageNumber) {
  const page = task?.execution?.pages?.find((item) => item.page === pageNumber && item.status === 'succeeded');
  const url = getImageUrl(page?.image);
  if (page && url) return { ...page.image, imageUrl: url, nodeId: page.imageNodeId, status: page.status };
  const sheet = currentSheet(task);
  const previousVersion = sheet?.pageEdit?.pageBases?.find(entry => entry.page === pageNumber)?.version ?? sheet?.pageEdit?.baseVersion;
  const previous = task.executionHistory?.find(execution => execution.version === previousVersion)?.pages?.find(item => item.page === pageNumber && item.status === 'succeeded');
  const previousUrl = getImageUrl(previous?.image);
  return previousUrl ? { ...previous.image, imageUrl: previousUrl, nodeId: previous.imageNodeId, isPrevious: true } : null;
}

function decisionLabel(decision) {
  return ({ retained: '已保留', excluded: '已排除', pending: '待选择' })[decision];
}
function isImageFile(file) { return /image\/(png|jpeg|webp|bmp)/i.test(file?.mimeType || file?.type || '') || /\.(png|jpe?g|webp|bmp)$/i.test(file?.name || ''); }
function attachmentType(file) {
  const extension = String(file?.name || '').split('.').at(-1)?.toUpperCase();
  return ['PDF', 'TXT', 'MD'].includes(extension) ? extension : '文件';
}
function externalHref(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
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

function taskStage(task) {
  if (!task) return 0;
  if (!task.inputConfirmation) return 1;
  if (!sheetAuthorized(task)) return 3;
  if (task.finalApproval?.version === task.sheetVersion) return 6;
  if (task.execution?.status === 'succeeded') return 5;
  return 4;
}

export function Workbench({
  companySearch,
  companyCopyCheck,
  task,
  canvasNeedsSync = false,
  summary,
  onCreate,
  job,
  jobBusy,
  onAction,
  onSetReferences,
  onChat,
  onDraftSheet,
  model = '',
  models = [],
  modelsLoaded = false,
  modelsLoading = false,
  modelError = '',
  modelBusy = false,
  onModelChange,
  onLoadModels,
  onCanvasSync,
  onOpenCanvas,
  onCancelJob,
  onSearchAssets,
  onConfirmReferencesAndContinue,
  onRefresh,
  onRetryChat,
}) {
  const [tab, setTab] = useState('references');
  const [mobilePane, setMobilePane] = useState('chat');
  const [objectCollapsed, setObjectCollapsed] = useState(false);
  const [canvasBusy, setCanvasBusy] = useState(false);
  const [canvasCandidates, setCanvasCandidates] = useState([]);
  const [canvasError, setCanvasError] = useState('');
  const [exportResult, setExportResult] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const conversationScrollRef = useRef(null);
  const followConversationRef = useRef(true);

  useEffect(() => {
    setCanvasCandidates([]);
    setExportResult(null);
    setTab(task?.finalApproval?.version === task?.sheetVersion ? 'review' : task?.sheetVersion ? 'sheet' : 'references');
  }, [task?.id]);

  useEffect(() => { if (task?.sheetVersion) setTab(currentSheet(task)?.kind === 'page-edit' ? 'review' : 'sheet'); }, [task?.sheetVersion]);

  const answersByQuestionMessage = useMemo(() => new Map((task?.conversation || [])
    .filter((message) => message.role === 'user' && message.answers?.messageId && (!message.clientStatus || message.clientStatus === 'accepted'))
    .map((message) => [message.answers.messageId, message.answers])), [task?.conversation]);

  useEffect(() => {
    followConversationRef.current = true;
    const element = conversationScrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [task?.id]);

  useEffect(() => {
    const element = conversationScrollRef.current;
    if (element && followConversationRef.current) element.scrollTop = element.scrollHeight;
  }, [task?.conversation, job?.events, job?.status]);

  function sendMessage(text, answers, attachments) {
    followConversationRef.current = true;
    return onChat(text, answers, attachments);
  }

  async function act(action, payload, options = {}) {
    setActionBusy(true);
    try {
      const result = await onAction(action, payload);
      if (action === 'export') setExportResult(result.export);
      if (options.notice) return result;
      return result;
    } catch {
      return null;
    } finally { setActionBusy(false); }
  }

  async function syncCanvas(payload = { expectedRevision: task.revision }) {
    setCanvasBusy(true); setCanvasError('');
    try {
      const result = await onCanvasSync(payload);
      const found = result.candidates;
      if (found.length) setCanvasCandidates(found);
      else if (!payload.selections) setCanvasCandidates([]);
      return result;
    } catch (cause) {
      setCanvasError(cause.message || '无法读取 Canvas 结果。');
      throw cause;
    } finally { setCanvasBusy(false); }
  }

  if (!task) return <EmptyWorkbench onCreate={onCreate} />;

  const stage = taskStage(task);
  const activeSheet = currentSheet(task);
  const editingPages = activeSheet?.kind === 'page-edit';
  const stageNames = editingPages ? ['对话修改', '绘图', '审核与导出'] : ['需求确认', '参考确认', '制作单确认', '绘图', '审核与导出'];
  const chat = task.conversation;
  const taskJobActive = Boolean(job && !['succeeded', 'failed', 'cancelled'].includes(job.status));
  const actionDisabled = actionBusy || taskJobActive || jobBusy;

  return <div className="workbench">
    <header className="workbench-header">
      <button className="mobile-pane-toggle" onClick={() => setMobilePane(mobilePane === 'chat' ? 'object' : 'chat')} aria-label="切换对话和工作对象">
        {mobilePane === 'chat' ? '查看工作对象' : '返回创作对话'}
      </button>
      <div className="task-heading"><div><h1>{task.title}</h1><p>{formatLabel(task.brief)}<span className="dot-separator">·</span>{task.sheetVersion ? `${editingPages ? '修改记录' : '制作单'} v${task.sheetVersion}` : '需求沟通'}</p></div>
        {summary?.status === 'unreadable' && <span className="status-chip status-bad">任务数据无法读取</span>}
      </div>
      <button type="button" className="button outline small object-panel-toggle" aria-label={objectCollapsed ? '展开工作对象面板' : '收起工作对象面板'} aria-expanded={!objectCollapsed} title={objectCollapsed ? '展开工作对象面板' : '收起工作对象面板'} onClick={() => setObjectCollapsed((collapsed) => !collapsed)}>{objectCollapsed ? '展开工作对象' : '收起工作对象'}</button>
      <button className="button outline canvas-open" onClick={onOpenCanvas}>打开 Canvas <span aria-hidden="true">↗</span></button>
    </header>
    <div className="stage-rail" aria-label="任务阶段">
      {stageNames.map((name, index) => {
        const done = editingPages ? index === 0 || (index === 1 && task.execution?.status === 'succeeded') || (index === 2 && summary?.finalApproved) : stage > index + 1 || (index === 0 && Boolean(task.inputConfirmation)) || (index === 1 && Boolean(task.inputConfirmation)) || (index === 2 && Boolean(task.sheetVersion) && sheetAuthorized(task)) || (index === 3 && task.execution?.status === 'succeeded') || (index === 4 && summary?.finalApproved);
        const current = editingPages ? index === (task.execution?.status === 'succeeded' ? 2 : 1) && !done : stage === index + 1;
        return <div key={name} className={`stage-step ${done ? 'done' : current ? 'current' : ''}`}><span className="stage-number">{done ? '✓' : index + 1}</span><span>{name}</span>{index < stageNames.length - 1 && <i className="stage-connector" />}</div>;
      })}
    </div>
    <div className={`workbench-grid ${objectCollapsed ? 'object-collapsed' : ''}`}>
      <section className={`conversation-panel ${mobilePane === 'chat' ? 'mobile-visible' : 'mobile-hidden'}`} aria-label="创作对话">
        <div className="panel-title-row"><div><span className="eyebrow">正在协作</span><h2>创作对话</h2></div>{taskJobActive && <span className="live-indicator"><i />{jobLabel(job.kind)}</span>}</div>
        <div className="conversation-scroll" id="conversation-scroll" ref={conversationScrollRef} onScroll={(event) => {
          const element = event.currentTarget;
          followConversationRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}>
          <div className="brief-card"><span className="brief-label">本次需求</span><p>{briefText(task.brief) || '需求内容为空。请在对话中补充。'}</p>{task.dna?.enabled && <span className="dna-badge">DNA v{task.dna.revision} 已应用</span>}</div>
          {chat.map((message, index) => <Message
            key={message.id || `${message.role}-${message.requestId || message.createdAt || index}`}
            message={message}
            sources={task.sources || []}
            onRetryChat={onRetryChat}
            answeredAnswers={answersByQuestionMessage.get(message.id)}
            onSubmitAnswers={sendMessage}
            answerDisabled={actionDisabled}
          />)}
          {job && <JobActivity job={job} onCancel={onCancelJob} />}
          {!chat.length && !job && <div className="conversation-empty"><WhaleCharacter pose="idle" /><div><strong>对话已准备好</strong><p>继续描述受众、目标、内容重点或风格要求。Agent 的操作状态会显示在这里。</p></div></div>}
          {task.operations.length > 0 && <details className="operation-history"><summary>查看任务操作记录（{task.operations.length}）</summary><ol>{task.operations.map((operation, index) => <li key={operation.id}><time>{new Date(operation.at).toLocaleString('zh-CN')}</time><strong>{operation.stage}</strong><span>{operation.message}</span></li>)}</ol></details>}
        </div>
        <div className="chat-composer-wrap">
          {!task.canvas?.clientConnected && (task.execution?.pages?.some(page => page.image) || task.executionHistory?.some(execution => execution.pages?.some(page => page.image)) || task.sources?.some(source => source.type === 'current_attachment' && source.decision !== 'excluded')) && <div className="canvas-sync-note"><span>当前绘图页未连接。执行改图前请打开本任务的 Canvas，无需新建对话或重新确认制作单。</span><button className="button outline small" onClick={onOpenCanvas}>连接绘图页</button></div>}
          <div className="composer-model-row">
            <label className="composer-model-control">基础模型<select aria-label="选择基础模型" value={model} onChange={(event) => onModelChange?.(event.target.value)} disabled={modelBusy || !onModelChange}>
              {model && !models.some((item) => item.id === model) && <option value={model}>{model}</option>}
              {!model && <option value="">尚未配置默认模型</option>}
              {models.map((item) => <option key={item.id} value={item.id}>{item.name && item.name !== item.id ? `${item.name}（${item.id}）` : item.id}</option>)}
            </select></label>
            <button type="button" className="button outline small composer-model-refresh" onClick={onLoadModels} disabled={modelsLoading || modelBusy}>{modelsLoading ? '获取中…' : modelsLoaded ? '刷新列表' : '获取模型'}</button>
            {modelError ? <small className="composer-model-status error" role="alert">{modelError}</small> : modelsLoaded && !models.length ? <small className="composer-model-status" role="status">没有返回模型；可在设置页手动填写模型 ID。</small> : modelsLoaded ? <small className="composer-model-status" role="status">已获取 {models.length} 个基础模型。</small> : <small className="composer-model-status">当前任务使用的模型只影响后续对话、制作单整理和读图复审。</small>}
          </div>
          <ChatComposer onSend={(text, attachments) => sendMessage(text, undefined, attachments)} sendDisabled={jobBusy || taskJobActive} />
          <div className="composer-hint"><span>Enter 发送</span><span>·</span><span>Shift + Enter 换行</span></div>
        </div>
      </section>
      <section className={`object-panel ${mobilePane === 'object' ? 'mobile-visible' : 'mobile-hidden'}`} aria-label="当前任务工作对象">
        <div className="object-header"><div><span className="eyebrow">当前工作对象</span><div className="object-title-row"><h2>{tab === 'references' ? '参考素材' : tab === 'sheet' ? '制作单' : '成品审核'}</h2>{activeSheet && tab === 'sheet' && <span className={`version-chip ${sheetAuthorized(task, activeSheet.version) ? 'confirmed' : 'pending'}`}>v{activeSheet.version} · {sheetAuthorized(task, activeSheet.version) ? activeSheet.kind === 'page-edit' ? '对话修改' : '已确认' : '未确认'}</span>}</div></div></div>
        <div className="object-tabs" role="tablist" aria-label="工作对象"><div>{TABS.map(([id, label], index) => <button key={id} id={`tab-${id}`} role="tab" tabIndex={tab === id ? 0 : -1} aria-selected={tab === id} aria-controls={`panel-${id}`} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)} onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          event.preventDefault();
          const direction = event.key === 'ArrowRight' ? 1 : -1;
          const next = TABS[(index + direction + TABS.length) % TABS.length][0];
          setTab(next);
          document.getElementById(`tab-${next}`)?.focus();
        }}>{label}</button>)}</div></div>
        <div className="object-content">
          {tab === 'references' && <ReferencesPanel companySearch={companySearch} task={task} onSetReferences={onSetReferences} onSearchAssets={onSearchAssets} onConfirmAndContinue={onConfirmReferencesAndContinue} busy={actionDisabled} />}
          {tab === 'sheet' && <SheetPanel task={task} sheet={activeSheet} onAction={act} onDraftSheet={onDraftSheet} busy={actionDisabled} />}
          {tab === 'review' && <ReviewPanel task={task} summary={summary} sheet={activeSheet} candidates={canvasCandidates} setCandidates={setCanvasCandidates} onAction={act} onSync={syncCanvas} canvasBusy={canvasBusy} canvasError={canvasError} exportResult={exportResult} busy={actionDisabled} canvasNeedsSync={canvasNeedsSync} />}
          {(tab === 'sheet' || tab === 'review') && companyCopyCheck}
        </div>
        <div className="object-footer">
          {tab === 'references' && <span>保留的素材及事实边界会随任务版本保存。</span>}
          {tab === 'sheet' && <span>{activeSheet ? `确认后按 v${activeSheet.version} 开始绘图。` : '先完成人工确认，再整理制作单。'}</span>}
          {tab === 'review' && <span>只有当前图片完成复审和人工批准后才能导出。</span>}
          {tab === 'review' && <button className="button primary" onClick={() => setTab('sheet')}>查看制作单</button>}
        </div>
      </section>
    </div>
  </div>;
}

function formatLabel(brief) {
  if (brief && typeof brief === 'object') {
    const count = Number(brief.pageCount);
    if (Number.isInteger(count) && count > 0) return `${count} 张 · ${brief.format === 'carousel' ? '图文' : brief.format === 'poster' ? '海报' : '创作任务'}`;
    if (brief.format) return String(brief.format);
  }
  return '创作任务';
}

function Message({ message, sources = [], onRetryChat, answeredAnswers, onSubmitAnswers, answerDisabled }) {
  const [localPreviewUrls, setLocalPreviewUrls] = useState([]);
  const role = message.role;
  const text = message.text;
  const questions = Array.isArray(message.questions) ? message.questions : [];
  const localFiles = Array.isArray(message.attachmentFiles) ? message.attachmentFiles : NO_ATTACHMENTS;
  const sourceAttachments = (message.attachmentSourceIds || []).flatMap((id) => {
      const source = sources.find((item) => item.id === id);
      return (source?.files || []).map((file) => ({ ...file, sourceId: id }));
    });
  const attachments = sourceAttachments.length
    ? sourceAttachments
    : Array.isArray(message.attachments) ? message.attachments : NO_ATTACHMENTS;
  useEffect(() => {
    const urls = localFiles.map((file) => {
      try { return URL.createObjectURL(file); } catch { return ''; }
    });
    setLocalPreviewUrls(urls);
    return () => urls.forEach((url) => { if (url) URL.revokeObjectURL(url); });
  }, [localFiles]);
  if (!String(text || '').trim() && !questions.length) return null;
  const clientStatus = message.clientStatus;
  const statusCopy = clientStatus === 'sending' ? '发送中…' : clientStatus === 'accepted' ? '已发送 · Agent 处理中' : clientStatus === 'uncertain' ? `发送状态待确认：${message.clientError || '网络未返回结果，服务器可能已接受'}。同一请求 ID 可安全重试。` : clientStatus === 'failed' ? `发送失败：${message.clientError || '服务器明确拒绝了请求'}` : '';
  return <div className={`message-row ${role}`}>
    <span className={role === 'user' ? 'user-avatar' : 'agent-avatar'}>{role === 'user' ? '我' : <WhaleAvatar decorative />}</span>
    <div className="message-body">
      {String(text || '').trim() && <div className="message-bubble">{String(text)}</div>}
      {attachments.length > 0 && <div className="message-attachments" aria-label="本条消息附件">{attachments.map((file, index) => {
        const localFile = localFiles[index];
        const preview = localPreviewUrls[index];
        const href = file.fileUrl || file.imageUrl || preview || '';
        const image = isImageFile(file) || isImageFile(localFile);
        const name = file.name || localFile?.name || '附件';
        return <div className="message-attachment" key={`${file.sourceId || ''}-${file.order ?? index}-${name}`}>
          {image && href ? <a href={href} target="_blank" rel="noreferrer" title={`打开附件：${name}`}><img src={href} alt={`${name} 预览`} /></a> : <span className="message-attachment-type">{attachmentType(file.name ? file : localFile)}</span>}
          {href && !preview ? <a className="message-attachment-name" href={href} target="_blank" rel="noreferrer" title={name}>{name}</a> : <span className="message-attachment-name" title={name}>{name}</span>}
          {file.downloadUrl && <a className="message-attachment-name" href={file.downloadUrl} download={name} aria-label={`下载附件：${name}`}>下载</a>}
        </div>;
      })}</div>}
      {questions.length > 0 && <QuestionCard message={message} questions={questions} answeredAnswers={answeredAnswers} disabled={answerDisabled} onSubmit={onSubmitAnswers} />}
      {statusCopy && <div className={`message-delivery ${clientStatus}`} role={['failed', 'uncertain'].includes(clientStatus) ? 'alert' : 'status'}>
        <span>{statusCopy}</span>
        {['failed', 'uncertain'].includes(clientStatus) && message.clientCanRetry !== false && <button type="button" className="text-button" onClick={() => onRetryChat?.(message)}>以同一请求 ID 重试</button>}
      </div>}
      {message.model && <small className="message-model">模型 · {message.model}</small>}
      {message.createdAt && !message.id?.startsWith('client:') && <time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>}
    </div>
  </div>;
}

function QuestionCard({ message, questions, answeredAnswers, disabled, onSubmit }) {
  const [draft, setDraft] = useState(() => Object.fromEntries(questions.map((question) => [question.id, { optionIds: [], otherText: '' }])));
  const [sending, setSending] = useState(false);
  const answered = answeredAnswers?.messageId === message.id;
  const answers = answered ? answeredAnswers.items || [] : [];
  const answerByQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
  const complete = questions.length > 0 && questions.every((question) => {
    const answer = draft[question.id] || { optionIds: [], otherText: '' };
    return answer.optionIds.length > 0 || (question.allowOther && answer.otherText.trim());
  });

  function updateChoice(question, optionId, checked) {
    setDraft((current) => {
      const answer = current[question.id] || { optionIds: [], otherText: '' };
      const optionIds = question.multiple
        ? checked ? [...new Set([...answer.optionIds, optionId])] : answer.optionIds.filter((id) => id !== optionId)
        : checked ? [optionId] : [];
      return { ...current, [question.id]: { ...answer, optionIds } };
    });
  }

  function updateOther(question, otherText) {
    setDraft((current) => {
      const answer = current[question.id] || { optionIds: [], otherText: '' };
      return { ...current, [question.id]: { ...answer, otherText } };
    });
  }

  async function submit(event) {
    event.preventDefault();
    if (!complete || disabled || sending || answered) return;
    const items = questions.map((question) => {
      const answer = draft[question.id] || { optionIds: [], otherText: '' };
      return {
        questionId: question.id,
        optionIds: [...answer.optionIds],
        ...(question.allowOther && answer.otherText.trim() ? { otherText: answer.otherText.trim() } : {}),
      };
    });
    const summary = questions.map((question, index) => {
      const answer = items[index];
      const labels = question.options.filter((option) => answer.optionIds.includes(option.id)).map((option) => option.label);
      if (answer.otherText) labels.push(answer.otherText);
      return `${question.question}：${labels.join('、')}`;
    }).join('\n');
    setSending(true);
    try { await onSubmit?.(`回答 Agent 的补充问题：\n${summary}`, { messageId: message.id, items }); }
    catch { /* The composer keeps the exact request available for retry. */ }
    finally { setSending(false); }
  }

  return <form className={`question-card ${answered ? 'answered' : ''}`} onSubmit={submit}>
    <div className="question-card-head"><strong>{answered ? '已回答' : '选择后继续'}</strong><span>{questions.length} 项</span></div>
    {questions.map((question, index) => {
      const prior = answerByQuestion.get(question.id);
      const selectedIds = answered ? prior?.optionIds || [] : draft[question.id]?.optionIds || [];
      const otherText = answered ? prior?.otherText || '' : draft[question.id]?.otherText || '';
      const multiple = question.multiple === true;
      return <fieldset className="question-item" key={question.id} disabled={disabled || sending || answered}>
        <legend><span>{String(index + 1).padStart(2, '0')}</span>{question.question}</legend>
        <div className="question-options">
          {(question.options || []).map((option) => <label key={option.id} className={`question-option ${selectedIds.includes(option.id) ? 'selected' : ''}`}>
            <input type={multiple ? 'checkbox' : 'radio'} name={`question-${message.id}-${question.id}`} value={option.id} checked={selectedIds.includes(option.id)} onChange={(event) => updateChoice(question, option.id, event.target.checked)} />
            <span>{option.label}</span>
          </label>)}
        </div>
        {question.allowOther && <label className="question-other">其他补充
          <input value={otherText} onChange={(event) => updateOther(question, event.target.value)} placeholder="用几个词说明即可" />
        </label>}
        {answered && (selectedIds.length > 0 || otherText) && <p className="question-answer-copy">你的选择：{[...question.options.filter((option) => selectedIds.includes(option.id)).map((option) => option.label), ...(otherText ? [otherText] : [])].join('、')}</p>}
      </fieldset>;
    })}
    {!answered && <button className="button primary small question-submit" disabled={!complete || disabled || sending}>{sending ? '正在提交…' : '提交选择'}</button>}
  </form>;
}

export function ChatComposer({ onSend, disabled = false, sendDisabled = false, inputId = 'chat-message', label = '告诉 Agent 想怎么改', sendLabel = '发送消息', placeholder = '描述这次要做什么；也可拖入图片或 PDF…', autoFocus = false }) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const valueRevision = useRef(0);
  const [attachmentFiles, setAttachmentFiles] = useState([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [previews, setPreviews] = useState([]);
  const fileInput = useRef(null);
  const textarea = useRef(null);
  useEffect(() => {
    const next = attachmentFiles.map((file) => ({
      name: file.name,
      url: isImageFile(file) ? URL.createObjectURL(file) : '',
      type: isImageFile(file) ? 'image' : 'PDF',
    }));
    setPreviews(next);
    return () => next.forEach((item) => { if (item.url) URL.revokeObjectURL(item.url); });
  }, [attachmentFiles]);

  function addAttachments(incoming) {
    const files = [...(incoming || [])];
    if (!files.length) return;
    const supported = [];
    const rejected = [];
    for (const file of files) {
      const isPdf = file.type === 'application/pdf' || /\.pdf$/iu.test(file.name || '');
      const isImage = isImageFile(file);
      if (!isPdf && !isImage) rejected.push(`${file.name || '未命名文件'}：仅支持图片或 PDF`);
      else if (file.size > 100 * 1024 * 1024) rejected.push(`${file.name || '未命名文件'}：单个文件不能超过 100 MiB`);
      else supported.push(file);
    }
    setAttachmentFiles((current) => {
      const next = [...current, ...supported];
      if (next.length > 20) rejected.push('一次最多添加 20 个附件。');
      return next.slice(0, 20);
    });
    setAttachmentError(rejected.join('；'));
  }

  async function submit() {
    if ((!value.trim() && !attachmentFiles.length) || disabled || sendDisabled || sending) return;
    const message = value.trim();
    const files = [...attachmentFiles];
    const submittedValueRevision = valueRevision.current;
    setSending(true);
    try {
      await onSend(message, files);
      if (valueRevision.current === submittedValueRevision) setValue('');
      setAttachmentFiles((current) => current.filter((file) => !files.includes(file)));
    }
    catch { /* The pending message keeps the same request ID and attachment files for retry. */ }
    finally { setSending(false); textarea.current?.focus(); }
  }

  return <div className="chat-composer-shell">
    {attachmentFiles.length > 0 && <div className="chat-attachment-strip" aria-label="待发送附件">{attachmentFiles.map((file, index) => <div className="chat-attachment-chip" key={`${file.name}-${file.lastModified}-${index}`}>
      {previews[index]?.url ? <img src={previews[index].url} alt={`${file.name} 缩略图`} /> : <span className="chat-attachment-type">{attachmentType(file)}</span>}
      <span className="chat-attachment-name" title={file.name}>{file.name || '剪贴板图片'}</span>
      <button type="button" className="icon-button" aria-label={`移除附件 ${file.name || index + 1}`} onClick={() => setAttachmentFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))} disabled={disabled}>×</button>
    </div>)}</div>}
    {attachmentError && <p className="inline-error" role="alert">{attachmentError}</p>}
    <div className={`chat-composer ${dragging ? 'dragging' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => { event.preventDefault(); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); addAttachments(event.dataTransfer.files); }}>
      <input ref={fileInput} className="chat-file-input" type="file" multiple accept="image/png,image/jpeg,image/webp,image/bmp,application/pdf,.png,.jpg,.jpeg,.webp,.bmp,.pdf" aria-label="选择图片或 PDF 附件" onChange={(event) => { addAttachments(event.target.files); event.target.value = ''; }} disabled={disabled} />
      <button type="button" className="attach-button" onClick={() => fileInput.current?.click()} disabled={disabled} aria-label="选择图片或 PDF 附件">＋</button>
      <label className="visually-hidden" htmlFor={inputId}>{label}</label>
      <textarea ref={textarea} id={inputId} autoFocus={autoFocus} rows={2} value={value} onChange={(event) => { valueRevision.current += 1; setValue(event.target.value); }} onPaste={(event) => {
        const pasted = [...(event.clipboardData?.items || [])].filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter(Boolean);
        if (pasted.length) { event.preventDefault(); addAttachments(pasted); }
      }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder={placeholder} disabled={disabled} />
      <button className="send-button" onClick={submit} aria-label={sendLabel} disabled={disabled || sendDisabled || sending || (!value.trim() && !attachmentFiles.length)}>{sending ? '…' : '➤'}</button>
    </div>
    <p className="attachment-drop-hint">可添加图片或 PDF；拖到此处或按“＋”选择。说明可直接写在上方输入框。</p>
  </div>;
}

function JobActivity({ job, onCancel }) {
  const events = job.events;
  const active = job.status === 'queued' || job.status === 'running';
  return <div className={`job-activity ${active ? 'active' : job.status}`}>
    <div className="job-activity-head"><WhaleCharacter pose={active ? 'busy' : job.status === 'succeeded' ? 'happy' : 'idle'} /><span className="activity-mark">{active ? <i /> : job.status === 'succeeded' ? '✓' : job.status === 'cancelled' ? 'Ⅱ' : '!'}</span><div><strong>{jobLabel(job.kind)}</strong><span>{active ? '服务处理中' : job.status === 'succeeded' ? '操作完成' : job.status === 'cancelled' ? '已停止' : '操作失败'}</span>{job.model && <small className="job-model">本次模型 · {job.model}</small>}</div></div>
    {events.length > 0 && <ul>{events.slice(-5).map((event) => <li key={event.seq}><span className="activity-line" /><span>{event.message}</span></li>)}</ul>}
    {job.result?.message && <p className="job-result">{job.result.message}</p>}
    {job.error?.message && <p className="job-error">{job.error.message}</p>}
    {active && <button className="text-button danger-text" onClick={onCancel}>请求停止</button>}
  </div>;
}

function EmptyWorkbench({ onCreate }) {
  return <div className="empty-workbench"><div className="whale-empty-art"><WhaleCharacter decorative={false} /></div><span className="eyebrow">创作工作台</span><h1>从一个想法开始</h1><p>描述你要做的内容，和 Agent 一起把需求、参考、制作单与成品逐步确认下来。</p><button className="button primary" onClick={onCreate}>＋ 新建创作</button></div>;
}

function ReferencesPanel({ task, onSetReferences, onSearchAssets, onConfirmAndContinue, busy, companySearch }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [selected, setSelected] = useState(null);
  const [purpose, setPurpose] = useState('');
  const [factBoundary, setFactBoundary] = useState('');
  const [external, setExternal] = useState({ title: '', url: '', body: '', purpose: '', factBoundary: '' });
  const [sourceEdits, setSourceEdits] = useState({});
  const sources = task.sources;
  const unresolved = sources.filter((source) => !['retained', 'excluded'].includes(source.decision));
  const inputConfirmed = Boolean(task.inputConfirmation);
  const retainedSources = sources.filter((source) => source.decision === 'retained');
  const hasUnsavedSourceEdits = sources.some((source) => {
    const edit = sourceEdits[source.id];
    return edit && (edit.purpose !== (source.purpose || '') || edit.factBoundary !== (source.factBoundary || ''));
  });

  useEffect(() => { setSourceEdits({}); }, [task.id, task.revision]);

  function editedSource(source) {
    return sourceEdits[source.id] || { purpose: source.purpose || '', factBoundary: source.factBoundary || '' };
  }
  function existingSourceItem(source, decision = source.decision || 'pending') {
    const edit = editedSource(source);
    return { kind: 'existing', id: source.id, decision, purpose: edit.purpose, factBoundary: edit.factBoundary };
  }

  async function search(event) {
    event?.preventDefault();
    setSearching(true); setSearchError('');
    try {
      const found = await onSearchAssets({ query, status: 'confirmed', limit: 30 });
      setResults(found.assets);
    } catch (cause) { setSearchError(cause.message || '素材检索失败。'); }
    finally { setSearching(false); }
  }

  async function addSelected(event) {
    event.preventDefault();
    if (!selected || !purpose.trim() || !factBoundary.trim()) return;
    const items = sources.map((source) => existingSourceItem(source));
    items.push({ kind: 'asset', assetId: selected.id, assetRevision: selected.revision, decision: 'pending', purpose: purpose.trim(), factBoundary: factBoundary.trim() });
    try {
      const result = await onSetReferences({ expectedRevision: task.revision, items });
      if (result) { setSelected(null); setPurpose(''); setFactBoundary(''); }
    } catch { /* The parent presents the conflict and keeps the source editor open. */ }
  }

  async function addExternal(event) {
    event.preventDefault();
    if (!external.title.trim() || (!external.url.trim() && !external.body.trim()) || !external.purpose.trim() || !external.factBoundary.trim()) return;
    const item = {
      kind: 'external',
      id: window.crypto.randomUUID(),
      title: external.title.trim(),
      ...(external.url.trim() ? { url: external.url.trim() } : {}),
      ...(external.body.trim() ? { body: external.body.trim() } : {}),
      decision: 'pending',
      purpose: external.purpose.trim(),
      factBoundary: external.factBoundary.trim(),
    };
    try {
      const result = await onSetReferences({ expectedRevision: task.revision, items: [...sources.map((source) => existingSourceItem(source)), item] });
      if (result) setExternal({ title: '', url: '', body: '', purpose: '', factBoundary: '' });
    } catch { /* The parent presents the conflict and keeps the source editor open. */ }
  }

  async function saveSources(decisionSource, decision) {
    const items = sources.map((source) => existingSourceItem(source, source.id === decisionSource?.id ? decision : source.decision || 'pending'));
    const result = await onSetReferences({ expectedRevision: task.revision, items });
    if (result) setSourceEdits({});
  }

  async function confirmInputs(event) {
    event.preventDefault();
    if (busy || hasUnsavedSourceEdits) return;
    if (!inputConfirmed && unresolved.length > 0) {
      const confirmation = `继续整理制作单时将排除 ${unresolved.length} 项尚未选择的参考素材，保留 ${retainedSources.length} 项。制作单仍会等待你审核确认，之后才会出图。`;
      if (!window.confirm(confirmation)) return;
    }
    await onConfirmAndContinue(task.revision);
  }

  return <div className="reference-panel" id="panel-references" role="tabpanel" aria-labelledby="tab-references">
    <div className="panel-intro"><p>历史素材、当前资料与外部参考都可以加入本任务。逐项保留或排除，并确认借鉴用途和事实边界；只有保留的内容会进入制作单。</p></div>
    {sources.length ? <div className="reference-list">{sources.map((source) => {
      const edit = editedSource(source);
      const dirty = edit.purpose !== (source.purpose || '') || edit.factBoundary !== (source.factBoundary || '');
      const canDecide = Boolean(edit.purpose.trim() && edit.factBoundary.trim());
      return <article className="reference-item" key={source.id}>
        <div className="reference-item-head"><div><strong>{source.title}</strong><span className={`decision-pill ${source.decision}`}>{decisionLabel(source.decision)}</span></div><small>{source.type === 'company' ? `公司素材 · ${source.company.documentId}` : source.type === 'current_attachment' ? '当前任务附件' : source.type === 'external' ? '外部参考' : `本机素材 v${source.asset.revision}`}{source.tags?.length ? ` · ${source.tags.join(' · ')}` : ''}</small></div>
        {source.companyPreviewUrl && <img className="company-source-preview" src={source.companyPreviewUrl} alt={`${source.title}预览`} loading="lazy" />}
        {source.summary && <p className="reference-summary">{source.summary}</p>}
        {source.url && (externalHref(source.url) ? <a className="reference-external-link" href={externalHref(source.url)} target="_blank" rel="noreferrer">{source.url}</a> : <span className="reference-external-link">{source.url}</span>)}
        {source.body && <details><summary>查看提取内容</summary><p className="reference-body">{source.body}</p></details>}
        {source.extractions?.length > 0 && <details><summary>查看附件提取内容（{source.extractions.length}）</summary>{source.extractions.map((extraction, index) => <div className="reference-extraction" key={`${extraction.name}-${index}`}><strong>{extraction.name || `原件 ${index + 1}`}</strong><pre>{extraction.text || extraction.pages?.map((page) => page.text).join('\n\n') || '没有提取到可读文本。'}</pre>{extraction.warnings?.length > 0 && <small>{extraction.warnings.join(' · ')}</small>}</div>)}</details>}
        <div className="reference-edit-fields"><label className="field-label">借鉴用途<input value={edit.purpose} onChange={(event) => setSourceEdits((current) => ({ ...current, [source.id]: { ...edit, purpose: event.target.value } }))} /></label><label className="field-label">事实边界<textarea rows={2} value={edit.factBoundary} onChange={(event) => setSourceEdits((current) => ({ ...current, [source.id]: { ...edit, factBoundary: event.target.value } }))} /></label></div>
        {source.files?.length > 0 && <div className="reference-files" aria-label={`${source.title || '参考素材'}原件`}>
          {source.files.map((file, index) => <a key={`${file.order}-${file.name}`} href={file.fileUrl} target="_blank" rel="noreferrer" title={`查看原件：${file.name}`}>
            {isImageFile(file) ? <img src={file.fileUrl} alt={`${source.title || '参考素材'}原件 ${index + 1}`} /> : <span>{file.name}</span>}
          </a>)}
        </div>}
        <div className="inline-actions">{dirty && <button className="button small outline" onClick={() => saveSources(null, null)} disabled={busy || !canDecide}>保存说明</button>}<button className={`button small ${source.decision === 'retained' ? 'primary' : 'secondary'}`} onClick={() => saveSources(source, 'retained')} disabled={busy || !canDecide}>保留</button><button className={`button small ${source.decision === 'excluded' ? 'selected-neutral' : 'secondary'}`} onClick={() => saveSources(source, 'excluded')} disabled={busy || !canDecide}>排除</button></div>
      </article>;
    })}</div> : <div className="empty-inline"><span className="empty-symbol">⌕</span><div><strong>还没有选择参考素材</strong><p>可以检索素材库、补充当前业务资料，也可以明确确认本次不使用历史参考。</p></div></div>}

    {companySearch}
    <details className="asset-search-block">
      <summary>从本机素材库选择已入库素材</summary>
      <form className="search-form" onSubmit={search}><label className="visually-hidden" htmlFor="reference-search">检索素材</label><input id="reference-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入主题、关键词或标签" /><button className="button outline small" type="submit" disabled={searching}>{searching ? '检索中…' : '检索'}</button></form>
      {searchError && <p className="inline-error" role="alert">{searchError}</p>}
      {results.length > 0 && <div className="asset-result-list">{results.map((asset) => <button className={`asset-result ${selected?.id === asset.id ? 'active' : ''}`} key={asset.id} onClick={() => { setSelected(asset); setPurpose(''); setFactBoundary(''); }}>
        <span className="asset-thumb">{asset.files?.[0]?.fileUrl && isImageFile(asset.files[0]) ? <img src={asset.files[0].fileUrl} alt="" /> : '▧'}</span><span className="asset-result-copy"><strong>{asset.title}</strong><small>{asset.tags?.join(' · ') || '无标签'} · v{asset.revision}</small></span><span className="asset-add-mark">{selected?.id === asset.id ? '✓' : '＋'}</span>
      </button>)}</div>}
      {selected && <form className="selection-form" onSubmit={addSelected}>
        <h3>加入「{selected.title}」</h3>
        <label className="field-label">借鉴用途<input value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="例如：只参考配色和留白" required /></label>
        <label className="field-label">事实边界<textarea rows={2} value={factBoundary} onChange={(event) => setFactBoundary(event.target.value)} placeholder="说明哪些信息不可当作本次事实" required /></label>
        <button className="button primary small" disabled={busy}>加入待选择清单</button>
      </form>}
    </details>

    <details className="external-reference-block">
      <summary>补充当前资料或外部参考</summary>
      <form className="external-reference-form" onSubmit={addExternal}>
        <label className="field-label">资料名称<input value={external.title} onChange={(event) => setExternal((current) => ({ ...current, title: event.target.value }))} required /></label>
        <label className="field-label">网页链接（可选）<input type="url" value={external.url} onChange={(event) => setExternal((current) => ({ ...current, url: event.target.value }))} placeholder="https://…" /></label>
        <label className="field-label">当前业务资料或补充内容<textarea rows={4} value={external.body} onChange={(event) => setExternal((current) => ({ ...current, body: event.target.value }))} placeholder="粘贴本次任务要参考的事实、背景或外部资料" /></label>
        <label className="field-label">借鉴用途<input value={external.purpose} onChange={(event) => setExternal((current) => ({ ...current, purpose: event.target.value }))} required /></label>
        <label className="field-label">事实边界<textarea rows={2} value={external.factBoundary} onChange={(event) => setExternal((current) => ({ ...current, factBoundary: event.target.value }))} required /></label>
        <button className="button outline small" disabled={busy || !external.title.trim() || (!external.url.trim() && !external.body.trim()) || !external.purpose.trim() || !external.factBoundary.trim()}>加入待选择清单</button>
      </form>
    </details>

    <form className="confirmation-box" onSubmit={confirmInputs}>
      <div className="confirmation-heading"><span className="confirm-icon">✓</span><div><strong>{inputConfirmed ? '需求与参考已确认' : '确认需求和参考选择'}</strong><p>{inputConfirmed ? `基于任务版本 ${task.inputConfirmation.revision} 确认。修改需求或参考后需要重新确认。` : '确认后，Agent 才能基于当前需求、来源和 DNA 生成制作单。'}</p></div></div>
      {hasUnsavedSourceEdits && <p className="validation-note">还有未保存的用途或事实边界修改。</p>}
      <button className="button primary full-width" disabled={busy || hasUnsavedSourceEdits}>{inputConfirmed ? '继续整理制作单' : retainedSources.length ? '确认素材并继续' : '不使用参考并继续'}</button>
      {inputConfirmed && <div className="confirmed-record"><span>{task.inputConfirmation.by}</span><span>{task.inputConfirmation.note}</span><time>{formatDate(task.inputConfirmation.confirmedAt)}</time></div>}
    </form>
    {retainedSources.length > 0 && <p className="source-count">当前有 {retainedSources.length} 项参考将进入制作单。</p>}
  </div>;
}

function SheetPanel({ task, sheet, onAction, onDraftSheet, busy }) {
  const [draft, setDraft] = useState(null);
  const [editingConfirmed, setEditingConfirmed] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const inputConfirmed = Boolean(task.inputConfirmation);
  const sheetConfirmed = sheet && sheetAuthorized(task, sheet.version);

  useEffect(() => { setDraft(sheet ? structuredClone(sheet) : null); setEditingConfirmed(false); setPageIndex(0); }, [sheet?.version, task.revision]);

  function updatePage(index, field, value) {
    setDraft((current) => ({ ...current, pages: current.pages.map((page, pageIndex) => pageIndex === index ? { ...page, [field]: value } : page) }));
  }
  const referenceChoices = task.sources.filter(source => source.decision === 'retained').flatMap(source => (source.files || []).filter(file => /\.(png|jpe?g|webp)$/iu.test(file.name || '')).map(file => ({ source, file })));
  function toggleReference(sourceId, fileOrder, checked) {
    setDraft(current => {
      const page = current.pages[pageIndex];
      const references = (page.referenceImages || []).filter(ref => !(ref.sourceId === sourceId && ref.fileOrder === fileOrder));
      if (checked) references.push({ sourceId, fileOrder });
      return { ...current, sourceIds: [...new Set([...(current.sourceIds || []), ...(checked ? [sourceId] : [])])], pages: current.pages.map((value, index) => index === pageIndex ? { ...value, sourceIds: [...new Set([...(value.sourceIds || []), ...(checked ? [sourceId] : [])])], referenceImages: references } : value) };
    });
  }
  const dirty = Boolean(draft && sheet && JSON.stringify({ title: draft.title, sourceIds: draft.sourceIds, pages: draft.pages }) !== JSON.stringify({ title: sheet.title, sourceIds: sheet.sourceIds, pages: sheet.pages }));

  async function save() {
    if (!draft || !dirty) return;
    const result = await onAction('set-sheet', { sheet: { title: draft.title, sourceIds: draft.sourceIds || [], pages: draft.pages }, expectedRevision: task.revision, inputRevision: task.inputConfirmation.revision });
    if (result) setEditingConfirmed(false);
  }
  async function confirm(event) {
    event.preventDefault();
    if (!sheet || dirty) return;
    await onAction('confirm-sheet', { version: sheet.version, by: '本机用户', note: `用户在 Web 点击确认制作单 v${sheet.version}`, expectedRevision: task.revision });
  }
  async function execute() {
    await onAction('execute', { version: sheet.version, expectedRevision: task.revision });
  }

  if (!inputConfirmed && !sheetConfirmed) return <div className="locked-state"><span className="lock-symbol">⌑</span><h3>先确认需求与参考</h3><p>当前制作单只能基于已确认的需求和来源创建。</p><button className="button outline" onClick={() => document.getElementById('tab-references')?.click()}>前往确认</button></div>;
  if (!sheet) return <div className="sheet-empty"><div className="empty-sheet-mark">▤</div><h3>还没有制作单</h3><p>Agent 可以根据已确认的需求与参考整理逐页方案。页数、准确文案和绘图要求都会在这里等待你审核。</p><button className="button primary" onClick={() => onDraftSheet({ expectedRevision: task.revision, inputRevision: task.inputConfirmation.revision })} disabled={busy}>请 Agent 整理制作单</button></div>;

  return <div className="sheet-panel" id="panel-sheet" role="tabpanel" aria-labelledby="tab-sheet">
    <div className="sheet-context"><span>{sheet.pages.length === 1 ? '单张海报' : `${sheet.pages.length} 页图文`}</span><span>{sheet.kind === 'page-edit' ? '按对话修改' : `需求版本 ${sheet.inputsRevision}`}</span><span>{sheetConfirmed ? sheet.kind === 'page-edit' ? '对话已授权' : '已确认' : '待确认'}</span></div>
    {sheetConfirmed && <div className="confirmed-sheet-actions"><span>{sheet.kind === 'page-edit' ? '已按你的对话指令执行局部修改。原版本保留；继续微调可直接在对话中说明。' : '首次创作已确认。已有图片的细节调整可直接在对话中说明；完整改版会创建待确认的新版本。'}</span>{editingConfirmed ? <button type="button" className="button secondary small" onClick={() => { setDraft(structuredClone(sheet)); setEditingConfirmed(false); }}>取消编辑</button> : <button type="button" className="button outline small" onClick={() => setEditingConfirmed(true)} disabled={!inputConfirmed}>编辑完整制作单</button>}</div>}
    <label className="field-label sheet-title-label">制作单标题<input value={draft?.title || ''} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} disabled={busy || (sheetConfirmed && !editingConfirmed)} /></label>
    <div className="sheet-page-tabs" role="tablist" aria-label="制作单页码">{draft?.pages.map((page, index) => <button type="button" key={page.page} role="tab" tabIndex={pageIndex === index ? 0 : -1} aria-selected={pageIndex === index} className={pageIndex === index ? 'selected' : ''} onClick={() => setPageIndex(index)} onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const next = (index + direction + draft.pages.length) % draft.pages.length;
      setPageIndex(next);
      event.currentTarget.parentElement.children[next].focus();
    }}><span>{String(page.page).padStart(2, '0')}</span><small>{draft.pages.length === 1 ? '海报' : `第 ${page.page} 页`}</small></button>)}</div>
    {draft?.pages[pageIndex] && <article className="page-edit" key={`${sheet.version}-${draft.pages[pageIndex].page}`}>
      <div className="page-index"><span>{String(draft.pages[pageIndex].page).padStart(2, '0')}</span><small>{sheet.pages.length === 1 ? '海报' : `第 ${draft.pages[pageIndex].page} 页`}</small><span className="page-mini">▧</span></div>
      <div className="page-fields"><div className="page-field-head"><h3>{draft.pages[pageIndex].page === 1 && draft.pages.length === 1 ? '单张海报' : `第 ${draft.pages[pageIndex].page} 页`}</h3><span>尺寸 {draft.pages[pageIndex].size}</span></div>
        <label className="field-label">页面准确文案<textarea rows={4} value={draft.pages[pageIndex].copy} onChange={(event) => updatePage(pageIndex, 'copy', event.target.value)} disabled={busy || (sheetConfirmed && !editingConfirmed)} /></label>
        <label className="field-label">画面要求<textarea rows={4} value={draft.pages[pageIndex].prompt} onChange={(event) => updatePage(pageIndex, 'prompt', event.target.value)} disabled={busy || (sheetConfirmed && !editingConfirmed)} /></label>
        <label className="field-label">尺寸<input value={draft.pages[pageIndex].size} onChange={(event) => updatePage(pageIndex, 'size', event.target.value)} disabled={busy || (sheetConfirmed && !editingConfirmed)} /></label>
        <fieldset className="sheet-visual-references" disabled={busy || (sheetConfirmed && !editingConfirmed)}>
          <legend>传给绘图模型的参考图 / Logo</legend>
          <p>{draft.pages[pageIndex].referenceImages?.length ? `已选 ${draft.pages[pageIndex].referenceImages.length} 张，会随本页绘图实际发送。` : '本页尚未选择图片，当前会使用纯文字生图。'} Logo 也需从本任务已保留的附件中选择。</p>
          <div className="sheet-reference-grid">{referenceChoices.filter(({source,file}) => !sheetConfirmed || editingConfirmed || draft.pages[pageIndex].referenceImages?.some(ref => ref.sourceId === source.id && ref.fileOrder === file.order)).map(({source,file}) => {
            const selected = Boolean(draft.pages[pageIndex].referenceImages?.some(ref => ref.sourceId === source.id && ref.fileOrder === file.order));
            return <label className={`sheet-reference-choice ${selected ? 'selected' : ''}`} key={`${source.id}-${file.order}`}>
              <input type="checkbox" checked={selected} aria-label={`传图 ${source.title} ${file.name}`} disabled={!selected && (draft.pages[pageIndex].referenceImages?.length || 0) >= 12} onChange={event => toggleReference(source.id, file.order, event.target.checked)} />
              <img src={file.fileUrl} alt={`${source.title} ${file.name}`} loading="lazy" />
              <span title={`${source.title} · ${file.name}`}>{source.title} · {file.name}</span>
            </label>;
          })}</div>
          {!referenceChoices.length && <small>可在对话中上传参考图或 Logo，保留并确认后再整理制作单。</small>}
        </fieldset>
        <div className="page-reference-summary"><span>采用的参考</span><small>{draft.pages[pageIndex].sourceIds.length ? draft.pages[pageIndex].sourceIds.map((id) => task.sources.find((source) => source.id === id)?.title || `来源已移除 ${id}`).join('、') : '未引用'}</small></div>
      </div>
    </article>}
    {!sheetConfirmed && <div className="sheet-actions"><button className="button secondary" onClick={save} disabled={busy || !dirty}>{busy ? '处理中…' : '保存修改'}</button><form className="sheet-confirm-form" onSubmit={confirm}><button className="button primary" disabled={busy || dirty}>{dirty ? '先保存修改' : `确认 v${sheet.version}`}</button></form></div>}
    {sheetConfirmed && editingConfirmed && <div className="sheet-actions"><span>保存会生成一个新的待确认版本。</span><button className="button secondary" onClick={save} disabled={busy || !dirty}>{busy ? '正在保存…' : '保存为新版本'}</button></div>}
    {sheetConfirmed && !editingConfirmed && <div className="execution-box"><div><strong>{executionText(task.execution)}</strong><p>{task.execution?.status === 'succeeded' ? '每页结果已回收，可进入成品审核。' : '绘图会按页面保存结果，已成功的页面不会重复提交。'}</p></div>
      {task.execution?.status === 'pending' && <button className="button primary" onClick={execute} disabled={busy}>确认 v{sheet.version} 并开始绘图</button>}
      {['failed', 'cancelled', 'running'].includes(task.execution?.status) && <button className="button primary" onClick={() => {
        const failed = task.execution.pages.find(page => page.status === 'failed');
        if (failed && !window.confirm(`重试第 ${failed.page} 页并继续后续页？会使用当前图片配置发起新请求，已成功的页面将保留。`)) return;
        onAction('resume', { version: sheet.version, expectedRevision: task.revision, ...(failed ? { retryPage: failed.page } : {}) });
      }} disabled={busy}>{task.execution.pages.some(page => page.status === 'failed') ? '重试失败页并继续' : task.execution.status === 'running' ? '查询并继续' : '继续绘图'}</button>}
      {(task.execution?.pages || []).filter(page => page.status === 'failed').map(page => <button key={page.page} className="button outline" disabled={busy} onClick={() => {
        if (window.confirm(`重试第 ${page.page} 页？这会发起一次新的图片生成请求，已经成功的页面会保留。`)) onAction('resume', { version: sheet.version, expectedRevision: task.revision, retryPage: page.page });
      }}>重试第 {page.page} 页</button>)}
      {task.execution?.status === 'succeeded' && <button className="button outline" onClick={() => document.getElementById('tab-review')?.click()}>查看成品审核</button>}
    </div>}
  </div>;
}

function executionText(execution) {
  switch (execution?.status) {
    case 'running': return '绘图正在执行';
    case 'succeeded': return '绘图已完成';
    case 'failed': return '绘图执行失败';
    case 'cancelled': return '绘图已停止';
    default: return '制作单已确认';
  }
}

function ReviewPanel({ task, summary, sheet, candidates, setCandidates, onAction, onSync, canvasBusy, canvasError, exportResult, busy, canvasNeedsSync }) {
  const [pageNumber, setPageNumber] = useState(1);
  const [notes, setNotes] = useState('');
  const [savingDecision, setSavingDecision] = useState('');
  const [imageExpanded, setImageExpanded] = useState(false);
  const lightboxRef = useRef(null);
  const reviewSavingRef = useRef(false);
  const pages = sheet?.pages || [];
  const imageByPage = useMemo(() => new Map(pages.map((page) => [page.page, imageForPage(task, page.page)])), [task, pages]);
  const currentImage = imageByPage.get(pageNumber);
  const currentReview = canvasNeedsSync || currentImage?.isPrevious ? null : latestReview(task.reviews, task.sheetVersion, pageNumber, currentImage?.sha256);
  const pageExecution = task.execution?.pages?.find((record) => record.page === pageNumber);
  const canRestore = sheet?.kind === 'page-edit' && task.executionHistory?.some(execution => execution.pages?.some(page => page.page === pageNumber && page.status === 'succeeded' && (currentImage?.isPrevious || page.image?.sha256 !== currentImage?.sha256)));
  const passed = !canvasNeedsSync && pages.length > 0 && pages.every((page) => {
    const image = imageByPage.get(page.page);
    return Boolean(image && !image.isPrevious && latestReview(task.reviews, task.sheetVersion, page.page, image.sha256)?.decision === 'pass');
  });
  const finalApproved = !canvasNeedsSync && task.finalApproval?.version === task.sheetVersion;

  useEffect(() => { if (!pages.some((page) => page.page === pageNumber) && pages.length) setPageNumber(pages[0].page); }, [pages, pageNumber]);
  useEffect(() => { setNotes(''); }, [pageNumber, task.id]);
  useEffect(() => {
    if (!imageExpanded) return undefined;
    const previous = document.activeElement;
    const closeButton = lightboxRef.current?.querySelector('button');
    closeButton?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') setImageExpanded(false);
      if (event.key === 'Tab') { event.preventDefault(); closeButton?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus?.(); };
  }, [imageExpanded]);
  async function submitReview(nextDecision) {
    if (canvasNeedsSync || !currentImage || busy || reviewSavingRef.current) return;
    reviewSavingRef.current = true;
    setSavingDecision(nextDecision);
    const reviewNotes = notes.trim() ? notes : (nextDecision === 'pass' ? '用户点击通过本页，未补充文字观察' : '用户标记需修改，具体修改要求待补充');
    try {
      const result = await onAction('record-review', { page: pageNumber, sha256: currentImage.sha256, decision: nextDecision, reviewer: '本机用户', notes: reviewNotes, expectedRevision: task.revision });
      if (result) setNotes('');
    } finally {
      reviewSavingRef.current = false;
      setSavingDecision('');
    }
  }
  async function selectCandidate(candidate) {
    const result = await onAction('canvas-sync', { version: task.sheetVersion, expectedRevision: task.revision, selections: [{ page: candidate.page, nodeId: candidate.nodeId }] });
    if (!result) return;
    setCandidates((items) => items.map((item) => item.page === candidate.page ? { ...item, selected: true } : item));
  }
  async function approve() {
    if (!passed || busy) return;
    const images = pages.map((page) => ({ page: page.page, sha256: imageByPage.get(page.page)?.sha256 }));
    await onAction('approve-final', { version: task.sheetVersion, images, by: '本机用户', note: `用户在 Web 点击批准制作单 v${task.sheetVersion} 的全部当前图片`, expectedRevision: task.revision });
  }

  if (!sheet || !sheetAuthorized(task)) return <div className="locked-state"><span className="lock-symbol">⌑</span><h3>制作单还未确认</h3><p>请先确认具体制作单版本并完成绘图。</p><button className="button outline" onClick={() => document.getElementById('tab-sheet')?.click()}>查看制作单</button></div>;
  if (!pages.length) return <div className="locked-state"><span className="lock-symbol">▧</span><h3>还没有绘图结果</h3><p>确认制作单后，逐页执行结果会显示在这里。</p></div>;

  return <div className="review-panel" id="panel-review" role="tabpanel" aria-labelledby="tab-review">
    <div className="review-toolbar"><span>{task.execution?.status === 'succeeded' ? '实际成品' : executionText(task.execution)}</span><button className="button outline small" onClick={() => onSync({ expectedRevision: task.revision })} disabled={canvasBusy}>↻ {canvasBusy ? '同步中…' : '从 Canvas 同步图像'}</button></div>
    {canvasNeedsSync && <p className="canvas-sync-warning" role="alert">画布结果已改变，请同步选图并复审后再批准。当前审核与批准状态已清除。</p>}
    {canvasError && <p className="inline-error" role="alert">{canvasError}</p>}
    {candidates.length > 0 && <div className="canvas-candidates"><div className="candidate-heading"><strong>Canvas 中的当前任务结果</strong><span>选择后会更新该页图片并撤销旧审核。</span></div>{candidates.map((candidate) => <article className="candidate-card" key={`${candidate.page}-${candidate.nodeId}`}>
      <span className="candidate-page">第 {candidate.page} 页</span>{candidate.imageUrl ? <img src={candidate.imageUrl} alt={`Canvas 第 ${candidate.page} 页候选图片`} /> : <span className="candidate-no-preview">服务没有返回预览</span>}<div className="candidate-actions"><strong>{candidate.title}</strong><button className="button small secondary" onClick={() => selectCandidate(candidate)} disabled={busy || candidate.selected}>{candidate.selected ? '已同步' : '使用此图'}</button></div>
    </article>)}</div>}
    <div className="review-pages">{pages.map((page) => {
      const image = imageByPage.get(page.page);
      const review = canvasNeedsSync ? null : latestReview(task.reviews, task.sheetVersion, page.page, image?.sha256);
      return <button key={page.page} className={`review-page ${pageNumber === page.page ? 'active' : ''}`} onClick={() => setPageNumber(page.page)} aria-label={`审核第 ${page.page} 页`}>
        <span className="review-thumb">{image?.imageUrl ? <img src={image.imageUrl} alt="" /> : <span>▧</span>}</span><span className="review-page-meta"><b>{String(page.page).padStart(2, '0')}</b><small>{page.page === 1 && pages.length === 1 ? '单张海报' : `第 ${page.page} 页`}</small></span><span className={`review-mark ${review?.decision === 'pass' ? 'passed' : review?.decision === 'revise' ? 'revise' : ''}`}>{review?.decision === 'pass' ? '✓' : review?.decision === 'revise' ? '!' : '·'}</span>
      </button>;
    })}</div>
    <div className="review-main">
      <div className="review-image-wrap">
        {currentImage?.imageUrl ? <button className="review-image-button" onClick={() => setImageExpanded(true)} aria-label="放大查看成品图片"><img src={currentImage.imageUrl} alt={`第 ${pageNumber} 页实际成品`} /></button> : <div className="no-image-state"><span>▧</span><strong>第 {pageNumber} 页尚无成品</strong><small>{pageExecution?.status ? `当前状态：${pageExecution.status}` : '等待真实绘图结果'}</small></div>}
        {currentImage && <div className="image-caption"><span>第 {pageNumber} 页 · {currentImage.width || '—'} × {currentImage.height || '—'}</span><span>SHA-256 {String(currentImage.sha256 || '').slice(0, 12)}…</span></div>}
        {currentImage?.isPrevious && <p className="validation-note">本次修改尚未完成，当前显示上一版图片。</p>}
      </div>
      <div className="review-form-wrap">
      <div className="review-copy"><h3>{pageNumber === 1 && pages.length === 1 ? '单张海报' : `第 ${pageNumber} 页`}</h3><p>{pages.find((page) => page.page === pageNumber).copy}</p></div>
        {currentReview && <div className={`review-record ${currentReview.decision}`}><strong>{currentReview.decision === 'pass' ? '当前图片已通过复审' : '当前图片需要修改'}</strong><p>{reviewText(currentReview.notes)}</p><small>{currentReview.reviewer} · {formatDate(currentReview.reviewedAt)}</small></div>}
        {!currentImage && <p className="validation-note">没有可实际查看的图片时，不能提交通过结论。</p>}
        <div className="review-actions"><button type="button" className="button outline small" onClick={() => onAction('review', { page: pageNumber, expectedRevision: task.revision })} disabled={busy || canvasNeedsSync || !currentImage || currentImage.isPrevious}>请 Agent 读图复审本页</button><span>Agent 会检查实际图片；你仍需自行复审并批准。</span></div>
        {currentImage && !currentImage.isPrevious && <div className="review-form">
          <label className="field-label">补充检查记录（可选）<textarea rows={4} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="可选：记录实际看到的文字、清晰度或需要修改的位置" disabled={canvasNeedsSync || busy || Boolean(savingDecision)} /></label>
          <div className="decision-buttons"><button type="button" className="button small primary" onClick={() => submitReview('pass')} disabled={busy || Boolean(savingDecision) || canvasNeedsSync}>{savingDecision === 'pass' ? '保存中…' : '通过'}</button><button type="button" className="button small selected-warn" onClick={() => submitReview('revise')} disabled={busy || Boolean(savingDecision) || canvasNeedsSync}>{savingDecision === 'revise' ? '保存中…' : '需要修改'}</button></div>
        </div>}
        <div className="review-actions">
          {canRestore && <button className="button outline small" onClick={() => onAction('restore-page-edit', { page: pageNumber, expectedRevision: task.revision })} disabled={busy}>恢复本页上一版</button>}
        </div>
        <div className="canvas-sync-note"><span>只修改选中的页面，其他图片保留。你也可以直接在对话里描述要改哪里。</span>{pageExecution?.status === 'failed' && <button className="text-button" onClick={() => {
          if (window.confirm(`重新生成第 ${pageNumber} 页？这会发起一次新的图片生成请求。`)) onAction('resume', { version: task.sheetVersion, expectedRevision: task.revision, retryPage: pageNumber });
        }} disabled={busy}>重试第 {pageNumber} 页</button>}</div>
      </div>
    </div>
    <div className="final-approval-box"><div className="approval-status"><span className={`approval-icon ${finalApproved ? 'approved' : passed ? 'ready' : ''}`}>{finalApproved ? '✓' : passed ? '!' : '·'}</span><div><strong>{finalApproved ? '已批准当前成品' : canvasNeedsSync ? '画布结果已改变，等待同步' : passed ? '所有当前页面已通过复审' : '逐页实际查看并复审'}</strong><p>{finalApproved ? `${task.finalApproval.by} · ${formatDate(task.finalApproval.approvedAt)}` : canvasNeedsSync ? '请同步画布中的新结果，选图后重新复审。' : passed ? '最后一步由你确认当前图片和制作单版本。' : '每一页都要绑定当前图片完成复审，换图后旧审核会失效。'}</p></div></div>
      {finalApproved ? <button className="button primary" onClick={() => onAction('export', { expectedRevision: task.revision })} disabled={busy}>导出素材包</button> : <button className="button primary" onClick={approve} disabled={!passed || busy}>人工批准当前成品</button>}
      {exportResult && <div className="export-record"><strong>素材包已创建</strong><span>{exportResult.version}</span><a className="button outline small" href={exportResult.downloadUrl}>下载素材包</a></div>}
    </div>
    {imageExpanded && currentImage?.imageUrl && <div ref={lightboxRef} className="image-lightbox" role="dialog" aria-modal="true" aria-label={`第 ${pageNumber} 页成品大图`} onClick={() => setImageExpanded(false)} tabIndex={-1}><button type="button" className="lightbox-close" onClick={() => setImageExpanded(false)} aria-label="关闭大图">×</button><img src={currentImage.imageUrl} alt={`第 ${pageNumber} 页实际成品`} onClick={(event) => event.stopPropagation()} /></div>}
  </div>;
}

function reviewText(notes) {
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) return notes.join('；');
  if (notes && typeof notes === 'object') return Object.entries(notes).map(([key, value]) => `${key}：${typeof value === 'string' ? value : JSON.stringify(value)}`).join('；');
  return '';
}

function latestReview(reviews, version, page, sha256) {
  return [...reviews].reverse().find((review) => review.version === version && review.page === page && review.sha256 === sha256);
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
