import { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

function recordsFrom(response) { return response.assets; }
function assetFrom(response) { return response.asset; }
function stateLabel(status) {
  const labels = { staged: '待清洗', cleaning: '清洗中', needs_review: '待人工确认', clean_failed: '清洗失败', clean_cancelled: '已停止清洗', clean_config_missing: '缺少模型配置', confirmed: '已入库', deleted: '已删除' };
  return labels[status] || status || '状态未知';
}
function isImage(file) { return /image\/(png|jpeg|webp|bmp)/i.test(file.mimeType || '') || /\.(png|jpe?g|webp|bmp)$/i.test(file.name || ''); }
const IMPORT_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'txt', 'md', 'pdf']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp']);
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'pdf']);

function extension(name = '') { return String(name).split('.').at(-1)?.toLowerCase() || ''; }
function relativeFolder(path) {
  const segments = String(path || '').split('/').filter(Boolean);
  const relative = segments.length > 1 ? segments.slice(1) : segments;
  return relative.length > 1 ? relative.slice(0, -1).join('/') : '';
}
function describeFolderFiles(files) {
  const accepted = [];
  const ignored = [];
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    const basename = path.split('/').at(-1) || file.name;
    if (basename === '.DS_Store') { ignored.push({ name: path, reason: '系统文件' }); continue; }
    if (!IMPORT_EXTENSIONS.has(extension(basename))) { ignored.push({ name: path, reason: '暂不支持此格式' }); continue; }
    accepted.push({ file, path, basename, directory: relativeFolder(path) });
  }
  const grouped = new Map();
  for (const item of accepted) {
    const key = item.directory || '__selected-folder__';
    const current = grouped.get(key) || { key, directory: item.directory, files: [] };
    current.files.push(item);
    grouped.set(key, current);
  }
  const groups = [...grouped.values()].map((group) => {
    group.files.sort((left, right) => left.basename.localeCompare(right.basename, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    const segments = group.directory.split('/').filter(Boolean);
    const samplePath = group.files[0]?.path?.split('/').filter(Boolean) || [];
    const title = segments.at(-1) || samplePath[0] || '所选文件夹';
    return {
      ...group,
      title,
      imageCount: group.files.filter((item) => IMAGE_EXTENSIONS.has(extension(item.basename))).length,
      textCount: group.files.filter((item) => TEXT_EXTENSIONS.has(extension(item.basename))).length,
    };
  }).sort((left, right) => left.title.localeCompare(right.title, 'zh-CN', { numeric: true, sensitivity: 'base' }));
  return { groups, ignored };
}

export function Library({ tags: initialTags, refreshKey, onRun, onStartJob, job }) {
  const [items, setItems] = useState([]);
  const [asset, setAsset] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tagState, setTagState] = useState(initialTags || { revision: 1, tags: [] });
  const [tagEdit, setTagEdit] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [tagDeleteConfirm, setTagDeleteConfirm] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importFiles, setImportFiles] = useState([]);
  const [importTitle, setImportTitle] = useState('');
  const [importBody, setImportBody] = useState('');
  const [importTags, setImportTags] = useState('');
  const [importSource, setImportSource] = useState('');
  const [importMode, setImportMode] = useState('single');
  const [folderGroups, setFolderGroups] = useState([]);
  const [folderIgnored, setFolderIgnored] = useState([]);
  const [folderBatchId, setFolderBatchId] = useState('');
  const [folderResults, setFolderResults] = useState(null);
  const [folderClean, setFolderClean] = useState(null);
  const [folderLimitError, setFolderLimitError] = useState('');
  const [edit, setEdit] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [replacementFiles, setReplacementFiles] = useState([]);

  useEffect(() => { setTagState(initialTags || { revision: 1, tags: [] }); }, [initialTags, refreshKey]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(async () => {
      setLoading(true); setError('');
      try {
        const response = await api.assets({ query, tags: tagFilter, status: statusFilter, limit: 100 });
        if (!active) return;
        const nextItems = recordsFrom(response);
        setItems(nextItems);
        if (!selectedId && nextItems.length) setSelectedId(nextItems[0].id);
        if (selectedId && !nextItems.some((item) => item.id === selectedId)) setSelectedId(nextItems[0]?.id || '');
        if (!nextItems.length) { setSelectedId(''); setAsset(null); }
      } catch (cause) { if (active) setError(cause.message || '无法读取素材库。'); }
      finally { if (active) setLoading(false); }
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, tagFilter, statusFilter, refreshKey]);

  useEffect(() => {
    if (!selectedId) { setAsset(null); setEdit(null); return; }
    let active = true;
    api.asset(selectedId).then((response) => {
      if (!active) return;
      const next = assetFrom(response);
      setAsset(next);
      setEdit({ title: next.title || '', body: next.body || '', summary: next.summary || '', tags: (next.tags || []).join(', '), source: typeof next.source === 'string' ? next.source : JSON.stringify(next.source || {}, null, 2) });
      setDeleteConfirm(false);
      setReplacementFiles([]);
    }).catch((cause) => { if (active) setError(cause.message || '无法打开这条素材。'); });
    return () => { active = false; };
  }, [selectedId, refreshKey]);

  const activeCount = useMemo(() => items.filter((item) => item.status !== 'deleted').length, [items]);

  async function perform(operation, success) {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await onRun(operation, { success });
      if (success) setNotice(success);
      return result;
    } catch (cause) { setError(cause.message || '素材操作失败。'); return null; }
    finally { setBusy(false); }
  }

  async function performJob(operation) {
    setError(''); setNotice('');
    try { return await onStartJob(operation); }
    catch (cause) { setError(cause.message || '操作没有提交。'); return null; }
  }

  function moveFile(list, setList, index, delta) {
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const next = [...list]; [next[index], next[target]] = [next[target], next[index]]; setList(next);
  }

  async function importAsset(event) {
    event.preventDefault();
    if (!importTitle.trim() || !importFiles.length) { setError('请填写素材名称并至少选择一个原件。'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const form = new FormData();
      form.append('title', importTitle.trim());
      form.append('body', importBody);
      form.append('tags', JSON.stringify(splitTags(importTags)));
      let source = { kind: 'user-provided' };
      if (importSource.trim()) {
        try { source = JSON.parse(importSource); }
        catch { source = importSource.trim(); }
      }
      form.append('source', JSON.stringify(source));
      importFiles.forEach((file) => form.append('files', file, file.name));
      const response = await onRun(() => api.importAssets(form), { success: '原件已暂存，可以开始 AI 清洗。' });
      const created = assetFrom(response);
      setShowImport(false); setImportFiles([]); setImportTitle(''); setImportBody(''); setImportTags(''); setImportSource('');
      if (created?.id) setSelectedId(created.id);
      setNotice('原件已暂存，可以开始 AI 清洗。');
    } catch (cause) { setError(cause.message || '导入素材失败。'); }
    finally { setBusy(false); }
  }

  function chooseFolder(event) {
    const files = Array.from(event.target.files || []);
    const { groups, ignored } = describeFolderFiles(files);
    setFolderGroups(groups);
    setFolderIgnored(ignored);
    setFolderBatchId(window.crypto.randomUUID());
    setFolderResults(null);
    setFolderClean(null);
    const accepted = groups.flatMap((group) => group.files);
    const oversized = accepted.find((entry) => entry.file.size > 100 * 1024 * 1024);
    const totalSize = accepted.reduce((sum, entry) => sum + entry.file.size, 0);
    const limitError = accepted.length > 1000
      ? '批量导入最多支持 1000 个文件。'
      : oversized
        ? `单个文件超过 100 MiB：${oversized.basename}`
        : totalSize > 250 * 1024 * 1024
          ? '这批文件超过 250 MiB，请分批选择。'
          : '';
    setFolderLimitError(limitError);
    setError(groups.length ? '' : '文件夹内没有可导入的图片、TXT、MD 或 PDF。');
    event.target.value = '';
  }

  function moveFolderGroup(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= folderGroups.length) return;
    setFolderGroups((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function importFolder(event) {
    event.preventDefault();
    if (!folderGroups.length || !folderBatchId) { setError('请先选择包含文章子文件夹的目录。'); return; }
    if (folderLimitError) { setError(folderLimitError); return; }
    const extractAfterImport = event.nativeEvent.submitter?.value === 'extract';
    if (extractAfterImport && !window.confirm(`将批量暂存 ${folderGroups.length} 篇素材，并逐篇调用基础模型提取与清洗？每篇仍需你单独检查并确认入库。`)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const entries = folderGroups.flatMap((group) => group.files);
      const form = new FormData();
      form.append('batchId', folderBatchId);
      form.append('paths', JSON.stringify(entries.map((entry) => entry.path)));
      entries.forEach((entry) => form.append('files', entry.file, entry.basename));
      const response = await onRun(() => api.importFolderAssets(form), { success: extractAfterImport ? '文件夹素材已批量暂存，正在逐篇调用 AI 清洗。' : '文件夹素材已批量暂存。' });
      setFolderResults(response);
      const stagedEntries = (response.entries || []).filter((entry) => entry.status === 'staged' && entry.asset?.id);
      const staged = stagedEntries[0];
      if (staged) setSelectedId(staged.asset.id);
      if (extractAfterImport && stagedEntries.length) {
        setFolderClean({ queue: stagedEntries, current: null, completed: [], stopped: false, active: true, done: false });
        setNotice(`批量导入完成：${stagedEntries.length} 篇进入 AI 清洗队列，${response.totals?.failed ?? 0} 篇导入失败。`);
      } else {
        setNotice(`批量导入完成：${response.totals?.staged ?? 0} 篇已暂存，${response.totals?.failed ?? 0} 篇失败。`);
      }
    } catch (cause) { setError(cause.message || '批量导入素材失败。'); }
    finally { setBusy(false); }
  }

  async function startBatchClean() {
    const priorCompleted = folderClean?.completed || [];
    const finishedStatuses = new Set(['succeeded', 'confirmed', 'needs_review']);
    const completedIds = new Set(priorCompleted.filter((item) => finishedStatuses.has(item.status)).map((item) => item.entry.asset?.id));
    const staged = (folderResults?.entries || []).filter((entry) => entry.status === 'staged' && entry.asset?.id && !completedIds.has(entry.asset.id));
    if (!staged.length || busy || folderClean?.active) return;
    if (!window.confirm(`将逐篇调用 AI 清洗这 ${staged.length} 篇素材？每篇仍需你单独检查并确认入库。`)) return;
    setBusy(true);
    const queue = [];
    const completed = priorCompleted.filter((item) => finishedStatuses.has(item.status));
    try {
      for (const entry of staged) {
        try {
          const detail = await api.asset(entry.asset.id);
          const latest = detail.asset;
          if (latest.status === 'confirmed') completed.push({ entry, status: 'confirmed' });
          else if (latest.status === 'needs_review') completed.push({ entry, status: 'needs_review' });
          else queue.push({ ...entry, asset: latest });
        } catch (cause) {
          completed.push({ entry, status: 'failed', error: { message: cause.message || '读取素材当前版本失败。' } });
        }
      }
      setFolderClean({ queue, current: null, completed, stopped: false, active: true, done: false });
    } finally { setBusy(false); }
  }

  function stopBatchClean() {
    setFolderClean((current) => current ? { ...current, stoppedCount: current.queue.length, queue: [], stopped: true } : current);
  }

  useEffect(() => {
    if (!folderClean?.active || folderClean.done || folderClean.current) return;
    if (job && ['queued', 'running'].includes(job.status)) return;
    if (folderClean.stopped || !folderClean.queue.length) {
      setFolderClean((current) => current ? { ...current, active: false, done: true } : current);
      return;
    }
    const [entry, ...queue] = folderClean.queue;
    setFolderClean((current) => current ? { ...current, queue, current: { entry, state: 'starting' } } : current);
    (async () => {
      try {
        const result = await onStartJob(() => api.cleanAsset(entry.asset.id, { expectedRevision: entry.asset.revision }));
        if (result?.job?.id) {
          setFolderClean((current) => current?.current?.entry.asset.id === entry.asset.id ? { ...current, current: { entry, jobId: result.job.id, state: 'running' } } : current);
        } else {
          setFolderClean((current) => current ? { ...current, current: null, completed: [...current.completed, { entry, status: 'failed', error: { message: '清洗任务没有返回状态。' } }] } : current);
        }
      } catch (cause) {
        setFolderClean((current) => current ? { ...current, current: null, completed: [...current.completed, { entry, status: 'failed', error: { message: cause.message || '清洗未提交。' } }] } : current);
      }
    })();
  }, [folderClean, job?.id, job?.status, onStartJob]);

  useEffect(() => {
    const current = folderClean?.current;
    if (!current?.jobId || job?.id !== current.jobId || !['succeeded', 'failed', 'cancelled'].includes(job.status)) return;
    setFolderClean((state) => state ? {
      ...state,
      current: null,
      completed: [...state.completed, { entry: current.entry, status: job.status, error: job.error }],
    } : state);
  }, [job, folderClean?.current?.jobId]);

  async function saveEdit(event) {
    event.preventDefault();
    if (!asset || !edit) return;
    let source = edit.source;
    try { source = JSON.parse(edit.source); } catch { /* A source label may be plain text. */ }
    await perform(() => api.editAsset(asset.id, { expectedRevision: asset.revision, title: edit.title, body: edit.body, summary: edit.summary, tags: splitTags(edit.tags), source }), '人工修改已保存，素材需要重新确认入库。');
  }

  async function clean() {
    if (!asset) return;
    await performJob(() => api.cleanAsset(asset.id, { expectedRevision: asset.revision }));
  }

  async function confirmAsset(event) {
    event.preventDefault();
    if (!asset) return;
    await perform(() => api.confirmAsset(asset.id, { expectedRevision: asset.revision, by: '本机用户', note: `用户在 Web 点击确认素材 v${asset.revision} 入库` }), '素材已人工确认并加入总库。');
  }

  async function replaceFiles() {
    if (!asset || !replacementFiles.length) return;
    const form = new FormData();
    form.append('expectedRevision', String(asset.revision));
    replacementFiles.forEach((file) => form.append('files', file, file.name));
    await perform(() => api.replaceAssetFiles(asset.id, form), '原件已替换；请重新清洗并确认。');
  }

  async function removeAsset() {
    if (!asset) return;
    if (!deleteConfirm) { setDeleteConfirm(true); return; }
    const result = await perform(() => api.deleteAsset(asset.id, { expectedRevision: asset.revision }), '素材已移入回收状态。');
    if (result) setDeleteConfirm(false);
  }

  async function renameTag(tag) {
    if (!tagDraft.trim() || tagDraft.trim() === tag) { setTagEdit(''); return; }
    const result = await perform(() => api.renameTag({ tag, newTag: tagDraft.trim(), expectedRevision: tagState.revision }), '标签已改名。');
    if (result) { setTagEdit(''); setTagDraft(''); await refreshTags(); }
  }
  async function deleteTag(tag) {
    const result = await perform(() => api.deleteTag({ tag, expectedRevision: tagState.revision }), '标签已从关联素材中移除。');
    if (result) { setTagDeleteConfirm(''); await refreshTags(); }
  }
  async function refreshTags() {
    try { setTagState(await api.tags()); } catch (cause) { setError(cause.message || '读取标签失败。'); }
  }

  return <section className="library-page">
    <header className="section-header library-header"><div><span className="eyebrow">同一个总库 · 自由标签</span><h1>素材库</h1><p>上传原件后可显式发起 AI 清洗；检查提取内容并人工修正，确认后才会供任务检索。</p></div><button className="button primary" onClick={() => setShowImport((value) => !value)}>＋ 导入素材</button></header>
    {(error || notice) && <div className={`inline-banner ${error ? 'error' : 'success'}`} role={error ? 'alert' : 'status'}>{error || notice}<button className="icon-button" aria-label="关闭提示" onClick={() => { setError(''); setNotice(''); }}>×</button></div>}
    {showImport && <form className="import-panel" onSubmit={importMode === 'single' ? importAsset : importFolder}>
      <div className="import-head"><div><span className="eyebrow">先暂存原件</span><h2>{importMode === 'single' ? '导入一条素材' : '按文件夹批量导入'}</h2></div><button type="button" className="icon-button" aria-label="关闭导入" onClick={() => setShowImport(false)}>×</button></div>
      <div className="import-mode-switch" role="group" aria-label="素材导入方式"><button type="button" className={`button small ${importMode === 'single' ? 'primary' : 'secondary'}`} aria-pressed={importMode === 'single'} onClick={() => setImportMode('single')}>单篇导入</button><button type="button" className={`button small ${importMode === 'folder' ? 'primary' : 'secondary'}`} aria-pressed={importMode === 'folder'} onClick={() => setImportMode('folder')}>选择文件夹</button></div>
      {importMode === 'single' ? <>
        <div className="import-fields"><label className="field-label">素材名称<input value={importTitle} onChange={(event) => setImportTitle(event.target.value)} required maxLength={500} /></label><label className="field-label">自由标签<input value={importTags} onChange={(event) => setImportTags(event.target.value)} placeholder="用逗号分隔标签" /></label></div>
        <label className="field-label">已有正文或补充说明<textarea rows={4} value={importBody} onChange={(event) => setImportBody(event.target.value)} placeholder="可留空，后续清洗会提取文本或 OCR 图片内容" /></label>
        <label className="field-label">来源说明（可选 JSON 或文本）<input value={importSource} onChange={(event) => setImportSource(event.target.value)} placeholder="例如原始文件来源" /></label>
        <div className="file-picker-row"><label className="button outline file-picker">选择原件<input type="file" multiple accept=".png,.jpg,.jpeg,.webp,.bmp,.txt,.md,.pdf" onChange={(event) => setImportFiles(Array.from(event.target.files || []))} /></label><span>{importFiles.length ? `${importFiles.length} 个文件，将按下方顺序入库` : '支持图片、TXT、MD 和 PDF'}</span></div>
        {importFiles.length > 0 && <OrderedFiles files={importFiles} setFiles={setImportFiles} />}
        <div className="import-footer"><span>导入只会暂存原件，不会自动清洗或入库。</span><button className="button primary" disabled={busy || !importTitle.trim() || !importFiles.length}>{busy ? '正在导入…' : '暂存原件'}</button></div>
      </> : <>
        <p className="folder-import-intro">按每个相对父文件夹分成一篇，图片与正文不会合并到别的文章。选好目录后可先检查篇数、文件数和顺序；“批量导入并提取”会逐篇调用基础模型。</p>
        <div className="file-picker-row"><label className="button outline file-picker">选择目录<input type="file" multiple directory="" webkitdirectory="" accept=".png,.jpg,.jpeg,.webp,.bmp,.txt,.md,.pdf" onChange={chooseFolder} /></label><span>{folderGroups.length ? `${folderGroups.length} 篇 · ${folderGroups.reduce((sum, group) => sum + group.files.length, 0)} 个支持文件` : '支持图片、TXT、MD 和 PDF'}</span></div>
        {folderLimitError && <p className="validation-note" role="alert">{folderLimitError}</p>}
        {folderGroups.length > 0 && <div className="folder-preview" aria-label="文件夹导入预览"><div className="folder-preview-heading"><strong>待导入文章</strong><span>调整后的顺序会用于导入</span></div><ol>{folderGroups.map((group, index) => <li className="folder-preview-item" key={group.key}>
          <span className="folder-order">{String(index + 1).padStart(2, '0')}</span><div className="folder-preview-copy"><strong>{group.title}</strong><small>{group.directory || '所选文件夹'} · {group.imageCount} 张图片 · {group.textCount} 个正文/PDF · {group.files.length} 个原件</small><span>{group.files.map((entry) => entry.basename).join(' · ')}</span></div><div className="folder-order-actions"><button type="button" className="icon-button" aria-label={`上移 ${group.title}`} onClick={() => moveFolderGroup(index, -1)} disabled={!index}>↑</button><button type="button" className="icon-button" aria-label={`下移 ${group.title}`} onClick={() => moveFolderGroup(index, 1)} disabled={index === folderGroups.length - 1}>↓</button></div>
        </li>)}</ol></div>}
        {folderIgnored.length > 0 && <details className="folder-ignored"><summary>忽略 {folderIgnored.length} 个文件（系统文件或不支持的格式）</summary><ul>{folderIgnored.map((item, index) => <li key={`${item.name}-${index}`}>{item.name} · {item.reason}</li>)}</ul></details>}
        <div className="import-footer folder-import-footer"><span>提取清洗完成后，每篇仍需单独检查并人工确认入库。</span><div className="folder-import-actions"><button type="submit" className="button outline" value="stage" disabled={busy || !folderGroups.length || Boolean(folderLimitError) || Boolean(folderResults)}>{busy ? '正在导入…' : '仅批量暂存'}</button><button type="submit" className="button primary" value="extract" disabled={busy || !folderGroups.length || Boolean(folderLimitError) || Boolean(folderResults)}>{busy ? '正在导入…' : '批量导入并提取'}</button></div></div>
        {folderResults && <section className="folder-import-results" aria-live="polite"><div className="folder-preview-heading"><div><strong>批量导入结果</strong><small>{folderResults.totals?.staged ?? 0} 篇已暂存 · {folderResults.totals?.failed ?? 0} 篇失败 · {folderResults.totals?.files ?? 0} 个文件</small></div>
          {folderClean?.active && folderClean.current && <button type="button" className="button outline small" onClick={stopBatchClean}>停止后续清洗</button>}
        </div><ol>{folderResults.entries?.map((entry, index) => {
          const assetId = entry.asset?.id;
          const cleanResult = folderClean?.completed.find((item) => item.entry.asset?.id === assetId);
          const cleanCurrent = folderClean?.current?.entry.asset?.id === assetId;
          const cleanQueued = folderClean?.queue.some((item) => item.asset?.id === assetId);
          const status = cleanCurrent ? folderClean.current.state === 'starting' ? '正在提交清洗…' : 'AI 清洗中…' : cleanQueued ? '等待清洗' : cleanResult ? cleanResult.status === 'succeeded' || cleanResult.status === 'needs_review' ? '待人工确认' : cleanResult.status === 'confirmed' ? '已入库' : cleanResult.status === 'cancelled' ? '清洗已停止' : `清洗失败：${cleanResult.error?.message || '请检查后重试'}` : entry.status === 'staged' ? '已暂存' : `导入失败：${entry.error?.message || '请检查原件'}`;
          const cleanFailed = Boolean(cleanResult && !['succeeded', 'needs_review', 'confirmed', 'cancelled'].includes(cleanResult.status)) || entry.status === 'failed';
          const cleanSucceeded = ['succeeded', 'needs_review', 'confirmed'].includes(cleanResult?.status);
          const isGood = cleanSucceeded || (!cleanResult && entry.status === 'staged');
          return <li className="folder-result-item" key={`${entry.directory}-${index}`}><span className={`folder-result-mark ${isGood ? 'good' : cleanFailed ? 'bad' : ''}`}>{cleanCurrent ? '…' : isGood ? '✓' : '!'}</span><div><strong>{String(index + 1).padStart(2, '0')} · {entry.title || entry.directory || '素材'}</strong><small>{status}</small></div>{entry.asset?.id && <button type="button" className="button outline small" onClick={() => setSelectedId(entry.asset.id)}>查看素材</button>}</li>;
        })}</ol>
        {folderClean?.done && <p className="folder-clean-summary" role="status">清洗队列结束：{folderClean.completed.filter((item) => ['succeeded', 'needs_review', 'confirmed'].includes(item.status)).length} 篇完成，{folderClean.completed.filter((item) => !['succeeded', 'needs_review', 'confirmed'].includes(item.status)).length} 篇失败或停止，{folderClean.stoppedCount || 0} 篇未启动。每篇仍需单独检查并确认入库。</p>}
        {(folderResults.entries || []).some((entry) => entry.status === 'staged' && entry.asset?.id && !folderClean?.completed.some((item) => item.entry.asset?.id === entry.asset.id && ['succeeded', 'needs_review', 'confirmed'].includes(item.status))) && !folderClean?.active && <button type="button" className="button secondary folder-clean-button" onClick={startBatchClean} disabled={busy || Boolean(job && ['queued', 'running'].includes(job.status))}>{busy ? '读取素材最新版本…' : '批量 AI 提取清洗'}</button>}
        {folderIgnored.length === 0 && folderResults.ignored?.length > 0 && <details className="folder-ignored"><summary>忽略 {folderResults.ignored.length} 个文件</summary><ul>{folderResults.ignored.map((item, index) => <li key={`${item.name}-${index}`}>{item.name} · {item.reason}</li>)}</ul></details>}
        </section>}
      </>}
    </form>}
    <div className="library-layout">
      <aside className="library-list-pane">
        <div className="library-list-head"><div><strong>素材记录</strong><small>{activeCount} 条 · {items.length} 条当前结果</small></div><button className="icon-button" aria-label="刷新素材列表" onClick={() => refreshTags().then(() => onRun(() => api.assets({ query, tags: tagFilter, status: statusFilter, limit: 100 }), { refresh: false })).then((response) => setItems(recordsFrom(response)))} disabled={loading}>↻</button></div>
        <form className="library-search" onSubmit={(event) => event.preventDefault()}><label className="visually-hidden" htmlFor="library-query">搜索素材</label><input id="library-query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、正文、摘要" /></form>
        <div className="library-filters"><label className="visually-hidden" htmlFor="tag-filter">按标签筛选</label><select id="tag-filter" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}><option value="">全部标签</option>{(tagState.tags || []).map((tag) => <option key={tag} value={tag}>{tag}</option>)}</select><label className="visually-hidden" htmlFor="status-filter">按状态筛选</label><select id="status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">全部状态</option><option value="staged">待清洗</option><option value="cleaning">清洗中</option><option value="needs_review">待人工确认</option><option value="clean_failed">清洗失败</option><option value="clean_cancelled">已停止清洗</option><option value="clean_config_missing">缺少模型配置</option><option value="confirmed">已入库</option></select></div>
        <div className="library-record-list" aria-live="polite">{loading ? <p className="list-state">正在读取素材…</p> : items.length ? items.map((item) => <button key={item.id} className={`library-record ${item.id === selectedId ? 'selected' : ''}`} onClick={() => setSelectedId(item.id)}>
          <span className="record-thumb">{item.files?.[0]?.fileUrl && isImage(item.files[0]) ? <img src={item.files[0].fileUrl} alt="" /> : '▧'}</span><span className="record-copy"><strong>{item.title}</strong><small>{item.tags?.join(' · ') || '无标签'}</small><span className={`asset-state ${item.status}`}>{stateLabel(item.status)}</span></span>
        </button>) : <div className="empty-list"><span>▧</span><strong>没有匹配的素材</strong><small>调整搜索条件或导入新素材。</small></div>}</div>
      </aside>
      <main className="asset-detail-pane">
        {!asset ? <div className="asset-detail-empty"><span className="empty-symbol">▧</span><h2>选择一条素材</h2><p>原件、清洗内容和人工校正会在详情区显示。</p><button className="button outline" onClick={() => setShowImport(true)}>导入素材</button></div> : <>
          <div className="asset-detail-heading"><div><span className={`asset-state ${asset.status}`}>{stateLabel(asset.status)}</span><h2>{asset.title}</h2><p>素材 ID {asset.id} · 版本 {asset.revision} · 更新于 {formatDate(asset.updatedAt)}</p></div><div className="heading-actions"><button className="button outline small" onClick={clean} disabled={busy || asset.status === 'confirmed' || asset.status === 'cleaning'}>{asset.status === 'cleaning' ? '正在清洗…' : 'AI 清洗'}</button><button className={`button small ${deleteConfirm ? 'danger' : 'secondary'}`} onClick={removeAsset} disabled={busy || asset.status === 'deleted'}>{deleteConfirm ? '再次点击确认删除' : '移入回收'}</button></div></div>
          {asset.lastError?.message && <div className="inline-banner error">{asset.lastError.message}</div>}
          <div className="asset-detail-grid">
            <section className="asset-content-section"><div className="subsection-head"><div><h3>人工校正</h3><p>保存修改会使现有确认失效，需再次确认入库。</p></div></div>
              <form className="asset-edit-form" onSubmit={saveEdit}>
                <label className="field-label">标题<input value={edit?.title || ''} onChange={(event) => setEdit((current) => ({ ...current, title: event.target.value }))} /></label>
                <label className="field-label">正文<textarea rows={8} value={edit?.body || ''} onChange={(event) => setEdit((current) => ({ ...current, body: event.target.value }))} /></label>
                <label className="field-label">摘要<textarea rows={4} value={edit?.summary || ''} onChange={(event) => setEdit((current) => ({ ...current, summary: event.target.value }))} /></label>
                <label className="field-label">自由标签<input value={edit?.tags || ''} onChange={(event) => setEdit((current) => ({ ...current, tags: event.target.value }))} /></label>
                <label className="field-label">来源<input value={edit?.source || ''} onChange={(event) => setEdit((current) => ({ ...current, source: event.target.value }))} /></label>
                <button className="button outline" disabled={busy || !edit}>保存人工修改</button>
              </form>
          {asset.status === 'needs_review' && <form className="asset-confirm-form" onSubmit={confirmAsset}><div><h3>人工确认入库</h3><p>检查正文、标签与原件后点击确认；确认动作会记录为“本机用户”。</p></div><button className="button primary" disabled={busy}>确认入库</button></form>}
              {asset.status === 'confirmed' && asset.confirmation && <div className="confirmed-record"><strong>已由 {asset.confirmation.by} 确认</strong><span>{asset.confirmation.note}</span><time>{formatDate(asset.confirmation.at)}</time></div>}
            </section>
            <aside className="asset-source-section"><div className="subsection-head"><div><h3>原件与提取结果</h3><p>保留文件顺序；原件替换后需要重新清洗和确认。</p></div></div>
              {asset.extractions?.length > 0 && <div className="extraction-list">{asset.extractions.map((item, index) => <details key={`${item.name || item.path || 'extract'}-${index}`}><summary>{item.name || `文件 ${index + 1}`} · {item.kind || '提取文本'} · {item.status || '已提取'}</summary>{item.warnings?.length > 0 && <small className="validation-note">{item.warnings.join(' · ')}</small>}<pre>{item.text || item.pages?.map((page) => page.text).join('\n\n') || '没有提取到正文。'}</pre></details>)}</div>}
          <div className="original-files">{asset.files?.map((file) => <article className="original-file" key={file.order}><div className="original-preview">{isImage(file) ? <a href={file.fileUrl} target="_blank" rel="noreferrer"><img src={file.fileUrl} alt={file.name} /></a> : <a href={file.fileUrl} target="_blank" rel="noreferrer" className="file-type">{file.name?.split('.').pop()?.toUpperCase() || 'FILE'}</a>}</div><div className="original-meta"><strong>{String(file.order + 1).padStart(2, '0')} · {file.name}</strong><small>{formatBytes(file.size)} · {file.mimeType || '未知类型'}</small><small>SHA-256 {String(file.sha256 || '').slice(0, 12)}…</small></div></article>)}{!asset.files?.length && <p className="list-state">这条素材没有原件记录。</p>}</div>
              <div className="replace-files"><label className="button outline small file-picker">选择替换原件<input type="file" multiple accept=".png,.jpg,.jpeg,.webp,.bmp,.txt,.md,.pdf" onChange={(event) => setReplacementFiles(Array.from(event.target.files || []))} /></label>{replacementFiles.length > 0 && <><span>{replacementFiles.length} 个文件，按所选顺序替换</span><button className="button secondary small" onClick={replaceFiles} disabled={busy}>替换原件</button></>}</div>
            </aside>
          </div>
        </>}
      </main>
    </div>
    <section className="tag-manager"><div className="tag-manager-head"><div><span className="eyebrow">统一自由标签</span><h2>标签管理</h2><p>改名或删除会作用于所有关联素材；遇到清洗冲突时请稍后重试。</p></div><span className="revision-chip">目录 v{tagState.revision}</span></div>
      <div className="tag-list">{tagState.tags?.length ? tagState.tags.map((tag) => <div className="tag-row" key={tag}>{tagEdit === tag ? <><input aria-label={`标签 ${tag} 新名称`} value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} /><button className="button small primary" onClick={() => renameTag(tag)} disabled={busy || !tagDraft.trim()}>保存名称</button><button className="button small secondary" onClick={() => { setTagEdit(''); setTagDraft(''); }}>取消</button></> : <><button className="tag-filter-button" onClick={() => setTagFilter(tag)}>{tag}</button><span className="tag-actions"><button className="text-button" onClick={() => { setTagEdit(tag); setTagDraft(tag); }}>改名</button>{tagDeleteConfirm === tag ? <><button className="text-button danger-text" onClick={() => deleteTag(tag)} disabled={busy}>确认删除</button><button className="text-button" onClick={() => setTagDeleteConfirm('')}>取消</button></> : <button className="text-button danger-text" onClick={() => setTagDeleteConfirm(tag)}>删除</button>}</span></>}</div>) : <p className="list-state">素材库还没有自由标签；可在素材详情中添加。</p>}</div>
    </section>
  </section>;
}

