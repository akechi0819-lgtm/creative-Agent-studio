import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTask, readTask, confirmInputs, setBrief, setSheet, confirmSheet } from '../src/creative/tasks.mjs';
import { executeTask } from '../src/creative/executor.mjs';
const config={projectId:'fixture',webUrl:'http://fixture',clientId:'fixture'};
const getHealth=async()=>({targets:[{hasCanvas:true,projectId:'fixture',clientId:'fixture'}]});
async function setup(t,count=1){
 const root=await mkdtemp(path.join(os.tmpdir(),'studio-executor-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let task=await createTask({title:'合同夹具',brief:{topic:'合同验证',audience:'开发者',requirements:'模拟非真实成品'}},root);
 task=await confirmInputs(task.id,{revision:task.revision,by:'test fixture',note:'仅模拟确认'},{root});
 task=await setSheet(task.id,{title:'夹具',pages:Array.from({length:count},(_,i)=>({page:i+1,copy:'文字',prompt:'模拟',size:'3:4'}))},{root,expectedRevision:task.revision,inputRevision:task.inputConfirmation.revision});
 await confirmSheet(task.id,{version:1,by:'test fixture',note:'仅模拟确认'},{root,expectedRevision:task.revision});return {root,id:task.id};
}
async function executeCurrent(id,options){const task=await readTask(id,options.root);return executeTask(id,{...options,expectedRevision:task.revision});}
function canvas({failPage,unknown=false,cancelController}={}){
 let nodes=[],connections=[],runs=0;
 return {
 tool:async(name,input)=>{
  if(name==='canvas_get_state')return {nodes,connections};
  if(name==='canvas_apply_ops'){nodes.push(...input.ops.filter(o=>o.type==='add_node').map(o=>({id:o.id,type:o.nodeType,metadata:o.metadata})));return {};}
  if(name==='canvas_run_generation'){
   runs++;if(cancelController){cancelController.abort();throw new DOMException('abort','AbortError');}
   if(runs!==failPage&&!unknown){const image={id:`image-${runs}`,type:'image',metadata:{status:'success'}};nodes.push(image);connections.push({fromNodeId:input.nodeId,toNodeId:image.id});}return {};
  }
  if(name==='generation_get_status')return {tasks:unknown?[]:[{id:input.nodeIds[0],status:'failed'}]};
  throw new Error(name);
 },deliver:()=>{const config=nodes.filter(n=>n.type==='config').at(-1);const image={id:'late-image',type:'image',metadata:{status:'success'}};nodes.push(image);connections.push({fromNodeId:config.id,toNodeId:image.id});},recover:async(nodeId,file)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'fixture bytes');return {path:file,nodeId};},runs:()=>runs
 };
}
test('未确认版本拒绝外部调用',async t=>{const {root,id}=await setup(t);const c=canvas();await assert.rejects(executeCurrent(id,{root,version:2,config,getHealth,...c}));assert.equal(c.runs(),0);});
test('执行入口必须携带调用方读取的 revision，过期执行在触碰 Canvas 前拒绝',async t=>{
 const {root,id}=await setup(t);const prepared=await readTask(id,root);const c=canvas();
 await assert.rejects(executeTask(id,{root,version:1,config,getHealth,...c}),/expectedRevision/);
 await setBrief(id,'变化后的需求',{root,expectedRevision:prepared.revision});
 await assert.rejects(executeTask(id,{root,version:1,expectedRevision:prepared.revision,config,getHealth,...c}),error=>error.code==='ERR_TASK_REVISION_CONFLICT');
 assert.equal(c.runs(),0);
});
test('三页失败后恢复仅重试明确失败页，不重做已完成页',async t=>{
 const {root,id}=await setup(t,3);const c=canvas({failPage:2});
 await assert.rejects(executeCurrent(id,{root,version:1,config,getHealth,...c}));
 let task=await readTask(id,root);assert.equal(task.execution.pages[0].status,'succeeded');assert.equal(task.execution.pages[1].status,'failed');
 await executeCurrent(id,{root,version:1,config,getHealth,...c,retryPage:2});task=await readTask(id,root);
 assert.equal(c.runs(),4);assert.equal(task.execution.status,'succeeded');
 await executeCurrent(id,{root,version:1,config,getHealth,...c});assert.equal(c.runs(),4);
});
test('未知提交恢复不重放',async t=>{const {root,id}=await setup(t);const c=canvas({unknown:true});for(let i=0;i<2;i++)await assert.rejects(executeCurrent(id,{root,version:1,config,getHealth,...c}));assert.equal(c.runs(),1);assert.equal((await readTask(id,root)).execution.pages[0].status,'uncertain');});
test('在途取消保留提交意图且恢复不再发送',async t=>{
 const {root,id}=await setup(t);const controller=new AbortController();const c=canvas({cancelController:controller});
 await assert.rejects(executeCurrent(id,{root,version:1,config,getHealth,...c,signal:controller.signal}));
 const task=await readTask(id,root);assert.equal(task.execution.status,'cancelled');assert.equal(task.execution.pages[0].submitted,true);
 await assert.rejects(executeCurrent(id,{root,version:1,config,getHealth,...c}));assert.equal(c.runs(),1);
});
test('取消后迟到的成功结果由原节点回收，恢复不重新生成',async t=>{
 const {root,id}=await setup(t);const controller=new AbortController();const c=canvas({cancelController:controller});
 await assert.rejects(executeCurrent(id,{root,version:1,config,getHealth,...c,signal:controller.signal}));
 c.deliver();await executeCurrent(id,{root,version:1,config,getHealth,...c});
 assert.equal(c.runs(),1);assert.equal((await readTask(id,root)).execution.status,'succeeded');
});
test('五页支持及完成文件变动不会静默沿用',async t=>{const {root,id}=await setup(t,5);const c=canvas();await executeCurrent(id,{root,version:1,config,getHealth,...c});assert.equal(c.runs(),5);const task=await readTask(id,root);await writeFile(task.execution.pages[0].image.path,'changed');await assert.rejects(executeCurrent(id,{root,version:1,config,getHealth,...c}));assert.equal(c.runs(),5);});

