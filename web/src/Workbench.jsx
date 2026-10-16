import { WhaleCharacter } from './WhaleCharacter.jsx';
import { WhaleAvatar } from './WhaleAvatar.jsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { imageUrl as getImageUrl } from './api.js';

const NO_ATTACHMENTS = [];

function briefText(brief) {
  if (typeof brief === 'string') return brief;
  if (!brief || typeof brief !== 'object') return '';
  return typeof brief.content === 'string' ? brief.content : JSON.stringify(brief, null, 2);
}

function compactText(value, limit) {
  const text = String(value || '').replace(/\s+/gu, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
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
function jobLabel(kind) {
  return ({
    chat: 'Agent 对话',
    'confirm-and-execute': '按确认方案绘图',
    'approve-and-export': '确认交付并打包',
    execute: '逐页绘图',
    resume: '继续绘图',
    'asset-clean': '素材清洗',
    'dna-organize': 'DNA 草稿整理',
  })[kind] || kind;
}

export function Workbench({
  task,
  summary,
  onCreate,
  job,
  jobBusy,
  onAction,
  onChat,
  model = '',
  models = [],
  modelsLoaded = false,
  modelsLoading = false,
  modelError = '',
  modelBusy = false,
  onModelChange,
  onLoadModels,
  onOpenCanvas,
  onCancelJob,
  onRetryChat,
}) {
  const [objectCollapsed, setObjectCollapsed] = useState(false);
  const [exportResult, setExportResult] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const conversationScrollRef = useRef(null);
  const followConversationRef = useRef(true);

  useEffect(() => { setExportResult(null); }, [task?.id, task?.sheetVersion]);

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

  if (!task) return <EmptyWorkbench onCreate={onCreate} />;

  const activeSheet = currentSheet(task);
  const sources = task.sources || [];
  const chat = task.conversation || [];
  const operations = task.operations || [];
  const taskJobActive = Boolean(job && !['succeeded', 'failed', 'cancelled'].includes(job.status));
  const actionDisabled = Boolean(actionBusy || taskJobActive || jobBusy);
  const latestProposalId = [...chat].reverse().find((message) => message.referenceProposal)?.id;
  const executionMatchesSheet = Boolean(activeSheet && task.execution?.version === activeSheet.version);
  const executionSucceeded = executionMatchesSheet && task.execution?.status === 'succeeded';
  const currentExecutionPages = executionSucceeded ? task.execution?.pages || [] : [];
  const deliveryImages = currentExecutionPages.map((page) => ({ page: page.page, sha256: page.image?.sha256 }));
  const currentImagePages = new Set(deliveryImages.filter((image) => typeof image.sha256 === 'string').map((image) => image.page));
  const hasCurrentOutput = Boolean(activeSheet && task.execution?.version === activeSheet.version && task.execution?.pages?.some((page) => page.status === 'succeeded' && page.image));
  const canDeliver = Boolean(executionSucceeded
    && activeSheet?.pages?.length
    && deliveryImages.length === activeSheet.pages.length
    && currentExecutionPages.every((page) => page.status === 'succeeded')
    && deliveryImages.every((image) => typeof image.sha256 === 'string' && /^[a-f0-9]{64}$/iu.test(image.sha256))
    && activeSheet.pages.every((page) => currentImagePages.has(page.page)));
  const finalApproved = summary?.finalApproved === true
    || (summary == null && task.finalApproval?.version === task.sheetVersion);
  const currentExport = finalApproved
    ? exportResult?.sheetVersion === task.sheetVersion ? exportResult : task.exports?.at(-1)
    : null;

  function sendMessage(text, answers, attachments) {
    followConversationRef.current = true;
    return onChat(text, answers, attachments, {
      revision: task.revision,
      sheetVersion: task.sheetVersion,
      referenceProposalId: latestProposalId,
    });
  }

  async function act(action, payload) {
    setActionBusy(true);
    try {
      const result = await onAction(action, payload);
      if (action === 'approve-and-export' && result?.export) {
        setExportResult({ ...result.export, sheetVersion: payload.version });
        if (result.export.downloadUrl) {
          const download = document.createElement('a');
          download.href = result.export.downloadUrl;
          download.download = '';
          document.body.appendChild(download);
          download.click();
          download.remove();
        }
      }
      return result;
    } catch {
      return null;
    } finally {
      setActionBusy(false);
    }
  }

  const pageCount = activeSheet?.pages?.length || 0;
  return <div className="workbench">
    <header className="workbench-header">
      <div className="task-heading"><div><h1>{task.title}</h1><p>{formatLabel(task.brief)}<span className="dot-separator">·</span>{activeSheet ? `${activeSheet.kind === 'page-edit' ? '修改方案' : '方案'} v${activeSheet.version}` : '需求沟通'}</p></div>
        {summary?.status === 'unreadable' && <span className="status-chip status-bad">任务数据无法读取</span>}
      </div>
      <button type="button" className="button outline small object-panel-toggle" aria-label={objectCollapsed ? '展开预览面板' : '收起预览面板'} aria-expanded={!objectCollapsed} title={objectCollapsed ? '展开预览面板' : '收起预览面板'} onClick={() => setObjectCollapsed((collapsed) => !collapsed)}>{objectCollapsed ? '展开预览' : '收起预览'}</button>
      <button className="button outline canvas-open" onClick={onOpenCanvas}>打开 Canvas <span aria-hidden="true">↗</span></button>
    </header>
    <div className={`workbench-grid ${objectCollapsed ? 'object-collapsed' : ''}`}>
      <section className="conversation-panel" aria-label="创作对话">
        <div className="panel-title-row"><div><span className="eyebrow">正在协作</span><h2>创作对话</h2></div>{taskJobActive && <span className="live-indicator"><i />{jobLabel(job.kind)}</span>}</div>
        <div className="conversation-scroll" id="conversation-scroll" ref={conversationScrollRef} onScroll={(event) => {
          const element = event.currentTarget;
          followConversationRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}>
          <div className="brief-card"><span className="brief-label">本次需求</span><p>{briefText(task.brief) || '需求内容为空。请在对话中补充。'}</p>{task.dna?.enabled && <span className="dna-badge">DNA v{task.dna.revision} 已应用</span>}</div>
          {chat.map((message, index) => <Message
            key={message.id || `${message.role}-${message.requestId || message.createdAt || index}`}
            message={message}
            sources={sources}
            onRetryChat={onRetryChat}
            answeredAnswers={answersByQuestionMessage.get(message.id)}
            onSubmitAnswers={sendMessage}
            answerDisabled={actionDisabled}
            proposalStale={message.referenceProposal?.revision !== task.revision || latestProposalId !== message.id}
            onConfirmProposal={() => sendMessage('确认参考方案并继续')}
          />)}
          {activeSheet && !sheetAuthorized(task) && <SchemeDecisionCard
            task={task}
            sheet={activeSheet}
            busy={actionDisabled}
            onConfirm={() => act('confirm-and-execute', {
              version: activeSheet.version,
              expectedRevision: task.revision,
              note: `用户在左侧确认制作单 v${activeSheet.version} 并开始绘图`,
            })}
          />}
          {executionSucceeded && !finalApproved && <section className="dialogue-object delivery-decision" aria-label="成品交付确认">
            <h3>{finalApproved ? '交付已确认' : '成品已完成'}</h3>
            <p>{finalApproved
              ? '当前版本的素材包已准备好，可在右侧预览面板下载。'
              : canDeliver
                ? `当前方案 v${activeSheet.version} 共 ${pageCount} 页。确认后会锁定这些图片并生成下载包。`
                : '成品尚未包含每页的当前图片，请等待绘图完成后再确认交付。'}</p>
            {!finalApproved && <button className="button primary" disabled={!canDeliver || actionDisabled} onClick={() => act('approve-and-export', {
              expectedRevision: task.revision,
              version: activeSheet.version,
              images: deliveryImages,
            })}>{actionBusy ? '正在准备交付…' : '确认交付并下载'}</button>}
          </section>}
          {job && <JobActivity job={job} onCancel={onCancelJob} />}
          {!chat.length && !job && <div className="conversation-empty"><WhaleCharacter pose="idle" /><div><strong>对话已准备好</strong><p>描述目标、内容或风格要求，也可以在看到方案后直接说出要修改的地方。</p></div></div>}
          {operations.length > 0 && <details className="operation-history"><summary>查看任务操作记录（{operations.length}）</summary><ol>{operations.map((operation) => <li key={operation.id}><time>{new Date(operation.at).toLocaleString('zh-CN')}</time><strong>{operation.stage}</strong><span>{operation.message}</span></li>)}</ol></details>}
        </div>
        <div className="chat-composer-wrap">
          <div className="composer-model-row">
            <label className="composer-model-control">基础模型<select aria-label="选择基础模型" value={model} onChange={(event) => onModelChange?.(event.target.value)} disabled={modelBusy || !onModelChange}>
              {model && !models.some((item) => item.id === model) && <option value={model}>{model}</option>}
              {!model && <option value="">尚未配置默认模型</option>}
              {models.map((item) => <option key={item.id} value={item.id}>{item.name && item.name !== item.id ? `${item.name}（${item.id}）` : item.id}</option>)}
            </select></label>
            <button type="button" className="button outline small composer-model-refresh" onClick={onLoadModels} disabled={modelsLoading || modelBusy}>{modelsLoading ? '获取中…' : modelsLoaded ? '刷新列表' : '获取模型'}</button>
            {modelError ? <small className="composer-model-status error" role="alert">{modelError}</small> : modelsLoaded && !models.length ? <small className="composer-model-status" role="status">没有返回模型；可在设置页手动填写模型 ID。</small> : modelsLoaded ? <small className="composer-model-status" role="status">已获取 {models.length} 个基础模型。</small> : <small className="composer-model-status">当前模型用于对话理解和方案整理。</small>}
          </div>
          <ChatComposer onSend={(text, attachments) => sendMessage(text, undefined, attachments)} sendDisabled={jobBusy || taskJobActive || actionBusy} />
          <div className="composer-hint"><span>Enter 发送</span><span>·</span><span>Shift + Enter 换行</span></div>
        </div>
      </section>
      <section className="object-panel" aria-label="当前任务预览">
        <div className="object-header"><div><span className="eyebrow">当前任务预览</span><div className="object-title-row"><h2>{hasCurrentOutput ? '成品预览' : activeSheet ? '方案预览' : '任务预览'}</h2>{activeSheet && <span className={`version-chip ${sheetAuthorized(task) ? 'confirmed' : 'pending'}`}>v{activeSheet.version} · {sheetAuthorized(task) ? '已确认' : '待确认'}</span>}</div></div></div>
        <div className="object-content"><ObjectPreview task={task} sheet={activeSheet} executionSucceeded={executionSucceeded} /></div>
        <div className="object-footer">
          <span>{currentExport ? `版本 v${activeSheet?.version} · 素材包已就绪` : '图片预览与版本信息显示在这里；修改意见直接发在左侧对话。'}</span>
          {currentExport?.downloadUrl && <a className="button outline small" href={currentExport.downloadUrl} download>下载素材包</a>}
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

function Message({ proposalStale, onConfirmProposal,  message, sources = [], onRetryChat, answeredAnswers, onSubmitAnswers, answerDisabled }) {
  const [localPreviewUrls, setLocalPreviewUrls] = useState([]);
  const role = message.role;
  const text = message.text;
  const questions = Array.isArray(message.questions) ? message.questions : [];
  const proposalBrief = compactText(briefText(message.referenceProposal?.brief), 240);
  const localFiles = Array.isArray(message.attachmentFiles) ? message.attachmentFiles : NO_ATTACHMENTS;
  const sourceAttachments = (message.attachmentSourceIds || []).flatMap((id) => {
      const source = sources.find((item) => item.id === id);
      return (source?.files || []).map((file) => ({ ...file, sourceId: id }));
    });
  const attachments = sourceAttachments.length
    ? sourceAttachments
    : [...(Array.isArray(message.attachments) ? message.attachments : []), ...(Array.isArray(message.deliverables) ? message.deliverables : [])];
  useEffect(() => {
    const urls = localFiles.map((file) => {
      try { return URL.createObjectURL(file); } catch { return ''; }
    });
    setLocalPreviewUrls(urls);
    return () => urls.forEach((url) => { if (url) URL.revokeObjectURL(url); });
  }, [localFiles]);
  if (!String(text || '').trim() && !questions.length && !attachments.length && !message.referenceProposal) return null;
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
      {message.referenceProposal && <div className="brief-card">
        <strong>待确认需求与参考 · 任务版本 {message.referenceProposal.revision}</strong>
        <p>需求摘要：{proposalBrief || '未提供文字摘要'}</p>
        {message.referenceProposal.items?.length
          ? message.referenceProposal.items.map((item) => <p key={item.id}>{sources.find((source) => source.id === item.id)?.title || item.id}：{decisionLabel(item.decision)} · {compactText(item.purpose, 160)}</p>)
          : <p>本次不使用参考素材。</p>}
        <small>{proposalStale ? '此方案已过期，请以最新讨论为准。' : '可以直接在对话中提出修改，或确认后继续。'}</small>
        <button type="button" className="button small primary" onClick={onConfirmProposal} disabled={answerDisabled || proposalStale}>确认参考方案并继续</button>
      </div>}
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

export function ChatComposer({ onSend, disabled = false, sendDisabled = false, inputId = 'chat-message', label = '告诉 Agent 想怎么改', sendLabel = '发送消息', placeholder = '描述这次要做什么；也可拖入文档、表格或图片…', autoFocus = false }) {
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
      if (!isPdf && !isImage && !/\.(docx|doc|xlsx|xls|csv|txt|md|zip)$/iu.test(file.name || '')) rejected.push(`${file.name || '未命名文件'}：不支持该附件格式`);
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
      <input ref={fileInput} className="chat-file-input" type="file" multiple accept="image/png,image/jpeg,image/webp,image/bmp,application/pdf,.png,.jpg,.jpeg,.webp,.bmp,.pdf,.docx,.doc,.xlsx,.xls,.csv,.txt,.md,.zip" aria-label="选择文档、表格或图片附件" onChange={(event) => { addAttachments(event.target.files); event.target.value = ''; }} disabled={disabled} />
      <button type="button" className="attach-button" onClick={() => fileInput.current?.click()} disabled={disabled} aria-label="选择文档、表格或图片附件">＋</button>
      <label className="visually-hidden" htmlFor={inputId}>{label}</label>
      <textarea ref={textarea} id={inputId} autoFocus={autoFocus} rows={2} value={value} onChange={(event) => { valueRevision.current += 1; setValue(event.target.value); }} onPaste={(event) => {
        const pasted = [...(event.clipboardData?.items || [])].filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter(Boolean);
        if (pasted.length) { event.preventDefault(); addAttachments(pasted); }
      }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder={placeholder} disabled={disabled} />
      <button className="send-button" onClick={submit} aria-label={sendLabel} disabled={disabled || sendDisabled || sending || (!value.trim() && !attachmentFiles.length)}>{sending ? '…' : '➤'}</button>
    </div>
    <p className="attachment-drop-hint">可添加文档、表格、图片或 ZIP；拖到此处或按“＋”选择。说明可直接写在上方输入框。</p>
  </div>;
}

function JobActivity({ job, onCancel }) {
  if (job.status === 'succeeded') return null;
  const events = Array.isArray(job.events) ? job.events : [];
  const active = job.status === 'queued' || job.status === 'running';
  const failed = job.status === 'failed';
  const latestProgress = events.at(-1)?.message;
  const details = events.length > 0 || job.model || job.result?.message;
  return <div className={`job-activity ${active ? 'active' : job.status}`}>
    <div className="job-activity-head"><span className="activity-mark">{active ? <i /> : failed ? '!' : 'Ⅱ'}</span><div>
      <strong>{active ? `${jobLabel(job.kind)}中` : failed ? `${jobLabel(job.kind)}失败` : `${jobLabel(job.kind)}已停止`}</strong>
      <span>{active ? compactText(latestProgress || '正在处理…', 180) : failed ? compactText(job.error?.message || job.result?.message || '操作失败', 240) : '操作已停止。你可以在对话中调整后继续。'}</span>
    </div></div>
    {active && <button className="text-button danger-text" onClick={onCancel}>请求停止</button>}
    {details && <details><summary>查看操作详情</summary>
      {job.model && <p className="job-model">本次模型 · {job.model}</p>}
      {events.length > 0 && <ul>{events.slice(-5).map((event) => <li key={event.seq}><span className="activity-line" /><span>{compactText(event.message, 180)}</span></li>)}</ul>}
      {job.result?.message && <p className="job-result">{compactText(job.result.message, 240)}</p>}
    </details>}
  </div>;
}

function EmptyWorkbench({ onCreate }) {
  return <div className="empty-workbench"><div className="whale-empty-art"><WhaleCharacter decorative={false} /></div><span className="eyebrow">创作工作台</span><h1>从一个想法开始</h1><p>描述要做的内容，或拖入资料，助手会整理并给出结果。</p><button className="button primary" onClick={onCreate}>＋ 新建创作</button></div>;
}


function pageReferenceUsage(task, page) {
  const sources = task.sources || [];
  const references = page.referenceImages || [];
  if (!references.length) return '未指定参考图片';
  return references.map((reference) => {
    const source = sources.find((item) => item.id === reference.sourceId);
    const file = source?.files?.find((item) => item.order === reference.fileOrder);
    const role = reference.role === 'content' ? '内容参考' : reference.role === 'style' ? '风格参考' : '内容与风格参考';
    const name = [source?.title, file?.name].filter(Boolean).join(' · ') || '参考图片';
    return `${name}（${role}）`;
  }).join('；');
}

function SchemeDecisionCard({ task, sheet, busy, onConfirm }) {
  return <details className="dialogue-object" open>
    <summary>待确认方案 · v{sheet.version}</summary>
    <div className="preview-gallery">
      <h3>{sheet.title || '本次制作方案'}</h3>
      {sheet.pages.map((page) => <article key={page.page}>
        <strong>第 {page.page} 页 · {page.size || '尺寸未注明'}</strong>
        <p>{page.copy || '尚未填写页面文案'}</p>
        <small>图片用途：{pageReferenceUsage(task, page)}</small>
        <details><summary>查看画面细节</summary><p>{page.prompt || '暂无额外画面说明'}</p></details>
      </article>)}
      <button className="button primary" onClick={onConfirm} disabled={busy}>按此方案开始制作</button>
    </div>
  </details>;
}

function ObjectPreview({ task, sheet, executionSucceeded }) {
  if (!sheet) {
    const files = [...new Map((task.conversation || []).flatMap(message => message.deliverables || []).map(file => [file.downloadUrl || file.fileUrl, file])).values()];
    return <div className="preview-gallery">{files.length ? files.map((file, index) => <article key={file.downloadUrl || index}>
      <strong>{file.name || '任务文件'}</strong>
      {isImageFile(file) && (file.imageUrl || file.fileUrl) && <a href={file.imageUrl || file.fileUrl} target="_blank" rel="noreferrer"><img src={file.imageUrl || file.fileUrl} alt={file.name || '任务图片'} /></a>}
      <p><a className="button outline small" href={file.downloadUrl || file.fileUrl} download={file.name}>下载文件</a></p>
    </article>) : <p>任务生成的图片和文件会显示在这里。</p>}</div>;
  }
  return <div className="preview-gallery">
    <h3>{sheet.title || '本次制作方案'} · v{sheet.version}</h3>
    {(sheet.pages || []).map((page) => {
      const image = imageForPage(task, page.page);
      const currentImage = image && !image.isPrevious;
      return <article key={page.page}>
        <strong>第 {page.page} 页 · {page.size || '尺寸未注明'}{image?.isPrevious ? ' · 上一版' : ''}</strong>
        {image?.imageUrl ? <a href={image.imageUrl} target="_blank" rel="noreferrer"><img src={image.imageUrl} alt={`第 ${page.page} 页${image.isPrevious ? '上一版' : '当前'}图片`} /></a> : <p>{executionSucceeded ? '当前版本没有可预览的图片' : '方案尚未出图'}</p>}
        {currentImage ? image.width && image.height ? <small>{image.width} × {image.height}</small> : null : <>
          <p>{page.copy || '尚未填写页面文案'}</p>
          <small>图片用途：{pageReferenceUsage(task, page)}</small>
          <details><summary>查看画面细节</summary><p>{page.prompt || '暂无额外画面说明'}</p></details>
          {image?.isPrevious && <small>本次方案尚未生成新图，当前显示上一版。</small>}
        </>}
      </article>;
    })}
  </div>;
}
