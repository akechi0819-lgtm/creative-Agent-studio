import fs from 'node:fs/promises';
import path from 'node:path';

const UUID_DIRECTORY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPANY_BRIDGE_FILES = ['company-canvas-bridge.json', 'company-canvas-bridge-instance.json'];

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
async function inspectService({directory,scope,descriptorName,lockNames}){
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
      base=localOrigin(record.baseUrl);
      const token=record.apiKey;
      if(typeof token!=='string'||!token)throw new Error('invalid service credential');
      headers={authorization:`Bearer ${token}`};
    }catch{reason='record-invalid';}
    if(headers){
      try{
        const response=await fetch(base+'/health',{headers:{...headers,connection:'close'},signal:AbortSignal.timeout(1000),redirect:'error'});
        if(!response.ok){await response.arrayBuffer();reason=`health-http-${response.status}`;}
        else {
          let health;
          try{health=await response.json();}catch{reason='health-invalid';}
          if(health){
            const identityMatches=health.instanceId===record.instanceId&&health.service==='studio-model-plugin';
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
  return {key,kind:'plugin',scope,state,live:state==='healthy'?true:live,reason,base,headers};
}
async function auxiliary(root){
  const plugin=await inspectService({directory:path.join(root,'model-plugin'),scope:'model-plugin',descriptorName:'instance.json',lockNames:['service.lock']});
  const companyBridges=await inspectCompanyBridges(root);
  return [...(plugin ? [plugin] : []),...companyBridges];
}
async function companyBridgeTaskIds(root){
  const canvasDirectory=path.join(root,'canvas');
  let canvasInfo;
  try{canvasInfo=await fs.lstat(canvasDirectory);}catch(error){if(error.code==='ENOENT')return [];throw error;}
  if(!canvasInfo.isDirectory()||canvasInfo.isSymbolicLink())return [];
  const entries=await fs.readdir(canvasDirectory,{withFileTypes:true});
  const taskIds=[];
  for(const entry of entries){
    if(!UUID_DIRECTORY.test(entry.name))continue;
    const directory=path.join(canvasDirectory,entry.name);
    let directoryInfo;
    try{directoryInfo=await fs.lstat(directory);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(!directoryInfo.isDirectory()||directoryInfo.isSymbolicLink())continue;
    for(const name of COMPANY_BRIDGE_FILES){
      try{await fs.lstat(path.join(directory,name));taskIds.push(entry.name);break;}
      catch(error){if(error.code!=='ENOENT'){taskIds.push(entry.name);break;}}
    }
  }
  return taskIds;
}
async function inspectCompanyBridges(root){
  const taskIds=await companyBridgeTaskIds(root);
  if(!taskIds.length)return [];
  const results=await Promise.all(taskIds.map(async taskId=>{
    const key=path.join(path.resolve(root),'canvas',taskId);
    try{
      const bridge=await import('../company/bridge.mjs');
      const status=await bridge.companyBridgeStatus({root,taskId});
      const identityMatches=status?.taskId===taskId&&status?.projectId===taskId;
      if(identityMatches&&status.state==='healthy'&&status.running===true&&status.owned===true){
        return {key,kind:'company-canvas-bridge',scope:'canvas-task',taskId,state:'healthy',live:true};
      }
      if(status?.state==='dead'&&status.running===false){
        return {key,kind:'company-canvas-bridge',scope:'canvas-task',taskId,state:'stale',live:false,reason:'process-exited'};
      }
      return {key,kind:'company-canvas-bridge',scope:'canvas-task',taskId,state:'unverified',live:status?.running===true?true:null,reason:'bridge-unverified'};
    }catch{
      return {key,kind:'company-canvas-bridge',scope:'canvas-task',taskId,state:'unverified',live:null,reason:'bridge-inspection-failed'};
    }
  }));
  return results;
}
function publicStatus(values){
  const plugins=values.filter(value=>value.kind==='plugin');
  const active=value=>value.state==='healthy'||value.live===true;
  return {
    modelPluginRunning:plugins.some(active),
    modelPluginUnverified:plugins.some(value=>value.state==='unverified'),
    instances:values.map(({kind,scope,taskId,state,live,reason})=>({kind,scope,...(taskId?{taskId}:{}),state,live,...(reason?{reason}:{})})),
  };
}
export async function auxiliaryStatus(root){return publicStatus(await auxiliary(root));}
export async function stopAuxiliary(root){
  const values=await auxiliary(root);
  const verified=values.filter(value=>value.state==='healthy');
  for(const item of verified){
    if(item.kind==='plugin'){
      try{
        const response=await fetch(item.base+'/studio/stop',{method:'POST',headers:{...item.headers,connection:'close','content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(3000),redirect:'error'});
        await response.arrayBuffer();
        if(!response.ok)throw new Error();
      }catch{throw new Error('配套服务停止请求未通过身份校验或未响应，请查看 doctor。');}
      continue;
    }
    if(item.kind==='company-canvas-bridge'){
      try{
        const bridge=await import('../company/bridge.mjs');
        const result=await bridge.stopCompanyBridge({root,taskId:item.taskId});
        const identityMatches=result?.taskId===item.taskId&&(!result.projectId||result.projectId===item.taskId);
        const stopped=result?.state==='stopped'&&result.stopped===true&&result.owned===true;
        const alreadyDead=result?.state==='dead'&&result.stopped===false&&result.owned===false;
        if(!identityMatches||(!stopped&&!alreadyDead))throw new Error();
      }catch{throw new Error('公司 Canvas taskbridge 停止请求未完成；身份无法确认或服务未响应，请查看 doctor。');}
    }
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
  throw new Error('模型插件仍在停止或无法确认已退出；未报告全部停止，请稍后再查 doctor。');
}
