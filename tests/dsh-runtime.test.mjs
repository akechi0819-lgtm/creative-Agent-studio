import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createTask,readTask,confirmInputs,setSheet,confirmSheet,attachTaskFiles,setSources,withTask} from '../src/creative/tasks.mjs';
import {cleanAsset,confirmAsset,importAsset} from '../src/assets/library.mjs';
import {createAssistantMessage,createSystemMessage,createToolResultMessage,createUserMessage} from '../adapters/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
import {createDshContext,createStudioAgent} from '../adapters/dsh/runtime.mjs';

async function fixture(t,{fail=false,slow=false,duplicateReview=false,askQuestions=false,searchQuery=null,duplicateSearch=false,maxRequestBytes}={}){
  const root=await mkdtemp(os.tmpdir()+'/studio-p3-dsh-');
  const requests=[];
  const requestSizes=[];
  const server=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    const requestBytes=Buffer.byteLength(text);
    requestSizes.push(requestBytes);
    if(maxRequestBytes&&requestBytes>maxRequestBytes){res.writeHead(413,{'content-type':'application/json'}).end(JSON.stringify({error:{message:'mock body too large'}}));return;}
    const body=JSON.parse(text);requests.push(body);
    if(slow){await new Promise(resolve=>setTimeout(resolve,500));if(res.destroyed)return;}
    if(fail){res.writeHead(401,{'content-type':'application/json'}).end(JSON.stringify({error:{message:'mock-secret-key-invalid'}}));return;}
    const resultSeen=body.messages.some(m=>m.role==='tool');
    const check=body.tools.some(x=>x.function.name==='studio_connection_probe');
    const review=body.tools.some(x=>x.function.name==='studio_record_image_review');
    const ask=askQuestions&&body.tools.some(x=>x.function.name==='studio_ask_questions');
    const search=Boolean(searchQuery)&&body.tools.some(x=>x.function.name==='studio_search_assets');
    res.writeHead(200,{'content-type':'text/event-stream'});
    const payload=review?{decision:'revise',notes:{文字:'测试替身固定返回待核，未模拟通过',可读性:'不可判断，需修改',一致性:'待核',主题:'待核',修改位置:'整页'}}:{audience:'亲子家庭',format:'三页图文',topic:'阅读指南'};
    const questionPayload={questions:[{id:'audience',question:'内容主要面向谁？',options:[{id:'parents',label:'家长'},{id:'students',label:'学生'}],allowOther:true}]};
    const toolName=check?'studio_connection_probe':review?'studio_record_image_review':ask?'studio_ask_questions':search?'studio_search_assets':'studio_update_brief';
    const argumentsValue=check?JSON.stringify({colors:'绿色背景、红色方块'}):search?JSON.stringify({query:searchQuery}):JSON.stringify({payload:JSON.stringify(ask?questionPayload:payload)});
    const delta=resultSeen?{content:ask?'请在上方点选回答即可。':'已整理需求，请在工作台检查后确认。'}:{tool_calls:[{index:0,id:'mock-call-1',type:'function',function:{name:toolName,arguments:argumentsValue}}]};
    if(duplicateSearch&&search&&!resultSeen)delta.tool_calls.push({...structuredClone(delta.tool_calls[0]),index:1,id:'mock-call-2'});
    if(duplicateReview&&review&&!resultSeen){delta.tool_calls.push({...structuredClone(delta.tool_calls[0]),index:1,id:'mock-call-2'});}
    res.write('data: '+JSON.stringify({id:'mock-completion',object:'chat.completion.chunk',created:1,model:'mock',choices:[{index:0,delta:{role:'assistant',...delta},finish_reason:null}]})+'\n\n');
    res.write('data: '+JSON.stringify({id:'mock-completion',object:'chat.completion.chunk',created:1,model:'mock',choices:[{index:0,delta:{},finish_reason:resultSeen?'stop':'tool_calls'}]})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
  const readConfig=async()=>({basic:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'mock',apiKey:'mock-secret-key'}});
  return {root,requests,requestSizes,readConfig,agent:createStudioAgent({root,readConfig})};
}

