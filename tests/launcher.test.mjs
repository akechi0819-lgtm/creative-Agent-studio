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

test('abnormal workbench exit can stop only authenticated residual services in its data root',async t=>{
  const {root}=await fixture(t);
  const {createServer}=await import('node:http');
  const {auxiliaryStatus,stopAuxiliary}=await import('../src/launcher/services.mjs');
  const server=createServer((req,res)=>{
    assert.equal(req.headers.authorization,'Bearer fixture-token');
    if(req.url==='/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify({service:'studio-model-plugin',instanceId:'fixture-plugin'}));}
    else if(req.url==='/studio/stop'){res.end('{}');server.close();}
    else res.writeHead(404).end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  await fs.mkdir(path.join(root,'model-plugin'));
  await fs.writeFile(path.join(root,'model-plugin','instance.json'),JSON.stringify({baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'fixture-token',instanceId:'fixture-plugin'}));
  assert.deepEqual(await auxiliaryStatus(root),{modelPluginRunning:true,canvasInstances:0});
  assert.deepEqual(await stopAuxiliary(root),{auxiliaryStopped:1});
  assert.deepEqual(await auxiliaryStatus(root),{modelPluginRunning:false,canvasInstances:0});
});