function OrderedFiles({ files, setFiles }) {
  return <ol className="ordered-files">{files.map((file, index) => <li key={`${file.name}-${file.lastModified}-${index}`}><span className="file-order">{String(index + 1).padStart(2, '0')}</span><span className="file-name">{file.name}</span><span className="file-size">{formatBytes(file.size)}</span><button type="button" className="icon-button" aria-label={`上移 ${file.name}`} onClick={() => { if (!index) return; const next = [...files]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; setFiles(next); }} disabled={!index}>↑</button><button type="button" className="icon-button" aria-label={`下移 ${file.name}`} onClick={() => { if (index === files.length - 1) return; const next = [...files]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; setFiles(next); }} disabled={index === files.length - 1}>↓</button><button type="button" className="icon-button danger-text" aria-label={`移除 ${file.name}`} onClick={() => setFiles(files.filter((_, itemIndex) => itemIndex !== index))}>×</button></li>)}</ol>;
}

function splitTags(value) { return [...new Set(String(value || '').split(/[,，\n]/u).map((tag) => tag.trim()).filter(Boolean))]; }
function formatDate(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN'); }
function formatBytes(value) { if (!Number.isFinite(value)) return '—'; if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`; return `${(value / (1024 * 1024)).toFixed(1)} MB`; }