async function confirmedKetAsset(root,index){
  const sourcePath=path.join(root,`ket-source-${index}.png`);
  await writeFile(sourcePath,await readFile(new URL('../docs/evidence/p0/gpt-image-2.png',import.meta.url)));
  const imported=await importAsset({
    title:`KET 家长参考 ${index}`,
    body:`KET 家长备考实操参考 ${index}`,
    tags:['KET','家长'],
    source:{kind:'user-provided',platform:'xhs',origin:'fixture',factBoundary:'仅作结构与表达参考，不作当前事实'},
    files:[{path:sourcePath,name:`ket-source-${index}.png`,mimeType:'image/png'}],
  },{root});
  const reviewed=await cleanAsset(imported.id,{root,expectedRevision:imported.revision,cleaner:async({title,body})=>({
    title,body,summary:`KET 家长结构摘要 ${index}`,tags:['KET','家长'],
    extractions:[{text:`SECRET-OCR-SENTINEL-${index}-`.repeat(1000)}],
  })});
  return confirmAsset(reviewed.id,{by:'王老师',note:'已核对素材原件与摘要'},{root,expectedRevision:reviewed.revision});
}

function requestImageStats(request){
  const dataUrls=[];
  const visit=value=>{
    if(typeof value==='string'){
      const match=value.match(/^data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)$/);
      if(match)dataUrls.push(match[1]);
    }else if(Array.isArray(value))value.forEach(visit);
    else if(value&&typeof value==='object')Object.values(value).forEach(visit);
  };
  visit(request.messages);
  return {count:dataUrls.length,encodedBytes:dataUrls.reduce((sum,value)=>sum+Buffer.from(value,'base64').byteLength,0)};
}

test('Web adapter runs actual DSH model/tool loop, stores draft, cannot confirm for human, resumes session',async t=>{
  const f=await fixture(t);
  const task=await createTask({title:'隔离阅读任务',brief:'帮我整理三页图文需求'},f.root);
  const visible=[];
  const result=await f.agent.chat({taskId:task.id,text:'面向亲子家庭，做三页阅读指南。',expectedRevision:task.revision,onEvent:e=>visible.push(e)});
  assert.match(result.text,/整理需求/);
  const next=await readTask(task.id,f.root);
  assert.equal(next.brief.audience,'亲子家庭');
  assert.equal(next.inputConfirmation,null);
  assert.ok(f.requests.length>=2);
  const names=f.requests[0].tools.map(x=>x.function.name);
  assert.ok(names.includes('studio_write_sheet'));
  assert.ok(names.includes('studio_ask_questions'));
  assert.ok(!names.some(x=>/confirm|approve|bash|write_file/.test(x)));
  assert.ok(!JSON.stringify(visible).includes('mock-secret-key'));
  assert.ok(visible.some(x=>x.type==='tool'));
  await f.agent.chat({taskId:task.id,text:'继续',expectedRevision:next.revision});
  assert.ok(f.requests.at(-1).messages.filter(x=>x.role==='user').length>=2);
});

test('DSH emits structured question events through its real tool loop',async t=>{
  const f=await fixture(t,{askQuestions:true});
  const task=await createTask({title:'点选追问夹具',brief:'已有背景，但受众未明确'},f.root);
  const events=[];
  const result=await f.agent.chat({taskId:task.id,text:'根据现有需求先确认目标读者。',expectedRevision:task.revision,onEvent:async event=>events.push(event)});
  assert.match(result.text,/点选回答/);
  const emitted=events.find(event=>event.type==='questions');
  assert.deepEqual(emitted.questions[0].options.map(option=>option.label),['家长','学生']);
  assert.ok(f.requests[0].tools.some(tool=>tool.function.name==='studio_ask_questions'));
  assert.ok(f.requests.some(request=>request.messages.some(message=>message.role==='tool')));
  assert.equal((await readTask(task.id,f.root)).inputConfirmation,null);
});

