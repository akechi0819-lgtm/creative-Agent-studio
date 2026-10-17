import { useEffect, useState } from 'react';
import { api } from './api.js';

export function CompanySettings({ onRun, task, initial = null, onConfigured = () => {} }) {
  const [config, setConfig] = useState(initial);
  const [draft, setDraft] = useState({ username: initial?.teedy?.username || '', password: '' });
  const [clearPassword, setClearPassword] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    if (initial) {
      setConfig(initial);
      setDraft(current => ({ username: initial.teedy?.username || '', password: current.password }));
      return () => { active = false; };
    }
    api.companyConfig().then(({ config: next }) => {
      if (!active) return;
      setConfig(next);
      setDraft({ username: next.teedy?.username || '', password: '' });
    }).catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [initial]);
  async function save(event) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const payload = { expectedRevision: config.revision, teedy: { username: draft.username.trim(), password: draft.password } };
      if (clearPassword) payload.clearSecrets = ['teedy.password'];
      const { config: next } = await onRun(() => api.saveCompanyConfig(payload), { refresh: false });
      setConfig(next); onConfigured(next); setDraft({ username: next.teedy.username || '', password: '' }); setClearPassword(false);
      setNotice('个人 Teedy 账号已保存到当前电脑的私有配置。');
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  async function connect() {
    if (!task) return;
    const child = window.open('', '_blank');
    if (!child) { setError('请允许打开画布窗口后重试。'); return; }
    child.opener = null; setBusy(true); setError('');
    try { const result = await api.canvasOpen(task.id); child.location.replace(result.openUrl); setNotice('已打开当前任务的本机 Canvas。基础和图片模型使用本机个人配置，成品仍返回本任务审核。'); }
    catch (cause) { child.close(); setError(cause.message); }
    finally { setBusy(false); }
  }
  return <section className="settings-page">
    <header className="section-header"><div><span className="eyebrow">公司版 · 本机运行</span><h1>公司连接</h1><p>公司服务地址由管理员预配置。每位同事只保存自己的 Teedy 账号；任务画布会自动建立独立连接。</p></div></header>
    {error && <p className="inline-banner error" role="alert">{error}</p>}{notice && <p className="inline-banner success" role="status">{notice}</p>}
    {!config ? <p>正在读取公司连接…</p> : <>
      {!config.deploymentConfigured && <p className="inline-banner error" role="alert">公司服务地址尚未由管理员预配置，请联系管理员完成部署。</p>}
      <div className="settings-columns"><section className="settings-section"><h2>公司素材库</h2>
        <label className="field-label">固定素材库地址<output className="readonly-service-address">{config.teedy?.baseUrl || '管理员尚未配置'}</output></label>
        <form onSubmit={save}>
          <label className="field-label">个人账号<input value={draft.username} onChange={event => setDraft(current => ({ ...current, username: event.target.value }))} placeholder="自己的 Reader 账号" autoComplete="username" /></label>
          <label className="field-label">个人密码<input type="password" value={draft.password} onChange={event => { setDraft(current => ({ ...current, password: event.target.value })); setClearPassword(false); }} placeholder={config.teedy.passwordConfigured ? '已保存；留空保留' : '输入自己的密码'} autoComplete="new-password" /></label>
          {config.teedy.passwordConfigured && <label className="check-row"><input type="checkbox" checked={clearPassword} onChange={event => setClearPassword(event.target.checked)} /><span>明确清除本机保存的密码</span></label>}
          <p className="field-help">只检索、预览并在人工保留后下载原件。素材、标签及员工权限继续由原素材库管理。账号与密码仅保存在当前电脑。</p>
          <div className="settings-actions"><button className="button primary" disabled={busy || !config.deploymentConfigured || (!draft.username.trim() && !clearPassword) || (!draft.password && !config.teedy.passwordConfigured && !clearPassword) || (draft.username.trim() !== (config.teedy.username || '') && !draft.password && !clearPassword)}>{busy ? '处理中…' : '保存个人账号'}</button></div>
        </form>
      </section><section className="settings-section"><h2>本机 Canvas</h2>
        <p className="field-help">Canvas 负责当前任务的画布和成品回传；图片模型使用本机“模型与服务”中的个人配置。</p>
        <p>{task ? `当前任务：${task.title}` : '先创建或选择一个任务，再打开 Canvas。'}</p>
      </section></div>
      <div className="settings-actions"><button type="button" className="button outline" onClick={connect} disabled={busy || !task}>打开本机 Canvas</button></div>
    </>}
  </section>;
}

