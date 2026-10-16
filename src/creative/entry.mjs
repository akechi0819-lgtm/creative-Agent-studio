import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {dataRoot} from '../canvas/client.mjs';

function directory(id,root){
 if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw new Error('任务ID无效');
 return path.join(path.resolve(root??dataRoot()),'tasks',id);
}
function busy(message='任务正由另一个入口推进，请等该操作结束再接续。'){
 return Object.assign(new Error(message),{code:'ERR_TASK_ENTRY_BUSY',safeMessage:message});
}
function alive(pid){if(!Number.isInteger(pid)||pid<1)throw busy('任务入口记录无效，请检查当前工作区。');try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;if(e.code==='EPERM')return true;throw e;}}
async function record(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw busy('任务入口记录不可读，请检查当前工作区。');}}

export async function taskEntryStatus(id,{root}={}){
 const owner=await record(path.join(directory(id,root),'.entry.json'));
 return owner?{pid:owner.pid,alive:alive(owner.pid),entry:owner.entry,startedAt:owner.startedAt}:null;
}
export async function assertTaskEntryAccess(id,root){
 const owner=await record(path.join(directory(id,root),'.entry.json'));
 if(owner&&owner.pid!==process.pid)throw busy(alive(owner.pid)?undefined:'任务原入口已退出，请恢复工作台或核对入口记录后解除占用。');
}
async function assertCoreUnlocked(id,root){
 const owner=await record(path.join(directory(id,root),'.lock','owner.json'));
 if(owner&&owner.pid!==process.pid)throw busy(alive(owner.pid)?undefined:'任务原执行进程已退出，请先恢复检查点。');
}
export async function clearTaskEntry(id,{root,deadPid}={}){
 const file=path.join(directory(id,root),'.entry.json');
 const owner=await record(file);if(!owner)return {cleared:false};
 if(!Number.isInteger(deadPid)||owner.pid!==deadPid||alive(deadPid))throw busy('入口所有者仍存活或PID不匹配，未解除占用。');
 const current=await record(file);
 if(!current||current.token!==owner.token)throw busy('任务入口已变化，请重新查看。');
 await fs.unlink(file);return {cleared:true};
}
/** A Web job owns the whole turn; core per-write locks remain inside it. */
export async function acquireTaskEntry(id,root){
 const file=path.join(directory(id,root),'.entry.json');
 await assertCoreUnlocked(id,root);
 const owner={pid:process.pid,token:randomUUID(),entry:'web',startedAt:new Date().toISOString()};
 let handle;
 try{handle=await fs.open(file,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw busy();throw e;}
 try{await handle.writeFile(JSON.stringify(owner));await handle.close();}catch(error){await handle.close().catch(()=>{});await fs.unlink(file).catch(()=>{});throw error;}
 const release=async()=>{const current=await record(file);if(!current||current.token!==owner.token)throw busy('任务入口已变化，无法确认释放。');await fs.unlink(file);};
 try{await assertCoreUnlocked(id,root);}catch(e){await release().catch(()=>{});throw e;}
 return release;
}
