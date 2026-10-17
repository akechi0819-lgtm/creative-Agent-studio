import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { backupData, restoreData, assertOffline } from '../src/launcher/backup.mjs';
import { serveControl, runtimeStatus, stopRuntime } from '../src/launcher/control.mjs';

async function fixture(t){
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'studio-maintenance-'));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const root=path.join(base,'用户 data');
  await fs.mkdir(path.join(root,'config'),{recursive:true});
  await fs.writeFile(path.join(root,'config','studio.json'),'{"fixture":"private-local-config"}');
  return {base,root};
}
test('backup restores verified original bytes, retains prior data and omits runtime tokens',async t=>{
  const {base,root}=await fixture(t);
  await fs.mkdir(path.join(root,'web'));
  await fs.writeFile(path.join(root,'web','runtime.json'),JSON.stringify({pid:2147483647,url:'http://127.0.0.1:1',controlUrl:'http://127.0.0.1:1',token:'ephemeral'}));
  await fs.writeFile(path.join(root,'user.log'),'user attachment kept');
  const assetBytes=Buffer.from([0,1,2,255,137,80,78,71]);
  const storageKey='image-file-fixture';
  const storageName=createHash('sha256').update(storageKey).digest('hex')+'.json';
  const storagePath=path.join(root,'storage','image_files',storageName);
  const storageRecord={key:storageKey,contentType:'image/png',base64:assetBytes.toString('base64')};
  await fs.mkdir(path.dirname(storagePath),{recursive:true});
  await fs.writeFile(storagePath,JSON.stringify(storageRecord));
  const dest=path.join(base,'备份');
  const result=await backupData(root,dest);
  assert.equal(result.files,3);
  assert.equal(result.canvasStorageIncluded,true);
  assert.equal(result.browserProfileIncluded,false);
  await assert.rejects(fs.access(path.join(dest,'data','web','runtime.json')));
  await fs.writeFile(path.join(root,'config','studio.json'),'newer data');
  await fs.writeFile(storagePath,JSON.stringify({...storageRecord,base64:Buffer.from('newer image').toString('base64')}));
  const restored=await restoreData(root,dest);
  assert.match(await fs.readFile(path.join(root,'config','studio.json'),'utf8'),/private-local-config/);
  assert.equal(await fs.readFile(path.join(restored.previousData,'config','studio.json'),'utf8'),'newer data');
  const restoredRecord=JSON.parse(await fs.readFile(storagePath,'utf8'));
  const restoredBytes=Buffer.from(restoredRecord.base64,'base64');
  assert.deepEqual(restoredBytes,assetBytes);
  assert.equal(createHash('sha256').update(restoredBytes).digest('hex'),createHash('sha256').update(assetBytes).digest('hex'));
  const previousRecord=JSON.parse(await fs.readFile(path.join(restored.previousData,'storage','image_files',storageName),'utf8'));
  assert.equal(Buffer.from(previousRecord.base64,'base64').toString(),'newer image');
  assert.equal(await fs.readFile(path.join(root,'user.log'),'utf8'),'user attachment kept');
});
test('corrupt backup and traversal manifest never replace current data',async t=>{
  const {base,root}=await fixture(t);const dest=path.join(base,'backup');
  await backupData(root,dest);
  await fs.writeFile(path.join(dest,'data','config','studio.json'),'corrupt');
  await assert.rejects(restoreData(root,dest),/变化/);
  assert.match(await fs.readFile(path.join(root,'config','studio.json'),'utf8'),/private-local-config/);
  const manifest=JSON.parse(await fs.readFile(path.join(dest,'manifest.json'),'utf8'));
  manifest.files[0].path='../outside';
  await fs.writeFile(path.join(dest,'manifest.json'),JSON.stringify(manifest));
  await assert.rejects(restoreData(root,dest),/路径/);
});
test('backup rejects live writers, nested destination and symlinks',async t=>{
  const {base,root}=await fixture(t);
  await fs.writeFile(path.join(root,'config','.write-lock'),JSON.stringify({pid:process.pid}));
  await assert.rejects(assertOffline(root),/仍有/);
  await fs.rm(path.join(root,'config','.write-lock'));
  await assert.rejects(backupData(root,path.join(root,'backup')),/之外/);
  if(process.platform!=='win32'){
    await fs.symlink(path.join(root,'config'),path.join(root,'link'));
    await assert.rejects(backupData(root,path.join(base,'backup')),/符号链接/);
  }
});
test('authenticated HTTP control supports Windows graceful stop without PID signals',async t=>{
  const {root}=await fixture(t);await fs.mkdir(path.join(root,'web'));
  const instanceId='test-instance';
  await fs.writeFile(path.join(root,'web','instance.lock'),JSON.stringify({pid:process.pid,instanceId}));
  let close;
  close=await serveControl({root,instanceId,url:'http://127.0.0.1:12345',stop:async()=>{await close();await fs.rm(path.join(root,'web','instance.lock'));}});
  t.after(()=>close());
  const record=JSON.parse(await fs.readFile(path.join(root,'web','runtime.json'),'utf8'));
  assert.equal((await fetch(record.controlUrl+'/stop',{method:'POST'})).status,403);
  assert.equal((await runtimeStatus(root)).running,true);
  await assert.rejects(assertOffline(root),/stop/);
  assert.deepEqual(await stopRuntime(root),{running:false,stopped:true});
  assert.equal((await runtimeStatus(root)).running,false);
});

