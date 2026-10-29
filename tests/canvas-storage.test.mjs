import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {canvasStorageHandler} from '../src/canvas/storage.mjs';

test('stale open canvases cannot erase other projects or resurrect a deleted history entry',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'shared-history-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const handler=canvasStorageHandler({data:root,authorize:()=>true});
  const server=createServer((req,res)=>void handler(req,res,new URL(req.url,'http://localhost')));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/__studio/storage/app_state/${encodeURIComponent('infinite-canvas:canvas_store')}`;
  const project=(id,second)=>({id,updatedAt:`2026-10-29T12:00:${second}.000Z`,nodes:[]});
  const write=async(projects,deletedProjects=[])=>{
    const response=await fetch(url,{method:'PUT',headers:{'content-type':'application/vnd.creative-agent-studio.localforage-string'},body:JSON.stringify({state:{projects,deletedProjects},version:0})});
    assert.equal(response.status,200);
  };
  await write([project('A','00')]);
  await Promise.all([write([project('A','02')]),write([project('A','00'),project('B','01')])]);
  let value=await fetch(url).then(r=>r.json());
  assert.deepEqual(value.state.projects.map(p=>p.id),['A','B']);
  assert.equal(value.state.projects[0].updatedAt,project('A','02').updatedAt);
  await write([project('B','01')],[{id:'A',deletedAt:'2026-10-29T12:00:03.000Z'}]);
  await write([project('A','02'),project('B','04')]);
  value=await fetch(url).then(r=>r.json());
  assert.deepEqual(value.state.projects.map(p=>p.id),['B']);
});

test('shared Canvas bytes persist across sessions, independent storage handlers with private authorization',async t=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'studio-canvas-storage-'));
  const root=path.join(base,'data');await fs.mkdir(root);
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  let handler=canvasStorageHandler({data:root,authorize:req=>req.headers.cookie==='fixture=session'});
  const server=createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url,'http://localhost')))res.writeHead(404).end();});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const url=`http://127.0.0.1:${server.address().port}/__studio/storage/image_files/`+encodeURIComponent('image:../测试');
  assert.equal((await fetch(url)).status,403);
  const bytes=Buffer.from([1,0,254,33,128]);
  assert.equal((await fetch(url,{method:'PUT',headers:{cookie:'fixture=session','content-type':'image/png'},body:bytes})).status,200);
  handler=canvasStorageHandler({data:root,authorize:req=>req.headers.cookie==='fixture=session'});
  const restored=await fetch(url,{headers:{cookie:'fixture=session'}});
  assert.equal(restored.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await restored.arrayBuffer()),bytes);
  const keys=await fetch(url.slice(0,url.lastIndexOf('/')),{headers:{cookie:'fixture=session'}}).then(r=>r.json());
  assert.deepEqual(keys,['image:../测试']);
});
