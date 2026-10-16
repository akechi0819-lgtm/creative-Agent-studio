import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {listenStudioServer} from '../src/web/server.mjs';
import {saveConfig} from '../src/web/config.mjs';
import {readTask,setSheet} from '../src/creative/tasks.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-reference-continue-'));
const evidence=path.resolve('docs/evidence/p3-reference-continue');await fs.mkdir(evidence,{recursive:true});
const report={date:new Date().toISOString(),checks:[],scope:'实际Web服务、隔离任务与本地Agent替身；无收费请求'};
let app,browser,calls=0;
try{
 await saveConfig({expectedRevision:1,base:{baseUrl:'http://127.0.0.1:9/v1',model:'fixture',apiKey:'isolated-reference-stub'}},{root});
 app=await listenStudioServer({root,port:0,agent:{chat:async({taskId,expectedRevision,model})=>{
  calls++;assert.equal(model,'fixture');const task=await readTask(taskId,root);
  assert.ok(task.inputConfirmation);assert.equal(task.revision,expectedRevision);
  assert.deepEqual(task.sources.map(s=>s.decision),['retained','excluded']);
  await setSheet(taskId,{title:'参考确认后的制作单',sourceIds:[task.sources[0].id],pages:[{page:1,copy:'隔离测试文案',prompt:'仅供软件验证的版式',size:'3:4',sourceIds:[task.sources[0].id]}]},{root,expectedRevision,inputRevision:task.inputConfirmation.revision});
  return {text:'已整理制作单，请检查后确认。'};
 }}});
 const url=`http://127.0.0.1:${app.address.port}`;
 async function post(route,body){const r=await fetch(url+route,{method:'POST',headers:{origin:url,'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok);return r.json();}
 async function fixture(title){const {task}=await post('/api/tasks',{title,brief:{content:'面向家长制作学习海报'}});const result=await post(`/api/tasks/${task.id}/references`,{expectedRevision:task.revision,items:['retained','pending'].map((decision,i)=>({kind:'external',id:randomUUID(),title:`隔离参考${i+1}`,body:'仅供结构参考',purpose:'借鉴结构',factBoundary:'不引用品牌和事实',decision}))});return result.task;}
 const task=await fixture('确认后自动继续测试');
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));let dialogs=0;
 page.on('dialog',async dialog=>{dialogs++;assert.match(dialog.message(),/其余 1 项未选择素材将排除/u);await dialog.accept();});
 await page.goto(url,{waitUntil:'networkidle'});await page.getByRole('button',{name:task.title,exact:true}).click();
 await page.getByRole('button',{name:'确认素材并继续',exact:true}).click();
 await page.getByRole('tab',{name:'制作单',exact:true}).waitFor();
 await page.waitForFunction(()=>document.querySelector('#tab-sheet')?.getAttribute('aria-selected')==='true');
 const current=await readTask(task.id,root);assert.equal(calls,1);assert.equal(dialogs,1);assert.ok(current.inputConfirmation);assert.equal(current.sheets.length,1);assert.equal(current.sheetConfirmation,null);
 await page.screenshot({path:path.join(evidence,'confirmed-and-sheet.png')});
 report.checks.push('one-confirmation-excludes-unselected-confirms-current-revision-and-starts-chat-once','agent-sees-confirmed-retained-source-and-selected-model','new-sheet-opens-automatically-without-confirming-or-drawing');
 const conflict=await fixture('确认冲突不继续测试');await page.reload({waitUntil:'networkidle'});await page.getByRole('button',{name:conflict.title,exact:true}).click();
 await page.route(`**/api/tasks/${conflict.id}/confirm-inputs`,route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'ERR_TASK_REVISION_CONFLICT',message:'隔离版本冲突'}})}));
 await page.getByRole('button',{name:'确认素材并继续',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'隔离版本冲突'}).waitFor();assert.equal(calls,1);assert.equal((await readTask(conflict.id,root)).inputConfirmation,null);
 report.checks.push('confirmation-conflict-does-not-send-chat-or-pretend-success');assert.deepEqual(errors,[]);report.status='passed';
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;}
finally{await browser?.close();await app?.close();await fs.rm(root,{recursive:true,force:true});await fs.writeFile(path.join(evidence,'verification.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));
