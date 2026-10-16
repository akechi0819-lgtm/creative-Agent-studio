import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {attachTaskFiles,confirmInputs,createTask,readTask,withTask} from '../src/creative/tasks.mjs';
import {createStudioAgent} from '../adapters/dsh/runtime.mjs';

async function fixture(t,{toolArguments={edits:[{page:1,instruction:'只调整标题留白和强调色。',copy:'周末亲子阅读指南'}]},toolSequence=null,hasBaseline=true,baselinePages=[1],duplicateCalls=0,uploadedImages=0,readPage=null}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'studio-page-edit-'));
  const requests=[];
  let mockArguments=structuredClone(toolArguments);
  let readIssued=false;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);requests.push(body);
    const editTool=body.tools?.find(item=>item.function.name==='studio_edit_pages');
    const readTool=body.tools?.find(item=>item.function.name==='studio_read_page_image');
    const hasToolResult=body.messages.some(message=>message.role==='tool');
    const toolResultCount=body.messages.filter(message=>message.role==='tool').length;
    const scripted=Array.isArray(toolSequence)?toolSequence[toolResultCount]:null;
    const callRead=readPage!==null&&readTool&&!readIssued;
    if(callRead)readIssued=true;
    const callEdit=!callRead&&editTool&&(scripted?.name==='studio_edit_pages'||(!Array.isArray(toolSequence)&&!hasToolResult));
    const callScripted=!callRead&&Boolean(scripted);
    const scriptedCall=scripted?{tool_calls:[{index:0,id:'mock-sequenced-call-'+(toolResultCount+1),type:'function',function:{name:scripted.name,arguments:JSON.stringify(scripted.arguments)}}]}:null;
    const delta=callRead
      ?{tool_calls:[{index:0,id:'mock-read-page-call',type:'function',function:{name:'studio_read_page_image',arguments:JSON.stringify({page:readPage})}}]}
      :callScripted
      ?scriptedCall
      :callEdit
      ?{tool_calls:Array.from({length:duplicateCalls+1},(_,index)=>({index,id:'mock-edit-call-'+(index+1),type:'function',function:{name:'studio_edit_pages',arguments:JSON.stringify(mockArguments)}}))}
      :{content:'已处理本轮请求。'};
    const finish=callRead||callEdit||callScripted?'tool_calls':'stop';
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write('data: '+JSON.stringify({id:'mock-edit-completion',object:'chat.completion.chunk',created:1,model:'mock',choices:[{index:0,delta:{role:'assistant',...delta},finish_reason:null}]})+'\n\n');
    res.write('data: '+JSON.stringify({id:'mock-edit-completion',object:'chat.completion.chunk',created:1,model:'mock',choices:[{index:0,delta:{},finish_reason:finish}]})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const readConfig=async()=>({basic:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'mock',apiKey:'mock-page-edit-key'}});
  const agent=createStudioAgent({root,readConfig});
  let task=await createTask({title:'局部修改隔离任务',brief:'已有成品的局部修改测试'},root);
  if(hasBaseline) task=await withTask(task.id,draft=>{
    draft.execution={version:5,status:'pending',pages:[]};
    draft.executionHistory=[{
      version:1,status:'succeeded',
      pages:baselinePages.map(page=>({page,status:'succeeded',image:{path:'/private/SECRET-HISTORY-IMAGE-PATH-'+page+'.png',sha256:'a'.repeat(64)}})),
      embeddedPreview:'SECRET-HISTORY-BASE64-'.repeat(3000),
    }];
  },{root,expectedRevision:task.revision});
  if(uploadedImages){
    const imagePath=path.resolve(import.meta.dirname,'../docs/evidence/p0/gpt-image-2.png');
    task=await attachTaskFiles(task.id,{files:Array.from({length:uploadedImages},(_,index)=>({path:imagePath,name:`uploaded-${index+1}.png`,mimeType:'image/png'})),title:'当前上传的AI图片'},{root,expectedRevision:task.revision});
    const sourceId=task.sources.find(item=>item.type==='current_attachment').id;
    const replaceReference=reference=>{if(reference?.sourceId==='replace-with-current-upload')reference.sourceId=sourceId;};
    mockArguments=structuredClone(toolArguments);
    for(const edit of mockArguments.edits||[]){replaceReference(edit.image);for(const reference of edit.styleImages||[])replaceReference(reference);}
  }
  return {root,requests,agent,task,readConfig};
}