test('DSH search falls back from a phrase, stages five pending assets once, and keeps library payloads out of model context',async t=>{
  const f=await fixture(t,{searchQuery:'KeT 学习 小红书',duplicateSearch:true});
  for(let index=0;index<7;index+=1)await confirmedKetAsset(f.root,index);
  const task=await createTask({title:'KET家长手帐',brief:'给3到6年级家长做引流手帐参考'},f.root);
  const confirmed=await confirmInputs(task.id,{revision:task.revision,by:'王老师',note:'用户确认当前需求草稿'},{root:f.root});
  const visible=[];

  const result=await f.agent.chat({taskId:task.id,text:'请检索 KET 家长相关历史素材并列候选给我确认。',expectedRevision:confirmed.revision,onEvent:event=>visible.push(event)});
  const saved=await readTask(task.id,f.root);
  assert.equal(result.task.sources.length,5);
  assert.equal(saved.sources.length,5);
  assert.ok(saved.sources.every(source=>source.decision==='pending'));
  assert.equal(saved.inputConfirmation,null);
  assert.equal(saved.revision,confirmed.revision+1,'repeating the same search must not create another task revision');
  assert.equal(new Set(saved.sources.map(source=>source.id)).size,5);
  assert.ok(visible.some(event=>event.type==='tool'&&/命中 7 项，展示 5 项，新增待选择 5 项/.test(event.text)));
  assert.ok(visible.some(event=>event.type==='tool'&&/命中 7 项，展示 5 项，新增待选择 0 项/.test(event.text)));
  assert.ok(visible.some(event=>event.type==='tool'&&/原需求\/参考确认失效/.test(event.text)));

  const modelRequest=JSON.stringify(f.requests.find(request=>request.messages.some(message=>message.role==='tool')));
  for(const forbidden of ['SECRET-OCR-SENTINEL','confirmedSnapshot','extractions','history','relativePath','ket-source-0.png']){
    assert.equal(modelRequest.includes(forbidden),false,`model request must not include ${forbidden}`);
  }
  assert.ok(modelRequest.length<100_000,'the model receives only a compact search result and task context');
});

test('DSH can discuss a pending uploaded PDF using bounded, explicitly unverified extracted text',async t=>{
  const f=await fixture(t);
  const task=await createTask({title:'附件直聊',brief:'先理解用户刚上传的资料'},f.root);
  const pdfPath=path.join(f.root,'parent-handout.pdf');
  await writeFile(pdfPath,Buffer.from('%PDF-1.4 fixture'));
  const pending=await attachTaskFiles(task.id,{
    files:[{path:pdfPath,name:'parent-handout.pdf',mimeType:'application/pdf'}],
    extractions:[{name:'parent-handout.pdf',kind:'pdf',text:'PENDING-PDF-CONTEXT-SENTINEL '+'用户上传原文片段。'.repeat(1000)}],
  },{root:f.root,expectedRevision:task.revision});
  await withTask(task.id,draft=>{
    draft.sources[0].history=[{text:'SECRET-PENDING-ATTACHMENT-HISTORY'}];
  },{root:f.root,expectedRevision:pending.revision});

  await f.agent.chat({taskId:task.id,text:'请结合我刚上传的 PDF 解释重点。',expectedRevision:pending.revision+1});
  const request=JSON.stringify(f.requests[0].messages);
  assert.ok(request.includes('PENDING-PDF-CONTEXT-SENTINEL'));
  assert.ok(request.includes('未经用户确认不得作为已核实事实'));
  assert.equal(request.includes('SECRET-PENDING-ATTACHMENT-HISTORY'),false);
  assert.equal(request.includes('relativePath'),false);
  assert.equal(request.includes('/private/'),false);
  assert.equal(request.includes('sources/'),false,'local attachment paths are not sent through task source projection');
  assert.equal(request.includes('PENDING-PDF-CONTEXT-SENTINEL'),true,'the original filename may label an extracted excerpt, but file paths stay private');
  const contextText=request.slice(request.indexOf('PENDING-PDF-CONTEXT-SENTINEL'));
  assert.ok(contextText.length<5_000,'the extracted attachment is bounded in task context');
});

