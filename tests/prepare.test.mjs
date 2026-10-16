import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareWorkspace } from '../src/launcher/prepare.mjs';
import { buildTargets, captureBuildInputs } from '../src/launcher/builds.mjs';

const groups = ['.', 'third_party/canvas/canvas-agent', 'third_party/canvas/web', 'adapters/dsh'];
async function put(root, name, value) {
  const file = path.join(root, name); await fs.mkdir(path.dirname(file), {recursive:true}); await fs.writeFile(file, value);
}
async function packageGroup(root, group, version = '1.0.0', installed = true) {
  const base = path.join(root, group);
  const pkg = {name:'prepare-fixture',version:'1.0.0',dependencies:{'fixture-dependency':version}};
  await put(base, 'package.json', JSON.stringify(pkg));
  await put(base, 'package-lock.json', JSON.stringify({name:pkg.name,version:pkg.version,lockfileVersion:3,requires:true,packages:{'':pkg,'node_modules/fixture-dependency':{version,resolved:`https://example.invalid/fixture-${version}.tgz`}}}));
  if (installed) await installGroup(base);
}
async function installGroup(base) {
  const lock = JSON.parse(await fs.readFile(path.join(base,'package-lock.json'),'utf8'));
  const version=lock.packages['node_modules/fixture-dependency'].version;
  await put(base,'node_modules/fixture-dependency/package.json',JSON.stringify({name:'fixture-dependency',version,main:'index.js'}));
  await put(base,'node_modules/fixture-dependency/index.js','module.exports = true;');
}
async function emitBuild(root,target) {
  const files=new Set(target.output.requiredFiles);
  if(target.output.htmlEntry) {
    files.add(path.posix.join(target.output.directory,'assets/app.js'));
  }
  if(target.output.typescriptSources) {
    for(const file of (await captureBuildInputs(root,target)).files) {
      if(file.path.startsWith(target.output.typescriptSources+'/')&&file.path.endsWith('.ts')&&!file.path.endsWith('.d.ts')) {
        const base=file.path.slice(target.output.typescriptSources.length+1,-3);
        files.add(path.posix.join(target.output.directory,base+'.js'));
        files.add(path.posix.join(target.output.directory,base+'.d.ts'));
      }
    }
  }
  for(const file of files) await put(root,file,file.endsWith('.html')?'<script type="module" src="/assets/app.js"></script>':'export {};');
}
async function fixture(t,{installed=true,outputs=true}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-prepare-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const group of groups) await packageGroup(root,group,'1.0.0',installed);
  for(const target of buildTargets) {
    for(const file of target.inputFiles) {
      if(!file.endsWith('package.json')&&!file.endsWith('package-lock.json')) await put(root,file,'// fixture build input');
    }
    for(const directory of target.inputDirs) {
      const dir=typeof directory==='string'?directory:directory.path;
      await put(root,path.posix.join(dir,target.id==='CanvasAgent'?'index.ts':'main.js'),'export {};');
    }
  }
  // Known, complete developer outputs newer than all their inputs can be adopted.
  for(const target of buildTargets) for(const file of (await captureBuildInputs(root,target)).files) await fs.utimes(path.join(root,file.path),new Date(0),new Date(0));
  if(outputs) for(const target of buildTargets) await emitBuild(root,target);
  const installs=[],builds=[];
  let failInstall,failBuild,onBuild;
  const operations={
    npm:async(args,cwd)=>{
      const group=path.relative(root,cwd).split(path.sep).join('/')||'.';
      if(args[0]==='ci') {
        installs.push(group);
        if(failInstall===group){failInstall=null;throw new Error('fixture interrupted install');}
        await installGroup(cwd);
      } else {
        const target=buildTargets.find(v=>v.cwd===group&&JSON.stringify(v.npmArgs)===JSON.stringify(args));
        assert.ok(target); await build(target);
      }
    },
    node:async(args)=>{const target=buildTargets.find(v=>path.join(root,v.nodeScript||'')===args[0]);assert.ok(target);await build(target);},
    python:async()=>({skipped:true,fingerprint:'verified-python-fixture',pythonExecutable:path.join(root,'.venv-ocr','bin','python')}),
  };
  async function build(target) {
    builds.push(target.id);
    if(failBuild===target.id){failBuild=null;throw new Error('fixture interrupted build');}
    await emitBuild(root,target); await onBuild?.(target);
  }
  return {root,installs,builds,operations,run:options=>prepareWorkspace({root,operations,...options}),failInstall:group=>{failInstall=group;},failBuild:id=>{failBuild=id;},onBuild:fn=>{onBuild=fn;}};
}

