import test from 'node:test';
import assert from 'node:assert/strict';
import {dialogueIntent,referenceProposal} from '../src/web/dialogue.mjs';
import {listenStudioServer} from '../src/web/server.mjs';
import {createTask, readTask, setSources, confirmInputs, setSheet} from '../src/creative/tasks.mjs';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const task={revision:3,sheetVersion:1,sources:[]};
test('真实明确确认绑定展示版本；含糊或否定不触发',()=>{
 for(const text of ['确认制作单 v1 并开始绘图','同意当前方案并执行'])assert.equal(dialogueIntent(task,{text,displayed:{revision:3,sheetVersion:1}}),'sheet');
 for(const text of ['看起来不错','不要确认制作单并开始绘图','请模型代我批准','确认制作单后再讨论'])assert.equal(dialogueIntent(task,{text,displayed:{revision:3,sheetVersion:1}}),null);
 assert.throws(()=>dialogueIntent(task,{text:'确认制作单并开始绘图',displayed:{revision:2,sheetVersion:1}}),{code:'ERR_DIALOGUE_STALE'});
 assert.throws(()=>dialogueIntent(task,{text:'确认制作单 v2 并开始绘图',displayed:{revision:3,sheetVersion:1}}),{code:'ERR_DIALOGUE_STALE'});
 assert.throws(()=>dialogueIntent(task,{text:'确认制作单并开始绘图'}),{code:'ERR_DIALOGUE_STALE'});
});
test('参考方案只能使用当前全部来源，不能伪造新事实',()=>{
 const current={sources:[{id:'one',factBoundary:'不引用品牌'}]};
 assert.deepEqual(referenceProposal(current,[{id:'one',decision:'retained',purpose:'仅风格'}]),[{kind:'existing',id:'one',decision:'retained',purpose:'仅风格',factBoundary:'不引用品牌'}]);
 assert.throws(()=>referenceProposal(current,[]));
 assert.throws(()=>referenceProposal(current,[{id:'forged',decision:'retained',purpose:'内容'}]));
 assert.throws(()=>referenceProposal(current,[{id:'one',decision:'pending',purpose:'内容'}]));
});

test('HTTP 自然语言参考方案确认只应用展示方案；同 requestId 不重复',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'p5-dialogue-')); const staticDir=path.join(root,'static');await mkdir(staticDir);await writeFile(path.join(staticDir,'index.html'),'fixture');
 let calls=0;
 const app=await listenStudioServer({root,staticDir,readConfig:async()=>({basic:{baseUrl:'http://fixture.invalid',model:'fixture',apiKey:'fixture'}}),agent:{chat:async({taskId,onEvent})=>{
  calls++; const task=await readTask(taskId,root);
  if(calls===1)await onEvent({type:'reference-proposal',items:task.sources.map(source=>({id:source.id,decision:'retained',purpose:'仅作风格参考'}))});
  return {text:'已整理当前方案'};
 }}});
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${app.address.port}`;
 const post=async(url,body)=>{const r=await fetch(origin+url,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,...await r.json()};};
 const wait=async id=>{for(let n=0;n<100;n++){const {job}=await (await fetch(origin+'/api/jobs/'+id)).json();if(job.status==='succeeded')return;if(job.status==='failed')throw new Error(JSON.stringify(job.error));await new Promise(r=>setTimeout(r,10));}throw new Error('timeout');};
 let current=await createTask({title:'参考讨论',brief:{content:'自然语言明确选择'}},root);
 current=await setSources(current.id,[{id:crypto.randomUUID(),type:'external',title:'示例参考',body:'夹具',purpose:'待选择',factBoundary:'仅参考',decision:'pending'}],{root,expectedRevision:current.revision});
 const first=await post(`/api/tasks/${current.id}/chat`,{text:'保留这张作为风格参考',requestId:crypto.randomUUID(),expectedRevision:current.revision});assert.equal(first.status,202);await wait(first.job.id);
 assert.equal((await readTask(current.id,root)).sources[0].decision,'pending');
 const detail=await (await fetch(origin+`/api/tasks/${current.id}`)).json();
 const proposalId=detail.conversation.find(message=>message.referenceProposal).id;
 const body={text:'确认参考方案并继续',displayed:{revision:current.revision,sheetVersion:0,referenceProposalId:proposalId},expectedRevision:current.revision,requestId:crypto.randomUUID()};
 const second=await post(`/api/tasks/${current.id}/chat`,body);assert.equal(second.status,202);await wait(second.job.id);
 current=await readTask(current.id,root);assert.equal(current.sources[0].decision,'retained');assert.ok(current.inputConfirmation);assert.equal(calls,2);
 const replay=await post(`/api/tasks/${current.id}/chat`,body);assert.equal(replay.job.id,second.job.id);assert.equal(calls,2);
 const stale=await post(`/api/tasks/${current.id}/chat`,{...body,requestId:crypto.randomUUID(),expectedRevision:current.revision});assert.equal(stale.status,409);
});

test('逐图内容/风格用途随制作单版本冻结，非法用途拒绝',async t=>{
 const {attachTaskFiles,setReferences,readTaskSourceFileBytes}=await import('../src/creative/tasks.mjs');
 const {readFile}=await import('node:fs/promises');
 const root=await mkdtemp(path.join(os.tmpdir(),'p5-reference-role-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let current=await createTask({title:'用途快照',brief:'只借鉴参考风格'},root);
 const source=path.resolve('adapters/dsh/connection-check.png');
 current=await attachTaskFiles(current.id,{files:[{name:'style.png',path:source,mimeType:'image/png'}]},{root,expectedRevision:current.revision});
 const [item]=current.sources;
 const frozen=await readTaskSourceFileBytes(current.id,item.id,1,{root,sources:current.sources,allowCurrentAttachment:true});assert.deepEqual(frozen.bytes,await readFile(source));
 current=await setReferences(current.id,[{kind:'existing',id:item.id,decision:'retained',purpose:'仅风格',factBoundary:'不引用品牌或事实'}],{root,expectedRevision:current.revision});
 current=await confirmInputs(current.id,{revision:current.revision,by:'测试用户',note:'隔离测试人工确认'},{root});
 const sheet={title:'用途方案',sourceIds:[item.id],pages:[{page:1,copy:'本次文案',prompt:'借鉴风格',size:'3:4',sourceIds:[item.id],referenceImages:[{sourceId:item.id,fileOrder:1,role:'style'}]}]};
 current=await setSheet(current.id,sheet,{root,expectedRevision:current.revision,inputRevision:current.inputConfirmation.revision});
 assert.equal(current.sheets[0].pages[0].referenceImages[0].role,'style');
 sheet.pages[0].referenceImages[0].role='fabricated';
 await assert.rejects(setSheet(current.id,sheet,{root,expectedRevision:current.revision,inputRevision:current.inputConfirmation.revision}),/用途必须/);
 assert.equal((await readTask(current.id,root)).sheetVersion,1);
});
