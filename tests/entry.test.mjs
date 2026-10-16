import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import {createTask,setBrief,readTask} from '../src/creative/tasks.mjs';
import {acquireTaskEntry,clearTaskEntry,taskEntryStatus} from '../src/creative/entry.mjs';

async function childOwns(root,id,kind){
 const entry=new URL('../src/creative/entry.mjs',import.meta.url).href;
 const tasks=new URL('../src/creative/tasks.mjs',import.meta.url).href;
 const source=kind==='entry'?`import {acquireTaskEntry} from ${JSON.stringify(entry)};const release=await acquireTaskEntry(process.argv[2],process.argv[1]);console.log('ready');process.stdin.once('data',async()=>{await release();process.exit(0)});`:`import {withTask} from ${JSON.stringify(tasks)};await withTask(process.argv[2],async()=>{console.log('ready');await new Promise(r=>process.stdin.once('data',r));},{root:process.argv[1]});`;
 const child=spawn(process.execPath,['--input-type=module','-e',source,root,id],{stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr.on('data',c=>stderr+=c);
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(new Error('child failed: '+stderr)));});
 return child;
}
async function fixture(t){const root=await mkdtemp(os.tmpdir()+'/studio-p3-entry-');t.after(()=>rm(root,{recursive:true,force:true}));return {root,task:await createTask({title:'入口互斥',brief:'原需求'},root)};}

test('whole Web turn blocks another process core writer, while reads stay available',async t=>{
 const {root,task}=await fixture(t);const child=await childOwns(root,task.id,'entry');
 t.after(()=>{if(child.exitCode===null)child.kill();});
 await assert.rejects(setBrief(task.id,'错误并发',{root,expectedRevision:task.revision}),e=>e.code==='ERR_TASK_ENTRY_BUSY');
 assert.deepEqual(await readTask(task.id,root),task);
 assert.equal((await taskEntryStatus(task.id,{root})).alive,true);
 const done=once(child,'exit');child.stdin.end('release');await done;
 const next=await setBrief(task.id,'正常接续',{root,expectedRevision:task.revision});assert.equal(next.brief,'正常接续');
});

test('entry acquisition rejects an active external core transaction without leaving a lease',async t=>{
 const {root,task}=await fixture(t);const child=await childOwns(root,task.id,'core');
 t.after(()=>{if(child.exitCode===null)child.kill();});
 await assert.rejects(acquireTaskEntry(task.id,root),e=>e.code==='ERR_TASK_ENTRY_BUSY');
 assert.equal(await taskEntryStatus(task.id,{root}),null);
 const done=once(child,'exit');child.stdin.end('release');await done;
 const release=await acquireTaskEntry(task.id,root);await release();
});

test('dead entry must be checked explicitly before release, and live owner cannot be cleared',async t=>{
 const {root,task}=await fixture(t);const child=await childOwns(root,task.id,'entry');
 const pid=child.pid;
 await assert.rejects(clearTaskEntry(task.id,{root,deadPid:pid}),e=>e.code==='ERR_TASK_ENTRY_BUSY');
 const done=once(child,'exit');child.kill('SIGKILL');await done;
 await assert.rejects(setBrief(task.id,'不能静默接管',{root,expectedRevision:task.revision}),e=>e.code==='ERR_TASK_ENTRY_BUSY');
 assert.equal((await clearTaskEntry(task.id,{root,deadPid:pid})).cleared,true);
 await setBrief(task.id,'明确恢复',{root,expectedRevision:task.revision});
});