async function serviceServer(t,handler){
  const {createServer}=await import('node:http');
  const server=createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{if(server.listening)server.close(()=>resolve());else resolve();}));
  return {server,baseUrl:`http://127.0.0.1:${server.address().port}`};
}
async function writePluginFixture(root,baseUrl,{instanceId='fixture-plugin',pid=process.pid,lockPid=pid}={}){
  const directory=path.join(root,'model-plugin');
  await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'instance.json'),JSON.stringify({baseUrl,apiKey:'fixture-token',instanceId,pid}));
  await fs.writeFile(path.join(directory,'service.lock'),JSON.stringify({pid:lockPid,instanceId}));
}
test('healthy residual plugin is diagnosed without secrets and stops through its authenticated endpoint',async t=>{
  const {root}=await fixture(t);let stopped=false;
  const {server,baseUrl}=await serviceServer(t,(req,res)=>{
    if(req.url==='/health'&&req.headers.authorization==='Bearer fixture-token'){
      res.setHeader('content-type','application/json');res.end(JSON.stringify({service:'studio-model-plugin',instanceId:'fixture-plugin'}));return;
    }
    if(req.url==='/studio/stop'&&req.headers.authorization==='Bearer fixture-token'){
      res.end('{}');setImmediate(async()=>{
        stopped=true;
        await fs.rm(path.join(root,'model-plugin','instance.json'),{force:true});
        await fs.rm(path.join(root,'model-plugin','service.lock'),{force:true});
        await new Promise(resolve=>server.close(resolve));
      });return;
    }
    res.writeHead(403).end();
  });
  await writePluginFixture(root,baseUrl);
  const {auxiliaryStatus,stopAuxiliary}=await import('../src/launcher/services.mjs');
  const status=await auxiliaryStatus(root);
  assert.deepEqual(status,{modelPluginRunning:true,modelPluginUnverified:false,canvasInstances:0,canvasUnverifiedInstances:0,instances:[{kind:'plugin',scope:'model-plugin',state:'healthy',live:true}]});
  assert.ok(!JSON.stringify(status).includes('fixture-token'));
  assert.deepEqual(await stopAuxiliary(root),{auxiliaryStopped:1});
  assert.equal(stopped,true);
  assert.deepEqual(await auxiliaryStatus(root),{modelPluginRunning:false,modelPluginUnverified:false,canvasInstances:0,canvasUnverifiedInstances:0,instances:[]});
});