test('retained image history stays under the request byte budget and is not duplicated across chat turns',async t=>{
  const requestLimit=4*1024*1024;
  const f=await fixture(t,{maxRequestBytes:requestLimit});
  const originalPath=path.resolve(import.meta.dirname,'../docs/evidence/p0/gpt-image-2.png');
  const originalBytes=await readFile(originalPath);
  const uploadPath=path.join(f.root,'eleven-reference-images.png');
  await writeFile(uploadPath,originalBytes);
  let task=await createTask({title:'保留素材视觉输入预算',brief:'验证十一张图像历史不会逐轮膨胀'},f.root);
  task=await attachTaskFiles(task.id,{
    files:Array.from({length:11},(_,index)=>({path:uploadPath,name:`reference-${index+1}.png`,mimeType:'image/png'})),
    title:'保留的十一张参考图',purpose:'用于本次需求讨论',factBoundary:'仅作视觉参考，图片内文字与事实仍需核对',
  },{root:f.root,expectedRevision:task.revision});
  task=await setSources(task.id,task.sources.map(source=>({...source,decision:'retained'})),{root:f.root,expectedRevision:task.revision});
  const source=task.sources[0];
  const config=(await f.readConfig()).basic;
  const dsh=await createDshContext({root:f.root,config});
  let handle;
  let legacyEncodedBytes=0;
  const sessionId=`studio-task-${task.id}`;
  try{
    handle=await dsh.agents.create({sessionId,meta:{cwd:f.root},agentOptions:{provider:'studio-basic',model:'mock',maxTokens:8000},setup:()=>{}});
    const session=handle.agent.session;
    session.append('turn/start',{turn:1});
    session.append('step/start',{turn:1,step:1});
    session.append('system/message',{turn:1,step:1,message:createSystemMessage('仅供离线 mock 验证。')},{surfaceOp:'append'});
    const oldContent=[];
    for(const file of source.files){
      const bytes=await readFile(path.join(f.root,'tasks',task.id,file.relativePath));
      const ref=await dsh.attachments.saveImage({data:new Uint8Array(bytes),mediaType:'image/png',name:source.title});
      legacyEncodedBytes+=4*Math.ceil(ref.bytes/3);
      oldContent.push({type:'text',text:`以下附图来自用户资料“${source.title}”（sourceId=${source.id}），顺序 ${file.order}；用途：${source.purpose}；事实边界：${source.factBoundary}。`},{type:'image',attachment:ref});
    }
    session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'历史轮已收到用户保留的参考图。'},...oldContent]}),{surfaceOp:'append'});
    session.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({source:{provider:'studio-basic',model:'mock'},content:[{type:'text',text:'历史记录完成。'}]}),stream:[]},{surfaceOp:'append'});
    session.append('step/end',{turn:1,step:1});
    session.append('turn/end',{turn:1,reason:{kind:'completed'}});
    await dsh.sessions.flush(session);
  }finally{
    await handle?.dispose();
    await dsh.fiber.dispose();
  }
  assert.ok(legacyEncodedBytes>requestLimit*5,'the old unbounded image representation exceeds the local mock request limit by a wide margin');

  await f.agent.chat({taskId:task.id,text:'继续讨论这些保留参考图。',expectedRevision:task.revision});
  t.diagnostic(`legacy full-image payload lower bound per set: ${legacyEncodedBytes} bytes; retained 11-image set plus newly repeated set: at least ${legacyEncodedBytes*2} bytes; fixed mock request bodies: ${f.requestSizes.join(', ')} bytes`);
  assert.ok(f.requests.length>=2,'the resumed session completed a mock tool round trip');
  for(const [index,request] of f.requests.entries()){
    const stats=requestImageStats(request);
    assert.equal(stats.count,11,`mock request ${index+1} carries one visual preview for each retained file`);
    assert.ok(stats.encodedBytes<=1536*1024,`mock request ${index+1} stays within the aggregate raw-image budget`);
    const requestText=JSON.stringify(request.messages);
    assert.equal((requestText.match(/素材图索引：/g)||[]).length,11,'each image retains its source index in model context');
    assert.ok(requestText.includes('有损视觉预览')&&requestText.includes('小字与细节可能无法辨读'),'the model is told that bounded previews can lose detail');
    assert.ok(f.requestSizes[index]<requestLimit,`mock request ${index+1} is below the 4 MiB local 413 threshold`);
  }
  const compactedTask=await readTask(task.id,f.root);
  await f.agent.chat({taskId:task.id,text:'再继续，不需要出图。',expectedRevision:compactedTask.revision});
  const lastRequest=f.requests.at(-1);
  const lastStats=requestImageStats(lastRequest);
  assert.equal(lastStats.count,11,'the second chat turn uses the existing image set instead of appending eleven more image blocks');
  assert.ok(f.requestSizes.at(-1)<requestLimit);
  assert.ok(f.requestSizes.at(-1)<f.requestSizes[0]+16_000,'later history grows only by the short chat text, not another copy of all images');

  const verify=await createDshContext({root:f.root,config});
  try{
    const reader=await verify.sessionPersistence.open(sessionId,'read');
    let persisted;
    try{persisted=(await reader.read()).events;}finally{await reader.close();}
    const offload=persisted.filter(event=>event.type==='image/offload');
    assert.equal(offload.length,1,'the oversized historical attachment set is projected to placeholders once');
    assert.equal(offload[0].data.targets.reduce((sum,target)=>sum+target.imageIndexes.length,0),11);
    const originalUser=persisted.find(event=>event.type==='user/message'&&event.data.content.some(block=>block.type==='text'&&block.text.includes('历史轮已收到')));
    assert.equal(originalUser.data.content.filter(block=>block.type==='image').length,11,'offloading changes only model projection; all original image references remain in the event log');
    const unchanged=await readTask(task.id,f.root);
    assert.deepEqual(unchanged.sources[0].files.map(file=>file.sha256),source.files.map(file=>file.sha256),'source originals remain byte-addressed and unchanged');
  }finally{await verify.fiber.dispose();}
});

