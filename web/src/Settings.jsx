import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

export function DnaSettings({ initial, task, job, refreshKey, onRun, onApplyToTask }) {
  const firstProfile = initial || { revision: 1, enabled: false, content: '' };
  const seenRevision = useRef(firstProfile.revision);
  const [profile, setProfile] = useState(firstProfile);
  const [content, setContent] = useState(profile?.content || '');
  const [enabled, setEnabled] = useState(Boolean(profile?.enabled));
  const [organizeText, setOrganizeText] = useState('');
  const [organizing, setOrganizing] = useState(false);
  const [localError, setLocalError] = useState('');
  const [localNotice, setLocalNotice] = useState('');
  const [applyBusy, setApplyBusy] = useState(false);
  const [organizeJobId, setOrganizeJobId] = useState('');

  useEffect(() => {
    const current = initial || { revision: 1, enabled: false, content: '' };
    if (seenRevision.current === current.revision) return;
    seenRevision.current = current.revision;
    setProfile(current); setContent(current.content || ''); setEnabled(Boolean(current.enabled));
  }, [initial]);

  useEffect(() => {
    if (!organizeJobId || job?.id !== organizeJobId || !['succeeded', 'failed', 'cancelled'].includes(job.status)) return;
    if (job.status === 'succeeded') {
      setContent(job.result.draft.content);
      setEnabled(false);
      setLocalNotice('DNA 草稿已整理到编辑区，尚未保存或启用。');
      setLocalError('');
    } else {
      setLocalError(job.error?.message || (job.status === 'cancelled' ? 'DNA 整理已停止。' : 'DNA 整理失败。'));
    }
    setOrganizing(false);
    setOrganizeJobId('');
  }, [job, organizeJobId]);

  const dirty = content !== (profile.content || '') || enabled !== Boolean(profile.enabled);
  const taskHasCurrent = task?.dna?.revision === profile.revision && task?.dna?.enabled === profile.enabled;

  async function organize() {
    if (!organizeText.trim()) return;
    setOrganizing(true); setLocalError(''); setLocalNotice('');
    let submitted = false;
    try {
      const result = await onRun(() => api.organizeDna({ text: organizeText.trim() }), { refresh: false });
      setOrganizeJobId(result.job.id);
      submitted = true;
      setLocalNotice('整理任务已提交；完成后草稿会显示在编辑区。');
    } catch (cause) { setLocalError(cause.message || 'DNA 整理失败。'); }
    finally { if (!submitted) setOrganizing(false); }
  }

  async function save(saveEnabled) {
    setLocalError(''); setLocalNotice('');
    if (saveEnabled && !content.trim()) { setLocalError('DNA 内容为空，不能启用。'); return; }
    const action = saveEnabled ? '保存并启用' : '保存草稿';
    if (saveEnabled && !window.confirm(`保存并启用 DNA ${dirty ? '当前编辑内容' : `v${profile.revision}`}？后续新任务会使用此版本。`)) return;
    try {
      const result = await onRun(() => api.saveDna({ revision: profile.revision, expectedRevision: profile.revision, enabled: saveEnabled, content, by: '本机用户', note: `用户在 Web 点击${action} DNA` }), { success: saveEnabled ? '已保存并启用新的 DNA 版本。' : '已保存 DNA 草稿，当前仍关闭。' });
      const next = result.profile;
      seenRevision.current = next.revision;
      setProfile(next); setContent(next.content); setEnabled(Boolean(next.enabled));
      setLocalNotice(saveEnabled ? '已保存并启用新的 DNA 版本。' : '已保存草稿，DNA 仍保持关闭。');
    } catch (cause) { setLocalError(cause.message || 'DNA 保存失败。'); }
  }

  async function apply() {
    if (!task || taskHasCurrent || applyBusy) return;
    setApplyBusy(true); setLocalError(''); setLocalNotice('');
    try { await onApplyToTask({ dnaRevision: profile.revision, expectedRevision: task.revision }); }
    catch (cause) { setLocalError(cause.message || '无法应用 DNA。'); }
    finally { setApplyBusy(false); }
  }

  return <section className="settings-page">
    <header className="section-header"><div><span className="eyebrow">显式维护，不自动学习</span><h1>DNA</h1><p>把品牌、表达习惯与明确要求整理成可复用内容。整理只生成草稿，保存和启用都由你决定。</p></div><span className={`large-status ${profile.enabled ? 'enabled' : ''}`}><i />{profile.enabled ? `已启用 · v${profile.revision}` : '默认关闭'}</span></header>
    {(localError || localNotice) && <div className={`inline-banner ${localError ? 'error' : 'success'}`} role={localError ? 'alert' : 'status'}>{localError || localNotice}</div>}
    <div className="settings-columns">
      <section className="settings-section dna-organizer"><div className="settings-section-head"><span className="section-index">01</span><div><h2>用自然语言整理</h2><p>写下你想沉淀的规则，Agent 会把它整理为可编辑草稿。</p></div></div>
        <label className="field-label">你想加入 DNA 的内容<textarea rows={7} value={organizeText} onChange={(event) => setOrganizeText(event.target.value)} placeholder="例如：常见内容语气、品牌视觉习惯、必须出现或避免的元素。" /></label>
        <button className="button outline" onClick={organize} disabled={organizing || !organizeText.trim()}>{organizing ? '正在整理…' : '整理为草稿'}</button>
        <p className="field-help">Agent 返回的内容只会放入右侧编辑区，不会自动写入 DNA。</p>
      </section>
      <section className="settings-section dna-editor"><div className="settings-section-head"><span className="section-index">02</span><div><h2>编辑与保存</h2><p>编辑当前草稿或已保存版本。保存后，新任务会读取固定快照。</p></div></div>
        <label className="field-label">DNA 内容<textarea rows={15} value={content} onChange={(event) => setContent(event.target.value)} placeholder="目前没有已保存的 DNA 内容。" maxLength={20000} /></label>
        <div className="enabled-toggle"><div><strong>{enabled ? '新任务默认应用此版本' : '新任务不应用 DNA'}</strong><small>此开关只在你明确保存时生效。</small></div><button type="button" role="switch" aria-checked={enabled} className={`switch ${enabled ? 'on' : ''}`} onClick={() => setEnabled((value) => !value)} aria-label="切换 DNA 启用状态"><i /></button></div>
        <div className="settings-actions"><button className="button secondary" onClick={() => save(false)} disabled={!dirty}>保存草稿</button><button className="button primary" onClick={() => save(true)} disabled={!dirty || !content.trim()}>保存并启用</button></div>
        <p className="field-help">{profile.savedAt ? `上次保存：${new Date(profile.savedAt).toLocaleString('zh-CN')} · 版本 ${profile.revision}` : '尚无已保存版本。'}</p>
      </section>
    </div>
    <section className="apply-dna-row"><div><span className="section-index">03</span><div><strong>应用到当前任务</strong><p>{task ? (taskHasCurrent ? `当前任务已固定 DNA v${task.dna?.revision}。` : `${profile.enabled ? `应用 DNA v${profile.revision}` : `在当前任务停用 DNA（固定关闭版 v${profile.revision}）`}会改变当前任务输入，需求、制作单和成品的下游确认需要重新检查。`) : '选择一个任务后，可显式应用当前版本。'}</p></div></div><button className="button outline" onClick={apply} disabled={!task || taskHasCurrent || applyBusy}>{applyBusy ? '应用中…' : profile.enabled ? '应用当前版本' : '在当前任务停用 DNA'}</button></section>
  </section>;
}