test('live plugin with a 503 health endpoint is reported as unverified and is not sent stop',async t=>{
  const {root}=await fixture(t);let stopRequests=0;
  const {baseUrl}=await serviceServer(t,(req,res)=>{
    if(req.url==='/health'){res.writeHead(503,{'content-type':'application/json'}).end('{}');return;}
    if(req.url==='/studio/stop')stopRequests++;
    res.writeHead(404).end();
  });
  await writePluginFixture(root,baseUrl);
  const {auxiliaryStatus,stopAuxiliary}=await import('../src/launcher/services.mjs');
  const status=await auxiliaryStatus(root);
  assert.equal(status.modelPluginRunning,true);
  assert.equal(status.modelPluginUnverified,true);
  assert.deepEqual(status.instances,[{kind:'plugin',scope:'model-plugin',state:'unverified',live:true,reason:'health-http-503'}]);
  assert.ok(!JSON.stringify(status).includes('fixture-token'));
  await assert.rejects(stopAuxiliary(root),/仍有存活或所有者无法确认/);
  assert.equal(stopRequests,0);
});

test('live plugin with a mismatched health identity is visible and never receives stop',async t=>{
  const {root}=await fixture(t);let stopRequests=0;
  const {baseUrl}=await serviceServer(t,(req,res)=>{
    if(req.url==='/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify({service:'studio-model-plugin',instanceId:'different-instance'}));return;}
    if(req.url==='/studio/stop')stopRequests++;
    res.writeHead(404).end();
  });
  await writePluginFixture(root,baseUrl);
  const {auxiliaryStatus,stopAuxiliary}=await import('../src/launcher/services.mjs');
  const status=await auxiliaryStatus(root);
  assert.equal(status.modelPluginRunning,true);
  assert.deepEqual(status.instances,[{kind:'plugin',scope:'model-plugin',state:'unverified',live:true,reason:'identity-mismatch'}]);
  await assert.rejects(stopAuxiliary(root),/仍有存活或所有者无法确认/);
  assert.equal(stopRequests,0);
});

test('a live plugin lock remains visible when its instance record is missing',async t=>{
  const {root}=await fixture(t);
  const directory=path.join(root,'model-plugin');await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'service.lock'),JSON.stringify({pid:process.pid,instanceId:'orphan-plugin'}));
  const {auxiliaryStatus,stopAuxiliary}=await import('../src/launcher/services.mjs');
  const status=await auxiliaryStatus(root);
  assert.equal(status.modelPluginRunning,true);
  assert.deepEqual(status.instances,[{kind:'plugin',scope:'model-plugin',state:'unverified',live:true,reason:'record-missing'}]);
  await assert.rejects(stopAuxiliary(root),/仍有存活或所有者无法确认/);
});

test('stale plugin records are distinguished from live services and do not block stop',async t=>{
  const {spawn}=await import('node:child_process');
  const child=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});
  const deadPid=child.pid;
  await new Promise(resolve=>child.once('exit',resolve));
  const {root}=await fixture(t);
  await writePluginFixture(root,'http://127.0.0.1:1',{pid:deadPid,lockPid:deadPid});
  const {auxiliaryStatus,stopAuxiliary}=await import('../src/launcher/services.mjs');
  const status=await auxiliaryStatus(root);
  assert.equal(status.modelPluginRunning,false);
  assert.deepEqual(status.instances,[{kind:'plugin',scope:'model-plugin',state:'stale',live:false,reason:'process-exited'}]);
  assert.deepEqual(await stopAuxiliary(root),{auxiliaryStopped:0});
});