test('existing developer dependencies and complete outputs are adopted without a ledger, and the second start installs nothing',async t=>{
  const f=await fixture(t);const first=await f.run();const second=await f.run();
  assert.equal(first.skipped,true);assert.equal(second.skipped,true);assert.deepEqual(f.installs,[]);assert.deepEqual(f.builds,[]);
  const state=JSON.parse(await fs.readFile(path.join(f.root,'.studio-runtime/prepare-state.json'),'utf8'));
  assert.equal(state.status,'ready');assert.equal(Object.keys(state.dependencies).length,4);assert.equal(Object.keys(state.builds).length,5);
});
test('release preparation can defer Python without calling its operation or claiming it is ready',async t=>{
  const f=await fixture(t);let pythonCalls=0;
  f.operations.python=async()=>{pythonCalls+=1;throw new Error('Python must remain deferred');};
  const result=await f.run({includePython:false});
  const state=JSON.parse(await fs.readFile(path.join(f.root,'.studio-runtime/prepare-state.json'),'utf8'));
  assert.equal(result.pythonDeferred,true);assert.equal(result.python,null);assert.equal(pythonCalls,0);
  assert.deepEqual(state.python,{status:'deferred',reason:'release-first-start'});
  assert.equal(result.skipped,true);
});
test('backend-only edits cause no installation or build; frontend-only edits rebuild only their component',async t=>{
  const f=await fixture(t);await f.run();await put(f.root,'src/business.mjs','export const changed=true;');await f.run();
  assert.deepEqual(f.builds,[]);await put(f.root,'web/src/main.js','export const ui=2;');await f.run();
  assert.deepEqual(f.installs,[]);assert.deepEqual(f.builds,['StudioWeb']);
});
test('a changed dependency group installs only that group and rebuilds only its dependent output',async t=>{
  const f=await fixture(t);await f.run();await packageGroup(f.root,'third_party/canvas/canvas-agent','2.0.0',false);await f.run();
  assert.deepEqual(f.installs,['third_party/canvas/canvas-agent']);assert.deepEqual(f.builds,['CanvasAgent']);
});
test('one missing output rebuilds its component without reinstalling dependencies or OCR',async t=>{
  const f=await fixture(t);await f.run();await fs.rm(path.join(f.root,'adapters/dsh/lib/client.js'));await f.run();
  assert.deepEqual(f.installs,[]);assert.deepEqual(f.builds,['DSH']);
});
test('partial installation failure keeps completed groups for retry',async t=>{
  const f=await fixture(t,{installed:false,outputs:false});f.failInstall('third_party/canvas/canvas-agent');
  await assert.rejects(f.run(),/interrupted install/);await f.run();
  assert.equal(f.installs.filter(v=>v==='.').length,1);
  assert.equal(f.installs.filter(v=>v==='third_party/canvas/canvas-agent').length,2);
  const before=[...f.installs];await f.run();assert.deepEqual(f.installs,before);
});
test('partial build failure retries only unfinished outputs and preserves successful dependency validation',async t=>{
  const f=await fixture(t,{outputs:false});f.failBuild('CanvasWeb');await assert.rejects(f.run(),/interrupted build/);await f.run();
  assert.deepEqual(f.installs,[]);assert.equal(f.builds.filter(v=>v==='StudioWeb').length,1);assert.equal(f.builds.filter(v=>v==='CanvasAgent').length,1);
  assert.equal(f.builds.filter(v=>v==='CanvasWeb').length,2);
});
test('a Node patch metadata change does not reinstall or rebuild working components',async t=>{
  const f=await fixture(t);await f.run();const file=path.join(f.root,'.studio-runtime/prepare-state.json');
  const state=JSON.parse(await fs.readFile(file,'utf8'));state.nodeVersion='22.0.0';await fs.writeFile(file,JSON.stringify(state));await f.run();
  assert.deepEqual(f.installs,[]);assert.deepEqual(f.builds,[]);
});
test('unrelated edits during a build do not invalidate it, while edits to its own inputs prevent a false ready stamp',async t=>{
  const f=await fixture(t);await f.run();await put(f.root,'web/src/main.js','export const ui=3;');
  f.onBuild(()=>put(f.root,'src/business.mjs','export const changed=3;'));await f.run();
  await put(f.root,'web/src/main.js','export const ui=4;');f.onBuild(()=>put(f.root,'web/src/main.js','export const ui=5;'));
  await assert.rejects(f.run(),/源码在构建期间变化/);f.onBuild(null);await f.run();assert.deepEqual(f.installs,[]);
});
test('explicit update rebuilds outputs while retaining healthy dependency groups and Python',async t=>{
  const f=await fixture(t);await f.run();await f.run({force:true});
  assert.deepEqual(f.installs,[]);assert.deepEqual(f.builds,buildTargets.map(v=>v.id));
});
test('an active source instance permits verified reuse but prevents changing build outputs',async t=>{
  const f=await fixture(t);await f.run();
  await put(f.root,'.studio-runtime/servers/fixture.json',JSON.stringify({pid:process.pid}));
  assert.equal((await f.run()).skipped,true);
  await put(f.root,'web/src/main.js','export const changed=10;');
  await assert.rejects(f.run(),/正在运行/);assert.deepEqual(f.installs,[]);assert.deepEqual(f.builds,[]);
});
test('a verification failure without evidence of missing dependencies does not trigger installation',async t=>{
  const f=await fixture(t);
  f.operations.checkDependencies=async()=>({ready:false,repairable:false,reason:'fixture validator unavailable'});
  await assert.rejects(f.run(),/无法完成依赖验证，未尝试重装/);
  assert.deepEqual(f.installs,[]);assert.deepEqual(f.builds,[]);
});
