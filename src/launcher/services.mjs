import fs from 'node:fs/promises';
import path from 'node:path';

function localOrigin(value){
  const url=new URL(value);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('服务地址无效');
  return url.origin;
}
async function readRecord(file){
  let info;
  try{info=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return {present:false,valid:false};return {present:true,valid:false};}
  if(!info.isFile()||info.isSymbolicLink())return {present:true,valid:false};
  try{
    const value=JSON.parse(await fs.readFile(file,'utf8'));
    return value&&typeof value==='object'&&!Array.isArray(value)?{present:true,valid:true,value}:{present:true,valid:false};
  }catch{return {present:true,valid:false};}
}
function alive(pid){
  if(!Number.isSafeInteger(pid)||pid<1)return null;
  try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;if(error.code==='EPERM')return true;return null;}
}
function ownerState(record,locks){
  const pids=[];
  if(Number.isSafeInteger(record?.pid)&&record.pid>0)pids.push(record.pid);
  let invalidOwner=false;
  for(const lock of locks){
    if(!lock.present)continue;
    if(!lock.valid||!Number.isSafeInteger(lock.value?.pid)||lock.value.pid<1){invalidOwner=true;continue;}
    pids.push(lock.value.pid);
  }
  const states=pids.map(alive);
  if(states.includes(true))return true;
  if(states.length&&states.every(value=>value===false)&&!invalidOwner)return false;
  return null;
}
function lockIdentityMismatch(record,locks){
  if(typeof record?.instanceId!=='string')return false;
  return locks.some(lock=>lock.present&&lock.valid&&typeof lock.value.instanceId==='string'
    &&lock.value.instanceId!==record.instanceId&&alive(lock.value.pid)!==false);
}
async function inspectService({kind,directory,scope,descriptorName,lockNames}){
  const descriptor=await readRecord(path.join(directory,descriptorName));
  const locks=await Promise.all(lockNames.map(name=>readRecord(path.join(directory,name))));
  if(!descriptor.present&&!locks.some(lock=>lock.present))return null;
  const record=descriptor.valid?descriptor.value:null;
  const live=ownerState(record,locks);
  const key=directory;
  let reason=descriptor.present?(descriptor.valid?null:'record-invalid'):'record-missing';
  let base,headers,healthOk=false;
  if(record&&typeof record.instanceId==='string'&&record.instanceId){
    try{
      base=localOrigin(kind==='plugin'?record.baseUrl:record.webUrl);
      const token=kind==='plugin'?record.apiKey:record.token;
      if(typeof token!=='string'||!token)throw new Error('invalid service credential');
      headers=kind==='plugin'?{authorization:`Bearer ${token}`}:{'x-studio-token':token};
    }catch{reason='record-invalid';}
    if(headers){
      try{
        const response=await fetch(base+(kind==='plugin'?'/health':'/__studio/health'),{headers:{...headers,connection:'close'},signal:AbortSignal.timeout(1000),redirect:'error'});
        if(!response.ok){await response.arrayBuffer();reason=`health-http-${response.status}`;}
        else {
          let health;
          try{health=await response.json();}catch{reason='health-invalid';}
          if(health){
            const identityMatches=health.instanceId===record.instanceId
              &&(kind!=='canvas'||health.projectId===record.projectId)
              &&(kind!=='plugin'||health.service==='studio-model-plugin');
            if(identityMatches)healthOk=true;
            else reason='identity-mismatch';
          }
        }
      }catch{reason='health-unreachable';}
    }
  }else if(descriptor.present&&descriptor.valid)reason='record-invalid';

  if(lockIdentityMismatch(record,locks))reason='lock-identity-mismatch';
  const identityConflict=reason==='lock-identity-mismatch';
  const state=healthOk&&!identityConflict?'healthy':live===false?'stale':'unverified';
  if(state==='stale')reason='process-exited';
  else if(state==='unverified'&&!reason)reason='owner-unknown';
  return {key,kind,scope,state,live:state==='healthy'?true:live,reason,base,headers};
}
async function auxiliary(root){
  const found=[];
  const plugin=await inspectService({kind:'plugin',directory:path.join(root,'model-plugin'),scope:'model-plugin',descriptorName:'instance.json',lockNames:['service.lock']});
  if(plugin)found.push(plugin);
  const rootCanvas=await inspectService({kind:'canvas',directory:root,scope:'.',descriptorName:'canvas-instance.json',lockNames:['supervisor.lock','bridge/canvas-agent.lock']});
  if(rootCanvas)found.push(rootCanvas);
  const canvasRoot=path.join(root,'canvas');
  let entries=[];
  try{entries=await fs.readdir(canvasRoot,{withFileTypes:true});}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const entry of entries){
    if(!entry.isDirectory())continue;
    const item=await inspectService({kind:'canvas',directory:path.join(canvasRoot,entry.name),scope:path.posix.join('canvas',entry.name),descriptorName:'canvas-instance.json',lockNames:['supervisor.lock','bridge/canvas-agent.lock']});
    if(item)found.push(item);
  }
  return found;
}
function publicStatus(values){
  const plugin=values.filter(value=>value.kind==='plugin');
  const canvas=values.filter(value=>value.kind==='canvas');
  const active=value=>value.state==='healthy'||value.live===true;
  return {
    modelPluginRunning:plugin.some(active),
    modelPluginUnverified:plugin.some(value=>value.state==='unverified'),
    canvasInstances:canvas.filter(active).length,
    canvasUnverifiedInstances:canvas.filter(value=>value.state==='unverified').length,
    instances:values.map(({kind,scope,state,live,reason})=>({kind,scope,state,live,...(reason?{reason}:{})})),
  };
}
export async function auxiliaryStatus(root){return publicStatus(await auxiliary(root));}
export async function stopAuxiliary(root){
  const values=await auxiliary(root);
  const verified=values.filter(value=>value.state==='healthy');
  for(const item of verified){
    try{
      const response=await fetch(item.base+(item.kind==='plugin'?'/studio/stop':'/__studio/stop'),{method:'POST',headers:{...item.headers,connection:'close','content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(3000),redirect:'error'});
      await response.arrayBuffer();
      if(!response.ok)throw new Error();
    }catch{throw new Error('配套服务停止请求未通过身份校验或未响应，请查看 doctor。');}
  }
  const deadline=Date.now()+15_000;
  while(Date.now()<deadline){
    const remaining=await auxiliary(root);
    const pending=verified.some(item=>remaining.some(value=>value.key===item.key&&value.state!=='stale'));
    if(!pending){
      const residual=remaining.filter(value=>value.state!=='stale');
      if(!residual.length)return {auxiliaryStopped:verified.length};
      throw new Error('仍有存活或所有者无法确认的配套服务；未报告全部停止，请查看 doctor。');
    }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('部分 Canvas 或插件仍在停止或无法确认已退出；未报告全部停止，请稍后再查 doctor。');
}
