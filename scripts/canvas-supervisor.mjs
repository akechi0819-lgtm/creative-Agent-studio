import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, open, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { canvasStorageHandler } from '../src/canvas/storage.mjs';
import { root, dataRoot } from '../src/canvas/client.mjs';

const data = dataRoot();
await mkdir(data, {recursive:true,mode:0o700});
await chmod(data,0o700);
const lock = path.join(data,'supervisor.lock');
let descriptor;
try { descriptor=await open(lock,'wx',0o600); } catch(error) {
  if(error.code!=='EEXIST') throw error;
  const owner=JSON.parse(await readFile(lock,'utf8'));
  if(!Number.isInteger(owner.pid)) throw new Error('实例锁无有效所有者，请检查 supervisor.lock');
  let alive=true; try {process.kill(owner.pid,0);} catch(e) {if(e.code==='ESRCH') alive=false; else throw e;}
  if(alive) throw new Error('本数据目录已有启动器，拒绝重复启动');
  await rm(lock); descriptor=await open(lock,'wx',0o600);
}
const instanceId = randomUUID(), token = randomBytes(32).toString('hex');
await descriptor.writeFile(JSON.stringify({pid:process.pid,instanceId}));
const projectId = process.env.STUDIO_PROJECT_ID || 'studio-p0';
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
const dist = path.join(root,'third_party/canvas/web/dist');
let child, stopping=false;
let webUrl='';
let bridgeUrl='';
const cookieName=`studio_canvas_${projectId}`;
const bootstrapTickets=new Map();
const browserSessions=new Map();
let currentImageConfig=null;
let currentConfigRevision=0;
const imageResultUrlTtlMs=60*60_000;
const maxImageResultUrlsPerSession=64;
const maxImageResultUrlLength=8192;
const maxImageJsonCaptureBytes=1024*1024;