export function ModelSettings({ initial, refreshKey, onRun }) {
  const firstConfig = initial || { revision: 1, base: {}, image: {} };
  const seenRevision = useRef(firstConfig.revision);
  const [config, setConfig] = useState(firstConfig);
  const [base, setBase] = useState(() => providerDraft(firstConfig.base));
  const [pluginState, setPluginState] = useState(null);
  const [pluginError, setPluginError] = useState('');
  const [pluginBusy, setPluginBusy] = useState('');
  const [pluginNotice, setPluginNotice] = useState('');
  const [clearKeys, setClearKeys] = useState([]);
  const [saving, setSaving] = useState(false);
  const [checkKind, setCheckKind] = useState('');
  const [checks, setChecks] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const current = initial || { revision: 1, base: {}, image: {} };
    if (seenRevision.current === current.revision) return;
    seenRevision.current = current.revision;
    setConfig(current);
    setBase(providerDraft(current.base));
    setClearKeys([]);
  }, [initial]);

  useEffect(() => {
    let active = true;
    api.modelPlugin().then((result) => {
      if (active) setPluginState(result);
    }).catch((cause) => {
      if (active) setPluginError(cause.message || '无法读取 WorkBuddy 登录状态。');
    });
    return () => { active = false; };
  }, []);

  const loginStatus = pluginState?.login?.status || 'idle';
  useEffect(() => {
    if (loginStatus !== 'pending') return undefined;
    let active = true;
    let timer;
    async function poll() {
      timer = setTimeout(async () => {
        try {
          const result = await api.modelPlugin();
          if (!active) return;
          setPluginError('');
          setPluginState(result);
          if (result?.login?.status === 'pending') poll();
        } catch (cause) {
          if (!active) return;
          setPluginError(cause.message || '读取 WorkBuddy 登录状态失败，正在重试。');
          poll();
        }
      }, 3000);
    }
    poll();
    return () => { active = false; clearTimeout(timer); };
  }, [loginStatus]);

  function updateModel(kind, field, value) {
    const setter = setBase;
    setter((current) => field === 'source'
      ? { ...current, source: value, model: '' }
      : { ...current, [field]: value });
    setChecks(null); setNotice(''); setError('');
  }
  function toggleClear(kind, checked) {
    setClearKeys((current) => checked ? [...new Set([...current, kind])] : current.filter((item) => item !== kind));
    setNotice('');
  }

  async function save() {
    setSaving(true); setError(''); setNotice('');
    try {
      const response = await onRun(() => api.saveConfig({ expectedRevision: config.revision, base: { ...base, source: base.source || 'custom' }, clearKeys }), { success: '配置已保存。' });
      const next = response.config;
      seenRevision.current = next.revision;
      setConfig(next);
      setBase((value) => ({ ...value, apiKey: '' })); setClearKeys([]); setChecks(null);
      setNotice('基础模型配置已保存；远端 Canvas 的生图模型继续在画布中配置。');
    } catch (cause) { setError(cause.message || '配置保存失败。'); }
    finally { setSaving(false); }
  }

  async function check(kind) {
    setCheckKind(kind); setError(''); setNotice(''); setChecks(null);
    try {
      const response = await onRun(() => api.checkConfig({ kind }), { refresh: false });
      setChecks(response.checks);
    } catch (cause) { setError(cause.message || '连接检查失败。'); }
    finally { setCheckKind(''); }
  }

  async function fetchModels(kind, draft) {
    const payload = { kind };
    const source = kind === 'base' ? (draft.source || 'custom') : 'custom';
    if (kind === 'base') payload.source = source;
    if (kind !== 'base' || source === 'custom') {
      if (draft.baseUrl.trim()) payload.baseUrl = draft.baseUrl.trim();
      if (draft.apiKey) payload.apiKey = draft.apiKey;
    }
    return api.models(payload);
  }

  async function runPluginAction(action, payload, busyKey, successMessage) {
    setPluginBusy(busyKey); setPluginError(''); setPluginNotice('');
    try {
      const result = await action(payload);
      setPluginState(result);
      if (successMessage) setPluginNotice(successMessage);
    } catch (cause) {
      setPluginError(cause.message || 'WorkBuddy 账号操作失败。');
    } finally { setPluginBusy(''); }
  }

  const canCheckBase = (() => {
    const savedBase = config.base || {};
    const source = savedBase.source || 'custom';
    if (!savedBase.model) return false;
    if (source === 'custom') return Boolean(savedBase.baseUrl && savedBase.apiKeyConfigured);
    return ['opencode', 'kilo', 'workbuddy-cn', 'workbuddy-intl'].includes(source);
  })();

  return <section className="settings-page">
    <header className="section-header"><div><span className="eyebrow">基础能力与图像生成分开配置</span><h1>模型与服务</h1><p>清洗、对话、工具调用和读图共用基础模型。生图模型在远端 Canvas 配置，本页只保存基础模型。</p></div><span className="revision-chip">配置 v{config.revision || 1}</span></header>
    {(error || notice) && <div className={`inline-banner ${error ? 'error' : 'success'}`} role={error ? 'alert' : 'status'}>{error || notice}</div>}
    <div className="provider-grid">
      <ProviderFields key={base.source || 'custom'} title="基础模型" description="清洗、对话、工具调用和读图共用当前模型。" kind="base" model={{ ...base, source: base.source || 'custom' }} saved={config.base || {}} clearSelected={clearKeys.includes('base')} configRevision={config.revision} onChange={updateModel} onClear={toggleClear} canCheck={canCheckBase} checking={checkKind === 'base'} onCheck={() => check('base')} onFetchModels={fetchModels} pluginState={pluginState} pluginError={pluginError} pluginBusy={pluginBusy} pluginNotice={pluginNotice} onPluginAction={runPluginAction} />
      <section className="settings-section"><h2>远端 Canvas 图片模型</h2><p>打开任务画布后，在远端 Canvas 设置生图服务并选择模型。公司版会读取画布当前模型，不覆盖远端设置。</p><p>公司站点地址在“公司连接”中保存。</p></section>
    </div>
    <div className="config-save-row"><div><strong>保存后新请求会使用新配置</strong><p>检查连接始终读取已保存的基础模型配置。自用 API 的密钥留空表示保留，勾选清除后保存才会移除。</p></div><button className="button primary" onClick={save} disabled={saving}>{saving ? '正在保存…' : '保存配置'}</button></div>
    {checks && <div className="check-results"><div className="settings-section-head"><span className="section-index">✓</span><div><h2>连接检查结果</h2><p>以下结果仅来自本次显式检查。</p></div></div><div className="check-result-grid">{Object.entries(checks).filter(([, value]) => value && typeof value === 'object').map(([kind, result]) => {
      const connected = result.status === 'connected';
      const neutral = result.status === 'unverified' || result.status === 'not_configured';
      const stateClass = connected ? 'enabled' : neutral ? 'neutral' : 'error';
      const imageStatus = ({ connected: '模型已列入列表', unverified: '模型状态待核', failed: '检查失败', not_configured: '未配置' })[result.status];
      const stateText = kind === 'image' ? imageStatus : connected ? '连接成功' : result.status === 'failed' ? '检查失败' : result.status;
      const imageCheckDetail = kind === 'image' ? (result.capabilities.connectionTested
        ? result.capabilities.modelListed
          ? '已向服务读取模型列表，当前模型在列表中；这不代表生图能力已验证。'
          : result.capabilities.modelsEndpointAvailable
            ? '服务已返回模型列表，但当前模型不在列表中；没有发起生图请求。'
            : '已连接服务，但无法读取标准模型列表；模型待核，没有发起生图请求。'
        : '没有完成服务连接验证；没有发起生图请求。') : '';
      return <article className="check-result" key={kind}><span className={`large-status ${stateClass}`}><i />{stateText}</span><h3>{kind === 'base' ? '基础模型' : '图片模型'}</h3><p>{result.message}</p>{imageCheckDetail && <small className="check-detail-note">{imageCheckDetail}</small>}{kind === 'base' && result.capabilities.length > 0 && <ul>{result.capabilities.map((item) => <li key={item}>{item}</li>)}</ul>}<small>{result.checkedAt ? new Date(result.checkedAt).toLocaleString('zh-CN') : ''}</small></article>;
    })}</div></div>}
    <div className="canvas-info-note"><span className="footer-icon">◇</span><div><strong>Canvas 在任务工作台中打开</strong><p>每个任务会自动绑定自己的远端画布项目。首次连接、项目身份和连接状态在打开或同步时由服务端核对。</p></div></div>
  </section>;
}