export function CompanySearch({ task, onRun }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [tags, setTags] = useState('');
  const [concepts, setConcepts] = useState('');
  useEffect(() => { setItems([]); setSearched(false); setError(''); }, [task?.id]);
  async function search(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const payload = { query: query.trim(), tags: tags.split(/[,，]/).map(value => value.trim()).filter(Boolean), required_concepts: concepts.split(/\n/).filter(line => line.trim()).map(line => line.split(/[|｜]/).map(value => value.trim()).filter(Boolean)), ...(task ? { taskId: task.id, expectedRevision: task.revision } : {}) };
      const result = await onRun(() => api.companySearch(payload), { refresh: Boolean(task) });
      setItems(result.items); setSearched(true);
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  return <section className="settings-section company-search"><h2>公司素材库</h2><p>{task ? '检索候选加入本任务预览，在对话中确认是否使用；只有保留后才下载原件。' : '检索现有公司库。选择创作任务后可把候选加入任务预览。'}</p>
    <form className="search-form" onSubmit={search}><label className="visually-hidden" htmlFor={`company-query-${task?.id || 'browse'}`}>检索公司素材</label><input id={`company-query-${task?.id || 'browse'}`} value={query} onChange={event => setQuery(event.target.value)} placeholder="输入公司素材主题或关键词" required /><button className="button outline" disabled={busy}>{busy ? '检索中…' : '检索公司库'}</button></form>
    <details><summary>限定标签或必须包含的内容</summary><label className="field-label">指定标签<input value={tags} onChange={event => setTags(event.target.value)} placeholder="逗号分隔；不填则按关键词检索" /></label><label className="field-label">必须包含的内容<textarea value={concepts} onChange={event => setConcepts(event.target.value)} rows={2} placeholder="每行一个必需条件；同一行用 | 分隔同义或备选说法" /></label></details>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {searched && !items.length && <p role="status">当前条件未命中图文素材；可自行调整条件后再查。</p>}
    <div className="company-results">{items.map(item => <article key={item.documentId} className="reference-item">{item.previews?.[0]?.preview_url && <img src={item.previews[0].preview_url} alt={`${item.title}缩略预览`} loading="lazy" decoding="async" />}<div><strong>{item.title}</strong><small>公司素材 · {item.documentId}</small><p>{item.summary}</p><small>{item.tags?.join(' · ')}</small></div></article>)}</div>
  </section>;
}

export function CompanyCopyCheck({ task }) {
  const [result, setResult] = useState(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const sheet = task?.sheets?.find(sheet => sheet.version === task.sheetVersion);
    setText((sheet?.pages || []).map(page => `第${page.page}页：${page.copy}`).join('\n\n'));
    setResult(null); setError('');
  }, [task?.id, task?.revision]);
  async function check() {
    setBusy(true); setError('');
    try { setResult(await api.companyCheckCopy(text)); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  return <details className="settings-section company-search"><summary>公司词库辅助检查</summary><p>制作单文案已带入。成品阶段请实际读图后补充图中文字、标题、正文和标签，再检查；命中由你判断，未命中不代表可以发布。</p>
    <label className="field-label">待检查文字<textarea value={text} onChange={event => { setText(event.target.value); setResult(null); }} rows={4} maxLength={500000} /></label>
    <button className="button outline small" onClick={check} disabled={busy || !text.trim()}>{busy ? '检查中…' : '检查当前文字'}</button>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {result && <div role="status"><p>词库 {result.recordCount} 条记录、{result.termCount} 个词项，命中 {result.matches.length} 处。仅检查上方文字。</p>{result.matches.slice(0, 100).map((match, index) => <p key={`${match.term}-${match.offset}-${index}`}><strong>{match.term}</strong> · 第 {match.offset + 1} 个字符 · {match.level} · {match.category.join('／')}<br />{match.reason.join('；')}</p>)}{result.matches.length > 100 && <p>当前展示前 100 处；请分段检查剩余内容。</p>}</div>}
  </details>;
}
