import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dataRoot, root as repo } from '../src/canvas/client.mjs';
import { alive, readJson, runtimeStatus, stopRuntime } from '../src/launcher/control.mjs';
import { auxiliaryStatus, stopAuxiliary } from '../src/launcher/services.mjs';
import { assertOffline, backupData, restoreData } from '../src/launcher/backup.mjs';

const args=process.argv.slice(2);
let command=args[0]&&!args[0].startsWith('--')?args.shift():'start';
const flags=new Set(['--no-open','--port','--destination','--from']);
const options={port:0};
for(let i=0;i<args.length;i++){
  const flag=args[i];if(!flags.has(flag))throw new Error(`未知选项 ${flag}`);
  if(flag==='--no-open')options.noOpen=true;
  else {const value=args[++i];if(!value||value.startsWith('--'))throw new Error(`${flag} 缺少参数`);options[flag.slice(2)]=value;}
}
const root=dataRoot();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const output=value=>console.log(JSON.stringify(value));
function openBrowser(url){
  const executable=process.platform==='darwin'?'open':process.platform==='win32'?'cmd.exe':'xdg-open';
  const child=spawn(executable,process.platform==='win32'?['/d','/c','start','',url]:[url],{stdio:'ignore',windowsHide:true});
  child.on('error',()=>console.error(`请在浏览器打开 ${url}`));child.unref();
}
async function prepare(force=false){
  const {prepareWorkspace}=await import('../src/launcher/prepare.mjs');
  return prepareWorkspace({root:repo,force,onProgress:event=>console.error(event.message||event)});
}
async function start(){
  const current=await runtimeStatus(root);
  if(current.running){if(!options.noOpen)openBrowser(current.url);return {...current,reused:true};}
  const old=await readJson(path.join(root,'web','instance.lock'));
  if(old&&alive(old.pid))throw new Error('此数据目录已有旧入口工作台运行，请使用原窗口停止；不会重启或接管。');
  await prepare();
  const port=Number(options.port);
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('端口必须为 0—65535 整数。');
  await fs.mkdir(path.join(root,'web'),{recursive:true,mode:0o700});
  const log=await fs.open(path.join(root,'web','service.log'),'a',0o600);
  const child=spawn(process.execPath,[...(process.allowedNodeEnvironmentFlags.has('--use-env-proxy')?['--use-env-proxy']:[]),path.join(repo,'scripts/web.mjs'),'--no-open','--port',String(port)],{cwd:repo,env:{...process.env,STUDIO_DATA_DIR:root},detached:true,windowsHide:true,stdio:['ignore',log.fd,log.fd]});
  let failed=false;child.once('error',()=>{failed=true;});child.unref();await log.close();
  const deadline=Date.now()+45_000;
  while(Date.now()<deadline&&!failed){
    const current=await runtimeStatus(root).catch(()=>({running:false}));
    if(current.running){if(!options.noOpen)openBrowser(current.url);return {...current,reused:false};}
    if(child.exitCode!==null)break;
    await pause(150);
  }
  throw new Error('工作台尚未健康就绪，请运行 doctor 并检查本数据目录 web/service.log。');
}
async function stopServices(){
  const result=await stopRuntime(root);
  const auxiliary=await stopAuxiliary(root);
  return {...result,...auxiliary};
}
async function doctor(){
  const current=await runtimeStatus(root).catch(e=>({running:false,error:e.message}));
  const config=await fs.access(path.join(root,'config','studio.json')).then(()=>true).catch(()=>false);
  const checks=[];
  for(const relative of ['node_modules','adapters/dsh/node_modules','third_party/canvas/web/dist/index.html','third_party/canvas/canvas-agent/dist/index.js','web/dist/index.html'])checks.push({path:relative,exists:await fs.access(path.join(repo,relative)).then(()=>true).catch(()=>false)});
  return {node:process.version,platform:process.platform,architecture:process.arch,source:repo,dataDirectory:root,workbench:current,services:await auxiliaryStatus(root),checks,configPresent:config,help:'首次配置在网页设置完成；网络/依赖错误运行 prepare；更新前 stop，再 update；详细说明见 docs/本地Web交付.md。'};
}
async function run(){
  if(command==='status')return runtimeStatus(root);
  if(command==='doctor')return doctor();
  if(!['start','stop','prepare','backup','restore','update'].includes(command))throw new Error('用法：start|stop|status|prepare|doctor|backup [--destination 目录]|restore --from 备份目录|update [--no-open]');
  // One short-lived maintenance owner per data directory; never lock real tasks.
  await fs.mkdir(path.dirname(root),{recursive:true,mode:0o700});
  const lockFile=`${root}.launcher.lock`;const owner={pid:process.pid,token:randomUUID()};let lock;
  try{lock=await fs.open(lockFile,'wx',0o600);}catch(e){
    if(e.code!=='EEXIST')throw e;
    const previous=await readJson(lockFile);
    if(!previous||alive(previous.pid))throw new Error('此数据目录已有启动或维护操作，请稍后再试。');
    await fs.rm(lockFile);lock=await fs.open(lockFile,'wx',0o600);
  }
  await lock.writeFile(JSON.stringify(owner));
  try{
    if(command==='start')return await start();
    if(command==='stop')return await stopServices();
    if(command==='prepare')return await prepare();
    if(command==='backup'||command==='update'){
      await assertOffline(root);
      const destination=options.destination||path.join(path.dirname(root),`${path.basename(root)} backups`,new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8));
      const backup=await backupData(root,destination);
      if(command==='backup')return backup;
      await prepare(true);
      return {updated:true,backup,source:repo,message:'已备份数据并准备当前源码。源码获取和 Git 切换由用户指定，不自动拉取远端。'};
    }
    if(!options.from)throw new Error('restore 需要 --from 备份目录。');
    return await restoreData(root,options.from);
  }finally{
    await lock.close();const current=await readJson(lockFile);
    if(current?.token===owner.token)await fs.rm(lockFile,{force:true});
  }
}
async function menu(){
  command='start';
  try{output(await run());}catch(error){console.error(error.message);}
  if(!process.stdin.isTTY||!process.stdout.isTTY)return;
  const {createInterface}=await import('node:readline/promises');
  const prompt=createInterface({input:process.stdin,output:process.stdout});
  try{
    for(;;){
      const choice=(await prompt.question('\n1 打开工作台  2 停止服务  3 备份数据  4 更新当前源码依赖  5 恢复备份  6 诊断  0 退出菜单\n请选择：')).trim();
      if(choice==='0')break;
      command=({'1':'start','2':'stop','3':'backup','4':'update','5':'restore','6':'doctor'})[choice];
      if(!command){console.log('请输入 0—6。');continue;}
      try{
        if(['backup','update','restore'].includes(command)){
          console.log('维护会先正常停止本数据目录的工作台；备份包含本地密钥配置，请妥善保管。');
          await stopServices();
        }
        if(command==='restore'){
          options.from=(await prompt.question('备份目录完整路径（恢复前的当前数据会另存保留）：')).trim().replace(/^"|"$/g,'');
          if(!options.from)continue;
        }
        output(await run());
      }catch(error){console.error(error.message);}
    }
  }finally{prompt.close();}
  console.log('菜单已退出；如未选择停止，服务继续在本机运行。');
}
try{if(command==='menu')await menu();else output(await run());}catch(error){console.error(error.message);process.exitCode=1;}
