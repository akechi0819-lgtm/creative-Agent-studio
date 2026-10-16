import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { connection, health, callCanvasTool, recoverImage, root } from '../src/canvas/client.mjs';

const config = await connection();
const evidence=path.join(root,'docs/evidence/p0'); await mkdir(evidence,{recursive:true});
const report={date:new Date().toISOString(),instanceId:config.instanceId,projectId:config.projectId,tests:[],liveGeneration:'not-run'};
let browser;
try {
  const credential=JSON.parse(await readFile(path.join(root,'.p0-state/image-credentials.json'),'utf8'));
  const proxy=process.env.HTTPS_PROXY ? {server:process.env.HTTPS_PROXY,bypass:'127.0.0.1,localhost'} : undefined;
  browser=await chromium.launch({channel:'chrome',headless:true,proxy});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const pageErrors=[];
  const agentRequests=[];
  page.on('pageerror',e=>pageErrors.push(e.message));
  page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/agent/')) agentRequests.push(new URL(r.url()).pathname);});
  await page.addInitScript(({baseUrl,apiKey,model})=>{
    localStorage.setItem('infinite-canvas:ai_config_store',JSON.stringify({state:{config:{
      channels:[{id:'p0',name:'P0 用户授权临时服务',baseUrl,apiKey,apiFormat:'openai',models:[{name:model,capability:'image'}]}],
      model:'p0::'+model,imageModel:'p0::'+model,models:['p0::'+model],proxyEnabled:false,canvasImageCount:'1',count:'1',size:'1:1',quality:'low'
    }},version:0}));
  },credential);
  await page.goto(config.browserUrl,{waitUntil:'domcontentloaded'});
  for(let i=0;i<100;i++){if((await health(config)).hasCanvas)break;await page.waitForTimeout(100);}
  assert.equal((await health(config)).hasCanvas,true,'自动连接独立目标画布');
  report.tests.push('independent-instance-auto-connect'); console.log('Canvas connected');
  const text=await callCanvasTool('canvas_create_text_node',{text:'Creative Agent Studio P0 · Codex direct tool',title:'P0 文本节点',x:0,y:0},config);
  assert.ok(text.nodes.some(n=>n.type==='text'&&n.metadata.content.includes('Codex direct tool')));
  report.tests.push('codex-shared-cli-text-node');
  const invalid=await fetch(config.bridgeUrl+'/api/tools',{method:'POST',headers:{'content-type':'application/json','x-canvas-agent-token':config.token},body:JSON.stringify({name:'canvas_get_state',projectId:'wrong-project',clientId:'wrong-client',input:{}})});
  assert.equal(invalid.status,403);report.tests.push('wrong-project-rejected');
  const unavailable=await fetch(config.bridgeUrl+'/agent/codex/threads/new',{method:'POST',headers:{'content-type':'application/json','x-canvas-agent-token':config.token},body:'{}'});
  assert.equal(unavailable.status,404);report.tests.push('agent-start-route-absent');
  // This flag resumes status only: an unknown or pending paid request is never automatically replayed.
  let nodeId;
  const existing=await readFile(path.join(root,'.p0-state/pending-generation.json'),'utf8').then(JSON.parse).catch(()=>null);
  if(!process.argv.includes('--new-generation')) {
    if(!existing || existing.instanceId!==config.instanceId) throw new Error('没有属于当前实例的生成记录；显式传 --new-generation 才会提交一张新的收费测试图');
    const state=await callCanvasTool('canvas_get_state',{},config);
    if(!state.nodes.some(n=>n.id===existing.nodeId)) throw new Error('当前编辑页没有已记录节点，状态无法确认；停止以避免重放收费请求');
    nodeId=existing.nodeId;console.log('Resume existing generation status');
  } else {
    const flow=await callCanvasTool('canvas_create_image_prompt_flow',{prompt:'Create a square editorial illustration of a serene mountain lake at sunrise, refined teal and warm orange palette, geometric paper cut art, no text, no logos. This is a technical image generation test.',title:'P0 GPT Image 2',model:'p0::'+credential.model,count:1,size:'1:1',quality:'low',x:400,y:0},config);
    nodeId=flow.nodes.filter(n=>n.type==='config').at(-1).id;
    await writeFile(path.join(root,'.p0-state/pending-generation.json'),JSON.stringify({instanceId:config.instanceId,nodeId}));
    await callCanvasTool('canvas_run_generation',{nodeId,mode:'image'},config);
    console.log('One authorized GPT Image 2 request submitted; checking completion');
  }
  report.generationNodeId=nodeId;
  let image,previous;
  for(let i=0;i<360;i++) {
    const state=await callCanvasTool('canvas_get_state',{},config);
    const outputs=new Set(state.connections.filter(e=>e.fromNodeId===nodeId).map(e=>e.toNodeId));
    image=state.nodes.find(n=>outputs.has(n.id)&&n.type==='image'&&n.metadata.status==='success');
    const status=await callCanvasTool('generation_get_status',{scope:'canvas',nodeIds:[nodeId]},config);
    const task=status.tasks.find(t=>t.id===nodeId);
    if(task?.status!==previous){console.log('Generation status:',task?.status||'unknown');previous=task?.status;}
    if(image) break;
    if(task?.status==='failed') throw new Error('真实生成失败：'+task.error);
    await page.waitForTimeout(2000);
  }
  if(!image)throw new Error('生图状态未完成；保留节点与请求记录，禁止自动重放');
  const imagePath=path.join(evidence,'gpt-image-2.png');
  report.image=await recoverImage(image.id,imagePath,config);
  report.image.sha256=createHash('sha256').update(await readFile(imagePath)).digest('hex');
  report.liveGeneration='succeeded';report.tests.push('real-gpt-image-2-status-file-recovery');
  console.log('Real image recovered:',report.image.bytes,'bytes');
  await callCanvasTool('canvas_set_viewport',{viewport:{x:30,y:140,k:0.58}},config);
  await page.waitForTimeout(500);
  await page.screenshot({path:path.join(evidence,'canvas.png')});
  assert.deepEqual(agentRequests,[]);assert.deepEqual(pageErrors,[]);
  report.tests.push('no-agent-browser-requests','no-browser-runtime-errors');
  report.processes=spawnSync('ps',['-Ao','pid,ppid,comm'],{encoding:'utf8'}).stdout.split('\n').filter(line=>line.trim().split(/\s+/)[0]===String(config.pid)||line.trim().split(/\s+/)[1]===String(config.pid));
  await page.reload({waitUntil:'domcontentloaded'});
  // Reconnect credentials are kept in memory in the drawing tab, so reopen the local bootstrap after reload.
  await page.goto(config.browserUrl,{waitUntil:'domcontentloaded'});
  for(let i=0;i<100;i++){if((await health(config)).hasCanvas)break;await page.waitForTimeout(100);}
  const restored=await callCanvasTool('canvas_get_state',{},config);assert.ok(restored.nodes.some(n=>n.id===image.id));report.tests.push('browser-reload-persistence');
  await writeFile(path.join(evidence,'canvas-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.tests,liveGeneration:report.liveGeneration,image:report.image},null,2));
} catch(error) {
  report.error=String(error.message).replace(/sk-[\w-]+/g,'[redacted]').replace(config.token,'[redacted]');
  await writeFile(path.join(evidence,'canvas-report.json'),JSON.stringify(report,null,2));console.error(report.error);process.exitCode=1;
} finally {await browser?.close();}
