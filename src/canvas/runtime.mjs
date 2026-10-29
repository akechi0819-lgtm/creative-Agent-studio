import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { root as sourceRoot, dataRoot, health, callCanvasTool } from './client.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** One persistent local Canvas workspace, shared by host conversation threads. */
export function createCanvasRuntime({ root = dataRoot(), openBrowser = launchBrowser } = {}) {
  root = path.resolve(root);
  const instanceFile = path.join(root, 'canvas-instance.json');
  let starting;

  async function instance() {
    let value;
    try { value = JSON.parse(await fs.readFile(instanceFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('本地画布实例记录无法读取'); }
    try {
      const status = await health(value, { signal: AbortSignal.timeout(1500) });
      if (value.sourceRoot !== sourceRoot) throw new Error('本数据目录已有其他版本的画布运行，请先关闭该画布服务');
      return { config: value, status };
    } catch (error) {
      if (value.sourceRoot !== sourceRoot && error.message.includes('其他版本')) throw error;
      return null;
    }
  }

  async function status() {
    const current = await instance();
    return { running: Boolean(current), dataRoot: root, webUrl: current?.config.webUrl || null,
      workspaceId: 'company-lite', targets: current?.status.targets || [] };
  }

  async function ensure() {
    const existing = await instance();
    if (existing) return existing.config;
    if (starting) return starting;
    starting = (async () => {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const args = [];
      if (process.allowedNodeEnvironmentFlags.has('--use-env-proxy') &&
        (process.execArgv.includes('--use-env-proxy') || ['HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','https_proxy','http_proxy','all_proxy'].some(key => process.env[key]))) args.push('--use-env-proxy');
      args.push(path.join(sourceRoot, 'scripts/canvas-supervisor.mjs'));
      const env = { STUDIO_DATA_DIR: root };
      for (const key of ['PATH','HOME','TMPDIR','TMP','TEMP','USERPROFILE','LOCALAPPDATA','APPDATA','SYSTEMROOT','WINDIR','LANG',
        'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy']) if (process.env[key]) env[key] = process.env[key];
      const log = await fs.open(path.join(root, 'canvas-runtime.log'), 'a', 0o600);
      const child = spawn(process.execPath, args, { cwd: sourceRoot, env, detached: true, windowsHide: true, stdio: ['ignore',log.fd,log.fd] });
      await log.close();
      let failed;
      child.once('error', error => { failed = error; });
      child.unref();
      for (let count = 0; count < 150 && !failed; count++) {
        const current = await instance();
        if (current) return current.config;
        if (child.exitCode !== null) break;
        await pause(100);
      }
      throw new Error('本地画布启动失败；请检查 canvas-runtime.log，不要重新生成图片');
    })();
    try { return await starting; } finally { starting = null; }
  }

  async function open({ mode = 'recent', projectId, browser = true } = {}) {
    if (!['recent','new','choose'].includes(mode)) throw new Error('画布打开方式无效');
    if (projectId !== undefined && !/^[A-Za-z0-9_-]{1,160}$/.test(projectId)) throw new Error('画布项目 ID 无效');
    const config = await ensure();
    const pathname = projectId ? `/canvas/${encodeURIComponent(projectId)}` : `/canvas?mode=${mode}`;
    const current = await health(config);
    const active = current.targets.find(item => item.active) || (current.targets.length === 1 ? current.targets[0] : null);
    if (browser && active) {
      await callCanvasTool('site_navigate', { path: pathname }, { ...config, clientId: active.clientId, projectId: active.projectId });
      return { ...(await status()), reusedWindow: true };
    }
    const response = await fetch(`${config.webUrl}/__studio/bootstrap/issue`, {
      method:'POST', headers:{'content-type':'application/json','x-studio-token':config.token}, body:'{}', signal:AbortSignal.timeout(3000),
    });
    const result = await response.json();
    if (!response.ok || !/^[a-f0-9]{64}$/.test(result.ticket || '')) throw new Error('本地画布连接凭证签发失败');
    const url = `${config.webUrl}${pathname}#studioBootstrap=${result.ticket}`;
    if (browser) await openBrowser(url);
    return { ...(await status()), ...(browser ? {} : { openUrl: url }), reusedWindow: false };
  }

  async function call(name, input = {}, target = {}) {
    const config = await ensure();
    return callCanvasTool(name, input, { ...config, ...target });
  }

  async function stop() {
    const current = await instance();
    if (!current) return { stopped: true };
    const response = await fetch(`${current.config.webUrl}/__studio/stop`, {
      method:'POST', headers:{'x-studio-token':current.config.token}, signal:AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error('本地画布未能停止');
    for (let count=0; count<50; count++) { if (!(await instance())) return {stopped:true}; await pause(100); }
    throw new Error('本地画布尚未退出');
  }
  return { status, ensure, open, call, stop };
}

function launchBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler',url] : [url];
  return new Promise((resolve,reject) => {
    const child=spawn(command,args,{stdio:'ignore',windowsHide:true});
    child.once('error',reject); child.once('exit',code=>code===0?resolve():reject(new Error('系统浏览器未能打开本地画布')));
  });
}

export function mcpConfiguration() {
  return { mcpServers: { 'company-lite-canvas': { command:process.execPath, args:[path.join(sourceRoot,'scripts/canvas-mcp.mjs')] } } };
}
