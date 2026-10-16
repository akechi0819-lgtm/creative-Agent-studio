import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {listenStudioServer} from '../src/web/server.mjs';
import {saveConfig,readConfig} from '../src/web/config.mjs';
import {createStudioAgent} from '../adapters/dsh/runtime.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-attachment-chain-'));
const evidence=path.resolve('docs/evidence/p3-chat-entry');await fs.mkdir(evidence,{recursive:true});
const report={date:new Date().toISOString(),scope:'真实Web服务、附件提取与官方DSH，本地模型替身；无真实收费请求',checks:[]};
const requests=[];let browser,app;
const model=createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;
  requests.push(JSON.parse(raw));await new Promise(r=>setTimeout(r,1000));
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const choice of [{delta:{role:'assistant',content:'已收到图片和 PDF，将只参考内容与版式，不引用品牌信息。'},finish_reason:null},{delta:{},finish_reason:'stop'}])res.write('data: '+JSON.stringify({id:'attachment-mock',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,...choice}]})+'\n\n');
  res.end('data: [DONE]\n\n');
});
function pdf(){
  const text='PDF_ATTACHMENT_SENTINEL_CONTENT. This reference describes content structure and poster layout. Do not reuse brand names. This is local software verification content only.';
  const content=`BT /F1 12 Tf 35 750 Td (${text}) Tj ET`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let value='%PDF-1.4\n';const offsets=[0];for(const [i,o] of objects.entries()){offsets.push(Buffer.byteLength(value));value+=`${i+1} 0 obj\n${o}\nendobj\n`;}
  const xref=Buffer.byteLength(value);value+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(value);
}
try{
  await new Promise(r=>model.listen(0,'127.0.0.1',r));
  await saveConfig({expectedRevision:1,base:{baseUrl:`http://127.0.0.1:${model.address().port}/v1`,model:'fixture',apiKey:'isolated-mock-key'}},{root});
  const config=()=>readConfig({root});app=await listenStudioServer({root,agent:createStudioAgent({root,readConfig:config}),readConfig:config,port:0});
  const url=`http://127.0.0.1:${app.address.port}`;
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url,{waitUntil:'networkidle'});await page.getByRole('button',{name:'新建创作',exact:true}).click();
  const dialog=page.getByRole('dialog');
  assert.equal(await dialog.locator('input[type=radio],select').count(),0);
  assert.equal(await dialog.getByLabel('任务名称').count(),0);
  await dialog.locator('input[type=file]').setInputFiles([{name:'layout.png',mimeType:'image/png',buffer:await fs.readFile('adapters/dsh/connection-check.png')},{name:'reference.pdf',mimeType:'application/pdf',buffer:pdf()}]);
  await page.waitForFunction(()=>{const image=document.querySelector('[role=dialog] .chat-attachment-chip img');return image?.complete&&image.naturalWidth>0;});
  report.checks.push('unsent-reference-local-preview-loads-under-csp');
  await page.screenshot({path:path.join(evidence,'new-creation-desktop.png')});
  const instruction='参考这个附件的内容和版式，不要引用品牌信息。';await dialog.getByLabel('你想做什么？',{exact:true}).fill(instruction);
  const uploadedPromise=page.waitForResponse(r=>r.url().endsWith('/attachments')&&r.request().method()==='POST');
  const chatPromise=page.waitForResponse(r=>r.url().endsWith('/chat')&&r.request().method()==='POST');
  const createPromise=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/tasks'&&r.request().method()==='POST');
  await dialog.getByRole('button',{name:'创建并开始沟通',exact:true}).click();
  const created=await(await createPromise).json();
  assert.deepEqual(created.task.brief,{content:instruction});
  await page.locator('.message-row.user').filter({hasText:instruction}).waitFor();report.checks.push('user-message-visible-during-attachment-processing');
  const uploadResponse=await uploadedPromise;assert.equal(uploadResponse.ok(),true);const uploaded=await uploadResponse.json();assert.ok(uploaded.sourceId);assert.equal(uploaded.task.sources.length,1);
  const chatResponse=await chatPromise;assert.equal(chatResponse.ok(),true);const started=await chatResponse.json();
  const deadline=Date.now()+60000;while(Date.now()<deadline){const {job}=await(await fetch(url+'/api/jobs/'+started.job.id)).json();if(job.status==='succeeded')break;if(['failed','cancelled'].includes(job.status))throw new Error(job.error?.code||job.status);await page.waitForTimeout(200);}
  const detail=await(await fetch(url+'/api/tasks/'+created.task.id)).json();assert.equal(detail.job.status,'succeeded');
  const stored=detail.conversation.find(m=>m.role==='user');assert.deepEqual(stored.attachmentSourceIds,[uploaded.sourceId]);
  assert.ok(JSON.stringify(requests).includes('PDF_ATTACHMENT_SENTINEL_CONTENT'),'PDF 原生文本未进入模型');
  assert.ok(requests.some(r=>r.messages.some(m=>Array.isArray(m.content)&&m.content.some(c=>c.type==='image_url'))),'实际图片未进入模型');
  assert.ok(JSON.stringify(requests).includes(instruction));assert.equal(detail.task.sources[0].decision,'pending');
  await page.reload({waitUntil:'networkidle'});await page.getByRole('button',{name:created.task.title,exact:true}).click();
  const message=page.locator('.message-row.user').filter({hasText:instruction});await message.getByText('reference.pdf',{exact:true}).waitFor();
  await page.waitForFunction(()=>{const image=document.querySelector('.message-row.user .message-attachments img');return image?.complete&&image.naturalWidth>0;});
  await page.screenshot({path:path.join(evidence,'first-message.png')});assert.deepEqual(errors,[]);
  report.checks.push('image-and-pdf-upload-through-real-http','pdf-extraction-and-image-enter-official-dsh','instructions-preserved-with-brand-boundary','source-ids-persist-and-previews-load-after-reload','pending-reference-not-auto-retained','no-browser-runtime-errors','creation-without-format-title-or-page-fields');
  await page.getByRole('button',{name:'新建创作',exact:true}).click();
  const textOnly='我要做两张海报，一张介绍课程，一张介绍学习方法。';
  await page.getByRole('dialog').getByLabel('你想做什么？',{exact:true}).fill(textOnly);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(evidence,'new-creation-mobile.png')});
  const secondCreate=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/tasks'&&r.request().method()==='POST');
  await page.getByRole('dialog').getByRole('button',{name:'创建并开始沟通',exact:true}).click();
  const second=await(await secondCreate).json();assert.deepEqual(second.task.brief,{content:textOnly});assert.equal(second.task.sources.length,0);
  await page.locator('.message-row.user').filter({hasText:textOnly}).waitFor();
  report.checks.push('text-only-creation-with-optional-reference-and-no-implicit-page-count');report.status='passed';
}catch(e){report.status='failed';report.error=e.message;process.exitCode=1;}
finally{await browser?.close();await app?.close();model.closeAllConnections();if(model.listening)await new Promise(r=>model.close(r));await fs.rm(root,{recursive:true,force:true});await fs.writeFile(path.join(evidence,'verification.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));
