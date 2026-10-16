import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {planFolderImport,importFolder} from '../src/assets/folders.mjs';
import {listAssets} from '../src/assets/library.mjs';
import {listenStudioServer} from '../src/web/server.mjs';

test('folder import groups articles, preserves natural image order, and rejects traversal/duplicate labels',()=>{
  const plan=planFolderImport(['总目录/甲篇/10.png','总目录/乙篇/正文.txt','总目录/甲篇/2.png','总目录/甲篇/1.png','总目录/.DS_Store']);
  assert.equal(plan.entries.length,2);assert.deepEqual(plan.entries.find(e=>e.title==='甲篇').files.map(f=>f.name),['1.png','2.png','10.png']);assert.equal(plan.ignored.length,1);
  for(const names of [['/Users/a/x.png'],['root/../x.png'],['root/a.png','root/a.png'],['C:\\root\\a.png']])assert.throws(()=>planFolderImport(names));
});

test('Web folder endpoint accepts 13 article directories / 85 files as separate assets, with replay protection',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-folder-api-'));
  const app=await listenStudioServer({root,port:0});
  t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${app.address.port}`,batchId=crypto.randomUUID();
  const png=await fs.readFile(new URL('../adapters/dsh/connection-check.png',import.meta.url));
  const paths=[];for(let i=0;i<13;i++)for(let j=1;j<=(i<7?7:6);j++)paths.push(`选中文件夹/第${i+1}篇/${j}.png`);
  const upload=async(labels=paths,id=batchId)=>{const form=new FormData();form.set('paths',JSON.stringify(labels));form.set('batchId',id);for(const name of labels)form.append('files',new Blob([png],{type:'image/png'}),path.posix.basename(name));const response=await fetch(url+'/api/assets/import-folder',{method:'POST',headers:{origin:url},body:form});return{response,body:await response.json()};};
  const first=await upload();assert.equal(first.response.status,201);assert.deepEqual(first.body.totals,{articles:13,staged:13,failed:0,files:85});
  assert.equal(first.body.entries.every(e=>e.asset.status==='staged'),true);assert.equal(JSON.stringify(first.body).includes(root),false);
  const replay=await upload();assert.deepEqual(replay.body.entries.map(e=>e.asset.id),first.body.entries.map(e=>e.asset.id));
  assert.equal((await listAssets({confirmedOnly:false},{root})).length,13);
  const bad=await upload(['选中文件夹/../1.png'],crypto.randomUUID());assert.equal(bad.response.status,400);
  assert.equal((await listAssets({confirmedOnly:false},{root})).length,13);
});

test('batch originals remain separate staged assets with text, partial failure, and idempotent retry',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-folder-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const names=['总目录/甲篇/2.png','总目录/甲篇/1.png','总目录/甲篇/正文.txt','总目录/乙篇/1.png','总目录/坏篇/正文.txt'];
  const png=await fs.readFile(new URL('../adapters/dsh/connection-check.png',import.meta.url));
  const files=[];
  for(const [i,label] of names.entries()){const file=path.join(root,`input-${i}`);await fs.writeFile(file,label.includes('坏篇')?'apiKey: sk-credentialshouldneverbeimported12345':label.endsWith('.txt')?'本篇正文':png);files.push({path:file,name:path.posix.basename(label)});}
  const batchId=crypto.randomUUID(),first=await importFolder({root,files,paths:names,batchId});
  assert.equal(first.totals.staged,2);assert.equal(first.totals.failed,1);
  const article=first.entries.find(e=>e.title==='甲篇').asset;
  assert.equal(article.status,'staged');assert.equal(article.body,'本篇正文');assert.deepEqual(article.files.map(f=>f.name),['1.png','2.png','正文.txt']);
  assert.equal((await listAssets({confirmedOnly:false},{root})).length,2);
  const again=await importFolder({root,files,paths:names,batchId});assert.deepEqual(again.entries.map(e=>e.asset?.id),first.entries.map(e=>e.asset?.id));
  assert.equal((await listAssets({confirmedOnly:false},{root})).length,2);
  await fs.writeFile(files[0].path,'changed');await assert.rejects(importFolder({root,files,paths:names,batchId}),e=>e.statusCode===409);
  assert.equal(JSON.stringify(first).includes('sk-credential'),false);
});