function providerDraft(channel = {}) {
  return { source: channel.source || 'custom', baseUrl: channel.baseUrl || '', model: channel.model || '', apiKey: '' };
}


function ProviderFields({ title, description, kind, model, saved, clearSelected, configRevision, onChange, onClear, canCheck, checking, onCheck, onFetchModels, pluginState, pluginError, pluginBusy, pluginNotice, onPluginAction }) {
  const [models, setModels] = useState([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const fetchRequest = useRef(0);

  useEffect(() => {
    fetchRequest.current += 1;
    setModels([]); setModelsLoaded(false); setFetchingModels(false); setFetchError('');
  }, [configRevision]);

  async function fetchAvailableModels() {
    if (keyBlocked || !modelSourceReady) return;
    const requestId = ++fetchRequest.current;
    setFetchingModels(true); setFetchError('');
    try {
      const result = await onFetchModels(kind, model);
      if (requestId !== fetchRequest.current) return;
      const entries = Array.isArray(result?.models) ? result.models : [];
      const seen = new Set();
      const valid = entries.filter((entry) => {
        if (!entry || typeof entry.id !== 'string' || !entry.id.trim() || seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      });
      setModels(valid); setModelsLoaded(true);
    } catch (cause) {
      if (requestId !== fetchRequest.current) return;
      setFetchError(cause.message || (isCustomSource ? '获取模型失败，请检查服务地址和密钥。' : '获取此来源的模型列表失败，请检查登录状态后重试。'));
      setModels([]); setModelsLoaded(false);
    } finally { if (requestId === fetchRequest.current) setFetchingModels(false); }
  }

  function change(field, value) {
    onChange(kind, field, value);
    if (field === 'baseUrl' || field === 'apiKey') {
      fetchRequest.current += 1;
      setModels([]); setModelsLoaded(false); setFetchingModels(false); setFetchError('');
    }
  }

  function changeClearSelection(checked) {
    onClear(kind, checked);
    if (checked && !model.apiKey) {
      fetchRequest.current += 1;
      setModels([]); setModelsLoaded(false); setFetchingModels(false); setFetchError('');
    }
  }

  const source = kind === 'base' ? (model.source || 'custom') : 'custom';
  const isCustomSource = kind !== 'base' || source === 'custom';
  const region = source === 'workbuddy-intl' ? 'intl' : 'cn';
  const regionName = region === 'intl' ? '国际版' : '国内版';
  const pluginLogin = pluginState?.login || { status: 'idle' };
  const accounts = Array.isArray(pluginState?.accounts) ? pluginState.accounts : [];
  const relevantAccounts = accounts.filter((account) => account.region === region);
  const isWorkBuddy = source === 'workbuddy-cn' || source === 'workbuddy-intl';
  const keyBlocked = isCustomSource && clearSelected && !model.apiKey;
  const modelSourceReady = !isWorkBuddy || Boolean(pluginState?.running && relevantAccounts.length);
  const providerConfigured = kind === 'base'
    ? Boolean(saved.model && ((saved.source || 'custom') !== 'custom' || (saved.baseUrl && saved.apiKeyConfigured)))
    : Boolean(saved.apiKeyConfigured);

  return <section className="provider-card">
      <div className="provider-head"><div><span className="provider-icon">{kind === 'base' ? '◈' : '▧'}</span><div><h2>{title}</h2><p>{description}</p></div></div><span className={`config-state ${providerConfigured ? 'configured' : ''}`}><i />{providerConfigured ? '已配置' : '未配置'}</span></div>
    {kind === 'base' && <div className="base-source-control"><label className="field-label">基础模型来源<select value={source} onChange={(event) => change('source', event.target.value)}>
      <optgroup label="自用 API"><option value="custom">自用 API（填写地址和密钥）</option></optgroup>
      <optgroup label="免费使用"><option value="kilo">Kilo</option><option value="opencode">OpenCode</option></optgroup>
      <optgroup label="WorkBuddy"><option value="workbuddy-cn">国内版</option><option value="workbuddy-intl">国际版</option></optgroup>
    </select></label>
    {source !== 'custom' && <button type="button" className="text-button" onClick={() => change('source', 'custom')}>使用自己的 API</button>}
    {source === 'opencode' || source === 'kilo'
      ? <div className="source-notice"><p>免费通道可能受上游限流。对话、清洗、工具调用和读图所用资料会发送给你选定的提供方处理。</p>{model.source === 'opencode' && <p>OpenCode 当前实测不可用：上游限制第三方客户端；建议选择 Kilo。</p>}</div>
      : source === 'custom' ? <p className="source-notice">填写你自己的兼容服务地址和 API 密钥。</p>
        : <p className="source-notice">登录你自己的 WorkBuddy {regionName}账号；后续请求使用此账号的平台额度。</p>}
    </div>}
    {isCustomSource && <label className="field-label">服务地址<input type="url" value={model.baseUrl} onChange={(event) => change('baseUrl', event.target.value)} placeholder="https://…" autoComplete="url" /></label>}
    <label className="field-label">模型名称<input value={model.model} onChange={(event) => change('model', event.target.value)} placeholder={isCustomSource ? '可手动填写自定义模型 ID' : '填写模型 ID'} autoComplete="off" /></label>
    <div className="model-fetch-row">
      <label className="field-label model-fetch-select-label">从模型列表选择<select aria-label={`${title}模型列表`} value={model.model} onChange={(event) => change('model', event.target.value)} disabled={!modelsLoaded || !models.length}>
        <option value="">{modelsLoaded && !models.length ? '服务未返回模型' : '先获取模型列表'}</option>
        {model.model && !models.some((item) => item.id === model.model) && <option value={model.model}>当前值：{model.model}</option>}
        {models.map((item) => <option key={item.id} value={item.id}>{item.name && item.name !== item.id ? `${item.name}（${item.id}）` : item.id}{item.vision ? ' · 支持读图' : ''}</option>)}
      </select></label>
      <button type="button" className="button outline small" onClick={fetchAvailableModels} disabled={fetchingModels || keyBlocked || !modelSourceReady}>{fetchingModels ? '正在获取…' : modelsLoaded ? '刷新模型' : '获取模型'}</button>
    </div>
    {fetchError ? <small className="model-fetch-message error" role="alert">{fetchError}</small> : keyBlocked ? <small className="model-fetch-message">已选择清除已保存密钥；请先保存清除或填写新密钥后获取模型。</small> : !modelSourceReady ? <small className="model-fetch-message">请先登录此区域的 WorkBuddy 账号，再获取模型列表。</small> : modelsLoaded && !models.length ? <small className="model-fetch-message" role="status">服务没有返回模型列表；仍可手动填写模型 ID。</small> : modelsLoaded ? <small className="model-fetch-message" role="status">已获取 {models.length} 个模型；选择后也可继续手动修改 ID。</small> : <small className="model-fetch-message">{isCustomSource ? '可先填写服务地址和密钥，再获取模型；也可直接手动填写模型 ID。' : '获取此来源提供的模型列表，选择后也可继续手动修改 ID。'}</small>}
    {isCustomSource && <>
      {kind === 'image' && <label className="field-label">API 密钥<input type="password" value={model.apiKey} onChange={(event) => change('apiKey', event.target.value)} placeholder={saved.apiKeyConfigured ? '已保存密钥 · 留空则保留' : '尚未配置'} autoComplete="new-password" /></label>}
      {kind === 'base' && <label className="field-label">API 密钥<input type="password" value={model.apiKey} onChange={(event) => change('apiKey', event.target.value)} placeholder={saved.apiKeyConfigured ? '已保存密钥 · 留空则保留' : '尚未配置'} autoComplete="new-password" />
        <small className="field-help">已保存密钥不会显示；需要替换时直接输入新密钥。</small></label>}
      <label className="check-row clear-key"><input type="checkbox" checked={clearSelected} onChange={(event) => changeClearSelection(event.target.checked)} /><span>明确清除已保存密钥</span></label>
    </>}
    {(isWorkBuddy || pluginLogin.status === 'pending') && <div className="workbuddy-panel">
      <div className="workbuddy-panel-head"><div><strong>{isWorkBuddy ? `WorkBuddy ${regionName}账号` : 'WorkBuddy 登录状态'}</strong><span className={`plugin-status ${pluginState?.running ? 'ready' : ''}`}><i />{pluginState ? (pluginState.running ? '登录服务可用' : '登录服务未运行') : '正在读取状态…'}</span></div>
        {isWorkBuddy && <button type="button" className="button outline small" onClick={() => onPluginAction(api.loginModelPlugin, { region }, `login-${region}`)} disabled={!pluginState?.running || pluginBusy !== '' || pluginLogin.status === 'pending'}>{pluginBusy === `login-${region}` ? '正在连接…' : relevantAccounts.length ? '添加账号' : `登录${regionName}`}</button>}</div>
      {isWorkBuddy && relevantAccounts.length ? <div className="workbuddy-account-list">{relevantAccounts.map((account) => <div className="workbuddy-account" key={`${account.region}:${account.id}`}><span className="account-status-dot" /><div><strong>{account.name}</strong><small>已登录 · 使用此账号的平台额度</small></div><button type="button" className="text-button" onClick={() => onPluginAction(api.logoutModelPlugin, { id: account.id, region: account.region }, `logout-${account.id}`, 'WorkBuddy 账号已退出。')} disabled={pluginBusy !== '' || pluginLogin.status === 'pending'}>{pluginBusy === `logout-${account.id}` ? '退出中…' : '退出登录'}</button></div>)}</div> : isWorkBuddy ? <p className="workbuddy-empty">此区域还没有登录账号。</p> : null}
      {pluginLogin.status === 'pending' && <div className="workbuddy-login-pending" role="status"><span>{pluginLogin.message || `等待完成 WorkBuddy ${regionName}登录。`}</span>{pluginLogin.url && <a href={pluginLogin.url} target="_blank" rel="noopener noreferrer">打开 WorkBuddy 登录页</a>}<button type="button" className="text-button" onClick={() => onPluginAction(api.cancelModelPlugin, {}, 'cancel', '已取消 WorkBuddy 登录。')} disabled={pluginBusy !== ''}>取消登录</button></div>}
      {pluginLogin.status === 'failed' && pluginLogin.message && <p className="workbuddy-error" role="alert">{pluginLogin.message}</p>}
      {pluginError && (isWorkBuddy || pluginLogin.status === 'pending') && <p className="workbuddy-error" role="alert">{pluginError}</p>}
      {pluginNotice && (isWorkBuddy || pluginLogin.status === 'pending') && <p className="workbuddy-notice" role="status">{pluginNotice}</p>}
    </div>}
    <div className="provider-action-row"><button type="button" className="button outline small" onClick={onCheck} disabled={!canCheck || checking}>{checking ? '检查中…' : '检查连接'}</button></div>
    {!canCheck && <small className="field-help">{kind === 'base' ? '保存完整配置后可检查已保存的基础模型。' : '保存完整配置后可检查连接。'}</small>}
    {kind === 'base' && <small className="field-help">检查连接读取已保存配置；当前修改需先保存才会生效。</small>}
  </section>;
}