function safeJson(res,status,value) {
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','referrer-policy':'no-referrer'});
  res.end(JSON.stringify(value));
}
function validStudioToken(value) {
  if(typeof value!=='string'||value.length!==token.length)return false;
  return timingSafeEqual(Buffer.from(value),Buffer.from(token));
}
function sameOrigin(req) { return !req.headers.origin || req.headers.origin===webUrl; }
async function readRequestJson(req,limit=64*1024) {
  const chunks=[];let size=0;
  for await(const chunk of req) {size+=chunk.length;if(size>limit)throw new Error('request too large');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
}
function validImageConfig(value) {
  if(value==null)return null;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid image config');
  const baseUrl=typeof value.baseUrl==='string'?value.baseUrl.trim():'';
  const model=typeof value.model==='string'?value.model.trim():'';
  const apiKey=typeof value.apiKey==='string'?value.apiKey:'';
  const apiFormat=value.apiFormat==='gemini'?'gemini':'openai';
  if(baseUrl.length>2000||model.length>300||apiKey.length>5000)throw new Error('invalid image config');
  if(baseUrl){const parsed=new URL(baseUrl);if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error('invalid image config');}
  return {baseUrl,model,apiKey,apiFormat};
}
function sessionCookie(req) {
  const prefix=`${cookieName}=`;
  for(const part of String(req.headers.cookie||'').split(';')) {
    const value=part.trim();
    if(value.startsWith(prefix))try{return decodeURIComponent(value.slice(prefix.length));}catch{return '';}
  }
  return '';
}
function browserSession(req) {
  const sessionId=sessionCookie(req);const session=browserSessions.get(sessionId);
  if(!session||session.expiresAt<Date.now()){browserSessions.delete(sessionId);return null;}
  return session;
}
function allowedImageTarget(session, target, method) {
  const image=session.imageConfig;
  if(!image?.baseUrl||!image.model||!image.apiKey)return false;
  let base;
  try {base=new URL(image.baseUrl);} catch {return false;}
  if(target.protocol!==base.protocol||target.origin!==base.origin||target.username||target.password||target.search||target.hash)return false;
  const basePath=base.pathname.replace(/\/+$/,'');
  const apiPath=/\/v1$/i.test(basePath)?basePath:`${basePath}/v1`;
  const path=target.pathname;
  return (method==='GET'&&path===`${apiPath}/models`)
    || (method==='POST'&&(path===`${apiPath}/images/generations`||path===`${apiPath}/images/edits`));
}
function isImageCreationTarget(session,target,method) {
  if(method!=='POST')return false;
  const image=session.imageConfig;
  if(!image?.baseUrl)return false;
  let base;
  try {base=new URL(image.baseUrl);} catch {return false;}
  if(target.protocol!==base.protocol||target.origin!==base.origin||target.username||target.password||target.search||target.hash)return false;
  const basePath=base.pathname.replace(/\/+$/,'');
  const apiPath=/\/v1$/i.test(basePath)?basePath:`${basePath}/v1`;
  return target.pathname===`${apiPath}/images/generations`||target.pathname===`${apiPath}/images/edits`;
}
function cleanImageResultUrls(session,now=Date.now()) {
  const urls=session.imageResultUrls;
  if(!(urls instanceof Map))return;
  for(const [value,expiresAt] of urls)if(expiresAt<=now)urls.delete(value);
  while(urls.size>maxImageResultUrlsPerSession)urls.delete(urls.keys().next().value);
}
function rememberImageResultUrls(session,body) {
  let parsed;
  try {parsed=JSON.parse(body.toString('utf8'));} catch {return;}
  if(!Array.isArray(parsed?.data))return;
  if(!(session.imageResultUrls instanceof Map))session.imageResultUrls=new Map();
  const expiresAt=Math.min(session.expiresAt,Date.now()+imageResultUrlTtlMs);
  for(const item of parsed.data) {
    const value=item?.url;
    if(typeof value!=='string'||!value||value.length>maxImageResultUrlLength)continue;
    let target;
    try {target=new URL(value);} catch {continue;}
    if(!['http:','https:'].includes(target.protocol)||target.username||target.password||target.hash)continue;
    session.imageResultUrls.delete(value);
    session.imageResultUrls.set(value,expiresAt);
  }
  cleanImageResultUrls(session);
}
function imageResultUrlAllowed(session,value) {
  cleanImageResultUrls(session);
  return session.imageResultUrls instanceof Map&&session.imageResultUrls.has(value);
}
function decodeImageProxyTarget(rawTarget) {
  // Existing raw target fixtures include the whole URL after the route prefix.
  // The app itself now encodes the URL so its signed query cannot become the proxy query.
  return /^https?:\/\//i.test(rawTarget)?rawTarget:decodeURIComponent(rawTarget);
}
async function relayUpstreamBody(upstream,res,{captureImageUrls=false,session}={}) {
  if(!upstream.body){res.end();return;}
  const canCapture=captureImageUrls&&/^application\/json(?:\s*;|$)/i.test(upstream.headers.get('content-type')||'');
  if(!canCapture){await pipeline(Readable.fromWeb(upstream.body),res);return;}
  const reader=upstream.body.getReader();
  const captured=[];let size=0,done=false;
  while(size<=maxImageJsonCaptureBytes) {
    const chunk=await reader.read();
    if(chunk.done){done=true;break;}
    const bytes=Buffer.from(chunk.value);
    captured.push(bytes);size+=bytes.length;
    if(size>maxImageJsonCaptureBytes)break;
  }
  const prefix=Buffer.concat(captured);
  if(done) {
    rememberImageResultUrls(session,prefix);
    res.end(prefix);
    return;
  }
  const remaining=Readable.from((async function*(){
    if(prefix.length)yield prefix;
    try {
      while(true) {
        const chunk=await reader.read();
        if(chunk.done)break;
        yield Buffer.from(chunk.value);
      }
    } finally {reader.releaseLock();}
  })());
  await pipeline(remaining,res);
}
async function proxyImageRequest(req,res) {
  if(!sameOrigin(req)){res.writeHead(403,{'cache-control':'no-store'}).end();return;}
  const session=browserSession(req);
  if(!session){safeJson(res,401,{error:'Studio session required'});return;}
  const prefix='/__studio/image-proxy/';
  const raw=String(req.url||'');
  if(!raw.startsWith(prefix)){res.writeHead(404,{'cache-control':'no-store'}).end();return;}
  const rawTarget=raw.slice(prefix.length);
  let targetValue,target;
  try {targetValue=decodeImageProxyTarget(rawTarget);target=new URL(targetValue);} catch {res.writeHead(400,{'cache-control':'no-store'}).end();return;}
  const method=req.method||'GET';
  const isApiTarget=allowedImageTarget(session,target,method);
  const isIssuedImageResult=method==='GET'&&imageResultUrlAllowed(session,targetValue);
  if(!isApiTarget&&!isIssuedImageResult){res.writeHead(403,{'cache-control':'no-store'}).end();return;}
  const controller=new AbortController();
  const timeoutMs=isIssuedImageResult?10*60_000:method==='GET'?15_000:10*60_000;
  const timeout=setTimeout(()=>controller.abort(),timeoutMs);
  req.once('aborted',()=>controller.abort());
  res.once('finish',()=>clearTimeout(timeout));
  res.once('close',()=>{clearTimeout(timeout);if(!res.writableEnded)controller.abort();});
  const headers=new Headers();
  if(isApiTarget)headers.set('authorization',`Bearer ${session.imageConfig.apiKey}`);
  for(const name of isApiTarget?['accept','content-type']:['accept']) {
    const value=req.headers[name];
    if(typeof value==='string')headers.set(name,value);
  }
  const init={method:req.method,headers,signal:controller.signal,redirect:'manual'};
  if((req.method||'GET')==='POST'){
    init.body=Readable.toWeb(req);
    init.duplex='half';
  }
  try {
    const upstream=await fetch(targetValue,init);
    if(upstream.status>=300&&upstream.status<400){res.writeHead(502,{'cache-control':'no-store'}).end();return;}
    const forwarded={};
    for(const name of ['content-type','etag','last-modified','retry-after']){
      const value=upstream.headers.get(name);if(value)forwarded[name]=value;
    }
    forwarded['cache-control']='no-store';
    res.writeHead(upstream.status,forwarded);
    if(!upstream.body){res.end();return;}
    try { await relayUpstreamBody(upstream,res,{captureImageUrls:isApiTarget&&isImageCreationTarget(session,target,method)&&upstream.status>=200&&upstream.status<300,session}); }
    catch { if(!res.destroyed)res.destroy(); }
  } catch {
    if(!res.destroyed&&!res.headersSent)safeJson(res,502,{error:'图片服务转发失败'});
    else if(!res.destroyed)res.destroy();
  }
}
const storageHandler=canvasStorageHandler({data,authorize:req=>sameOrigin(req)&&Boolean(browserSession(req))});
const server = createServer(async (req,res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if(await storageHandler(req,res,url))return;
  if(url.pathname.startsWith('/__studio/'))res.setHeader('referrer-policy','no-referrer');
  if(url.pathname.startsWith('/__studio/image-proxy/')){await proxyImageRequest(req,res);return;}
  if (url.pathname === '/__studio/health') {
    safeJson(res,200,{instanceId,projectId}); return;
  }
  if(url.pathname==='/__studio/bootstrap/issue') {
    if(req.method!=='POST'||!validStudioToken(req.headers['x-studio-token'])||!sameOrigin(req)){res.writeHead(403,{'cache-control':'no-store'}).end();return;}
    try {
      const body=await readRequestJson(req);
      if(Object.keys(body).some((key)=>key!=='projectTitle'))throw new Error('invalid bootstrap request');
      const projectTitle=typeof body.projectTitle==='string'&&body.projectTitle.trim()?body.projectTitle.trim().slice(0,160):'Creative Studio Canvas';
      if(/[\u0000-\u001f\u007f]/.test(projectTitle))throw new Error('invalid project title');
      for(const [key,item] of bootstrapTickets)if(item.expiresAt<Date.now())bootstrapTickets.delete(key);
      const ticket=randomBytes(32).toString('hex');
      bootstrapTickets.set(ticket,{projectTitle,expiresAt:Date.now()+60_000});
      safeJson(res,200,{ticket});
    } catch {safeJson(res,400,{error:'invalid bootstrap request'});}
    return;
  }
  if(url.pathname==='/__studio/config') {
    if(req.method!=='POST'||!validStudioToken(req.headers['x-studio-token'])||!sameOrigin(req)){res.writeHead(403,{'cache-control':'no-store'}).end();return;}
    try {
      const body=await readRequestJson(req,12*1024);
      if(!Number.isInteger(body.configRevision)||body.configRevision<1)throw new Error('invalid config revision');
      if(body.configRevision<currentConfigRevision){safeJson(res,409,{error:'stale config revision'});return;}
      const imageConfig=validImageConfig(body.imageConfig);
      currentImageConfig=imageConfig;
      currentConfigRevision=body.configRevision;
      for(const session of browserSessions.values()) {
        if(session.expiresAt>Date.now()) {
          session.imageConfig=currentImageConfig;
          session.configRevision=currentConfigRevision;
        }
      }
      safeJson(res,200,{ok:true,configRevision:currentConfigRevision});
    } catch {safeJson(res,400,{error:'invalid config update'});}
    return;
  }
  if(url.pathname==='/__studio/bootstrap') {
    if(req.method!=='POST'||!sameOrigin(req)){res.writeHead(403,{'cache-control':'no-store'}).end();return;}
    try {
      const body=await readRequestJson(req,4096);
      const ticket=typeof body.ticket==='string'?body.ticket:'';
      const item=bootstrapTickets.get(ticket);
      bootstrapTickets.delete(ticket);
      if(!item||item.expiresAt<Date.now()){safeJson(res,403,{error:'bootstrap ticket expired'});return;}
      for(const [key,session] of browserSessions)if(session.expiresAt<Date.now())browserSessions.delete(key);
      const sessionId=randomBytes(32).toString('hex');
      browserSessions.set(sessionId,{projectTitle:item.projectTitle,imageConfig:currentImageConfig,configRevision:currentConfigRevision,expiresAt:Date.now()+24*60*60_000,imageResultUrls:new Map()});
      res.setHeader('Set-Cookie',`${cookieName}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
      safeJson(res,200,{ok:true});
    } catch {safeJson(res,400,{error:'invalid bootstrap request'});}
    return;
  }
  if(url.pathname==='/__studio/session') {
    if(req.method!=='GET'||!sameOrigin(req)){res.writeHead(403,{'cache-control':'no-store'}).end();return;}
    const session=browserSession(req);
    if(!session){safeJson(res,401,{error:'Studio session required'});return;}
    safeJson(res,200,{ok:true,projectId,projectTitle:session.projectTitle,bridgeUrl,imageConfig:session.imageConfig,configRevision:session.configRevision,bridgeToken:token});
    return;
  }
  if (url.pathname === '/__studio/stop') {
    if (req.method !== 'POST' || !validStudioToken(req.headers['x-studio-token'])) {res.writeHead(403).end();return;}
    res.end('stopping'); void stop(); return;
  }
  try {
    const requested = path.resolve(dist, '.' + decodeURIComponent(url.pathname));
    if (!requested.startsWith(dist + path.sep)) throw new Error('invalid path');
    let file = requested;
    let body;
    try { body = await readFile(file); } catch { file=path.join(dist,'index.html'); body=await readFile(file); }
    res.setHeader('Content-Type',mime[path.extname(file)] || 'application/octet-stream'); res.end(body);
  } catch {res.writeHead(404).end();}
});
async function freePort() { const s=netServer(); await new Promise((resolve,reject)=>{s.on('error',reject);s.listen(0,'127.0.0.1',resolve);}); const port=s.address().port; await new Promise(r=>s.close(r));return port; }
async function stop() {
  if (stopping) return; stopping=true;
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(r=>child.once('exit',r)); }
  await new Promise(r=>server.close(r));
  await descriptor.close(); await rm(lock,{force:true}); await rm(path.join(data,'canvas-instance.json'),{force:true});
}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
process.once('exit',()=>{if(child&&child.exitCode===null)try{child.kill('SIGTERM');}catch{}});
try {
  await readFile(path.join(dist,'index.html'));
  const savedPort=await readFile(path.join(data,'canvas-web-port.json'),'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  const webPort=Number(process.env.STUDIO_WEB_PORT) || savedPort?.port || 0;
  await new Promise((resolve,reject)=>{server.on('error',reject);server.listen(webPort,'127.0.0.1',resolve);});
  await writeFile(path.join(data,'canvas-web-port.json'),JSON.stringify({port:server.address().port}),{mode:0o600});
  webUrl=`http://127.0.0.1:${server.address().port}`;
  const bridgePort=await freePort();
  const logs = await open(path.join(data,'canvas-bridge.log'),'a',0o600);
  child=spawn(process.execPath,[path.join(root,'third_party/canvas/canvas-agent/dist/index.js')],{
    cwd:root,env:{PATH:process.env.PATH||'',HOME:process.env.HOME||'',TMPDIR:process.env.TMPDIR||'',LANG:process.env.LANG||'en_US.UTF-8',PORT:String(bridgePort),CANVAS_AGENT_TOKEN:token,CANVAS_AGENT_DATA_DIR:path.join(data,'bridge'),CANVAS_AGENT_PROJECT_ID:projectId,CANVAS_AGENT_INSTANCE_ID:instanceId,CANVAS_AGENT_ORIGIN:webUrl},stdio:['ignore',logs.fd,logs.fd],
  });
  await logs.close();
  child.once('exit',()=>{ if (!stopping) void stop(); });
  child.once('error',()=>void stop());
  bridgeUrl=`http://127.0.0.1:${bridgePort}`;
  let ready=false;
  for (let i=0;i<100;i++) {
    if (child.exitCode !== null) break;
    try {const response=await fetch(bridgeUrl+'/health',{headers:{'x-canvas-agent-token':token}});const b=await response.json(); if(response.ok&&b.instanceId===instanceId){ready=true;break;}} catch {}
    await new Promise(r=>setTimeout(r,100));
  }
  if (!ready) throw new Error('纯绘图桥接启动失败，检查数据目录 canvas-bridge.log');
  const instance={instanceId,token,projectId,webUrl,bridgeUrl,pid:process.pid};
  if(!process.env.STUDIO_TASK_INSTANCE)instance.browserUrl=webUrl+'/canvas?mode=recent&projectId='+encodeURIComponent(projectId)+'#'+new URLSearchParams({agentUrl:bridgeUrl,agentToken:token});
  await writeFile(path.join(data,'canvas-instance.json'),JSON.stringify(instance,null,2),{mode:0o600});
  console.log(JSON.stringify({ready:true,instanceId,webUrl,projectId}));
} catch {console.error('Canvas 启动失败，请检查本地实例日志与锁状态'); await stop();process.exitCode=1;}
