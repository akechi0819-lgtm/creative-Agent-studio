// P1 真实 CLI 验收。仅 --new-authorized-four 可创建收费任务；恢复只查询已保存节点。
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root, connection, health, callCanvasTool } from '../src/canvas/client.mjs';
const stateRoot=path.join(root,'.p0-state/p1/runtime');
const stateFile=path.join(root,'.p0-state/p1/tasks.json');
const evidence=path.join(root,'docs/evidence/p1');
process.env.STUDIO_DATA_DIR=stateRoot;process.env.STUDIO_PROJECT_ID='studio-p1-acceptance';
await mkdir(evidence,{recursive:true});await mkdir(path.dirname(stateFile),{recursive:true});
let browser,config,owned=false;
const report={date:new Date().toISOString(),scope:'P1 Codex shared CLI; no DSH',tasks:[],agentRequests:[],pageErrors:[],cleanup:{}};
async function cli(action,id,payload){
 const args=[path.join(root,'scripts/studio.mjs'),action];if(id)args.push(id);
 if(payload!==undefined){const file=path.join(root,'.p0-state/p1/cli-input.json');await writeFile(file,JSON.stringify(payload),{mode:0o600});args.push('@'+file);}
 return new Promise((resolve,reject)=>{const p=spawn(process.execPath,args,{env:process.env,cwd:root,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('close',code=>{if(code!==0)return reject(new Error(`CLI ${action} 失败：${err.trim()}`));try{resolve(JSON.parse(out));}catch{reject(new Error('CLI 结果不是 JSON'));}});});
}
function matchesExpectedBrief(actual,expected){
 return Boolean(actual&&typeof actual==='object'&&!Array.isArray(actual)
  &&Object.keys(actual).length===3
  &&actual.topic===expected.topic
  &&actual.audience===expected.audience
  &&actual.requirements===expected.requirements);
}
function matchesExpectedSheet(task,spec){
 const record=task.sheets?.find(entry=>entry.version===1);
 return Boolean(record
  &&record.title===spec.title
  &&Array.isArray(record.sourceIds)&&record.sourceIds.length===0
  &&Array.isArray(record.pages)&&record.pages.length===spec.pages.length
  &&record.pages.every((page,index)=>{
   const expected=spec.pages[index];
   return page.page===expected.page&&page.copy===expected.copy&&page.prompt===expected.prompt&&page.size===expected.size
    &&Array.isArray(page.sourceIds)&&page.sourceIds.length===0;
  }));
}
try {
 const start=spawnSync(process.execPath,[path.join(root,'scripts/canvas.mjs'),'start'],{env:process.env,encoding:'utf8',timeout:20000});
 if(start.status!==0)throw new Error('验收实例未能启动；已有实例时拒绝接管');owned=true;config=await connection();
 const credentials=JSON.parse(await readFile(path.join(root,'.p0-state/image-credentials.json'),'utf8'));
 const proxy=process.env.HTTPS_PROXY?{server:process.env.HTTPS_PROXY,bypass:'127.0.0.1,localhost'}:undefined;
 browser=await chromium.launchPersistentContext(path.join(stateRoot,'acceptance-browser'),{channel:'chrome',headless:true,proxy,viewport:{width:1440,height:1000}});
 const page=browser.pages()[0]||await browser.newPage();
 page.on('pageerror',()=>report.pageErrors.push('browser runtime error'));
 page.on('request',r=>{try{const u=new URL(r.url());if(u.pathname.startsWith('/agent/'))report.agentRequests.push(u.pathname);}catch{}});
 await page.addInitScript(({baseUrl,apiKey,model})=>localStorage.setItem('infinite-canvas:ai_config_store',JSON.stringify({state:{config:{channels:[{id:'p1',name:'用户授权临时生图服务',baseUrl,apiKey,apiFormat:'openai',models:[{name:model,capability:'image'}]}],model:'p1::'+model,imageModel:'p1::'+model,models:['p1::'+model],proxyEnabled:false,canvasImageCount:'1',count:'1',size:'3:4',quality:'low'}},version:0})),credentials);
 await page.goto(config.browserUrl,{waitUntil:'domcontentloaded'});
 for(let i=0;i<120;i++){if((await health(config)).hasCanvas)break;await page.waitForTimeout(100);}
 assert.equal((await health(config)).hasCanvas,true);
 let state=await readFile(stateFile,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 if(!state)state={tasks:[]};
 if(state.tasks.length!==2||state.tasks.some(t=>!t.prepared)){
  if(!process.argv.includes('--new-authorized-four'))throw new Error('任务准备未完成；必须显式核对本线程已授权四张');
  for(const type of ['poster','multipage']){
   const bytes=await readFile(path.join(evidence,'specs',type+'.json'));const sheet=JSON.parse(bytes);
   const sha=createHash('sha256').update(bytes).digest('hex');
   const brief={topic:sheet.title,audience:'P1 内部验收',requirements:'无外部参考；米白、深蓝、橙色；逐页准确中文；'+sheet.pages.map(p=>p.copy).join(' / ')};
   let item=state.tasks.find(t=>t.type===type);let task;
   if(item){if(item.specSha256!==sha)throw new Error('制作单已变，原人工确认失效');task=await cli('show',item.id);}
   else {
    task=await cli('create',null,{title:sheet.title,brief});
    item={type,id:task.id,specSha256:sha,prepared:false};state.tasks.push(item);await writeFile(stateFile,JSON.stringify(state),{mode:0o600});
   }
   if(item.prepared)continue;
   if(!matchesExpectedBrief(task.brief,brief)||!Array.isArray(task.sources)||task.sources.length!==0)throw new Error('既有任务需求或来源与当前验收制作单不一致，拒绝继续确认');
   if(task.execution.pages.length)throw new Error('已有执行记录，不能自动重新准备制作单');
   if(!task.inputConfirmation)task=await cli('confirm-inputs',task.id,{revision:task.revision,by:'用户',note:'本线程用户明确确认两份需求及无外部参考来源选择；问题回复：确认两份需求与制作单，生成四张'});
   if(task.sheetVersion===0)task=await cli('set-sheet',task.id,{sheet,expectedRevision:task.revision,inputRevision:task.inputConfirmation.revision});
   if(task.sheetVersion!==1||!matchesExpectedSheet(task,sheet)||task.sheetInputsRevision!==task.inputConfirmation?.revision)throw new Error('任务制作单与当前验收制作单或输入确认版本不一致，不能沿用v1确认');
   if(!task.sheetConfirmation)task=await cli('confirm-sheet',task.id,{version:1,by:'用户',note:'本线程用户确认已展示制作单v1，共四张 GPT Image 2 验收图',expectedRevision:task.revision});
   item.prepared=true;await writeFile(stateFile,JSON.stringify(state),{mode:0o600});
  }
 }
 if(state.tasks.length!==2||state.tasks.some(t=>!t.prepared))throw new Error('任务准备未完成，人工核对后再继续，不能自动重建');
 for(const item of state.tasks){
  let task=await cli('show',item.id);
  if(process.argv.includes('--inspect')){
   for(const p of task.execution.pages){
    const status=await callCanvasTool('generation_get_status',{scope:'canvas',nodeIds:[p.nodeId]},config);
    console.log(JSON.stringify({type:item.type,page:p.page,status:status.tasks?.map(t=>({id:t.id,status:t.status,errorCategory:['401','403','429','500','502','503','timeout','network','quota'].find(s=>String(t.error||'').toLowerCase().includes(s))||'other-or-none'}))}));
   }
   continue;
  }
  console.log(JSON.stringify({stage:'execute',type:item.type,taskId:item.id}));
  task=await cli(process.argv.includes('--retry-known-failed-2')&&item.type==='multipage'?'resume':'execute',item.id,{version:1,expectedRevision:task.revision,model:'p1::'+credentials.model,...(process.argv.includes('--retry-known-failed-2')&&item.type==='multipage'?{retryPage:2}:{})});
  task=await cli('show',item.id);const images=[];
  for(const p of task.execution.pages){const relative=`${item.type}-page-${p.page}.png`;await copyFile(p.image.path,path.join(evidence,relative));images.push({page:p.page,path:relative,sha256:p.image.sha256,width:p.image.width,height:p.image.height});}
  report.tasks.push({type:item.type,id:item.id,version:1,status:task.execution.status,images});
  await writeFile(path.join(evidence,process.argv.includes('--inspect')?'inspection-report.json':'live-report.json'),JSON.stringify(report,null,2));
 }
 await page.screenshot({path:path.join(evidence,'canvas.png')});
 assert.deepEqual(report.agentRequests,[]);assert.deepEqual(report.pageErrors,[]);
 report.processes=spawnSync('ps',['-Ao','pid,ppid,comm'],{encoding:'utf8'}).stdout.split('\n').filter(line=>line.trim().split(/\s+/)[0]===String(config.pid)||line.trim().split(/\s+/)[1]===String(config.pid));
 report.result=process.argv.includes('--inspect')?'inspected-without-generation':'generated-awaiting-actual-review-and-human-final-approval';
} catch(error){report.result='failed-or-uncertain';report.error='真实CLI验收未完成；已持久任务须查询原节点，禁止盲目重放';process.exitCode=1;console.error(report.error);}
finally{
 await browser?.close();report.cleanup.browserClosed=true;
 if(owned){const current=await connection();assert.equal(current.instanceId,config.instanceId);const stop=spawnSync(process.execPath,[path.join(root,'scripts/canvas.mjs'),'stop'],{env:process.env,encoding:'utf8',timeout:20000});report.cleanup.stopRequested=stop.status===0;}
 await writeFile(path.join(evidence,process.argv.includes('--inspect')?'inspection-report.json':'live-report.json'),JSON.stringify(report,null,2));
}