test('已有成功历史成品可由局部工具定向修改且模型只看到无路径短摘要',async t=>{
  const f=await fixture(t,{baselinePages:[1,2],toolArguments:{edits:[{page:1,instruction:'只调整标题留白和强调色。',copy:'周末亲子阅读指南',stylePages:[2]}]}});
  let callbackArgs;
  const result=await f.agent.chat({taskId:f.task.id,text:'把第1页标题留白拉开，并替换为周末亲子阅读指南。',expectedRevision:f.task.revision,
    editPages:async args=>{
      callbackArgs=args;
      return withTask(f.task.id,draft=>{
        draft.execution={version:5,status:'succeeded',pages:[{page:1,status:'succeeded',image:{path:'/private/SECRET-EDIT-OUTPUT-PATH.png',sha256:'b'.repeat(64)}}]};
      },{root:f.root,expectedRevision:args.expectedRevision});
    }});
  assert.deepEqual(callbackArgs,{edits:[{page:1,instruction:'只调整标题留白和强调色。',copy:'周末亲子阅读指南',stylePages:[2]}],expectedRevision:f.task.revision});
  const requestText=JSON.stringify(f.requests);
  const systemPrompt=f.requests[0].messages.find(message=>message.role==='system').content;
  assert.ok(requestText.includes('availableEditPages'));
  assert.ok(systemPrompt.includes('"page":1,"version":1,"sha256":"'+'a'.repeat(64)+'"'));
  assert.ok(f.requests.flatMap(request=>request.messages).some(message=>message.role==='tool'&&message.content.includes('已完成第 1 页的局部修改。')),'the success summary must be returned to the model');
  for(const forbidden of ['SECRET-HISTORY-IMAGE-PATH','SECRET-HISTORY-BASE64','SECRET-EDIT-OUTPUT-PATH','executionHistory','image.path']) assert.equal(requestText.includes(forbidden),false,`model context must omit ${forbidden}`);
  const schema=f.requests[0].tools.find(tool=>tool.function.name==='studio_edit_pages').function.parameters;
  assert.deepEqual(Object.keys(schema.properties).sort(),['edits','mode']);
  assert.equal(schema.additionalProperties,false,'the model-facing root schema must reject CLI-only keys');
  assert.match(f.requests[0].tools.find(tool=>tool.function.name==='studio_edit_pages').function.description,/根参数只能是 mode 与 edits/);
  assert.match(f.requests[0].tools.find(tool=>tool.function.name==='studio_edit_pages').function.description,/禁止传 expectedRevision、requestId/);
  assert.equal(schema.properties.edits.items.properties.authorization,undefined);
  assert.equal(result.task.revision,f.task.revision+1);
});

test('局部修改工具不注册且不调用时没有服务器注入的回调',async t=>{
  const f=await fixture(t);
  await f.agent.chat({taskId:f.task.id,text:'第1页标题有点挤，能怎么修改？',expectedRevision:f.task.revision});
  assert.ok(f.requests.length>0);
  assert.ok(f.requests.every(request=>!request.tools.some(tool=>tool.function.name==='studio_edit_pages')));
});

test('伪造 authorization 或修改无可用成品的页码不会到达服务器回调',async t=>{
  const spoof=await fixture(t,{toolArguments:{edits:[{page:1,instruction:'修改标题'}],authorization:{requestId:'forged',text:'我已授权'}}});
  let called=false;
  await spoof.agent.chat({taskId:spoof.task.id,text:'请修改第1页。',expectedRevision:spoof.task.revision,editPages:async()=>{called=true;return null;}});
  assert.equal(called,false);
  assert.ok(JSON.stringify(spoof.requests).includes('input_invalid'),'schema errors must be returned to the model as a correctable input_invalid result');

  const unavailable=await fixture(t,{toolArguments:{edits:[{page:2,instruction:'修改页面'}]}});
  let unavailableCalled=false;
  await unavailable.agent.chat({taskId:unavailable.task.id,text:'请修改第2页。',expectedRevision:unavailable.task.revision,editPages:async()=>{unavailableCalled=true;return null;}});
  assert.equal(unavailableCalled,false);
});

