import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { connection, health, callCanvasTool, recoverImage, root, dataRoot } from '../src/canvas/client.mjs';
const [action='status',name,input='{}'] = process.argv.slice(2);
try {
  if (action === 'start') {
    try {const c=await connection();await health(c);throw new Error('本数据目录 Canvas 已运行，请使用 status');} catch(e) {if(e.message.includes('已运行'))throw e;}
    await mkdir(dataRoot(),{recursive:true});
    const log=await open(path.join(dataRoot(),'supervisor.log'),'a',0o600);
    const child=spawn(process.execPath,[path.join(root,'scripts/canvas-supervisor.mjs')],{cwd:root,env:process.env,detached:true,stdio:['ignore',log.fd,log.fd]}); child.unref(); await log.close();
    for(let i=0;i<150;i++){try{const c=await connection();await health(c);console.log(JSON.stringify({started:true,instanceId:c.instanceId,webUrl:c.webUrl,bridgeUrl:c.bridgeUrl,projectId:c.projectId}));process.exit(0);}catch{}await new Promise(r=>setTimeout(r,100));}
    throw new Error('Canvas 启动未完成，请检查 supervisor.log 和实例锁；不会连接其他服务');
  } else if (action === 'stop') {
    const c=await connection(); await health(c);
    const r=await fetch(c.webUrl+'/__studio/stop',{method:'POST',headers:{'x-studio-token':c.token}});if(!r.ok)throw new Error('停止身份校验失败');console.log(JSON.stringify({stopping:true,instanceId:c.instanceId}));
  } else if (action === 'status') console.log(JSON.stringify(await health(),null,2));
  else if (action === 'tool') console.log(JSON.stringify(await callCanvasTool(name,JSON.parse(input)),null,2));
  else if (action === 'image') console.log(JSON.stringify(await recoverImage(name,path.resolve(input)),null,2));
  else throw new Error('用法：canvas.mjs start|status|stop|tool NAME JSON|image NODE_ID OUTPUT');
} catch(e) {console.error(e.message);process.exitCode=1;}
