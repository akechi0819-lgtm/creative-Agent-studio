import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import './onboarding.css';

const STEPS = ['选择服务商', '地址与密钥', '选择模型', '分级检查', '示例首任务'];
const SAMPLE_BRIEF = '我想为小红书做一张春季新品宣传图。受众是附近的大学生，画面清新明亮，突出新品名称、上市时间和到店优惠。请先和我确认需求，再整理制作单；不要直接开始绘图。';
const MANAGED_SOURCES = new Set(['kilo', 'opencode', 'workbuddy-cn', 'workbuddy-intl']);

const PROVIDERS = [
  { id: 'custom', name: '自用 API', detail: '填写兼容 OpenAI API 的地址、密钥和模型 ID。', tag: '自定义' },
  { id: 'kilo', name: 'Kilo', detail: '基础模型来源，无需在这里填写 API 密钥。', tag: '托管来源' },
  { id: 'opencode', name: 'OpenCode', detail: '无需粘贴密钥；第三方客户端实际对话目前有上游限制。', tag: '有上游限制' },
  { id: 'workbuddy-cn', name: 'WorkBuddy 国内版', detail: '使用你本人登录的国内账号和平台额度。', tag: '登录账号' },
  { id: 'workbuddy-intl', name: 'WorkBuddy 国际版', detail: '使用你本人登录的国际账号和平台额度。', tag: '登录账号' },
];

const OFFICIAL_LINKS = [
  { label: 'OpenAI API 平台', href: 'https://platform.openai.com/api-keys' },
  { label: 'DeepSeek API 文档', href: 'https://api-docs.deepseek.com/guides/codex' },
];

export const ONBOARDING_DISMISSED_KEY = 'studio.onboardingDismissed';

export function hasUsableConfig(config, { companyMode = false } = {}) {
  const base = config?.base || {};
  const source = base.source || 'custom';
  if (!base.model?.trim()) return false;
  const baseConfigured = source !== 'custom'
    ? MANAGED_SOURCES.has(source)
    : Boolean(base.baseUrl?.trim() && base.apiKeyConfigured);
  if (!baseConfigured) return false;
  if (companyMode) return true;
  const image = config?.image || {};
  return Boolean(image.baseUrl?.trim() && image.model?.trim() && image.apiKeyConfigured);
}

function makeBaseDraft(channel = {}) {
  return {
    source: channel.source || 'custom',
    baseUrl: channel.baseUrl || '',
    model: channel.model || '',
    apiKey: '',
  };
}

function makeImageDraft(channel = {}) {
  return { baseUrl: channel.baseUrl || '', model: channel.model || '', apiKey: '' };
}