test('真实共享HTTP连接失败会落盘任务失败状态',async t=>{const {root,id}=await setup(t);await assert.rejects(executeCurrent(id,{root,version:1,config,getHealth:async()=>{throw new Error('controlled health failure');}}));const task=await readTask(id,root);assert.equal(task.execution.status,'failed');assert.equal(task.execution.pages.length,0);});

test('共享HTTP在途提交取消使任务保留未知意图且无重复提交',async t=>{
 const {createServer}=await import('node:http');
 const {root,id}=await setup(t);let nodes=[],runs=0,notify;const submitted=new Promise(r=>notify=r);
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/health'){res.end(JSON.stringify({instanceId:'local-test',targets:[{hasCanvas:true,projectId:'fixture',clientId:'fixture'}]}));return;}
  let body='';for await(const b of req)body+=b;const {name,input}=JSON.parse(body);
  if(name==='canvas_get_state')res.end(JSON.stringify({ok:true,result:{nodes,connections:[]}}));
  else if(name==='canvas_apply_ops'){nodes.push(...input.ops.filter(o=>o.type==='add_node').map(o=>({id:o.id,type:o.nodeType,metadata:o.metadata})));res.end(JSON.stringify({ok:true,result:{}}));}
  else if(name==='canvas_run_generation'){runs++;notify(); /* 可控延迟：保持请求在途，客户端随后取消 */}
  else res.end(JSON.stringify({ok:true,result:{tasks:[]}}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const controller=new AbortController();const local={...config,instanceId:'local-test',token:'test-only',bridgeUrl:`http://127.0.0.1:${server.address().port}`};
 const pending=executeCurrent(id,{root,version:1,config:local,signal:controller.signal});await submitted;controller.abort();await assert.rejects(pending);
 const task=await readTask(id,root);assert.equal(task.execution.status,'cancelled');assert.equal(task.execution.pages[0].status,'uncertain');assert.equal(runs,1);
 await assert.rejects(executeCurrent(id,{root,version:1,config:local}));assert.equal(runs,1);
});

test('修改方案保留未知提交历史并撤销旧确认，实际Agent读图可记录但不能代人批准',async t=>{
 const {setBrief,recordReview,approveFinal}=await import('../src/creative/tasks.mjs');
 const {root,id}=await setup(t);const c=canvas({unknown:true});await assert.rejects(executeCurrent(id,{root,version:1,config,getHealth,...c}));
 const before=await readTask(id,root);await setBrief(id,'新的需求',{root,expectedRevision:before.revision});const task=await readTask(id,root);assert.equal(task.executionHistory[0].pages[0].submitted,true);assert.equal(task.sheetConfirmation,null);assert.equal(task.inputConfirmation,null);
 const second=await setup(t);const complete=canvas();await executeCurrent(second.id,{root:second.root,version:1,config,getHealth,...complete});const done=await readTask(second.id,second.root);
 const reviewed=await recordReview(second.id,{page:1,sha256:done.execution.pages[0].image.sha256,decision:'pass',reviewer:'Codex',notes:'测试夹具，不代表真实读图'},{root:second.root,expectedRevision:done.revision});
 await assert.rejects(approveFinal(second.id,{version:1,images:[{page:1,sha256:done.execution.pages[0].image.sha256}],by:'Codex',note:'模型不能代人确认'},{root:second.root,expectedRevision:reviewed.revision}));
});