test('legacy search compaction runs in an open pre-step and survives two persisted resumes',async t=>{
  const f=await fixture(t);
  const task=await createTask({title:'历史搜索修复',brief:'KET家长引流手帐'},f.root);
  const first=await f.agent.chat({taskId:task.id,text:'先整理需求。',expectedRevision:task.revision});
  const sessionId=`studio-task-${task.id}`;
  const config=(await f.readConfig()).basic;
  const ctx=await createDshContext({root:f.root,config});
  let handle;
  try {
    handle=await ctx.agents.resume({resumeSessionId:sessionId,agentOptions:{provider:'studio-basic',model:'mock',maxTokens:8000},setup:()=>{}});
    const session=handle.agent.session;
    const reader=await ctx.sessionPersistence.open(sessionId,'read');
    let existing;
    try { existing=(await reader.read()).events; } finally { await reader.close(); }
    const previousTurn=existing.filter(event=>event.type==='turn/start').at(-1)?.data.turn ?? 0;
    const turn=previousTurn+1;
    session.append('turn/start',{turn});
    session.append('step/start',{turn,step:1});
    session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'历史测试输入'}]}),{surfaceOp:'append'});
    const callId='legacy-search-call';
    session.append('assistant/message',{turn,step:1,message:createAssistantMessage({source:{provider:'studio-basic',model:'mock'},content:[{type:'tool-call',id:callId,name:'studio_search_assets',arguments:JSON.stringify({query:'KET'})}]}),stream:[]},{surfaceOp:'append'});
    session.append('tool/call',{turn,step:1,callId,name:'studio_search_assets',arguments:JSON.stringify({query:'KET'})});
    const legacyPayload=JSON.stringify({assets:Array.from({length:7},(_,index)=>({id:`legacy-${index}`,revision:1,title:`旧 KET 候选 ${index}`,body:'LEGACY-OCR-SENTINEL '.repeat(5000),summary:'摘要',tags:['KET'],source:{kind:'user-provided',platform:'小红书',origin:'/private/path'},files:[],extractions:[{text:'LEGACY-OCR-SENTINEL'}],history:[{body:'LEGACY-HISTORY-SENTINEL'}]}))});
    session.append('tool/result',{turn,step:1,message:createToolResultMessage({callId,content:[{type:'text',text:legacyPayload}],isError:false})},{surfaceOp:'append'});
    session.append('step/end',{turn,step:1});
    session.append('turn/end',{turn,reason:{kind:'completed'}});
    await ctx.sessions.flush(session);
  } finally {
    await handle?.dispose();
    await ctx.fiber.dispose();
  }

  const events=[];
  await f.agent.chat({taskId:task.id,text:'继续处理当前需求。',expectedRevision:first.task.revision,onEvent:event=>events.push(event)});
  const latestRequest=JSON.stringify(f.requests.at(-1).messages);
  assert.equal(latestRequest.includes('LEGACY-OCR-SENTINEL'),false);
  assert.equal(latestRequest.includes('LEGACY-HISTORY-SENTINEL'),false);
  assert.equal(latestRequest.includes('/private/path'),false);
  assert.ok(latestRequest.includes('旧 KET 候选 0'));
  const legacyToolContent=f.requests.at(-1).messages.filter(message=>message.role==='tool').map(message=>typeof message.content==='string'?message.content:JSON.stringify(message.content)).join('\n');
  assert.ok(legacyToolContent.includes('"hitCount":7'));
  assert.ok(events.some(event=>event.type==='status'&&/已收敛 1 条历史素材检索结果/.test(event.text)));

  const verificationContext=await createDshContext({root:f.root,config});
  try {
    const reader=await verificationContext.sessionPersistence.open(sessionId,'read');
    let persisted;
    try { persisted=(await reader.read()).events; } finally { await reader.close(); }
    let openTurn=null;
    const replacements=[];
    for(const event of persisted){
      if(event.type==='turn/start')openTurn=event.data.turn;
      if(event.type==='tool/result'&&event.surfaceOp?.op==='replace')replacements.push({event,openTurn});
      if(event.type==='turn/end')openTurn=null;
    }
    assert.ok(replacements.some(({event,openTurn:turn})=>{
      let summary;
      try { summary=JSON.parse(event.data.message.content[0].text); } catch { return false; }
      return turn!==null&&summary.hitCount===7;
    }),'replacement events must be written while a turn is open');
  } finally { await verificationContext.fiber.dispose(); }

  const requestCount=f.requests.length;
  const resumedAgain=await f.agent.chat({taskId:task.id,text:'再继续整理，不要出图。',expectedRevision:first.task.revision});
  assert.ok(f.requests.length>requestCount,'the second resumed model request reached the mock provider');
  const secondResumeRequest=JSON.stringify(f.requests.at(-1).messages);
  assert.equal(secondResumeRequest.includes('LEGACY-OCR-SENTINEL'),false);
  assert.equal(secondResumeRequest.includes('LEGACY-HISTORY-SENTINEL'),false);
  assert.ok(secondResumeRequest.includes('旧 KET 候选 0'));
  assert.equal(resumedAgain.task.revision,first.task.revision);
});