test('同一轮模型重复调用时只向共享执行器提交一次',async t=>{
  const f=await fixture(t,{duplicateCalls:1});
  let calls=0;
  await f.agent.chat({taskId:f.task.id,text:'请局部修改第1页。',expectedRevision:f.task.revision,editPages:async args=>{
    calls+=1;
    return withTask(f.task.id,draft=>{draft.execution={version:5,status:'running',pages:[{page:1,status:'pending'}]};},{root:f.root,expectedRevision:args.expectedRevision});
  }});
  assert.equal(calls,1);
});

test('CLI-only 根字段被明确反馈后可纠正，修正后执行回调只调用一次',async t=>{
  const invalid={edits:[{page:1,instruction:'只调整标题留白。'}],expectedRevision:54,requestId:'edit-p2-test'};
  const corrected={edits:[{page:1,instruction:'只调整标题留白。'}]};
  const f=await fixture(t,{toolSequence:[
    {name:'studio_edit_pages',arguments:invalid},
    {name:'studio_edit_pages',arguments:corrected},
  ]});
  const callbackArgs=[];
  await f.agent.chat({taskId:f.task.id,text:'请只修改第1页标题留白。',expectedRevision:f.task.revision,editPages:async args=>{
    callbackArgs.push(args);
    return withTask(f.task.id,draft=>{draft.execution={version:5,status:'running',pages:[{page:1,status:'pending'}]};},{root:f.root,expectedRevision:args.expectedRevision});
  }});
  assert.deepEqual(callbackArgs,[{edits:corrected.edits,expectedRevision:f.task.revision}]);
  const toolMessages=f.requests.flatMap(request=>request.messages).filter(message=>message.role==='tool');
  assert.ok(toolMessages.some(message=>JSON.stringify(message).includes('input_invalid')));
  assert.ok(toolMessages.some(message=>JSON.stringify(message).includes('expectedRevision、requestId')));
  assert.ok(toolMessages.some(message=>JSON.stringify(message).includes('尚未调用执行器')));
  assert.equal(callbackArgs.length,1);
});

test('Canvas 断开后给出操作提示并阻止模型同轮回退写全量制作单',async t=>{
  const sheet={title:'不应写入的整单',sourceIds:[],pages:[{page:1,copy:'标题',prompt:'海报',size:'3:4',sourceIds:[],referenceImages:[]}]};
  const f=await fixture(t,{toolSequence:[
    {name:'studio_edit_pages',arguments:{edits:[{page:1,instruction:'仅调整标题留白。'}]}},
    {name:'studio_write_sheet',arguments:{payload:JSON.stringify(sheet)}},
  ]});
  const confirmed=await confirmInputs(f.task.id,{revision:f.task.revision,by:'隔离测试用户',note:'测试夹具确认'},{root:f.root});
  f.requests.length=0;
  let callbackCalls=0;
  await f.agent.chat({taskId:f.task.id,text:'请修改第1页。',expectedRevision:confirmed.revision,editPages:async()=>{
    callbackCalls+=1;
    const error=new Error('private provider details');
    error.code='ERR_CANVAS_DISCONNECTED';
    throw error;
  }});
  const toolMessages=f.requests.flatMap(request=>request.messages).filter(message=>message.role==='tool');
  assert.ok(toolMessages.some(message=>JSON.stringify(message).includes('canvas_disconnected')));
  assert.ok(toolMessages.some(message=>JSON.stringify(message).includes('打开当前任务的 Canvas')));
  assert.ok(toolMessages.some(message=>JSON.stringify(message).includes('local_edit_prevents_full_sheet')));
  assert.equal(callbackCalls,1);
  const updated=await readTask(f.task.id,f.root);
  assert.equal(updated.sheets.length,0,'the model must not write a full sheet as a same-turn fallback');
  assert.equal(JSON.stringify(f.requests).includes('private provider details'),false,'provider error text must not reach the model');
});

