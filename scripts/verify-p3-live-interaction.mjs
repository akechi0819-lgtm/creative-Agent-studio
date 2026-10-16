import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {dataRoot} from '../src/canvas/client.mjs';
import {queryAssets} from '../src/assets/library.mjs';
import {createStudioAgent} from '../adapters/dsh/runtime.mjs';
import {listenStudioServer} from '../src/web/server.mjs';

if(!process.argv.includes('--live'))throw new Error('真实验证须显式使用 --live；不自动重发模型请求。');
const evidence=path.resolve('docs/evidence/p3-interaction');await fs.mkdir(evidence,{recursive:true});
const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-live-interaction-'));
const report={date:new Date().toISOString(),scope:'真实模型下的点选追问、答案提交和 KET 素材候选验证；临时任务和素材副本',checks:[],chatRequests:0,imageRequests:0};
let app;
try{
  await fs.cp(path.join(dataRoot(),'assets'),path.join(root,'assets'),{recursive:true});
  const basic=JSON.parse(await fs.readFile('.p0-state/model-credentials.json','utf8'));
  const readConfig=async()=>({basic:{baseUrl:basic.baseUrl,model:basic.model,apiKey:basic.apiKey},image:{}});
  const agent=createStudioAgent({root,readConfig});app=await listenStudioServer({root,agent,readConfig,port:0});
  const url=`http://127.0.0.1:${app.address.port}`;
  const request=async(endpoint,body)=>{const response=await fetch(url+endpoint,{method:body?'POST':'GET',headers:{origin:url,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();if(!response.ok)throw new Error(`请求未完成：${value.error?.code||response.status}`);return value;};
  const task=(await request('/api/tasks',{title:'真实点选与素材检索隔离验证',brief:{content:'我想做一个KET学习相关的小红书图文',format:'carousel',pageCount:3}})).task;
  const chat=async(text,answers)=>{
    const before=(await request('/api/tasks/'+task.id)).task;
    const started=await request(`/api/tasks/${task.id}/chat`,{text,expectedRevision:before.revision,requestId:crypto.randomUUID(),model:basic.model,...(answers?{answers}:{})});report.chatRequests++;
    const deadline=Date.now()+240000;
    while(Date.now()<deadline){const {job}=await request('/api/jobs/'+started.job.id);if(job.status==='succeeded')return request('/api/tasks/'+task.id);if(['failed','cancelled'].includes(job.status))throw new Error(`模型轮次未完成：${job.error?.code||job.status}`);await new Promise(r=>setTimeout(r,1000));}
    throw new Error('模型请求仍未结束；未自动重发。');
  };
  let detail=await chat('我想做一个KET学习相关的小红书图文');
  const questionMessage=detail.conversation.find(m=>m.questions?.length);
  assert.ok(questionMessage,'真实模型没有发出结构化点选追问');
  assert.ok(questionMessage.questions.length<=3);report.checks.push('real-model-structured-choice-questions');
  report.questions=questionMessage.questions.map(q=>({question:q.question,options:q.options.map(o=>o.label)}));
  const items=questionMessage.questions.map(q=>{
    const question=q.question;
    const desired=/受众|面向|人群|谁/.test(question)?/家长/:/目标|目的|效果/.test(question)?/引流|资料|私信/:/风格|视觉|排版/.test(question)?/手帐|手账|笔记/:/页数|几页/.test(question)?/3|三/:/年级|年龄|阶段/.test(question)?/3|三|小学/:/参考|素材/.test(question)?/素材库|检索/:/家长|引流|手帐|手账/;
    const selected=q.options.find(o=>desired.test(o.label))||q.options[0];
    return{questionId:q.id,optionIds:[selected.id]};
  });
  detail=await chat('已选择本次创作需求。',{messageId:questionMessage.id,items});
  assert.ok(detail.conversation.some(m=>m.answers?.messageId===questionMessage.id));report.checks.push('real-model-choice-answer-roundtrip');
  detail=await chat('本次明确面向3～6年级孩子的家长，目标是课程资料引流，手帐笔记风格，不写价格、分数或考试时间，结尾只引导私信。请现在直接检索素材库里的KET参考，列为待我保留或排除的候选，优先KET主题；不要生成制作单，不要生图。');
  const matches=await queryAssets({query:'KeT'},{root});const ids=new Set(matches.map(a=>a.id));
  assert.ok(matches.length>0);assert.ok(detail.task.sources.some(s=>s.asset&&ids.has(s.asset.id)),'实际KET命中没有进入待选区');
  assert.ok(detail.task.sources.every(s=>s.decision==='pending'),'模型不能代替用户保留参考');assert.equal(detail.task.inputConfirmation,null);
  report.matchCount=matches.length;report.candidateCount=detail.task.sources.length;report.checks.push('real-ket-library-matches-staged-as-pending','no-model-human-confirmation','no-image-generation');
  report.status='passed';
}catch(e){report.status='failed';report.error=String(e.message).replace(/https?:\/\/\S+/g,'[服务地址]');process.exitCode=1;}
finally{await app?.close();await fs.rm(root,{recursive:true,force:true});report.temporaryRootRemoved=true;await fs.writeFile(path.join(evidence,'live-interaction.json'),JSON.stringify(report,null,2),{mode:0o600});}
console.log(JSON.stringify(report));