test('DSH resume sends each request with its selected model and leaves saved default unchanged',async t=>{
  const f=await fixture(t);
  const task=await createTask({title:'按次切换模型',brief:'两轮会话使用不同模型'},f.root);
  const first=await f.agent.chat({taskId:task.id,text:'第一轮',expectedRevision:task.revision,model:'selected-first-model'});
  const current=await readTask(task.id,f.root);
  await f.agent.chat({taskId:task.id,text:'第二轮继续',expectedRevision:current.revision,model:'selected-second-model'});
  assert.ok(f.requests.length>=2);
  assert.equal(f.requests[0].model,'selected-first-model');
  assert.ok(f.requests.some(request=>request.model==='selected-second-model'));
  assert.ok(f.requests.some(request=>request.messages.filter(message=>message.role==='user').length>=2));
  assert.equal((await readTask(task.id,f.root)).revision,first.task.revision);
});

test('DSH errors are safe and do not mark task confirmed',async t=>{
  const f=await fixture(t,{fail:true});
  const task=await createTask({title:'模型失败',brief:'示例'},f.root);
  await assert.rejects(f.agent.chat({taskId:task.id,text:'开始'}),e=>e.code==='ERR_STUDIO_AGENT'&&!e.message.includes('mock-secret-key'));
  assert.equal((await readTask(task.id,f.root)).revision,task.revision);
});

