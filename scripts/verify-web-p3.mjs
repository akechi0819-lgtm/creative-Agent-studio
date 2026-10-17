import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {unzipSync} from 'fflate';
import {listenStudioServer} from '../src/web/server.mjs';
import {saveConfig,readConfig} from '../src/web/config.mjs';
import {createStudioAgent} from '../adapters/dsh/runtime.mjs';
import {createCanvasManager} from '../src/web/canvas.mjs';

const repo=path.resolve(import.meta.dirname,'..');
const live=process.argv.includes('--live');
if(process.argv.includes('--gui'))throw new Error('--gui 是已废弃的旧版 Workbench 回归路径；请运行默认 mock 链路。');
const evidence=path.join(repo,'docs/evidence/p3');
await mkdir(evidence,{recursive:true});
const root=await mkdtemp(path.join(os.tmpdir(),'studio-p3-chain-'));
const report={date:new Date().toISOString(),scope:live?'真实模型及真实生图的隔离 Web/DSH/Canvas 创作链路':'真实 Web/DSH/Canvas 与本地可控模型服务的隔离链路',live,checks:[],tasks:[]};
const picture=await readFile(path.join(repo,'adapters/dsh/connection-check.png'));
let imageRequests=0;
const mock=createServer(async(req,res)=>{
 res.setHeader('access-control-allow-origin','*');
 res.setHeader('access-control-allow-headers','authorization,content-type');
 res.setHeader('access-control-allow-methods','GET,POST,OPTIONS');
 if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
 if(req.url.endsWith('/models')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'mock-image'},{id:'mock-base'}]}));return;}
 let input='';for await(const chunk of req)input+=chunk;
 const body=input?JSON.parse(input):{};
 if(req.url.endsWith('/images/generations')){imageRequests++;res.setHeader('content-type','application/json');res.end(JSON.stringify({created:1,data:[{b64_json:picture.toString('base64')}]}));return;}
 if(!body.stream){res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({summary:'隔离测试资料：阅读、简洁排版。',tags:['阅读','测试']})}}]}));return;}
 const tools=body.tools||[];
 const toolNames=tools.map(t=>t.function.name);
 const last=body.messages.at(-1);
 const text=typeof last?.content==='string'?last.content:(last?.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
 let name,args,answer='隔离测试：已处理当前需求，请人工检查。';
 if(last?.role!=='tool'){
   if(toolNames.includes('studio_connection_probe')){name='studio_connection_probe';args={colors:'绿色背景，红色方块'};}
   else if(toolNames.includes('studio_record_image_review')){name='studio_record_image_review';args={payload:JSON.stringify({decision:'pass',notes:{文字:'本地模型替身：固定色块夹具，无实际业务文案断言',可读性:'夹具可见',一致性:'绿底红块',主题:'隔离链路测试',修改位置:'无；非真实模型质量验收'}})};}
   else if(/制作单|VERIFY_P3_SHEET/.test(text)&&toolNames.includes('studio_write_sheet')){
     const n=Number(text.match(/VERIFY_P3_SHEET:(\d+)/)?.[1]||1);
     name='studio_write_sheet';args={payload:JSON.stringify({title:'春日阅读指南',sourceIds:[],pages:Array.from({length:n},(_,i)=>({page:i+1,copy:`阅读 ${i+1}`,prompt:'暖白背景，墨绿色简洁书本图案，清晰大字；本图用于软件链路验收。',size:'3:4',sourceIds:[]}))})};
   }else if(!tools.length)answer='表达语气：简洁\n视觉与品牌偏好：暖白与墨绿\n常用内容要求：\n必须出现的元素：\n避免出现的元素：\n其他偏好：';
 }
 const delta=name?{tool_calls:[{index:0,id:'call-'+Date.now(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{content:answer};
 res.writeHead(200,{'content-type':'text/event-stream'});
 for(const data of [{delta:{role:'assistant',...delta},finish_reason:null},{delta:{},finish_reason:name?'tool_calls':'stop'}])res.write('data: '+JSON.stringify({id:'mock-'+Date.now(),object:'chat.completion.chunk',created:1,model:'mock-base',choices:[{index:0,...data}]})+'\n\n');
 res.end('data: [DONE]\n\n');
});
await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
const mockUrl=`http://127.0.0.1:${mock.address().port}/v1`;
await saveConfig({expectedRevision:1,base:{baseUrl:mockUrl,model:'mock-base',apiKey:'test-key'},image:{baseUrl:mockUrl,model:'mock-image',apiKey:'test-key'}},{root});
let config=()=>readConfig({root});
if(live){
 const basic=JSON.parse(await readFile(path.join(repo,'.p0-state/model-credentials.json'),'utf8'));
 const image=JSON.parse(await readFile(path.join(repo,'.p0-state/image-credentials.json'),'utf8'));
 if(image.model!=='gpt-image-2')throw new Error('Live verification requires explicitly authorized gpt-image-2 route');
 config=async()=>({basic:{baseUrl:basic.baseUrl,model:basic.model,apiKey:basic.apiKey},image:{baseUrl:image.baseUrl,model:image.model,apiKey:image.apiKey}});
 report.requestedModels={basic:basic.model,image:image.model};
}
const canvas=createCanvasManager({root,readConfig:config});
const agent=createStudioAgent({root,readConfig:config});
const app=await listenStudioServer({root,agent,canvas,readConfig:config,port:0});
const url=`http://127.0.0.1:${app.address.port}`;
let browser,context,page;
const errors=[];
async function request(endpoint,value,method=value===undefined?'GET':'POST'){
 if(endpoint.endsWith('/chat')&&value&&!(value instanceof FormData)&&!value.requestId)value={...value,requestId:globalThis.crypto.randomUUID()};
 const response=await fetch(url+endpoint,{method,headers:{origin:url,...(value instanceof FormData?{}:{'content-type':'application/json'})},...(value===undefined?{}:{body:value instanceof FormData?value:JSON.stringify(value)})});
 const body=await response.json();
 if(!response.ok)throw new Error(`${endpoint}: ${body.error?.code} ${body.error?.message}`);
 return body;
}
async function job(value){
 const id=value.job.id;let previous;
 const deadline=Date.now()+(live?1200000:120000);
 while(Date.now()<deadline){
   const {job:current}=await request('/api/jobs/'+id);
   if(current.status!==previous){console.log(current.kind+': '+current.status);previous=current.status;}
   if(current.status==='succeeded')return current;
   if(['failed','cancelled'].includes(current.status))throw new Error(current.kind+': '+(current.error?.message||current.status));
   await new Promise(resolve=>setTimeout(resolve,live?1500:100));
 }throw new Error('Job still pending; do not replay paid generation');
}
async function current(id){return (await request('/api/tasks/'+id)).task;}
async function action(task,name,payload){const result=await request(`/api/tasks/${task.id}/${name}`,{expectedRevision:task.revision,...payload});return result.job?(await job(result),current(task.id)):result.task;}
try{
 const proxy=process.env.HTTPS_PROXY?{server:process.env.HTTPS_PROXY,bypass:'127.0.0.1,localhost'}:undefined;
 browser=await chromium.launch({channel:'chrome',headless:true,proxy});
 context=await browser.newContext({viewport:{width:1440,height:1000}});
 page=await context.newPage();
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(url,{waitUntil:'networkidle'});
 await page.screenshot({path:path.join(evidence,live?'live-empty.png':'web-empty.png')});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);report.checks.push('empty-web-view');
 const bootstrap=await request('/api/bootstrap');assert.equal(bootstrap.dna.enabled,false);
 if(!live){
   const form=new FormData();form.set('title','隔离参考');form.set('body','阅读资料，仅测试软件。');form.append('files',new Blob(['阅读资料'],{type:'text/plain'}),'reference.txt');
   let asset=(await request('/api/assets',form)).asset;
   await job(await request(`/api/assets/${asset.id}/clean`,{expectedRevision:asset.revision}));
   asset=(await request('/api/assets/'+asset.id)).asset;assert.equal(asset.status,'needs_review');
   asset=(await request('/api/assets/'+asset.id,{expectedRevision:asset.revision,summary:'人工校正后的摘要',tags:['人工标签']},'PUT')).asset;
   asset=(await request(`/api/assets/${asset.id}/confirm`,{expectedRevision:asset.revision,by:'测试用户',note:'隔离流程测试确认'})).asset;
   assert.equal(asset.status,'confirmed');report.checks.push('library-upload-clean-edit-confirm-search');
   const organized=await request('/api/dna/organize',{text:'简洁，暖白和墨绿。'});
   const draft=organized.job?(await job(organized)).result.draft:organized.draft;
   assert.ok(draft?.content);assert.equal((await request('/api/dna')).profile.enabled,false);
   await request('/api/dna',{expectedRevision:bootstrap.dna.revision,enabled:true,content:draft.content,by:'测试用户',note:'隔离DNA显式启用测试'});
   report.checks.push('dna-organize-does-not-save-explicit-enable');
 }
 for(const count of [1,3,5]){
   let task=(await request('/api/tasks',{title:`P3 ${count}页链路验收`,brief:{content:`为亲子家庭制作${count}页春日阅读图文，目标是介绍每天读书的小习惯；每页只出现“阅读 1”等按页码排列的标题，文字少、字大、暖白墨绿配色、简洁书本图案，不要二维码、品牌商标或其他文案。所有资料仅为软件验收虚构样例，不涉及价格、招生或现行政策；本次已明确不使用参考。`,audience:'亲子家庭',goal:'阅读习惯科普',style:'暖白、墨绿、书本图案、清晰大字',size:'3:4',pageCount:count,format:count===1?'poster':'carousel'}})).task;
   await job(await request(`/api/tasks/${task.id}/chat`,{text:'请核对当前需求并简短回复，先不要改变它或确认。',expectedRevision:task.revision}));task=await current(task.id);
   task=await action(task,'confirm-inputs',{revision:task.revision,by:'测试用户',note:'用户授权P3完整链路测试：确认隔离测试需求与空参考'});
   const draftText=live?`请根据当前已确认需求调用studio_write_sheet，创建恰好${count}页制作单。每页仅有一个准确大字标题“阅读 ${count===1?'1':'页码'}”，具体按页码用阅读 1、阅读 2等。暖白底色和墨绿书本，不使用细字，尺寸3:4，sourceIds为空。不要代确认。`:`VERIFY_P3_SHEET:${count} 请整理制作单，不代确认。`;
   await job(await request(`/api/tasks/${task.id}/chat`,{text:draftText,expectedRevision:task.revision}));task=await current(task.id);
   if(!task.sheets.length){const detail=await request('/api/tasks/'+task.id);report.lastAssistant=detail.conversation.filter(x=>x.role==='assistant').at(-1)?.text;throw new Error('Agent没有保存制作单：'+(report.lastAssistant||'无可显示结果'));}
   assert.equal(task.sheets.at(-1).pages.length,count);
   // Inspect the compact Workbench: the plan and output remain in one preview panel.
   await page.reload({waitUntil:'networkidle'});
   const taskButton=page.getByRole('button',{name:`P3 ${count}页链路验收`,exact:true});
   await taskButton.waitFor({state:'visible'});await taskButton.click();
   const heading=page.getByRole('heading',{name:`P3 ${count}页链路验收`,exact:true});
   await heading.waitFor({state:'visible'});await page.locator('.object-panel').waitFor({state:'visible'});
   await page.screenshot({path:path.join(evidence,`${live?'live':'web'}-workbench-plan-${count}.png`)});
   const opened=await request(`/api/tasks/${task.id}/canvas/open`,{});
   const drawing=await context.newPage();await drawing.goto(opened.openUrl,{waitUntil:'domcontentloaded'});
   const deadline=Date.now()+30000;let clientConnected=opened.clientConnected;
   while(Date.now()<deadline&&!clientConnected){await drawing.waitForTimeout(200);clientConnected=(await request(`/api/tasks/${task.id}/canvas/open`,{})).clientConnected;}
   assert.equal(clientConnected,true,'Canvas should connect before confirming the current plan');
   task=await action(task,'confirm-and-execute',{version:task.sheetVersion,note:'隔离 mock 链路：确认当前方案并开始绘图'});
   assert.equal(task.sheetConfirmation?.version,task.sheetVersion);
   assert.equal(task.execution.status,'succeeded');assert.equal(task.execution.pages.length,count);
   await page.reload({waitUntil:'networkidle'});await page.getByRole('button',{name:`P3 ${count}页链路验收`,exact:true}).click();
   await page.getByRole('button',{name:'确认交付并下载',exact:true}).waitFor({state:'visible'});
   await page.screenshot({path:path.join(evidence,`${live?'live':'web'}-workbench-ready-${count}.png`)});
   const images=task.execution.pages.map(p=>({page:p.page,sha256:p.image.sha256}));
   const exported=await request(`/api/tasks/${task.id}/approve-and-export`,{expectedRevision:task.revision,version:task.sheetVersion,images});
   task=exported.task;
   assert.equal(task.finalApproval?.version,task.sheetVersion);
   assert.equal(task.exports.length,1);
   const downloadUrl=exported.export?.downloadUrl;
   assert.ok(downloadUrl,'整套交付操作应返回素材包下载地址');
   const archiveResponse=await fetch(url+downloadUrl);assert.equal(archiveResponse.status,200);
   const zip=Buffer.from(await archiveResponse.arrayBuffer());
   const entries=unzipSync(zip);const manifest=JSON.parse(Buffer.from(entries['manifest.json']).toString());
   assert.equal(manifest.images.length,count);
   for(const img of manifest.images)assert.equal(createHash('sha256').update(entries[img.path]).digest('hex'),img.sha256);
   if(live)for(const record of task.execution.pages){const bytes=Buffer.from(await (await fetch(url+record.image.imageUrl)).arrayBuffer());await writeFile(path.join(evidence,`live-${count}-page-${record.page}.png`),bytes);}
   await page.reload({waitUntil:'networkidle'});await page.getByRole('button',{name:`P3 ${count}页链路验收`,exact:true}).click();
   await page.getByRole('link',{name:'下载素材包',exact:true}).waitFor({state:'visible'});
   await page.screenshot({path:path.join(evidence,`${live?'live':'web'}-workbench-delivered-${count}.png`)});
   report.tasks.push({pages:count,status:'passed',sheetVersion:task.sheetVersion,images:task.execution.pages.map(p=>({page:p.page,sha256:p.image.sha256})),archiveSha256:createHash('sha256').update(zip).digest('hex'),archiveFiles:Object.keys(entries).length});
   await drawing.close();
 }
 if(!live)assert.equal(imageRequests,9,'the 1/3/5-page mock chain should generate exactly nine fixture images');
 assert.deepEqual(errors,[]);report.checks.push('no-browser-runtime-errors','1-3-5-page-full-chain-and-zip-hashes');
 report.imageRequests=live?'真实Canvas图像请求，逐页制品为证':imageRequests;
 report.status='passed';
}catch(error){if(page){await page.screenshot({path:path.join(evidence,live?'live-failure.png':'web-failure.png')}).catch(()=>{});report.browserErrors=errors;report.failureView=(await page.locator('body').innerText().catch(()=>'' )).slice(0,8000);}report.status='failed';report.error=String(error.message).replace(/https?:\/\/[^\s]+/g,'[local/service URL]');console.error(report.error);process.exitCode=1;
}finally{
 await writeFile(path.join(evidence,live?'live-chain.json':'web-chain.json'),JSON.stringify(report,null,2));
 await context?.close();await browser?.close();await app.close();mock.closeAllConnections();await new Promise(resolve=>mock.close(resolve));
 await rm(root,{recursive:true,force:true});
}
console.log(JSON.stringify({status:report.status,live,checks:report.checks,tasks:report.tasks.length}));
