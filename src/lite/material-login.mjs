import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

const TOKEN_BYTES = 32;
const BODY_LIMIT = 8192;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const USERNAME_LIMIT = 512;
const PASSWORD_LIMIT = 2048;

function loginError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeBaseUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch {
    throw loginError('ERR_MATERIAL_URL', '素材库地址无效；需要远端 HTTPS 地址');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const localHostname = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1'
    || (net.isIP(hostname) === 4 && Number(hostname.split('.')[0]) === 127);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || localHostname) {
    throw loginError('ERR_MATERIAL_URL', '素材库地址仅支持非本机、不含凭据或查询参数的远端 HTTPS 地址');
  }
  return parsed.toString().replace(/\/$/, '');
}

function headers() {
  return {
    'Cache-Control': 'no-store, max-age=0',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'strict-origin',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function page(action, message = '', success = false) {
  const notice = message
    ? `<p class="notice ${success ? 'success' : 'error'}" role="status">${escapeHtml(message)}</p>`
    : '';
  const form = success ? '' : `
    <form method="post" action="${escapeHtml(action)}" enctype="application/x-www-form-urlencoded" autocomplete="on">
      <label for="username">用户名</label>
      <input id="username" name="username" type="text" autocomplete="username" maxlength="${USERNAME_LIMIT}" required autofocus>
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" maxlength="${PASSWORD_LIMIT}" required>
      <button type="submit">登录并验证素材访问</button>
    </form>
    <p class="hint">账号密码不会发送到对话；验证通过后保存在本机，供后续素材访问使用。此页面将在 10 分钟后失效。</p>`;
  const stages = success ? `
    <ul class="stages" aria-label="验证结果">
      <li><span>Teedy 登录</span><strong>已验证</strong></li>
      <li><span>素材查询</span><strong>已验证</strong></li>
      <li><span>原件下载</span><strong>已验证</strong></li>
    </ul>` : '';
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Company Lite · 素材库登录</title>
<style>
  :root{color-scheme:light;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f3f5f8;color:#17212b}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
  main{width:min(100%,440px);background:#fff;border:1px solid #dfe5ec;border-radius:16px;padding:32px;box-shadow:0 14px 38px #19283a12}
  .eyebrow{margin:0 0 8px;color:#316b75;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
  h1{margin:0;font-size:24px;line-height:1.25}p{line-height:1.55}.intro{margin:12px 0 24px;color:#526170;font-size:14px}
  form{display:grid;gap:10px}label{font-size:13px;font-weight:650;margin-top:4px}input{width:100%;height:44px;border:1px solid #c8d2dd;border-radius:8px;padding:0 12px;font:inherit;background:#fff;color:#17212b}
  input:focus{outline:3px solid #316b7530;border-color:#316b75}button{height:46px;margin-top:12px;border:0;border-radius:8px;background:#175b65;color:white;font:inherit;font-weight:700;cursor:pointer}
  button:hover{background:#104b54}.hint{margin:18px 0 0;color:#697887;font-size:12px}.notice{margin:0 0 18px;border-radius:8px;padding:12px 14px;font-size:14px}.error{background:#fff0ed;color:#8f2e22}.success{background:#eaf7ef;color:#205f3a}
  .stages{list-style:none;margin:20px 0 0;padding:0;border-top:1px solid #e7ebef}.stages li{display:flex;justify-content:space-between;gap:16px;padding:13px 0;border-bottom:1px solid #e7ebef;font-size:14px}.stages strong{color:#267044}
</style></head>
<body><main><p class="eyebrow">Company Lite</p><h1>${success ? '素材库验证完成' : '登录公司素材库'}</h1>
<p class="intro">使用本人 Teedy 账号完成登录、素材查询和原件下载验证。</p>${notice}${form}${stages}</main></body></html>`;
  return html;
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, { ...headers(), 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html);
}

async function readFormBody(request) {
  const chunks = [];
  let length = 0;
  let oversized = false;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > BODY_LIMIT) oversized = true;
    else if (!oversized) chunks.push(chunk);
  }
  if (oversized) throw loginError('ERR_MATERIAL_FORM_SIZE', '表单内容超出限制，请重新打开登录页面。');
  const values = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  const keys = [...values.keys()];
  if (keys.length !== 2 || new Set(keys).size !== 2 || !keys.includes('username') || !keys.includes('password')) {
    throw loginError('ERR_MATERIAL_FORM', '登录表单无效，请重新填写。');
  }
  const username = values.get('username');
  const password = values.get('password');
  if (!username.trim() || !password || username.length > USERNAME_LIMIT || password.length > PASSWORD_LIMIT) {
    throw loginError('ERR_MATERIAL_FORM', '用户名或密码为空或超出长度限制，请重新填写。');
  }
  return { username, password };
}

function failureMessage(error) {
  if (error?.code === 'ERR_MATERIAL_FORM' || error?.code === 'ERR_MATERIAL_FORM_SIZE') return error.message;
  if (error?.failureCode === 'no_small_image') return '前 20 份可见素材中未找到可用于安装验证的小图片原件。请确保账号可访问一张不超过 8 MiB 的图片后重试。';
  if (error?.failureCode === 'empty_download') return '素材记录可见，但原件下载内容为空。请检查文件读取权限后重试。';
  if (error?.stage === 'login') return '身份验证未通过。请检查用户名、密码或网络后重试。';
  if (error?.stage === 'query') return '登录成功，但素材查询验证未通过。请检查账户的只读访问权限后重试。';
  if (error?.stage === 'download') return '素材查询成功，但原件下载验证未通过。请检查文件读取权限后重试。';
  if (error?.stage === 'save') return '验证结果未保存。请检查本机存储权限后重试。';
  return '素材访问验证未完成。请检查连接设置后重试。';
}

/** Start a one-use local login page. Credentials are passed only to the in-memory callback. */
export async function startMaterialLogin({
  baseUrl,
  onCredentials,
  host = '127.0.0.1',
  port = 0,
  timeoutMs = LOGIN_TIMEOUT_MS,
  token = crypto.randomBytes(TOKEN_BYTES).toString('base64url'),
} = {}) {
  const safeUrl = safeBaseUrl(baseUrl);
  if (host !== '127.0.0.1') throw loginError('ERR_MATERIAL_BIND', '素材库登录页面只能绑定到 127.0.0.1');
  if (typeof onCredentials !== 'function') throw loginError('ERR_MATERIAL_LOGIN', '素材库登录验证函数缺失');
  if (!/^[A-Za-z0-9_-]{32,100}$/.test(token)) throw loginError('ERR_MATERIAL_TOKEN', '一次性登录令牌无效');

  const route = `/${token}`;
  let serverOrigin;
  let processing = false;
  let settled = false;
  let timeout;
  let resolveCompletion;
  let rejectCompletion;
  const completed = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  // The completion promise is awaited by the CLI. Keep an attached handler in case
  // the caller receives the session and the timeout fires before it starts waiting.
  completed.catch(() => {});

  const server = http.createServer(async (request, response) => {
    if (settled) {
      sendHtml(response, 410, page(route, '此登录链接无效或已过期。'));
      return;
    }
    let requestUrl;
    try { requestUrl = new URL(request.url || '/', serverOrigin); }
    catch {
      sendHtml(response, 400, page(route, '登录请求无效。请返回宿主对话重新打开登录页面。'));
      return;
    }
    const validHost = request.headers.host === serverOrigin.host;
    if (!validHost || requestUrl.origin !== serverOrigin.origin || requestUrl.pathname !== route || requestUrl.search || requestUrl.hash) {
      sendHtml(response, 404, page(route, '此登录链接无效或已过期。'));
      return;
    }
    if (request.method === 'GET') {
      sendHtml(response, 200, page(route));
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { ...headers(), Allow: 'GET, POST' });
      response.end();
      return;
    }
    if (request.headers.origin !== serverOrigin.origin) {
      sendHtml(response, 403, page(route, '请求来源检查失败。请返回宿主对话重新打开登录页面。'));
      return;
    }
    if (processing) {
      sendHtml(response, 409, page(route, '正在验证上一份表单，请稍候。'));
      return;
    }
    if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
      sendHtml(response, 415, page(route, '表单格式无效，请重新填写。'));
      return;
    }
    processing = true;
    try {
      const credentials = await readFormBody(request);
      let result;
      try { result = await onCredentials({ baseUrl: safeUrl, ...credentials }); }
      catch (error) {
        sendHtml(response, 200, page(route, failureMessage(error)));
        return;
      }
      settled = true;
      clearTimeout(timeout);
      sendHtml(response, 200, page(route, '登录、素材查询及原件下载验证均已通过。', true));
      server.close(() => resolveCompletion(result));
    } catch (error) {
      sendHtml(response, error?.code === 'ERR_MATERIAL_FORM_SIZE' ? 413 : 400, page(route, failureMessage(error)));
    } finally {
      processing = false;
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.on('error', (error) => {
    if (!settled) {
      settled = true;
      clearTimeout(timeout);
      rejectCompletion(loginError('ERR_MATERIAL_LOGIN_SERVER', error.code === 'EADDRINUSE' ? '本机登录端口暂不可用，请重试。' : '本机登录服务未能启动。'));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  serverOrigin = new URL(`http://127.0.0.1:${address.port}`);
  timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    server.close(() => rejectCompletion(loginError('ERR_MATERIAL_LOGIN_TIMEOUT', '本机素材库登录页面已过期，请重新运行 login-materials。')));
    server.closeAllConnections();
  }, timeoutMs);
  timeout.unref?.();

  return {
    url: new URL(route, serverOrigin).toString(),
    completed,
    close() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close(() => rejectCompletion(loginError('ERR_MATERIAL_LOGIN_CLOSED', '本机素材库登录已取消。')));
      server.closeAllConnections();
    },
  };
}
