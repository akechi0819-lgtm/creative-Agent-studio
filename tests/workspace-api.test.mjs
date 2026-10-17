import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {listenStudioServer} from '../src/web/server.mjs';
import {createTask,taskDirectory,readTask} from '../src/creative/tasks.mjs';

test('文档上传直接处理并回传可下载产物；换文件使旧SHA下载失效',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'p5-workspace-api-'));const staticDir=path.join(root,'static');await mkdir(staticDir);await writeFile(path.join(staticDir,'index.html'),'fixture');
 const output=Buffer.from('filtered roster fixture');const sha256=createHash('sha256').update(output).digest('hex');let outputPath;
 const app=await listenStudioServer({root,staticDir,readConfig:async()=>({basic:{baseUrl:'http://fixture.invalid',model:'fixture',apiKey:'fixture'}}),agent:{chat:async({taskId})=>{
  outputPath=path.join(taskDirectory(taskId,root),'workspace/outputs/roster.csv');await mkdir(path.dirname(outputPath),{recursive:true});await writeFile(outputPath,output);
  const fileUrl=`/api/tasks/${taskId}/workspace-artifacts/${encodeURIComponent('outputs/roster.csv')}?sha256=${sha256}`;
  return {text:'资料整理完成',deliverables:[{name:'roster.csv',size:output.length,mimeType:'text/csv',sha256,fileUrl,downloadUrl:fileUrl+'&download=1'}]};
 }}});t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${app.address.port}`;
 const post=async(endpoint,body)=>{const form=body instanceof FormData;const response=await fetch(origin+endpoint,{method:'POST',headers:{origin,...(form?{}:{'content-type':'application/json'})},body:form?body:JSON.stringify(body)});return {status:response.status,...await response.json()};};
 const task=await createTask({title:'整理人员表',brief:'筛选去重并交付CSV'},root);
 const form=new FormData();const requestId=randomUUID();form.append('files',new Blob(['name,group\nA,education'],{type:'text/csv'}),'人员.csv');form.append('expectedRevision',String(task.revision));form.append('uploadId',requestId);form.append('instructions','筛选去重');
 const upload=await post(`/api/tasks/${task.id}/attachments`,form);assert.equal(upload.status,200,JSON.stringify(upload));assert.equal(upload.task.sheetVersion,0);
 const pending=await post(`/api/tasks/${task.id}/chat`,{requestId,text:'筛选去重',expectedRevision:upload.task.revision,attachmentSourceIds:[upload.sourceId]});assert.equal(pending.status,202);
 let job;
 for(let n=0;n<100;n++){({job}=await (await fetch(origin+'/api/jobs/'+pending.job.id)).json());if(['succeeded','failed'].includes(job.status))break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(job.status,'succeeded');assert.equal((await readTask(task.id,root)).sheetVersion,0);
 const detail=await (await fetch(origin+`/api/tasks/${task.id}`)).json();const file=detail.conversation.at(-1).deliverables[0];
 const download=await fetch(origin+file.downloadUrl);assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/^attachment/);assert.equal(await download.text(),output.toString());
 await writeFile(outputPath,'changed');assert.equal((await fetch(origin+file.downloadUrl)).status,409);
 assert.equal((await fetch(origin+`/api/tasks/${task.id}/workspace-artifacts/${encodeURIComponent('inputs/人员.csv')}?sha256=${sha256}`)).status,404);
});

test('受信脚本若意外改变控制记录，中止本轮且不伪造回滚',async t=>{
 const {withProtectedTaskState}=await import('../src/web/script-state.mjs');
 const root=await mkdtemp(path.join(os.tmpdir(),'p5-script-state-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const task=await createTask({title:'控制记录保护',brief:'夹具'},root);let stopped=0;
 const options={taskId:task.id,root,onConflict:()=>{stopped++;}};
 assert.equal(await withProtectedTaskState(options,async()=>42),42);
 await assert.rejects(withProtectedTaskState(options,async()=>writeFile(path.join(taskDirectory(task.id,root),'task.json'),'changed by fixture')),{code:'ERR_SCRIPT_STATE_CONFLICT'});
 assert.equal(stopped,1);
});
