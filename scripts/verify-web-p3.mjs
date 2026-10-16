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
const gui=process.argv.includes('--gui');
if(gui&&live)throw new Error('--gui uses the isolated mock model path and cannot be combined with --live');
const evidence=path.join(repo,'docs/evidence/p3');
await mkdir(evidence,{recursive:true});
const layoutEvidence=path.join(repo,'docs/evidence/p3-interaction');
if(gui)await mkdir(layoutEvidence,{recursive:true});
const root=await mkdtemp(path.join(os.tmpdir(),'studio-p3-chain-'));
const report={date:new Date().toISOString(),scope:gui?'本地模拟模型服务下由浏览器按钮驱动的 Web/DSH/Canvas 单页链路':live?'真实模型及真实生图的隔离 Web/DSH/Canvas 创作链路':'真实 Web/DSH/Canvas 与本地可控模型服务的隔离链路',live,gui,checks:[],tasks:[]};
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
let browser,page;
const errors=[];
let layoutReport=null;
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
async function detail(id){return request('/api/tasks/'+id);}
async function action(task,name,payload){const result=await request(`/api/tasks/${task.id}/${name}`,{expectedRevision:task.revision,...payload});return result.job?(await job(result),current(task.id)):result.task;}
async function waitForGuiJob(taskId,kind,timeout=120000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){
   const value=await detail(taskId);const currentJob=value.job;
   if(currentJob?.kind===kind&&['succeeded','failed','cancelled'].includes(currentJob.status)){
     if(currentJob.status!=='succeeded')throw new Error(`GUI ${kind} Job ${currentJob.status}: ${currentJob.error?.message||''}`);
     return value;
   }
   await new Promise(resolve=>setTimeout(resolve,120));
 }
 throw new Error(`等待 GUI ${kind} 操作超时`);
}
async function waitForGuiTask(taskId,predicate,label,timeout=120000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){const value=await detail(taskId);if(predicate(value.task,value))return value;await new Promise(resolve=>setTimeout(resolve,120));}
 throw new Error(`等待 GUI ${label} 超时`);
}
async function assertConfirmationFieldsRemoved(labels=['确认人','确认说明']){
 for(const label of labels)assert.equal(await page.getByLabel(label,{exact:true}).count(),0,`${label} 输入应已移除`);
}
try{
 const proxy=process.env.HTTPS_PROXY?{server:process.env.HTTPS_PROXY,bypass:'127.0.0.1,localhost'}:undefined;
 browser=await chromium.launch({channel:'chrome',headless:true,proxy});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 page=await context.newPage();
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(url,{waitUntil:'networkidle'});
 await page.screenshot({path:path.join(evidence,gui?'gui-empty.png':live?'live-empty.png':'web-empty.png')});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);report.checks.push('empty-web-view');
 if(gui){
   const guiRequests=[];
   page.on('request',request=>{
     const pathname=new URL(request.url()).pathname;
     if(!pathname.startsWith('/api/'))return;
     const normalized=pathname.replace(/^\/api\/tasks\/[^/]+/,'/api/tasks/:id').replace(/^\/api\/jobs\/[^/]+/,'/api/jobs/:id');
     guiRequests.push(`${request.method()} ${normalized}`);
   });
   const brief='为亲子家庭制作一页春日阅读指南，突出每天读书的小习惯；暖白和墨绿，简洁书本图案，标题清晰易读。测试内容为虚构软件验收资料。';
   const title=brief.slice(0,30);
   await page.locator('.create-button').click();
   const dialog=page.getByRole('dialog');
   await dialog.getByLabel('你想做什么？').fill(brief);
   const firstChatResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/chat'));
   await dialog.getByRole('button',{name:'创建并开始沟通'}).click();
   const firstChat=await (await firstChatResponse).json();
   assert.ok(firstChat.job?.id,'新建创作应经由界面启动 Agent 对话');
   await job(firstChat);
   let taskId;
   const findDeadline=Date.now()+15000;
   while(Date.now()<findDeadline){const list=await request('/api/bootstrap');const found=list.tasks.find(item=>item.title===title);if(found){taskId=found.id;break;}await new Promise(resolve=>setTimeout(resolve,100));}
   assert.ok(taskId,'新建按钮应创建任务');
   await page.getByRole('heading',{name:title,exact:true}).waitFor({state:'visible'});
   await page.screenshot({path:path.join(evidence,'gui-created-task.png')});

   await assertConfirmationFieldsRemoved();
   assert.equal(await page.getByRole('checkbox',{name:'我确认本次不使用任何参考来源'}).count(),0,'空来源选择应由明确继续按钮记录');
   const confirmInputsResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/confirm-inputs'));
   const draftResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/chat'));
   await page.getByRole('button',{name:'不使用参考并继续',exact:true}).click();
   assert.equal((await confirmInputsResponse).status(),200);
   await waitForGuiTask(taskId,task=>Boolean(task.inputConfirmation),'确认需求');
   await page.screenshot({path:path.join(evidence,'gui-input-confirmed.png')});


   const draftJob=await (await draftResponse).json();assert.ok(draftJob.job?.id,'制作单按钮应提交 Agent Job');
   await job(draftJob);
   let details=await waitForGuiTask(taskId,task=>Boolean(task.sheets?.length),'Agent 制作单');
   await page.locator('.sheet-title-label input').waitFor({state:'visible'});
   await page.locator('.sheet-title-label input').fill('春日阅读指南（人工编辑）');
   await page.getByLabel('页面准确文案').fill('阅读 1：每天读一点');
   const saveSheetResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/set-sheet'));
   await page.getByRole('button',{name:'保存修改',exact:true}).click();
   assert.equal((await saveSheetResponse).status(),200);
   details=await waitForGuiTask(taskId,task=>task.sheets?.at(-1)?.pages?.[0]?.copy==='阅读 1：每天读一点','人工编辑保存');
   await page.screenshot({path:path.join(evidence,'gui-sheet-edited.png')});

   const sheetVersion=details.task.sheetVersion;
   await assertConfirmationFieldsRemoved();
   const confirmSheetResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/confirm-sheet'));
   await page.getByRole('button',{name:`确认 v${sheetVersion}`,exact:true}).click();
   assert.equal((await confirmSheetResponse).status(),200);
   details=await waitForGuiTask(taskId,task=>task.sheetConfirmation?.version===task.sheetVersion,'确认制作单');
   await page.screenshot({path:path.join(evidence,'gui-sheet-confirmed.png')});

   const canvasPopupPromise=page.waitForEvent('popup');
   await page.locator('.canvas-open').click();
   const drawing=await canvasPopupPromise;
   await drawing.waitForURL(/\/canvas(?:\?|\/|#)/,{timeout:20000});
   const canvasDeadline=Date.now()+30000;
   while(Date.now()<canvasDeadline&&!(await canvas.state(taskId)).clientConnected)await drawing.waitForTimeout(150);
   assert.equal((await canvas.state(taskId)).clientConnected,true,'打开 Canvas 按钮应连接当前任务');
   await drawing.screenshot({path:path.join(evidence,'gui-canvas-open.png')});

   const executeResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/execute'));
   await page.getByRole('button',{name:`确认 v${sheetVersion} 并开始绘图`,exact:true}).click();
   const executeJob=await (await executeResponse).json();assert.ok(executeJob.job?.id,'绘图按钮应提交逐页 Job');
   await job(executeJob);
   details=await waitForGuiTask(taskId,task=>task.execution?.status==='succeeded','Canvas 绘图');
   assert.equal(details.task.execution.pages.length,1);
   await drawing.screenshot({path:path.join(evidence,'gui-canvas-generated.png')});
   await page.screenshot({path:path.join(evidence,'gui-generation-complete.png')});

   await page.getByRole('tab',{name:'成品审核',exact:true}).click();
   const agentReviewResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/review'));
   await page.getByRole('button',{name:'请 Agent 读图复审本页',exact:true}).click();
   const reviewJob=await (await agentReviewResponse).json();assert.ok(reviewJob.job?.id,'Agent 读图按钮应提交 review Job');
   await job(reviewJob);
   const reviewedImageSha=details.task.execution.pages[0].image.sha256;
   details=await waitForGuiTask(taskId,task=>task.reviews?.some(review=>review.page===1&&review.sha256===reviewedImageSha&&review.decision==='pass'),'Agent 实际读图复审');
   await page.locator('.job-dock').waitFor({state:'detached',timeout:15000});
   await page.locator('.job-activity.succeeded').waitFor({state:'visible',timeout:15000});
   await page.locator('.review-record.pass').waitFor({state:'visible',timeout:15000});
   await page.screenshot({path:path.join(evidence,'gui-agent-reviewed.png')});

   const approveButton=page.getByRole('button',{name:'人工批准当前成品',exact:true});
   await approveButton.waitFor({state:'visible'});assert.equal(await approveButton.isEnabled(),true,'Agent 通过当前图片后应允许进入人工批准');
   await assertConfirmationFieldsRemoved(['批准人','确认说明']);
   assert.equal(await page.locator('.approval-form').count(),0,'最终批准不再显示确认表单');
   const approveResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/approve-final'));
   await approveButton.click();
   const approvalResponse=await approveResponse;assert.equal(approvalResponse.status(),200);
   details=await waitForGuiTask(taskId,task=>Boolean(task.finalApproval),'人工批准');
   await page.getByRole('button',{name:'导出素材包',exact:true}).waitFor({state:'visible'});
   await page.screenshot({path:path.join(evidence,'gui-human-approved.png')});

   const exportButton=page.getByRole('button',{name:'导出素材包',exact:true});
   assert.equal(await exportButton.isEnabled(),true,'人工批准后应显示可用导出按钮');
   const exportResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/export')).catch(error=>({waitError:error}));
   await exportButton.click();
   const exportHttpResponse=await exportResponse;if(exportHttpResponse.waitError)throw exportHttpResponse.waitError;
   const exported=await exportHttpResponse.json();assert.ok(exported.export?.downloadUrl);
   const downloadLink=page.getByRole('link',{name:'下载素材包',exact:true});
   await downloadLink.waitFor({state:'visible'});
   const downloadPromise=page.waitForEvent('download');await downloadLink.click();
   const download=await downloadPromise;const archivePath=path.join(evidence,'gui-export.zip');await download.saveAs(archivePath);
   const zip=await readFile(archivePath);const entries=unzipSync(zip);const manifest=JSON.parse(Buffer.from(entries['manifest.json']).toString());
   assert.equal(manifest.images.length,1);
   for(const image of manifest.images)assert.equal(createHash('sha256').update(entries[image.path]).digest('hex'),image.sha256);
   await page.screenshot({path:path.join(evidence,'gui-export-ready.png')});
   const reviewNote=page.locator('.review-form textarea');
   assert.equal(await reviewNote.count(),1,'成品复审表单应有一条可选检查记录');
   await reviewNote.fill('布局切换后仍应保留这条未提交记录');
   const mainArea=page.locator('.main-area');
   const expandedMain=await mainArea.boundingBox();
   await page.getByRole('button',{name:'收起导航栏',exact:true}).click();
   const expandNav=page.getByRole('button',{name:'展开导航栏',exact:true});
   await expandNav.focus();
   assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')==='展开导航栏'),true,'导航折叠开关应支持键盘聚焦');
   const collapsedMain=await mainArea.boundingBox();
   assert.ok(collapsedMain.width>expandedMain.width,'收起导航栏后工作区应获得更多横向空间');
   await expandNav.click();
   assert.equal(await reviewNote.inputValue(),'布局切换后仍应保留这条未提交记录','展开导航后应保留对象工作区表单状态');
   await page.getByRole('button',{name:'收起工作对象面板',exact:true}).click();
   assert.equal(await page.locator('.object-panel').isVisible(),false,'收起后对象工作区应隐藏');
   const expandObject=page.getByRole('button',{name:'展开工作对象面板',exact:true});
   await expandObject.focus();
   assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')==='展开工作对象面板'),true,'对象面板开关应支持键盘聚焦');
   await expandObject.click();
   assert.equal(await page.locator('.object-panel').isVisible(),true,'展开后对象工作区应恢复');
   assert.equal(await reviewNote.inputValue(),'布局切换后仍应保留这条未提交记录','折叠并展开对象工作区后应保留表单状态');
   await reviewNote.fill('');
   layoutReport=await page.evaluate(async()=>{
     const conversation=document.querySelector('#conversation-scroll');
     const objectContent=document.querySelector('.object-content');
     const rightPanel=document.querySelector('.object-panel');
     const composer=document.querySelector('.chat-composer-wrap');
     const addFixture=(container,kind)=>{
       const node=document.createElement('div');node.dataset.layoutFixture=kind;
       if(kind==='conversation'){
         node.className='message-row agent layout-fixture-message';
         node.innerHTML='<span class="agent-avatar" aria-hidden="true">✳</span><div class="message-body"><div class="message-bubble"></div></div>';
         node.querySelector('.message-bubble').textContent=`第 ${container.querySelectorAll('[data-layout-fixture="conversation"]').length+1} 条桌面布局验收长对话。`.repeat(4);
       }else{node.style.cssText='height:1200px;flex:0 0 1200px;';}
       container.append(node);
     };
     for(let index=0;index<40;index++)addFixture(conversation,'conversation');
     addFixture(objectContent,'object');
     await new Promise(resolve=>requestAnimationFrame(resolve));
     const rect=(element)=>{const value=element.getBoundingClientRect();return {top:value.top,bottom:value.bottom,left:value.left,right:value.right,width:value.width,height:value.height};};
     const rightBefore=rect(rightPanel),composerRect=rect(composer),header=rect(document.querySelector('.workbench-header')),stage=rect(document.querySelector('.stage-rail'));
     const documentScrollTop=document.scrollingElement?.scrollTop||0;
     conversation.scrollTop=0;const conversationBefore=conversation.scrollTop;conversation.scrollTop=conversation.scrollHeight;
     objectContent.scrollTop=0;const objectBefore=objectContent.scrollTop;objectContent.scrollTop=objectContent.scrollHeight;
     await new Promise(resolve=>requestAnimationFrame(resolve));
     return {viewport:{width:innerWidth,height:innerHeight},conversation:{fixtures:conversation.querySelectorAll('[data-layout-fixture="conversation"]').length,clientHeight:conversation.clientHeight,scrollHeight:conversation.scrollHeight,before:conversationBefore,after:conversation.scrollTop},object:{clientHeight:objectContent.clientHeight,scrollHeight:objectContent.scrollHeight,before:objectBefore,after:objectContent.scrollTop},rightPanelBefore:rightBefore,rightPanelAfter:rect(rightPanel),composer:composerRect,header,stage,documentScrollTop};
   });
   assert.equal(layoutReport.conversation.fixtures,40);
   assert.ok(layoutReport.conversation.scrollHeight>layoutReport.conversation.clientHeight,'长对话应由左侧列表内部滚动');
   assert.ok(layoutReport.conversation.after>layoutReport.conversation.before,'左侧对话滚动条应可移动');
   assert.ok(layoutReport.object.scrollHeight>layoutReport.object.clientHeight,'右对象内容应由自己的滚动区承载');
   assert.ok(layoutReport.object.after>layoutReport.object.before,'右对象内容滚动条应可移动');
   assert.deepEqual(layoutReport.rightPanelAfter,layoutReport.rightPanelBefore,'滚动任一内容区时右工作区位置应固定');
   assert.equal(layoutReport.documentScrollTop,0,'桌面长对话不应带动整页滚动');
   assert.ok(layoutReport.composer.top>=0&&layoutReport.composer.bottom<=layoutReport.viewport.height,'输入框应始终留在视口内');
   assert.ok(layoutReport.header.top>=0&&layoutReport.stage.bottom<=layoutReport.viewport.height,'任务标题和阶段条应始终可见');
   await page.screenshot({path:path.join(layoutEvidence,'layout-desktop.png')});
   await page.evaluate(()=>{document.querySelectorAll('[data-layout-fixture]').forEach((node)=>node.remove());const element=document.querySelector('#conversation-scroll');if(element)element.scrollTop=0;const right=document.querySelector('.object-content');if(right)right.scrollTop=0;});
   report.layout=layoutReport;
   report.checks.push('desktop-workbench-fixed-viewport','conversation-and-object-independent-scroll','sidebar-collapse-and-expand','object-collapse-preserves-form-state');
   await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);await page.screenshot({path:path.join(evidence,'gui-mobile.png')});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.getByRole('button',{name:'切换对话和工作对象',exact:true}).click();
   assert.equal(await page.locator('.object-panel.mobile-visible').isVisible(),true,'移动端应保留切换至对象工作区的 pane 操作');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'移动端对象 pane 不应造成横向溢出');
   await page.screenshot({path:path.join(layoutEvidence,'layout-mobile-object.png')});
   layoutReport.mobile={width:390,height:844,horizontalOverflow:false,objectPaneVisible:true};
   report.layout=layoutReport;
   report.checks.push('mobile-object-pane-toggle');
   assert.deepEqual(errors,[]);
   report.checks.push('GUI-create-confirm-inputs','GUI-agent-sheet-edit-save-confirm','GUI-open-canvas-and-generate','GUI-agent-image-review','GUI-manual-approve','GUI-export-download-and-zip-hashes','no-browser-runtime-errors','narrow-layout-no-horizontal-overflow');
   report.guiActions=guiRequests;
   report.imageRequests=imageRequests;
   report.tasks.push({title,pages:1,status:'passed',sheetVersion,archiveSha256:createHash('sha256').update(zip).digest('hex'),archiveFiles:Object.keys(entries).length});
   await drawing.close();
 }else{
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
   // Inspect the actual rendered workbench before any confirmation or generation.
   await page.reload({waitUntil:'networkidle'});
   await page.getByRole('button',{name:new RegExp(`P3 ${count}页链路验收`)}).click();
   await page.getByRole('tab',{name:'制作单',exact:true}).click();
   await page.screenshot({path:path.join(evidence,`${live?'live':'web'}-sheet-${count}.png`)});
   task=await action(task,'confirm-sheet',{version:task.sheetVersion,by:'测试用户',note:'用户授权P3链路测试：确认当前测试制作单与生成'});
   const opened=await request(`/api/tasks/${task.id}/canvas/open`,{});
   const drawing=await context.newPage();await drawing.goto(opened.openUrl,{waitUntil:'domcontentloaded'});
   const deadline=Date.now()+30000;while(Date.now()<deadline){if((await canvas.state(task.id)).clientConnected)break;await drawing.waitForTimeout(200);}
   assert.equal((await canvas.state(task.id)).clientConnected,true);
   task=await action(task,'execute',{version:task.sheetVersion});
   assert.equal(task.execution.status,'succeeded');assert.equal(task.execution.pages.length,count);
   for(let p=1;p<=count;p++){await job(await request(`/api/tasks/${task.id}/review`,{page:p,expectedRevision:task.revision}));task=await current(task.id);}
   const reviews=task.execution.pages.map(p=>task.reviews.filter(r=>r.page===p.page&&r.sha256===p.image.sha256).at(-1));
   if(reviews.some(r=>r?.decision!=='pass')){
     report.tasks.push({pages:count,status:'visual-revision-required',reviews:reviews.map(r=>({page:r.page,decision:r.decision,notes:r.notes}))});
     throw new Error(`${count}页真实视觉审核未全通过；不得伪造批准`);
   }
   task=await action(task,'approve-final',{version:task.sheetVersion,images:task.execution.pages.map(p=>({page:p.page,sha256:p.image.sha256})),by:'测试用户',note:'用户授权P3验收中的隔离任务交付测试；逐页当前图与真实读图记录已核对'});
   const exported=await request(`/api/tasks/${task.id}/export`,{expectedRevision:task.revision});task=await current(task.id);
   const downloadUrl=exported.downloadUrl||exported.export?.downloadUrl||task.exports.at(-1).downloadUrl;
   const zip=Buffer.from(await (await fetch(url+downloadUrl)).arrayBuffer());
   const entries=unzipSync(zip);const manifest=JSON.parse(Buffer.from(entries['manifest.json']).toString());
   assert.equal(manifest.images.length,count);
   for(const img of manifest.images)assert.equal(createHash('sha256').update(entries[img.path]).digest('hex'),img.sha256);
   if(live)for(const record of task.execution.pages){const bytes=Buffer.from(await (await fetch(url+record.image.imageUrl)).arrayBuffer());await writeFile(path.join(evidence,`live-${count}-page-${record.page}.png`),bytes);}
   await page.reload({waitUntil:'networkidle'});await page.getByRole('button',{name:new RegExp(`P3 ${count}页链路验收`)}).click();await page.getByRole('tab',{name:'成品审核',exact:true}).click();
   await page.screenshot({path:path.join(evidence,`${live?'live':'web'}-review-${count}.png`)});
   report.tasks.push({pages:count,status:'passed',sheetVersion:task.sheetVersion,images:task.execution.pages.map(p=>({page:p.page,sha256:p.image.sha256})),archiveSha256:createHash('sha256').update(zip).digest('hex'),archiveFiles:Object.keys(entries).length});
   await drawing.close();
 }
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);await page.screenshot({path:path.join(evidence,`${live?'live':'web'}-mobile.png`)});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.deepEqual(errors,[]);report.checks.push('no-browser-runtime-errors','narrow-layout-no-horizontal-overflow','1-3-5-page-full-chain-and-zip-hashes');
 report.imageRequests=live?'真实Canvas图像请求，逐页制品为证':imageRequests;
 report.status='passed';
 }
 report.status='passed';
}catch(error){if(page){await page.screenshot({path:path.join(evidence,gui?'gui-failure.png':live?'live-failure.png':'web-failure.png')}).catch(()=>{});report.browserErrors=errors;report.failureView=(await page.locator('body').innerText().catch(()=>'' )).slice(0,8000);}report.status='failed';report.error=String(error.message).replace(/https?:\/\/[^\s]+/g,'[local/service URL]');console.error(report.error);process.exitCode=1;
}finally{
 await writeFile(path.join(evidence,gui?'gui-chain.json':live?'live-chain.json':'web-chain.json'),JSON.stringify(report,null,2));
 if(gui&&layoutReport)await writeFile(path.join(layoutEvidence,'layout.json'),JSON.stringify(layoutReport,null,2));
 await browser?.close();await app.close();mock.closeAllConnections();await new Promise(resolve=>mock.close(resolve));
 await rm(root,{recursive:true,force:true});
}
console.log(JSON.stringify({status:report.status,live,gui,checks:report.checks,tasks:report.tasks.length}));