test('uploaded-images 无成功输出基线也可使用本任务上传图，且不保留来源或确认需求',async t=>{
  const f=await fixture(t,{hasBaseline:false,uploadedImages:2,toolArguments:{mode:'uploaded-images',edits:[{
    page:2,
    image:{sourceId:'replace-with-current-upload',fileOrder:2},
    instruction:'保留第二张的主体，把画风改得接近第一张。',
    styleImages:[{sourceId:'replace-with-current-upload',fileOrder:1}],
    copy:'周末阅读指南',
  }]}});
  const source=f.task.sources.find(item=>item.type==='current_attachment');
  assert.ok(source);
  f.requests.length=0;
  const captured=[];
  const result=await f.agent.chat({taskId:f.task.id,text:'把第二张按第一张的画风改，不要整理完整制作单。',expectedRevision:f.task.revision,editPages:async args=>{
    captured.push(args);
    return withTask(f.task.id,draft=>{draft.execution={version:null,status:'running',pages:[{page:2,status:'pending'}]};},{root:f.root,expectedRevision:args.expectedRevision});
  }});
  assert.deepEqual(captured,[{mode:'uploaded-images',edits:[{
    page:2,
    image:{sourceId:source.id,fileOrder:2},
    instruction:'保留第二张的主体，把画风改得接近第一张。',
    styleImages:[{sourceId:source.id,fileOrder:1}],
    copy:'周末阅读指南',
  }],expectedRevision:f.task.revision}]);
  const prompt=f.requests[0].messages.find(message=>message.role==='system').content;
  assert.ok(prompt.includes(source.id));
  assert.ok(prompt.includes('availableUploadedImages'));
  assert.ok(prompt.includes('styleImages'));
  assert.ok(!prompt.includes('relativePath'));
  const updated=await readTask(f.task.id,f.root);
  assert.equal(updated.revision,result.task.revision);
  assert.equal(updated.inputConfirmation,null);
  assert.equal(updated.sources.find(item=>item.id===source.id).decision,'pending');
  const call=f.requests[0].tools.find(tool=>tool.function.name==='studio_edit_pages');
  assert.ok(call);
  assert.deepEqual(Object.keys(call.function.parameters.properties).sort(),['edits','mode']);
});

test('uploaded-images 拒绝被排除附件和不存在的图片索引',async t=>{
  const f=await fixture(t,{hasBaseline:false,uploadedImages:2,toolArguments:{mode:'uploaded-images',edits:[{
    page:1,image:{sourceId:'missing-source',fileOrder:1},instruction:'局部调整画风',
  }]}});
  let called=false;
  await f.agent.chat({taskId:f.task.id,text:'请修改这张上传图片。',expectedRevision:f.task.revision,editPages:async()=>{called=true;return null;}});
  assert.equal(called,false);
  assert.ok(f.requests[0].tools.some(tool=>tool.function.name==='studio_edit_pages'));

  const excludedFixture=await fixture(t,{hasBaseline:false,uploadedImages:1,toolArguments:{mode:'uploaded-images',edits:[{
    page:1,image:{sourceId:'replace-with-current-upload',fileOrder:1},instruction:'局部调整画风',
  }]}});
  const source=excludedFixture.task.sources.find(item=>item.type==='current_attachment');
  const excluded=await withTask(excludedFixture.task.id,draft=>{draft.sources.find(item=>item.id===source.id).decision='excluded';},{root:excludedFixture.root,expectedRevision:excludedFixture.task.revision});
  let excludedCalled=false;
  await excludedFixture.agent.chat({taskId:excludedFixture.task.id,text:'请修改这张上传图片。',expectedRevision:excluded.revision,editPages:async()=>{excludedCalled=true;return null;}});
  assert.equal(excludedCalled,false);
  assert.ok(excludedFixture.requests.every(request=>!request.tools.some(tool=>tool.function.name==='studio_edit_pages')));
});