test('DSH in-flight cancellation reaches loop and leaves draft unchanged',async t=>{
  const f=await fixture(t,{slow:true});
  const task=await createTask({title:'停止任务',brief:'示例'},f.root);
  const abort=new AbortController();
  const operation=f.agent.chat({taskId:task.id,text:'开始',signal:abort.signal});
  setTimeout(()=>abort.abort(new Error('用户停止')),30);
  await assert.rejects(operation);
  assert.equal((await readTask(task.id,f.root)).revision,task.revision);
});

test('connection check verifies a real DSH tool round trip',async t=>{
  const f=await fixture(t);
  const result=await f.agent.check({});
  assert.equal(result.tools,true);
  assert.equal(result.text,true);
  assert.equal(result.vision,true);
});


async function reviewTask(f){
  let task=await createTask({title:'读图夹具',brief:'一张纯色测试图'},f.root);
  task=await confirmInputs(task.id,{revision:task.revision,by:'测试用户',note:'测试需求确认'},{root:f.root});
  task=await setSheet(task.id,{title:'测试图',pages:[{page:1,copy:'测试文字',prompt:'测试图',size:'1:1'}]},{root:f.root,expectedRevision:task.revision,inputRevision:task.inputConfirmation.revision});
  task=await confirmSheet(task.id,{version:task.sheetVersion,by:'测试用户',note:'测试制作单确认'},{root:f.root,expectedRevision:task.revision});
  const bytes=await readFile(new URL('../docs/evidence/p0/gpt-image-2.png',import.meta.url));
  const file=f.root+'/image.png';await writeFile(file,bytes);
  const sha256=createHash('sha256').update(bytes).digest('hex');
  task=await withTask(task.id,draft=>{draft.execution={version:draft.sheetVersion,status:'succeeded',pages:[{page:1,status:'succeeded',image:{path:file,sha256}}]};},{root:f.root,expectedRevision:task.revision});
  return {task,sha256};
}
test('DSH review attaches exact current pixels to model and binds observation to their hash',async t=>{
  const f=await fixture(t);
  const {task,sha256}=await reviewTask(f);
  await f.agent.review({taskId:task.id,page:1,expectedRevision:task.revision}).catch(e=>{throw e.cause??e;});
  assert.ok(f.requests[0].messages.some(m=>Array.isArray(m.content)&&m.content.some(c=>c.type==='image_url')));
  const reviewed=await readTask(task.id,f.root);
  assert.equal(reviewed.reviews.at(-1).sha256,sha256);
  assert.equal(reviewed.reviews.at(-1).decision,'revise');
  assert.equal(reviewed.finalApproval,null);
});


test('review becomes failed and its just-written observation is removed when Canvas changes after commit',async t=>{
  const f=await fixture(t);const {task}=await reviewTask(f);let checks=0;
  await assert.rejects(f.agent.review({taskId:task.id,page:1,expectedRevision:task.revision,beforeRecordReview:async()=>{if(++checks===2)throw new Error('Canvas changed after first check');}}));
  assert.equal(checks,2);
  const current=await readTask(task.id,f.root);
  assert.equal(current.reviews.length,0);assert.equal(current.finalApproval,null);
});

test('a review job cannot retain ambiguous records from duplicate model tool calls',async t=>{
  const f=await fixture(t,{duplicateReview:true});const {task}=await reviewTask(f);
  await assert.rejects(f.agent.review({taskId:task.id,page:1,expectedRevision:task.revision}));
  const current=await readTask(task.id,f.root);assert.equal(current.reviews.length,0);assert.equal(current.finalApproval,null);
});
