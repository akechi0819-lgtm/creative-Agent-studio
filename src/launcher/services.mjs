import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson} from './control.mjs';

function localOrigin(value){
  const url=new URL(value);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('服务地址无效');
  return url.origin;
}
async function checked(file,kind){
  const record=await readJson(file).catch(()=>null);
  if(!record)return null;
  try{
    const base=localOrigin(kind==='plugin'?record.baseUrl:record.webUrl);
    const headers=kind==='plugin'?{authorization:`Bearer ${record.apiKey}`}:{'x-studio-token':record.token};
    const response=await fetch(base+(kind==='plugin'?'/health':'/__studio/health'),{headers:{...headers,connection:'close'},signal:AbortSignal.timeout(1000),redirect:'error'});
    const health=await response.json();
    if(!response.ok||health.instanceId!==record.instanceId||kind==='canvas'&&health.projectId!==record.projectId||kind==='plugin'&&health.service!=='studio-model-plugin')return null;
    return {kind,base,headers,record};
  }catch{return null;}
}
async function auxiliary(root){
  const found=[];const plugin=await checked(path.join(root,'model-plugin','instance.json'),'plugin');if(plugin)found.push(plugin);
  const files=[path.join(root,'canvas-instance.json')];
  for(const entry of await fs.readdir(path.join(root,'canvas'),{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
    if(entry.isDirectory())files.push(path.join(root,'canvas',entry.name,'canvas-instance.json'));
  }
  for(const file of files){const value=await checked(file,'canvas');if(value)found.push(value);}
  return found;
}
export async function auxiliaryStatus(root){
  const values=await auxiliary(root);
  return {modelPluginRunning:values.some(v=>v.kind==='plugin'),canvasInstances:values.filter(v=>v.kind==='canvas').length};
}
export async function stopAuxiliary(root){
  const values=await auxiliary(root);
  for(const item of values){
    const response=await fetch(item.base+(item.kind==='plugin'?'/studio/stop':'/__studio/stop'),{method:'POST',headers:{...item.headers,connection:'close','content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(3000),redirect:'error'});
    await response.arrayBuffer();
    if(!response.ok)throw new Error('残留服务停止校验失败，请查看 doctor。');
  }
  const deadline=Date.now()+15_000;
  while(Date.now()<deadline){
    const remaining=await auxiliary(root);
    if(!remaining.length)return {auxiliaryStopped:values.length};
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error('部分 Canvas 或插件仍在停止，请稍后再查 doctor。');
}