test('Canvas uses its supervisor lock to report a live unverified instance with a missing descriptor',async t=>{
  const {root}=await fixture(t);const directory=path.join(root,'canvas','fixture-project');
  await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'supervisor.lock'),JSON.stringify({pid:process.pid,instanceId:'fixture-canvas'}));
  const {auxiliaryStatus,stopAuxiliary}=await import('../src/launcher/services.mjs');
  const status=await auxiliaryStatus(root);
  assert.equal(status.canvasInstances,1);
  assert.equal(status.canvasUnverifiedInstances,1);
  assert.deepEqual(status.instances,[{kind:'canvas',scope:'canvas/fixture-project',state:'unverified',live:true,reason:'record-missing'}]);
  await assert.rejects(stopAuxiliary(root),/仍有存活或所有者无法确认/);
});

test('Canvas identity mismatch stays visible and its stop endpoint is not called',async t=>{
  const {root}=await fixture(t);const directory=path.join(root,'canvas','fixture-project');let stopRequests=0;
  await fs.mkdir(directory,{recursive:true});
  const {baseUrl}=await serviceServer(t,(req,res)=>{
    if(req.url==='/__studio/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify({instanceId:'other-canvas',projectId:'fixture-project'}));return;}
    if(req.url==='/__studio/stop')stopRequests++;
    res.writeHead(404).end();
  });
  await fs.writeFile(path.join(directory,'canvas-instance.json'),JSON.stringify({webUrl:baseUrl,token:'fixture-canvas-token',projectId:'fixture-project',instanceId:'fixture-canvas',pid:process.pid}));
  await fs.writeFile(path.join(directory,'supervisor.lock'),JSON.stringify({pid:process.pid,instanceId:'fixture-canvas'}));
  const {auxiliaryStatus,stopAuxiliary}=await import('../src/launcher/services.mjs');
  const status=await auxiliaryStatus(root);
  assert.equal(status.canvasInstances,1);
  assert.deepEqual(status.instances,[{kind:'canvas',scope:'canvas/fixture-project',state:'unverified',live:true,reason:'identity-mismatch'}]);
  assert.ok(!JSON.stringify(status).includes('fixture-canvas-token'));
  await assert.rejects(stopAuxiliary(root),/仍有存活或所有者无法确认/);
  assert.equal(stopRequests,0);
});

test('healthy Canvas instance stops through its authenticated supervisor endpoint',async t=>{
  const {root}=await fixture(t);const directory=path.join(root,'canvas','fixture-project');let stopped=false;
  await fs.mkdir(directory,{recursive:true});
  const {server,baseUrl}=await serviceServer(t,(req,res)=>{
    if(req.url==='/__studio/health'&&req.headers['x-studio-token']==='fixture-canvas-token'){
      res.setHeader('content-type','application/json');res.end(JSON.stringify({instanceId:'fixture-canvas',projectId:'fixture-project'}));return;
    }
    if(req.url==='/__studio/stop'&&req.headers['x-studio-token']==='fixture-canvas-token'){
      res.end('stopping');setImmediate(async()=>{
        stopped=true;
        await fs.rm(path.join(directory,'canvas-instance.json'),{force:true});
        await fs.rm(path.join(directory,'supervisor.lock'),{force:true});
        await new Promise(resolve=>server.close(resolve));
      });return;
    }
    res.writeHead(403).end();
  });
  await fs.writeFile(path.join(directory,'canvas-instance.json'),JSON.stringify({webUrl:baseUrl,token:'fixture-canvas-token',projectId:'fixture-project',instanceId:'fixture-canvas',pid:process.pid}));
  await fs.writeFile(path.join(directory,'supervisor.lock'),JSON.stringify({pid:process.pid,instanceId:'fixture-canvas'}));
  const {auxiliaryStatus,stopAuxiliary}=await import('../src/launcher/services.mjs');
  assert.equal((await auxiliaryStatus(root)).canvasInstances,1);
  assert.deepEqual(await stopAuxiliary(root),{auxiliaryStopped:1});
  assert.equal(stopped,true);
  assert.equal((await auxiliaryStatus(root)).canvasInstances,0);
});