function cleanModels(models) {
  const seen = new Set();
  return (Array.isArray(models) ? models : []).filter((model) => {
    if (!model || typeof model.id !== 'string' || !model.id.trim() || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function savedCredentialMatches(saved, baseUrl) {
  return Boolean(saved?.apiKeyConfigured && saved?.baseUrl && saved.baseUrl === baseUrl.trim());
}

function resultLabel(result) {
  if (!result) return '尚未检查';
  if (result.capabilities && Object.hasOwn(result.capabilities, 'modelListed')) {
    if (result.capabilities.modelListed === true) return '模型已列出';
    if (result.capabilities.modelListed === false) return '模型未列出';
    if (result.capabilities.connectionTested) return '服务已连接';
  }
  return ({
    connected: '通过',
    unverified: '待人工确认',
    not_configured: '未配置',
    failed: '未通过',
    error: '检查出错',
    checked: '已检查',
  })[result.status] || '已检查';
}

function StatusMark({ result }) {
  const status = result?.status || 'pending';
  return <span className={`onboarding-check-state ${status}`}><i aria-hidden="true" />{resultLabel(result)}</span>;
}

/**
 * First-run setup UI. In the generic edition, Studio stores both the base and
 * image model channels. Pass companyMode to keep image selection in the
 * task-bound remote Canvas instead of writing its configuration locally.
 */
export function Onboarding({
  initialConfig,
  companyMode = false,
  onSkip = () => {},
  onConfigured = () => {},
  onCreateSample = async () => {},
}) {
  const initial = initialConfig || { revision: 1, base: {}, image: {} };
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState(initial);
  const [base, setBase] = useState(() => makeBaseDraft(initial.base));
  const [image, setImage] = useState(() => makeImageDraft(initial.image));
  const [reuseBaseCredentials, setReuseBaseCredentials] = useState(() => {
    const savedImage = initial.image || {};
    return (initial.base?.source || 'custom') === 'custom'
      && (!savedImage.model || savedImage.baseUrl === initial.base?.baseUrl);
  });
  const [models, setModels] = useState({ base: [], image: [] });
  const [modelsLoaded, setModelsLoaded] = useState({ base: false, image: false });
  const [modelsBusy, setModelsBusy] = useState('');
  const [modelErrors, setModelErrors] = useState({ base: '', image: '' });
  const modelRequests = useRef({ base: 0, image: 0 });
  const [pluginState, setPluginState] = useState(null);
  const [pluginError, setPluginError] = useState('');
  const [pluginBusy, setPluginBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState('');
  const [checks, setChecks] = useState({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sampleBrief, setSampleBrief] = useState(SAMPLE_BRIEF);
  const [creatingSample, setCreatingSample] = useState(false);

  const workBuddyRegion = base.source === 'workbuddy-intl' ? 'intl' : 'cn';
  const isWorkBuddy = base.source === 'workbuddy-cn' || base.source === 'workbuddy-intl';
  const workBuddyAccounts = (pluginState?.accounts || []).filter((account) => account.region === workBuddyRegion);
  const sharedCustomProvider = !companyMode && base.source === 'custom' && reuseBaseCredentials;
  const imageBaseUrl = sharedCustomProvider ? base.baseUrl : image.baseUrl;
  const imageCredentialSupplied = sharedCustomProvider ? base.apiKey : image.apiKey;

  useEffect(() => {
    if (!isWorkBuddy) return undefined;
    let active = true;
    setPluginState(null);
    setPluginError('');
    api.modelPlugin().then((result) => { if (active) setPluginState(result); })
      .catch((cause) => { if (active) setPluginError(cause.message || '无法读取 WorkBuddy 登录状态。'); });
    return () => { active = false; };
  }, [isWorkBuddy, workBuddyRegion]);

  useEffect(() => {
    if (pluginState?.login?.status !== 'pending') return undefined;
    let active = true;
    let timer;
    const poll = () => {
      timer = window.setTimeout(async () => {
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
      }, 2500);
    };
    poll();
    return () => { active = false; window.clearTimeout(timer); };
  }, [pluginState?.login?.status]);

  const savedBase = config.base || {};
  const savedImage = config.image || {};
  const baseUrl = base.baseUrl.trim();
  const baseReady = Boolean(base.model.trim() && (base.source !== 'custom'
    || (baseUrl && (base.apiKey.trim() || savedCredentialMatches(savedBase, baseUrl)))));
  const imageUrl = imageBaseUrl.trim();
  const imageKeyReady = sharedCustomProvider
    ? Boolean(imageCredentialSupplied.trim() || savedCredentialMatches(savedBase, imageUrl))
    : Boolean(imageCredentialSupplied.trim() || savedCredentialMatches(savedImage, imageUrl));
  const imageReady = companyMode || Boolean(image.model.trim() && imageUrl && imageKeyReady);
  const configReady = baseReady && imageReady;
  const savedBaseMatchesDraft = Boolean(
    savedBase.model === base.model.trim()
    && (savedBase.source || 'custom') === (base.source || 'custom')
    && (base.source !== 'custom' || (savedBase.baseUrl === baseUrl && savedBase.apiKeyConfigured && !base.apiKey.trim())),
  );
  const savedImageMatchesDraft = companyMode || Boolean(
    savedImage.model === image.model.trim()
    && savedImage.baseUrl === imageUrl
    && savedImage.apiKeyConfigured
    && !image.apiKey.trim()
    && !(sharedCustomProvider && base.apiKey.trim()),
  );
  const configurationSaved = configReady && savedBaseMatchesDraft && savedImageMatchesDraft;

  function invalidateModels(kind) {
    modelRequests.current[kind] += 1;
    setModels((current) => ({ ...current, [kind]: [] }));
    setModelsLoaded((current) => ({ ...current, [kind]: false }));
    setModelErrors((current) => ({ ...current, [kind]: '' }));
    if (modelsBusy === kind) setModelsBusy('');
  }

  function updateBase(field, value) {
    if (field !== 'model') invalidateModels('base');
    if (field === 'source') {
      setBase((current) => ({ ...current, source: value, model: '' }));
      if (value !== 'custom') setReuseBaseCredentials(false);
      else setReuseBaseCredentials((current) => current || !image.model || image.baseUrl === base.baseUrl);
    } else {
      setBase((current) => ({ ...current, [field]: value }));
    }
    if (!companyMode && (field === 'source' || field === 'baseUrl' || field === 'apiKey')) invalidateModels('image');
    setChecks({}); setError(''); setNotice('');
  }

  function updateImage(field, value) {
    if (field !== 'model') invalidateModels('image');
    setImage((current) => ({ ...current, [field]: value }));
    setChecks({}); setError(''); setNotice('');
  }

  async function fetchModels(kind) {
    const requestId = ++modelRequests.current[kind];
    setModelsBusy(kind); setModelErrors((current) => ({ ...current, [kind]: '' }));
    try {
      const lookupKind = kind === 'image' && sharedCustomProvider ? 'base' : kind;
      const payload = { kind: lookupKind };
      if (lookupKind === 'base') {
        payload.source = base.source || 'custom';
        if (payload.source === 'custom') {
          if (baseUrl) payload.baseUrl = baseUrl;
          if (base.apiKey) payload.apiKey = base.apiKey;
        }
      } else {
        if (imageUrl) payload.baseUrl = imageUrl;
        if (imageCredentialSupplied) payload.apiKey = imageCredentialSupplied;
      }
      const result = await api.models(payload);
      if (requestId !== modelRequests.current[kind]) return;
      setModels((current) => ({ ...current, [kind]: cleanModels(result?.models) }));
      setModelsLoaded((current) => ({ ...current, [kind]: true }));
    } catch (cause) {
      if (requestId !== modelRequests.current[kind]) return;
      setModels((current) => ({ ...current, [kind]: [] }));
      setModelsLoaded((current) => ({ ...current, [kind]: false }));
      setModelErrors((current) => ({ ...current, [kind]: cause.message || '获取模型列表失败。' }));
    } finally {
      if (requestId === modelRequests.current[kind]) setModelsBusy('');
    }
  }

  async function loginWorkBuddy() {
    setPluginBusy(true); setPluginError('');
    try {
      setPluginState(await api.loginModelPlugin({ region: workBuddyRegion }));
    } catch (cause) {
      setPluginError(cause.message || 'WorkBuddy 登录失败。');
    } finally { setPluginBusy(false); }
  }

  async function refreshPluginStatus() {
    setPluginBusy(true); setPluginError('');
    try { setPluginState(await api.modelPlugin()); }
    catch (cause) { setPluginError(cause.message || '无法读取 WorkBuddy 登录状态。'); }
    finally { setPluginBusy(false); }
  }

  async function saveConfiguration() {
    if (!baseReady) {
      setError(base.source === 'custom'
        ? '请填写基础模型服务地址、模型 ID 和 API 密钥；已保存的同地址密钥可以留空。'
        : '请先选择基础模型。');
      return false;
    }
    if (!imageReady) {
      setError('请填写图片模型服务地址、模型 ID 和 API 密钥，或选择与基础模型共用地址和密钥。');
      return false;
    }
    setSaving(true); setError(''); setNotice('');
    try {
      const payload = {
        expectedRevision: config.revision || 1,
        base: {
          source: base.source || 'custom',
          model: base.model.trim(),
          ...(base.source === 'custom' ? {
            baseUrl: baseUrl,
            apiKey: base.apiKey,
          } : {}),
        },
      };
      if (!companyMode) {
        payload.image = sharedCustomProvider
          ? { model: image.model.trim(), useBaseCredentials: true }
          : { baseUrl: imageUrl, model: image.model.trim(), apiKey: image.apiKey };
      }
      const response = await api.saveConfig(payload);
      const next = response.config;
      setConfig(next);
      setBase((current) => ({ ...current, apiKey: '' }));
      setImage((current) => ({ ...current, apiKey: '' }));
      setChecks({});
      setNotice('配置已保存到本机私有配置。模型列表和连通检查都不会生成图片。');
      await onConfigured(next);
      return true;
    } catch (cause) {
      setError(cause.message || '保存模型配置失败。');
      return false;
    } finally { setSaving(false); }
  }

  async function runCheck(kind) {
    setChecking(kind); setError(''); setNotice('');
    try {
      let result;
      if (kind === 'canvas') {
        const report = await api.companyCanvasCheck();
        result = {
          status: report.status === 'connected' || (Array.isArray(report.targets) && report.targets.length > 0) ? 'connected' : 'checked',
          message: report.message || (report.targets?.length ? `${report.targets.length} 个 Canvas 目标已返回连接诊断。` : '已完成远端 Canvas 诊断。'),
        };
      } else {
        const response = await api.checkConfig({ kind });
        result = response.checks?.[kind] || { status: 'error', message: '服务没有返回检查结果。' };
      }
      setChecks((current) => ({ ...current, [kind]: result }));
    } catch (cause) {
      setChecks((current) => ({ ...current, [kind]: { status: 'error', message: cause.message || '检查失败。' } }));
    } finally { setChecking(''); }
  }

  async function nextToChecks() {
    if (!baseReady) {
      setError(base.source === 'custom' ? '请先补全基础模型地址、密钥和模型 ID。' : '请先选择基础模型。');
      return;
    }
    if (!imageReady) {
      setError('请先补全图片模型地址、密钥和模型 ID，或开启同服务商复用。');
      return;
    }
    if (await saveConfiguration()) setStep(3);
  }

  async function createSample() {
    if (!sampleBrief.trim()) { setError('请先写下这次示例任务的需求。'); return; }
    setCreatingSample(true); setError('');
    try {
      await onCreateSample({ brief: sampleBrief.trim() });
    } catch (cause) {
      setError(cause.message || '示例任务没有创建成功。');
    } finally { setCreatingSample(false); }
  }

  function skip() {
    setBase((current) => ({ ...current, apiKey: '' }));
    setImage((current) => ({ ...current, apiKey: '' }));
    onSkip();
  }

  const provider = PROVIDERS.find((item) => item.id === base.source) || PROVIDERS[0];
  const imageListEnabled = !companyMode && Boolean(imageUrl && imageKeyReady);

  return <main className="onboarding-page">
    <div className="onboarding-frame">
      <header className="onboarding-header">
        <div><span className="onboarding-eyebrow">CREATIVE STUDIO · 首次设置</span><h1>先接好模型，再开始创作</h1><p>按步骤配置模型、检查连接，并用一条示例需求熟悉任务流程。</p></div>
        <button type="button" className="button subtle small onboarding-skip" onClick={skip} disabled={saving || creatingSample}>先跳过</button>
      </header>

      <nav className="onboarding-steps" aria-label="首次设置进度">
        {STEPS.map((label, index) => <button type="button" key={label} className={`onboarding-step ${step === index ? 'active' : ''} ${step > index ? 'done' : ''}`} onClick={() => { if (index < step) { setError(''); setStep(index); } }} aria-current={step === index ? 'step' : undefined} disabled={index > step}>
          <span>{step > index ? '✓' : String(index + 1).padStart(2, '0')}</span><strong>{label}</strong>
        </button>)}
      </nav>

      {(error || notice) && <div className={`onboarding-banner ${error ? 'error' : 'success'}`} role={error ? 'alert' : 'status'}>{error || notice}</div>}

      {step === 0 && <section className="onboarding-panel" aria-labelledby="onboarding-provider-title">
        <div className="onboarding-panel-heading"><span className="onboarding-index">01</span><div><h2 id="onboarding-provider-title">选择基础模型服务商</h2><p>它负责对话、工具调用、读图审核及本机素材清洗；图片生成是另一条模型通道。</p></div></div>
        <div className="onboarding-provider-grid">
          {PROVIDERS.map((item) => <button type="button" key={item.id} className={`onboarding-provider ${base.source === item.id ? 'selected' : ''}`} onClick={() => updateBase('source', item.id)} aria-pressed={base.source === item.id}>
            <span className="onboarding-provider-top"><strong>{item.name}</strong><small>{item.tag}</small></span><span>{item.detail}</span>
          </button>)}
        </div>
        {base.source === 'opencode' && <p className="onboarding-callout warning">现有验证记录显示 OpenCode 限制第三方客户端的实际对话。模型列表可读取不代表对话可用；如需托管来源，可考虑 Kilo。</p>}
        <div className="onboarding-actions"><span>可以随时跳过，之后从“模型与服务”重新打开。</span><button type="button" className="button primary" onClick={() => { setError(''); setStep(1); }}>继续<span aria-hidden="true"> →</span></button></div>
      </section>}

      {step === 1 && <section className="onboarding-panel" aria-labelledby="onboarding-access-title">
        <div className="onboarding-panel-heading"><span className="onboarding-index">02</span><div><h2 id="onboarding-access-title">{base.source === 'custom' ? '填写服务地址和 API 密钥' : `${provider.name} 的连接方式`}</h2><p>密钥只保存在当前电脑的 Studio 私有配置中，不会显示在普通配置回执里。</p></div></div>
        {base.source === 'custom' ? <div className="onboarding-fields">
          <label className="field-label">兼容 OpenAI API 的服务地址<input type="url" value={base.baseUrl} onChange={(event) => updateBase('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" autoComplete="url" /></label>
          <label className="field-label">基础模型 API 密钥<input type="password" value={base.apiKey} onChange={(event) => updateBase('apiKey', event.target.value)} placeholder={savedBase.apiKeyConfigured ? '同一地址已保存密钥；留空即可复用' : '粘贴服务商签发的 API 密钥'} autoComplete="new-password" /></label>
          <div className="onboarding-help-box"><strong>申请和填写帮助</strong><p>从你选定的服务商控制台创建 API 密钥，再复制其 OpenAI-compatible API 地址。不要把密钥放进 URL。</p><div className="onboarding-link-row">{OFFICIAL_LINKS.map((link) => <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer">{link.label} ↗</a>)}</div></div>
        </div> : <div className="onboarding-managed-help">
          {base.source === 'kilo' && <><h3>Kilo 不需要在 Studio 粘贴密钥</h3><p>选择基础模型时，Studio 会读取 Kilo 返回的模型列表。平台免费层、额度和可用性由 Kilo 决定。</p><a href="https://kilo.ai/" target="_blank" rel="noopener noreferrer">访问 Kilo 官方网站 ↗</a></>}
          {base.source === 'opencode' && <><h3>OpenCode 不需要在 Studio 粘贴密钥</h3><p>Studio 可查询模型目录；已有记录显示第三方客户端实际对话被上游拒绝。连接检查失败时请切换来源或使用自用 API。</p><a href="https://opencode.ai/" target="_blank" rel="noopener noreferrer">访问 OpenCode 官方网站 ↗</a></>}
          {isWorkBuddy && <><h3>请用你本人的 WorkBuddy 账号登录</h3><p>Studio 不会要求你复制 WorkBuddy 的登录凭据。登录后可读取此账号可用的基础模型，并按平台账号额度使用。</p>
            <div className="onboarding-login-row">{pluginState?.login?.status === 'pending' && pluginState.login.url ? <a href={pluginState.login.url} target="_blank" rel="noopener noreferrer">打开 WorkBuddy 登录页 ↗</a> : null}
              <button type="button" className="button outline small" onClick={loginWorkBuddy} disabled={pluginBusy || pluginState?.login?.status === 'pending'}>{pluginBusy ? '正在连接…' : workBuddyAccounts.length ? '添加账号' : `登录${workBuddyRegion === 'intl' ? '国际版' : '国内版'}`}</button>
              <button type="button" className="button subtle small" onClick={refreshPluginStatus} disabled={pluginBusy}>{pluginBusy ? '读取中…' : '更新登录状态'}</button>
            </div>
            {workBuddyAccounts.length > 0 && <p className="onboarding-account-status" role="status">已登录：{workBuddyAccounts.map((account) => account.name).join('、')}</p>}
            {pluginState?.login?.status === 'pending' && <p role="status">等待你在 WorkBuddy 页面完成登录，然后点击“更新登录状态”。</p>}
            {pluginError && <p className="onboarding-inline-error" role="alert">{pluginError}</p>}
          </>}
        </div>}

        {!companyMode && <div className="onboarding-shared-provider">
          <label><input type="checkbox" checked={sharedCustomProvider} disabled={base.source !== 'custom'} onChange={(event) => { setReuseBaseCredentials(event.target.checked); invalidateModels('image'); setError(''); }} /> 图片模型与对话模型共用服务地址和 API 密钥</label>
          <small>{base.source !== 'custom' ? '托管来源的基础模型凭据不提供给图片通道；请为图片 API 单独填写地址和密钥。' : '开启后只输入一次地址和密钥，保存时用于本机的基础模型与图片模型通道。'}</small>
        </div>}
        {!companyMode && !sharedCustomProvider && <div className="onboarding-fields image-access-fields">
          <h3>图片模型 API</h3>
          <label className="field-label">图片服务地址<input type="url" value={image.baseUrl} onChange={(event) => updateImage('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" autoComplete="url" /></label>
          <label className="field-label">图片模型 API 密钥<input type="password" value={image.apiKey} onChange={(event) => updateImage('apiKey', event.target.value)} placeholder={savedImage.apiKeyConfigured ? '同一地址已保存密钥；留空即可复用' : '粘贴图片服务商签发的 API 密钥'} autoComplete="new-password" /></label>
          <small>如果你选择了另一个服务商，请在该服务商控制台创建密钥。当前已保存的同地址密钥留空时会继续使用。</small>
        </div>}
        {companyMode && <div className="onboarding-callout"><strong>公司版的图片模型继续由远端 Canvas 管理</strong><p>本地 Studio 不会复制密钥或覆盖画布模型。完成示例任务后，在该任务的 Canvas 设置中选择图片服务和模型。</p></div>}
        <div className="onboarding-actions"><button type="button" className="button outline" onClick={() => { setError(''); setStep(0); }}>上一步</button><button type="button" className="button primary" onClick={() => { setError(''); setStep(2); }}>选择模型<span aria-hidden="true"> →</span></button></div>
      </section>}

      {step === 2 && <section className="onboarding-panel" aria-labelledby="onboarding-models-title">
        <div className="onboarding-panel-heading"><span className="onboarding-index">03</span><div><h2 id="onboarding-models-title">选择对话模型{companyMode ? '，了解图片模型位置' : '和图片模型'}</h2><p>两个模型承担不同工作。Studio 不会把模型列表或连通检查说成已经验证过图片生成。</p></div></div>
        <section className="onboarding-model-card">
          <div className="onboarding-model-head"><div><h3>基础模型 · {provider.name}</h3><p>负责需求对话、调用工具、读取参考图、整理素材及读图审核。</p></div><button type="button" className="button outline small" onClick={() => fetchModels('base')} disabled={modelsBusy === 'base' || (isWorkBuddy && workBuddyAccounts.length === 0)}>{modelsBusy === 'base' ? '读取中…' : modelsLoaded.base ? '刷新模型列表' : '获取模型列表'}</button></div>
          <label className="field-label">模型 ID<input list="onboarding-base-models" value={base.model} onChange={(event) => updateBase('model', event.target.value)} placeholder="从列表选取，或手动输入模型 ID" autoComplete="off" /></label>
          <datalist id="onboarding-base-models">{models.base.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</datalist>
          {modelErrors.base && <p className="onboarding-inline-error" role="alert">{modelErrors.base}</p>}
          {modelsLoaded.base && <small role="status">已读取 {models.base.length} 个模型；选择列表结果不代表实际对话检查通过。</small>}
          {isWorkBuddy && !workBuddyAccounts.length && <small>请先在上一步登录 WorkBuddy 账号，再读取模型列表。</small>}
        </section>

        {!companyMode ? <section className="onboarding-model-card">
          <div className="onboarding-model-head"><div><h3>图片模型</h3><p>负责 Canvas 中逐页生成图片；它不负责对话、制作单或工具调用。</p></div><button type="button" className="button outline small" onClick={() => fetchModels('image')} disabled={modelsBusy === 'image' || !imageListEnabled}>{modelsBusy === 'image' ? '读取中…' : modelsLoaded.image ? '刷新模型列表' : '获取模型列表'}</button></div>
          <label className="field-label">图片模型 ID<input list="onboarding-image-models" value={image.model} onChange={(event) => updateImage('model', event.target.value)} placeholder="从列表选取，或手动输入支持生图的模型 ID" autoComplete="off" /></label>
          <datalist id="onboarding-image-models">{models.image.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</datalist>
          {modelErrors.image && <p className="onboarding-inline-error" role="alert">{modelErrors.image}</p>}
          {modelsLoaded.image && <small role="status">已读取 {models.image.length} 个模型；模型目录含此 ID 不等于已经生成过图片。</small>}
          {!imageListEnabled && <small>请先在上一步填写图片服务地址和密钥，或开启共用服务商。</small>}
        </section> : <section className="onboarding-model-card remote-image-model">
          <div><h3>图片模型 · 远端任务 Canvas</h3><p>图片模型由 Canvas 直接调用并保存到该任务。完成示例首任务后，打开 Canvas 设置并选择图片服务及模型；Studio 不会读取、写入或覆盖这组远端凭据。</p></div>
          <span className="onboarding-remote-label">在 Canvas 中选择</span>
        </section>}

        <div className="onboarding-callout"><strong>费用与验证边界</strong><p>读取模型列表是只读请求，不会调用生图。基础模型的实际连通检查可能使用服务商额度；图片连通检查只检查模型目录，不发送图片生成请求。</p></div>
        <div className="onboarding-actions"><button type="button" className="button outline" onClick={() => { setError(''); setStep(1); }}>上一步</button><button type="button" className="button primary" onClick={nextToChecks}>保存并检查<span aria-hidden="true"> →</span></button></div>
      </section>}

      {step === 3 && <section className="onboarding-panel" aria-labelledby="onboarding-checks-title">
        <div className="onboarding-panel-heading"><span className="onboarding-index">04</span><div><h2 id="onboarding-checks-title">分级检查</h2><p>先确认本机配置，再分别检查基础模型、图片模型目录和 Canvas 连接；不会自动生成图片。</p></div></div>
        <div className="onboarding-save-status"><div><strong>{configurationSaved ? '当前配置已保存' : configReady ? '配置条件已满足' : '配置尚未完整'}</strong><p>{configReady ? `基础模型 ${base.model.trim()}${companyMode ? '' : ` · 图片模型 ${image.model.trim()}`}` : '回到前一步补齐模型 ID、服务地址或密钥。'}</p></div><button type="button" className="button outline small" onClick={saveConfiguration} disabled={saving || !configReady || configurationSaved}>{saving ? '保存中…' : configurationSaved ? '配置已保存' : '保存本机配置'}</button></div>
        <div className="onboarding-check-list">
          <article className="onboarding-check-card"><div><span className="onboarding-check-number">1</span><div><h3>本机配置</h3><p>{configurationSaved ? '模型 ID、服务地址和密钥状态已保存。' : '先保存当前输入；密钥只在本机私有目录保存。'}</p></div></div><StatusMark result={configurationSaved ? { status: 'connected' } : null} /></article>
          <article className="onboarding-check-card"><div><span className="onboarding-check-number">2</span><div><h3>基础模型对话与工具</h3><p>会向已保存的基础模型发出真实检查请求，可能消耗平台额度；不会生成图片。</p>{checks.base && <small>{checks.base.message}</small>}</div></div><div className="onboarding-check-action"><StatusMark result={checks.base} /><button type="button" className="button outline small" onClick={() => runCheck('base')} disabled={!configurationSaved || checking !== ''}>{checking === 'base' ? '检查中…' : '检查基础模型'}</button></div></article>
          {!companyMode && <article className="onboarding-check-card"><div><span className="onboarding-check-number">3</span><div><h3>图片模型目录</h3><p>只读服务端模型列表并核对所选 ID，不发起图片生成请求。</p>{checks.image && <small>{checks.image.message}{checks.image.capabilities?.connectionTested ? (checks.image.capabilities.modelListed ? ' 模型 ID 已列入列表。' : ' 当前模型 ID 未列入列表。') : ' 没有完成服务连接验证。'}</small>}</div></div><div className="onboarding-check-action"><StatusMark result={checks.image} /><button type="button" className="button outline small" onClick={() => runCheck('image')} disabled={!configurationSaved || checking !== ''}>{checking === 'image' ? '检查中…' : '检查图片通道'}</button></div></article>}
          {companyMode && <article className="onboarding-check-card"><div><span className="onboarding-check-number">3</span><div><h3>远端 Canvas 连接</h3><p>仅检查 Canvas 连接诊断，不验证模型能力，也不生成图片。</p>{checks.canvas && <small>{checks.canvas.message}</small>}</div></div><div className="onboarding-check-action"><StatusMark result={checks.canvas} /><button type="button" className="button outline small" onClick={() => runCheck('canvas')} disabled={checking !== ''}>{checking === 'canvas' ? '检查中…' : '检查 Canvas'}</button></div></article>}
        </div>
        <div className="onboarding-callout warning"><strong>图片能力还没有被实际生图验证</strong><p>模型列表和连接检查都不等于成功生成。真正绘图仍在任务中经你确认制作单后执行。</p></div>
        <div className="onboarding-actions"><button type="button" className="button outline" onClick={() => { setError(''); setStep(2); }}>上一步</button><button type="button" className="button primary" onClick={() => { setError(''); setStep(4); }}>写示例首任务<span aria-hidden="true"> →</span></button></div>
      </section>}

      {step === 4 && <section className="onboarding-panel" aria-labelledby="onboarding-sample-title">
        <div className="onboarding-panel-heading"><span className="onboarding-index">05</span><div><h2 id="onboarding-sample-title">创建示例首任务</h2><p>这会把下面的需求发给已选基础模型，可能消耗其额度；不会自动调用生图。</p></div></div>
        <label className="field-label">示例需求<textarea rows={5} maxLength={5000} value={sampleBrief} onChange={(event) => setSampleBrief(event.target.value)} /></label>
        <div className="onboarding-sample-flow"><span>模型先澄清需求</span><i>→</i><span>你确认制作单</span><i>→</i><span>你在 Canvas 选择图片模型并执行绘图</span></div>
        <div className="onboarding-callout"><strong>{companyMode ? '公司版图片模型设置' : '图片生成需要额外确认'}</strong><p>{companyMode ? '创建任务后，在远端 Canvas 里选择图片服务和模型。当前引导不会把本机密钥复制到公司画布。' : 'Canvas 图片模型已在本机配置；实际生成仍须在任务工作流中由你确认制作单后启动。'}</p></div>
        <div className="onboarding-actions"><button type="button" className="button outline" onClick={() => { setError(''); setStep(3); }} disabled={creatingSample}>上一步</button><button type="button" className="button primary" onClick={createSample} disabled={creatingSample || !sampleBrief.trim()}>{creatingSample ? '正在创建…' : '创建并提交示例需求'}</button></div>
        <button type="button" className="onboarding-finish-link" onClick={skip} disabled={creatingSample}>完成引导，稍后再创建任务</button>
      </section>}

      <footer className="onboarding-footer"><span>密钥留在本机私有配置；连接检查不会生成图片。</span><span>第 {step + 1} 步 / {STEPS.length}</span></footer>
    </div>
  </main>;
}