test('已有成品与上传图片模式拒绝混用对方的引用字段',async t=>{
  const uploaded=await fixture(t,{hasBaseline:false,uploadedImages:1,toolArguments:{mode:'uploaded-images',edits:[{
    page:1,image:{sourceId:'replace-with-current-upload',fileOrder:1},instruction:'改变颜色',stylePages:[1],
  }]}});
  let uploadedCalled=false;
  await uploaded.agent.chat({taskId:uploaded.task.id,text:'修改上传图片。',expectedRevision:uploaded.task.revision,editPages:async()=>{uploadedCalled=true;return null;}});
  assert.equal(uploadedCalled,false);

  const existing=await fixture(t,{toolArguments:{edits:[{page:1,instruction:'改变颜色',image:{sourceId:'source',fileOrder:1}}]}});
  let existingCalled=false;
  await existing.agent.chat({taskId:existing.task.id,text:'修改已有成品。',expectedRevision:existing.task.revision,editPages:async()=>{existingCalled=true;return null;}});
  assert.equal(existingCalled,false);
});

test('studio_read_page_image 通过 DSH image block 返回 hash 校验的成品预览，不把路径放进模型文本',async t=>{
  const f=await fixture(t,{readPage:1});
  const source=await readFile(path.resolve(import.meta.dirname,'../adapters/dsh/connection-check.png'));
  const imagePath=path.join(f.root,'tasks',f.task.id,'images','v1','page-1-attempt-1.png');
  await mkdir(path.dirname(imagePath),{recursive:true});
  await writeFile(imagePath,source);
  const sha256=createHash('sha256').update(source).digest('hex');
  f.task=await withTask(f.task.id,draft=>{draft.executionHistory[0].pages[0].image={path:imagePath,sha256};},{root:f.root,expectedRevision:f.task.revision});

  await f.agent.chat({taskId:f.task.id,text:'请先看第1页成品，再告诉我标题是否拥挤。',expectedRevision:f.task.revision});

  const requestText=JSON.stringify(f.requests);
  assert.ok(f.requests[0].tools.some(tool=>tool.function.name==='studio_read_page_image'));
  assert.equal(f.requests.length,2,'the rendered image must return to the model on its next request');
  const toolResult=f.requests[1].messages.find(message=>message.role==='tool');
  assert.ok(toolResult);
  assert.ok(typeof toolResult.content==='string');
  assert.ok(toolResult.content.includes('第 1 页'));
  assert.ok(toolResult.content.includes(sha256));
  const imageMessage=f.requests[1].messages.find(message=>message.role==='user'&&Array.isArray(message.content)&&message.content.some(block=>block.type==='image_url'));
  assert.ok(imageMessage,'DSH render must deliver the preview as image input after the tool result');
  assert.ok(imageMessage.content.some(block=>block.type==='image_url'&&block.image_url.url.startsWith('data:image/png;base64,')));
  assert.equal(toolResult.content.includes(imagePath),false);
  assert.equal(requestText.includes(imagePath),false,'filesystem paths must not be sent to the model');
  assert.equal(requestText.includes('SECRET-HISTORY-IMAGE-PATH'),false);
});

test('studio_read_page_image 拒绝哈希不匹配的历史成品',async t=>{
  const f=await fixture(t,{readPage:1});
  const imagePath=path.join(f.root,'tasks',f.task.id,'images','v1','page-1-attempt-1.png');
  const source=await readFile(path.resolve(import.meta.dirname,'../adapters/dsh/connection-check.png'));
  await mkdir(path.dirname(imagePath),{recursive:true});
  await writeFile(imagePath,source);
  f.task=await withTask(f.task.id,draft=>{draft.executionHistory[0].pages[0].image.path=imagePath;},{root:f.root,expectedRevision:f.task.revision});

  await f.agent.chat({taskId:f.task.id,text:'查看第1页。',expectedRevision:f.task.revision});

  assert.equal(f.requests.length,2);
  const toolResult=f.requests[1].messages.find(message=>message.role==='tool');
  assert.ok(toolResult);
  assert.ok(JSON.stringify(toolResult).includes('SHA-256 不一致'));
  assert.equal(JSON.stringify(f.requests).includes(imagePath),false);
  assert.equal(JSON.stringify(toolResult).includes('image_url'),false);
});
