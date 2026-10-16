import { useEffect, useState } from 'react';
import { api } from './api.js';

export function CompanySettings({ onRun, task }) {
  const [config, setConfig] = useState(null);
  const [draft, setDraft] = useState({ teedy: {}, canvas: {} });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [canvasReport, setCanvasReport] = useState(null);
  useEffect(() => { api.companyConfig().then(({ config }) => { setConfig(config); setDraft({ teedy: { ...config.teedy, password: '' }, canvas: { webUrl: config.canvas.webUrl } }); }).catch(cause => setError(cause.message)); }, []);
  const field = (group, key, label, placeholder, secret = false) => <label className="field-label" key={key}>{label}<input type={secret ? 'password' : 'text'} value={draft[group][key] || ''} onChange={event => setDraft(current => ({ ...current, [group]: { ...current[group], [key]: event.target.value } }))} placeholder={placeholder} autoComplete={secret ? 'new-password' : 'off'} /></label>;
  async function save(event) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const { config: next } = await onRun(() => api.saveCompanyConfig({ expectedRevision: config.revision,
        teedy: Object.fromEntries(['baseUrl', 'username', 'password'].map(key => [key, draft.teedy[key] || ''])), canvas: { webUrl: draft.canvas.webUrl || '' },
      }), { refresh: false });
      setConfig(next); setDraft({ teedy: { ...next.teedy, password: '' }, canvas: { webUrl: next.canvas.webUrl } });
      setNotice('公司连接已保存。账号与连接密钥保存在当前电脑的公司版私有目录。');
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  async function check() {
    setBusy(true); setError(''); setNotice('');
    try { const report = await api.companyCanvasCheck(task?.id); setCanvasReport(report); setNotice(report.message || '画布连接检查完成。'); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  async function connect() {
    if (!task) return;
    const child = window.open('', '_blank');
    if (!child) { setError('请允许打开画布窗口后重试。'); return; }
    child.opener = null; setBusy(true); setError('');
    try { const result = await api.canvasOpen(task.id); child.location.replace(result.openUrl); setNotice('已打开当前任务的独立画布。模型在远端画布中配置，成品仍返回本任务审核。'); }
    catch (cause) { child.close(); setError(cause.message); }
    finally { setBusy(false); }
  }
  return <section className="settings-page">
    <header className="section-header"><div><span className="eyebrow">公司版 · 本机运行</span><h1>公司连接</h1><p>使用自己的素材库账号和新版远端画布。每个创作任务自动建立独立画布连接。</p></div></header>
    {error && <p className="inline-banner error" role="alert">{error}</p>}{notice && <p className="inline-banner success" role="status">{notice}</p>}
    {!config ? <p>正在读取公司连接…</p> : <form onSubmit={save}>
      <div className="settings-columns"><section className="settings-section"><h2>公司素材库</h2>
        {field('teedy', 'baseUrl', 'Teedy HTTPS 地址', 'https://素材库域名')}
        {field('teedy', 'username', '个人账号', '自己的 Reader 账号')}
        {field('teedy', 'password', '密码', config.teedy.passwordConfigured ? '已保存，留空保留' : '输入密码', true)}
        <p className="field-help">只检索、预览和下载。素材、标签及员工权限继续由原素材库管理。更换服务地址或账号时请重新填写密码。</p>
      </section><section className="settings-section"><h2>新版远端 Canvas</h2>
        {field('canvas', 'webUrl', '画布 HTTPS 地址', 'https://画布域名')}
        <p className="field-help">保存站点地址后，在任务中点击“打开 Canvas”即可连接。每个任务自动获得自己的画布与本机工具连接，无需填写画布 ID 或连接密钥。</p>
        <p className="field-help">生图模型在远端画布中配置。公司版使用当前选定的远端模型。</p>
        <p>{task ? `当前任务：${task.title}` : '先创建或选择一个任务，再打开画布。'}</p>
      </section></div>
      <div className="settings-actions"><button className="button primary" disabled={busy}>{busy ? '处理中…' : '保存公司连接'}</button><button type="button" className="button outline" onClick={connect} disabled={busy || !task || !config.canvas.webUrl}>打开当前任务画布</button><button type="button" className="button outline" onClick={check} disabled={busy}>检查画布连接</button></div>
      {canvasReport && <div className="settings-section"><h2>画布连接检查</h2>{(canvasReport.missing || []).length > 0 && <p>待补齐：{canvasReport.missing.join('、')}</p>}{(canvasReport.targets || []).map(target => <p key={`${target.projectId}-${target.clientId}`}>{target.title || '当前任务画布'} · {target.hasCanvas ? '已连接' : '等待页面加载'}</p>)}</div>}
    </form>}
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
  return <section className="settings-section company-search"><h2>公司素材库</h2><p>{task ? '检索结果加入本任务待选参考；点击保留后下载本次原件。' : '检索现有公司库。选择创作任务后可把候选加入任务参考。'}</p>
    <form className="search-form" onSubmit={search}><label className="visually-hidden" htmlFor={`company-query-${task?.id || 'browse'}`}>检索公司素材</label><input id={`company-query-${task?.id || 'browse'}`} value={query} onChange={event => setQuery(event.target.value)} placeholder="输入公司素材主题或关键词" required /><button className="button outline" disabled={busy}>{busy ? '检索中…' : '检索公司库'}</button></form>
    <details><summary>限定标签或必须包含的内容</summary><label className="field-label">指定标签<input value={tags} onChange={event => setTags(event.target.value)} placeholder="逗号分隔；不填则按关键词检索" /></label><label className="field-label">必须包含的内容<textarea value={concepts} onChange={event => setConcepts(event.target.value)} rows={2} placeholder="每行一个必需条件；同一行用 | 分隔同义或备选说法" /></label></details>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {searched && !items.length && <p role="status">当前条件未命中图文素材；可自行调整条件后再查。</p>}
    <div className="company-results">{items.map(item => <article key={item.documentId} className="reference-item">{item.previews?.[0]?.preview_url && <img src={item.previews[0].preview_url} alt={`${item.title}预览`} loading="lazy" />}<div><strong>{item.title}</strong><small>公司素材 · {item.documentId}</small><p>{item.summary}</p><small>{item.tags?.join(' · ')}</small></div></article>)}</div>
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
