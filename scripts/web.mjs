import {readFile,writeFile,mkdir,open,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {alive,readJson} from '../src/launcher/control.mjs';
import {serveControl} from '../src/launcher/control.mjs';
import {dataRoot} from '../src/canvas/client.mjs';
import {ensureModelPlugin,stopModelPlugin} from '../src/web/model-plugin.mjs';
import {readConfig} from '../src/web/config.mjs';
import {listenStudioServer} from '../src/web/server.mjs';
import {createCanvasManager} from '../src/web/canvas.mjs';
import {createStudioAgent} from '../adapters/dsh/runtime.mjs';

const args=process.argv.slice(2);
const allowed=new Set(['--no-open','--port']);
let port=4310;
for(let i=0;i<args.length;i++){
  if(!allowed.has(args[i]))throw new Error('用法：npm run web -- [--port 4310] [--no-open]');
  if(args[i]==='--port'){port=Number(args[++i]);if(!Number.isInteger(port)||port<0||port>65535)throw new Error('端口必须为 0—65535 的整数。');}
}
const root=dataRoot();
await mkdir(path.join(root,'web'),{recursive:true,mode:0o700});
const lockPath=path.join(root,'web','instance.lock');
let lock;
try{lock=await open(lockPath,'wx',0o600);}catch(error){
  if(error.code!=='EEXIST')throw error;
  const owner=JSON.parse(await readFile(lockPath,'utf8'));
  let alive=true;try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}
  if(alive)throw new Error('此数据目录已有工作台运行；请使用已打开的网页或停止原进程。');
  await rm(lockPath);lock=await open(lockPath,'wx',0o600);
}
const instanceId=randomUUID();
const sourceRuntime=path.resolve(import.meta.dirname,'../.studio-runtime');
const releaseBundle=process.env.STUDIO_RELEASE_BUNDLE==='1';
const sourceMarker=releaseBundle?null:path.join(sourceRuntime,'servers',`${instanceId}.json`);
await lock.writeFile(JSON.stringify({pid:process.pid,instanceId}));
const getConfig=()=>readConfig({root});
const canvas=createCanvasManager({root,readConfig:getConfig});
const agent=createStudioAgent({root,readConfig:getConfig});
let app,controlClose,closing=false;
async function stop(){
  if(closing)return;closing=true;
  await app?.close().catch(()=>{});
  await canvas.stop().catch(()=>{});
  await stopModelPlugin({root}).catch(()=>{});
  await controlClose?.();
  if(sourceMarker)await rm(sourceMarker,{force:true});
  await lock.close();
  const owner=await readFile(lockPath,'utf8').then(JSON.parse).catch(()=>null);
  if(owner?.instanceId===instanceId)await rm(lockPath,{force:true});
}
process.once('SIGINT',()=>void stop());
process.once('SIGTERM',()=>void stop());
try{
  if(sourceMarker){
    await mkdir(path.dirname(sourceMarker),{recursive:true,mode:0o700});
    await writeFile(sourceMarker,JSON.stringify({pid:process.pid,instanceId,dataRoot:root}),{mode:0o600});
    const preparing=await readJson(path.join(sourceRuntime,'prepare.lock'));
    if(preparing&&alive(preparing.pid))throw new Error('当前源码正在准备依赖，请等待完成后启动。');
  }
  await readFile(path.resolve(import.meta.dirname,'../web/dist/index.html'));
  await ensureModelPlugin({root});
  app=await listenStudioServer({root,agent,canvas,readConfig:getConfig,port,host:'127.0.0.1'});
  const url=`http://127.0.0.1:${app.address.port}`;
  controlClose=await serveControl({root,instanceId,url,stop});
  console.log(`Creative Agent Studio Web UI：${url}`);
  console.log('按 Ctrl+C 或使用启动入口的 stop 命令停止工作台与本产品 Canvas。');
  if(!args.includes('--no-open')){
    const command=process.platform==='darwin'?'open':process.platform==='win32'?'cmd':'xdg-open';
    const parameters=process.platform==='win32'?['/c','start','',url]:[url];
    const opener=spawn(command,parameters,{stdio:'ignore',windowsHide:true});opener.on('error',()=>console.log('可在浏览器打开上方本地地址。'));
  }
}catch(error){
  await stop();
  console.error(error?.code==='EADDRINUSE'?'端口已占用；使用 --port 指定其他端口。':'工作台启动未完成；请先安装固定依赖并运行 npm run web:build。');
  process.exitCode=1;
}
