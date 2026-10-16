import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTask,setReferences,attachTaskFiles,readTask,confirmInputs,taskDirectory} from '../src/creative/tasks.mjs';
import {importAsset,cleanAsset,confirmAsset,deleteAsset} from '../src/assets/library.mjs';

async function fixture(t){const root=await mkdtemp(os.tmpdir()+'/studio-p3-reference-');t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('mixed references use one CAS, keep hidden frozen files through later decisions and library deletion',async t=>{
 const root=await fixture(t);const file=path.join(root,'source.txt');await writeFile(file,'历史结构参考');
 let asset=await importAsset({title:'库参考',files:[{path:file}]},{root});
 asset=await cleanAsset(asset.id,{root,expectedRevision:asset.revision,cleaner:async input=>({...input,summary:'历史结构',tags:['阅读'],fileResults:[]})});
 asset=await confirmAsset(asset.id,{by:'测试用户',note:'隔离素材确认'},{root,expectedRevision:asset.revision});
 let task=await createTask({title:'混合参考',brief:'只借鉴结构'},root);
 const common={decision:'retained',purpose:'结构',factBoundary:'不能当当前政策'};
 const revision=task.revision;
 task=await setReferences(task.id,[{kind:'asset',assetId:asset.id,assetRevision:asset.revision,...common},{kind:'external',id:'current',title:'当前资料',body:'当前产品的真实资料',...common}],{root,expectedRevision:revision});
 assert.equal(task.revision,revision+1);assert.equal(task.sources.length,2);
 const frozen=structuredClone(task.sources[0].files);
 await deleteAsset(asset.id,{root,expectedRevision:asset.revision});
 task=await setReferences(task.id,task.sources.map(source=>({kind:'existing',id:source.id,...common,decision:'excluded'})),{root,expectedRevision:task.revision});
 assert.deepEqual(task.sources[0].files,frozen);
 assert.equal(await readFile(path.join(taskDirectory(task.id,root),frozen[0].relativePath),'utf8'),'历史结构参考');
 await assert.rejects(setReferences(task.id,[],{root,expectedRevision:revision}));
 assert.equal((await readTask(task.id,root)).sources.length,2);
});

test('task attachment remains local, needs decision, preserves bytes and invalidates old input confirmation',async t=>{
 const root=await fixture(t);const file=path.join(root,'current.md');await writeFile(file,'本次业务资料');
 let task=await createTask({title:'附件',brief:'任务需求'},root);
 task=await confirmInputs(task.id,{revision:task.revision,by:'测试用户',note:'先确认空清单'},{root});
 task=await attachTaskFiles(task.id,{files:[{name:'current.md',path:file,mimeType:'text/markdown'}],extractions:[{name:'current.md',status:'extracted',text:'本次业务资料'}]},{root,expectedRevision:task.revision});
 assert.equal(task.inputConfirmation,null);assert.equal(task.sources[0].decision,'pending');
 assert.equal(task.sources[0].type,'current_attachment');
 const frozen=structuredClone(task.sources[0]);
 task=await setReferences(task.id,[{kind:'existing',id:frozen.id,purpose:frozen.purpose,factBoundary:frozen.factBoundary,decision:'retained'}],{root,expectedRevision:task.revision});
 assert.deepEqual(task.sources[0].files,frozen.files);assert.deepEqual(task.sources[0].extractions,frozen.extractions);
 await writeFile(file,'上传后改变外部文件');
 assert.equal(await readFile(path.join(taskDirectory(task.id,root),task.sources[0].files[0].relativePath),'utf8'),'本次业务资料');
});

test('mixed reference failure commits no decisions, blocks client file paths and unknown snapshot IDs',async t=>{
 const root=await fixture(t);const task=await createTask({title:'拒绝伪造',brief:'任务'},root);
 const common={purpose:'参考',factBoundary:'待核'};
 await assert.rejects(setReferences(task.id,[{kind:'external',title:'非法路径',body:'资料',files:[{relativePath:'config/studio.json'}],...common}],{root,expectedRevision:task.revision}));
 await assert.rejects(setReferences(task.id,[{kind:'existing',id:'不存在',...common}],{root,expectedRevision:task.revision}));
 assert.deepEqual(await readTask(task.id,root),task);
});

test('external links reject credential query and fragment keys including encoded names',async t=>{
 const root=await fixture(t);const task=await createTask({title:'安全外部链接',brief:'当前资料'},root);
 for(const suffix of ['?token=fixture-secret','?api_key=fixture-secret','?%74oken=fixture-secret','#access_token=fixture-secret']){
   await assert.rejects(setReferences(task.id,[{kind:'external',title:'参考',url:'https://example.invalid/page'+suffix,purpose:'参考',factBoundary:'待核'}],{root,expectedRevision:task.revision}),/敏感认证参数/);
   assert.equal((await readTask(task.id,root)).revision,task.revision);
 }
 const safe=await setReferences(task.id,[{kind:'external',title:'公开资料',url:'https://example.invalid/page?utm_source=studio#section',purpose:'公开资料',factBoundary:'由用户核对'}],{root,expectedRevision:task.revision});
 assert.equal(safe.sources.length,1);
});
