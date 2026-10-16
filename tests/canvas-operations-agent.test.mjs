import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTask,withTask,readTask} from '../src/creative/tasks.mjs';
import {createStudioAgent} from '../adapters/dsh/runtime.mjs';

async function fixture(t,calls){
  const root=await mkdtemp(path.join(os.tmpdir(),'studio-mechanical-agent-'));
  const requests=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);requests.push(body);
    const index=body.messages.filter(message=>message.role==='tool').length;
    const call=calls[index];
    const delta=call?{tool_calls:[{index:0,id:`mechanical-${index}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]}:{content:'机械操作完成，请查看附件；原成品保留。'};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [part,finish] of [[{role:'assistant',...delta},null],[{},call?'tool_calls':'stop']])res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'mock',choices:[{index:0,delta:part,finish_reason:finish}]})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const task=await createTask({title:'机械操作隔离任务',brief:'裁切并保留原图'},root);
  const agent=createStudioAgent({root,readConfig:async()=>({basic:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'mock',apiKey:'mechanical-fixture-key'}})});
  return {root,task,agent,requests};
}

test('聊天机械工具读取真实索引、绑定宿主版本、重复操作去重且不调用生图回调',async t=>{
  const crop={operation:'crop',nodeId:'source-node',crop:{x:0,y:0,width:0.5,height:0.5}};
  const f=await fixture(t,[{name:'studio_canvas_state',args:{}},{name:'studio_canvas_operation',args:crop},{name:'studio_canvas_operation',args:{crop:{height:0.5,width:0.5,y:0,x:0},nodeId:'source-node',operation:'crop'}}]);
  const calls=[];let states=0,paid=0;
  await f.agent.chat({taskId:f.task.id,text:'把原图左上四分之一裁出来，原图保留。',expectedRevision:f.task.revision,
    canvasState:async args=>{states++;assert.equal(args.expectedRevision,f.task.revision);return {nodes:[{id:'source-node',type:'image',naturalSize:{width:800,height:600}}]};},
    canvasOperation:async args=>{calls.push(args);return {task:await withTask(f.task.id,draft=>{draft.canvasOperations=[{id:args.operationId,operation:'crop'}];},{root:f.root,expectedRevision:args.expectedRevision}),result:{operation:'crop',images:[{nodeId:'crop-node',width:400,height:300,fileUrl:`/api/tasks/${f.task.id}/canvas-operation-files/output/1`}]}};},
    editPages:async()=>{paid++;throw new Error('must not generate');},
  });
  assert.equal(states,1);assert.equal(calls.length,1);assert.equal(paid,0);
  assert.match(calls[0].operationId,/^[a-f\d-]{36}$/);assert.deepEqual(calls[0].crop,crop.crop);
  const tool=f.requests[0].tools.find(value=>value.function.name==='studio_canvas_operation');
  assert.equal(tool.function.parameters.additionalProperties,false);
  assert.equal(tool.function.parameters.properties.operationId,undefined);
  const outputs=f.requests.at(-1).messages.filter(message=>message.role==='tool');
  assert.ok(outputs.some(message=>JSON.stringify(message).includes('crop-node')));
  assert.equal((await readTask(f.task.id,f.root)).sheetVersion,0);
});

test('机械操作拒绝模型伪造宿主字段，失败不重提且不能回退全量制作单',async t=>{
  const bad={operation:'crop',nodeId:'source-node',requestId:'forged'};
  const crop={operation:'crop',nodeId:'source-node',crop:{x:0,y:0,width:0.5,height:0.5}};
  const f=await fixture(t,[{name:'studio_canvas_operation',args:bad},{name:'studio_canvas_operation',args:crop},{name:'studio_canvas_operation',args:{...crop,width:100}},{name:'studio_canvas_operation',args:crop},{name:'studio_write_sheet',args:{payload:'{}'}}]);
  let calls=0;
  await f.agent.chat({taskId:f.task.id,text:'只裁切图片，不生成。',expectedRevision:f.task.revision,canvasState:async()=>({nodes:[]}),canvasOperation:async()=>{calls++;throw Object.assign(new Error('SECRET_PROVIDER_BODY'),{code:'ERR_CANVAS_DISCONNECTED'});}});
  assert.equal(calls,1);
  const messages=f.requests.at(-1).messages.filter(message=>message.role==='tool');
  assert.ok(messages.some(message=>JSON.stringify(message).includes('canvas_disconnected')));
  assert.ok(messages.some(message=>JSON.stringify(message).includes('local_edit_prevents_full_sheet')));
  assert.equal(JSON.stringify(messages).includes('SECRET_PROVIDER_BODY'),false);
});


test('附件导入、真实画布预览与像素合成的参数和图像块能够完整往返主对话',async t=>{
  const f=await fixture(t,[
    {name:'studio_canvas_operation',args:{operation:'import',image:{sourceId:'uploaded-source',fileOrder:1}}},
    {name:'studio_canvas_read_image',args:{nodeId:'base-poster'}},
    {name:'studio_canvas_operation',args:{operation:'compose',nodeId:'base-poster',layers:[{nodeId:'new-image',x:64,y:64,width:32,height:32,fit:'contain',clear:'#ffffff',smoothing:'nearest'}]}},
    {name:'studio_canvas_read_image',args:{nodeId:'composed-poster'}},
  ]);
  const bytes=await readFile(new URL('../adapters/dsh/connection-check.png',import.meta.url));
  const calls=[];const previews=[];
  await f.agent.chat({taskId:f.task.id,text:'把海报右下角的旧图换成新上传的图，别重画。',expectedRevision:f.task.revision,
    canvasState:async()=>({nodes:[]}),
    canvasOperation:async args=>{calls.push(args);return {task:await readTask(f.task.id,f.root),result:{operation:args.operation,images:[{nodeId:args.operation==='import'?'new-image':'composed-poster',width:128,height:128}]}};},
    canvasPreview:async args=>{previews.push(args.nodeId);return {bytes,mimeType:'image/png',sha256:'a'.repeat(64),width:128,height:128};},
  });
  assert.deepEqual(calls.map(value=>value.operation),['import','compose']);
  assert.deepEqual(calls[0].image,{sourceId:'uploaded-source',fileOrder:1});
  assert.equal(calls[0].nodeId,undefined);
  assert.deepEqual(previews,['base-poster','composed-poster']);
  assert.equal(calls[1].layers[0].clear,'#ffffff');
  assert.ok(f.requests.at(-1).messages.some(message=>Array.isArray(message.content)&&message.content.some(block=>block.type==='image_url'&&block.image_url?.url.startsWith('data:image/'))),'后续模型必须收到真实图像块而不是图片文字占位');
  assert.equal((await readTask(f.task.id,f.root)).sheetVersion,0);
});

test('拼接不需要伪造单个主节点，保留输入次序且未知结果不会退回AI重画',async t=>{
  const f=await fixture(t,[{name:'studio_canvas_operation',args:{operation:'stitch',nodeIds:['second','first','second'],direction:'horizontal',gap:8,background:'#ffffff'}}]);
  const calls=[];
  await f.agent.chat({taskId:f.task.id,text:'第二张、第一张、第二张这样横着拼起来。',expectedRevision:f.task.revision,
    canvasState:async()=>({nodes:[]}),canvasOperation:async args=>{calls.push(args);return {task:await readTask(f.task.id,f.root),result:{operation:args.operation,images:[{nodeId:'joined',width:400,height:128}]}};},
  });
  assert.equal(calls.length,1);assert.equal(calls[0].nodeId,undefined);
  assert.deepEqual(calls[0].nodeIds,['second','first','second']);
});


test('精确区域检测可向主对话提供像素框并用于通用合成，不靠视觉猜坐标',async t=>{
  const rect={x:354,y:234,width:120,height:120};
  const f=await fixture(t,[
    {name:'studio_canvas_detect_regions',args:{nodeId:'poster',kinds:['barcode']}},
    {name:'studio_canvas_operation',args:{operation:'compose',nodeId:'poster',layers:[{nodeId:'replacement',...rect,clear:'#ffffff',fit:'contain',smoothing:'nearest'}]}},
  ]);
  let regionCalls=0;const operations=[];
  await f.agent.chat({taskId:f.task.id,text:'把右下角旧码换成新图。',expectedRevision:f.task.revision,
    canvasState:async()=>({nodes:[]}),
    canvasRegions:async args=>{regionCalls++;assert.equal(args.nodeId,'poster');return {nodeId:'poster',sha256:'a'.repeat(64),width:520,height:400,regions:[{kind:'barcode',confidence:1,bounds:{x:356,y:236,width:116,height:116},suggestedBounds:rect}]};},
    canvasOperation:async args=>{operations.push(args);return {task:await readTask(f.task.id,f.root),result:{operation:'compose',images:[{nodeId:'result',width:520,height:400}]}};},
  });
  assert.equal(regionCalls,1);assert.equal(operations.length,1);
  const {x,y,width,height}=operations[0].layers[0];assert.deepEqual({x,y,width,height},rect);
  assert.ok(f.requests.at(-1).messages.some(message=>message.role==='tool'&&JSON.stringify(message).includes('suggestedBounds')));
});
