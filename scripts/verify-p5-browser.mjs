import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {listenStudioServer} from '../src/web/server.mjs';
import {saveConfig} from '../src/web/config.mjs';
import {createTask,confirmInputs,setSheet,readTask,setSources} from '../src/creative/tasks.mjs';
const repo=path.resolve(import.meta.dirname,'..');
const root=await mkdtemp(path.join(os.tmpdir(),'studio-p5-browser-'));
const staticDir=path.join(root,'static');const evidence=path.join(repo,'docs/evidence/p5');await mkdir(evidence,{recursive:true});
await mkdir(path.join(staticDir,'assets'),{recursive:true});await cp(path.join(repo,'web/public'),staticDir,{recursive:true});await cp(path.join(repo,'web/index.html'),path.join(staticDir,'index.html'));
await build({entryPoints:[path.join(repo,'web/src/main.jsx')],outfile:path.join(staticDir,'assets/app.js'),bundle:true,jsx:'automatic',external:['/brand/*'],loader:{'.png':'file','.svg':'file'}});
await saveConfig({expectedRevision:1,base:{baseUrl:'http://127.0.0.1:1/v1',apiKey:'fixture-key',model:'fixture-base'},image:{baseUrl:'http://127.0.0.1:1/v1',apiKey:'fixture-key',model:'fixture-image'}},{root});
let task=await createTask({title:'P5 样张方案',brief:{content:'隔离样张测试，无真实模型请求'}},root);
task=await confirmInputs(task.id,{revision:task.revision,by:'测试用户',note:'隔离测试人工确认'},{root});
task=await setSheet(task.id,{title:'隔离样张',pages:[{page:1,copy:'样张标题',prompt:'白底测试样张',size:'3:4'}]},{root,expectedRevision:task.revision,inputRevision:task.inputConfirmation.revision});
let referenceTask=await createTask({title:'P5 参考讨论',brief:'讨论与确认参考'},root);
referenceTask=await setSources(referenceTask.id,[{id:crypto.randomUUID(),type:'external',title:'合成参考',body:'合成测试参考',purpose:'等待选择',factBoundary:'仅参考',decision:'pending'}],{root,expectedRevision:referenceTask.revision});
const image=await readFile(path.join(repo,'adapters/dsh/connection-check.png'));let nodes=[],connections=[],runs=0;
const canvas={state:async()=>({status:'connected',projectId:'fixture',clientConnected:true}),ensure:async()=>({openUrl:'http://127.0.0.1:1',projectId:'fixture',clientConnected:true}),assertFresh:async()=>{},executionOptions:async()=>({config:{projectId:'fixture',webUrl:'http://fixture',clientId:'fixture'},getHealth:async()=>({targets:[{hasCanvas:true,projectId:'fixture',clientId:'fixture'}]}),tool:async(name,input)=>{
 if(name==='canvas_get_state')return {nodes,connections};
 if(name==='canvas_apply_ops'){nodes.push(...input.ops.filter(op=>op.type==='add_node').map(op=>({id:op.id,type:op.nodeType,metadata:op.metadata})));return {};}
 if(name==='canvas_run_generation'){runs++;const out={id:`image-${runs}`,type:'image',metadata:{status:'success'}};nodes.push(out);connections.push({fromNodeId:input.nodeId,toNodeId:out.id});return {};}
 throw new Error(name);
},recover:async(nodeId,file)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,image);return {path:file,nodeId};}})};
const app=await listenStudioServer({root,staticDir,canvas,agent:{chat:async({taskId,onEvent})=>{const current=await readTask(taskId,root);if(taskId===referenceTask.id&&!current.inputConfirmation)await onEvent({type:'reference-proposal',items:current.sources.map(source=>({id:source.id,decision:'retained',purpose:'只作风格参考'}))});return {text:'隔离测试响应'};},check:async()=>({text:true,tools:true,vision:false})}});
const url=`http://127.0.0.1:${app.address.port}`;const browser=await chromium.launch();const errors=[];let page;
try{
 page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(id=>localStorage.setItem('studio.activeTask',id),task.id);await page.goto(url);await page.getByRole('heading',{name:'P5 样张方案'}).waitFor();
 const left=page.getByRole('region',{name:'创作对话'}); // section with accessible name is region
 const right=page.getByRole('region',{name:'当前任务预览'});
 assert.equal(await right.getByRole('button',{name:/确认.*开始绘图/}).count(),0);
 await left.getByRole('button',{name:'按此方案开始制作',exact:true}).click();
 await left.getByRole('button',{name:'确认交付并下载',exact:true}).waitFor();
 assert.equal(runs,1);const done=await readTask(task.id,root);assert.equal(done.sheetConfirmation.version,1);assert.equal(done.execution.status,'succeeded');
 await page.screenshot({path:path.join(evidence,'workbench-wide.png'),fullPage:true});
 assert.equal(await page.getByRole('button',{name:/复审本页|审核通过|制作单|成品审核/}).count(),0);
 const downloadEvent=page.waitForEvent('download');
 await left.getByRole('button',{name:'确认交付并下载',exact:true}).click();
 const download=await downloadEvent;assert.equal(await download.failure(),null);
 await right.getByRole('link',{name:'下载素材包',exact:true}).waitFor();
 await page.setViewportSize({width:1280,height:800});await page.screenshot({path:path.join(evidence,'workbench-desktop-1280.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 await page.getByRole('button',{name:'收起预览面板'}).click();
 assert.equal(await right.isVisible(),false);
 await page.getByRole('button',{name:'展开预览面板'}).click();
 assert.equal(await right.isVisible(),true);
 await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('button',{name:/P5 参考讨论/}).click();
 await page.locator('#chat-message').fill('保留这份资料，只作风格参考');
 await page.getByRole('button',{name:'发送消息',exact:true}).click();
 const applyProposal=page.getByRole('button',{name:'确认参考方案并继续'});await applyProposal.waitFor();await applyProposal.click();
 await page.waitForFunction(async id=>{const r=await fetch('/api/tasks/'+id);const data=await r.json();return Boolean((data.task||data).inputConfirmation);},referenceTask.id);
 let referenceDone;for(let i=0;i<100;i++){referenceDone=await readTask(referenceTask.id,root);if(referenceDone.inputConfirmation)break;await new Promise(resolve=>setTimeout(resolve,100));}assert.equal(referenceDone.sources[0].decision,'retained');assert.ok(referenceDone.inputConfirmation);
 await page.getByRole('button',{name:'模型与服务设置',exact:true}).click();await page.getByRole('button',{name:'重新打开首次引导'}).click();
 await page.getByRole('heading',{name:/服务商|模型|开始|设置/}).first().waitFor();await page.screenshot({path:path.join(evidence,'onboarding-wide.png'),fullPage:true});
 await page.setViewportSize({width:1280,height:800});await page.screenshot({path:path.join(evidence,'onboarding-desktop-1280.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 assert.deepEqual(errors,[]);
 await writeFile(path.join(evidence,'browser.json'),JSON.stringify({status:'passed',checks:['已有效配置直接进工作台','左侧一次确认并执行','右侧无重复确认','1440与1280桌面视口无横溢出','预览折叠与展开','一次确认交付下载','无逐页复审表单','首次引导可重开','自然语言参考方案在左侧一次应用并继续'],runs,errors},null,2));
 console.log('P5 browser passed; image generation is a local controlled fixture.');
}finally{await page?.context().close();await browser.close();await app.close();await rm(root,{recursive:true,force:true});}
