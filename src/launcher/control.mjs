import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { runtimeIdentitiesMatch } from './identity.mjs';

export const readJson = async file => fs.readFile(file, 'utf8').then(JSON.parse).catch(e => { if(e.code==='ENOENT')return null; throw e; });
export function alive(pid) {
  if(!Number.isSafeInteger(pid)||pid<1)throw new Error('实例锁所有者无效，请检查数据目录。');
  try { process.kill(pid,0); return true; } catch(e) { if(e.code==='ESRCH')return false; throw e; }
}
const runtimeFile = root => path.join(root,'web','runtime.json');
function endpoint(value) {
  const u=new URL(value);
  if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.pathname!=='/'||u.username||u.password||u.search||u.hash)throw new Error('本机控制地址无效');
  return u.origin;
}
export async function runtimeStatus(root, currentIdentity) {
  const record=await readJson(runtimeFile(root));
  if(!record)return {running:false,...(currentIdentity?{currentIdentity}:{})};
  try {
    const response=await fetch(`${endpoint(record.controlUrl)}/health`,{headers:{authorization:`Bearer ${record.token}`},signal:AbortSignal.timeout(1500),redirect:'error'});
    const result=await response.json();
    if(response.ok&&result.instanceId===record.instanceId){
      const sourceIdentity=result.sourceIdentity||null;
      const identityMatches=currentIdentity?runtimeIdentitiesMatch(currentIdentity,sourceIdentity):undefined;
      return {
        running:true,
        url:record.url,
        instanceId:record.instanceId,
        pid:record.pid,
        sourceIdentity,
        ...(currentIdentity?{currentIdentity,identityMatches,identityMismatch:!identityMatches}:{}),
      };
    }
  }catch{}
  if(alive(record.pid))throw new Error('工作台进程仍在，但健康检查失败；请检查本数据目录 web/service.log，不会按 PID 强杀。');
  return {running:false,stale:true,...(currentIdentity?{currentIdentity}:{})};
}
export async function stopRuntime(root) {
  const status=await runtimeStatus(root);
  if(!status.running)return status;
  const record=await readJson(runtimeFile(root));
  const response=await fetch(`${endpoint(record.controlUrl)}/stop`,{method:'POST',headers:{authorization:`Bearer ${record.token}`},signal:AbortSignal.timeout(5000),redirect:'error'});
  if(!response.ok)throw new Error('工作台停止身份校验失败');
  const deadline=Date.now()+40_000;
  while(Date.now()<deadline){
    const owner=await readJson(path.join(root,'web','instance.lock'));
    if(!owner||owner.instanceId!==record.instanceId)return {running:false,stopped:true};
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error('工作台尚在完成停机，请稍后查询 status；未强制中断或重放请求。');
}
export async function serveControl({root,instanceId,url,stop,sourceIdentity=null}) {
  const token=randomBytes(32).toString('hex');
  const server=createServer((req,res)=>{
    const provided=String(req.headers.authorization||'');const expected=`Bearer ${token}`;
    if(req.headers.origin||provided.length!==expected.length||!timingSafeEqual(Buffer.from(provided),Buffer.from(expected))){res.writeHead(403).end();return;}
    res.setHeader('content-type','application/json');
    res.setHeader('cache-control','no-store');
    if(req.url==='/health'&&req.method==='GET'){res.end(JSON.stringify({instanceId,sourceIdentity}));return;}
    if(req.url==='/stop'&&req.method==='POST'){res.end(JSON.stringify({stopping:true}));setImmediate(()=>void stop());return;}
    res.writeHead(404).end();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  await fs.writeFile(runtimeFile(root),JSON.stringify({pid:process.pid,instanceId,url,controlUrl:`http://127.0.0.1:${server.address().port}`,token,sourceIdentity}),{mode:0o600});
  return async()=>{
    await new Promise(r=>server.close(r));
    const record=await readJson(runtimeFile(root));
    if(record?.instanceId===instanceId)await fs.rm(runtimeFile(root),{force:true});
  };
}
