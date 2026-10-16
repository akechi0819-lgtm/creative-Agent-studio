import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { alive, readJson, runtimeStatus } from './control.mjs';

const ignored = (name, relative) => name === '.lock' || name.startsWith('.lock-') || name.endsWith('.lock') || name === '.write-lock'
  || /^(?:web\/(?:runtime\.json|service\.log)|model-plugin\/instance\.json|(?:canvas\/[^/]+\/)?(?:canvas-instance\.json|supervisor\.log))$/.test(relative);
const inside = (parent,child) => child===parent || child.startsWith(parent+path.sep);
async function digest(file) {
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(file))hash.update(chunk);
  return hash.digest('hex');
}
async function walk(directory,relative='') {
  const files=[];
  for(const entry of await fs.readdir(directory,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})) {
    const name=relative?`${relative}/${entry.name}`:entry.name;
    if(ignored(entry.name,name))continue;
    const full=path.join(directory,entry.name);
    if(entry.isSymbolicLink())throw new Error(`备份不跟随符号链接：${name}`);
    if(entry.isDirectory())files.push(...await walk(full,name));
    else if(entry.isFile())files.push({path:name,sha256:await digest(full),bytes:(await fs.stat(full)).size});
    else throw new Error(`备份遇到非普通文件：${name}`);
  }
  return files.sort((a,b)=>a.path.localeCompare(b.path));
}
export async function assertOffline(root) {
  if((await runtimeStatus(root)).running)throw new Error('请先 stop 工作台，再备份、恢复或更新。');
  async function check(directory) {
    for(const entry of await fs.readdir(directory,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})) {
      const full=path.join(directory,entry.name);
      if(entry.isSymbolicLink())throw new Error('数据目录存在符号链接，请先移出后维护。');
      if(entry.isDirectory())await check(full);
      else if(entry.name.endsWith('.lock')||entry.name==='.write-lock'||entry.name==='owner.json') {
        const owner=await readJson(full);
        if(owner?.pid&&alive(owner.pid))throw new Error('此数据目录仍有工作台、Canvas、插件或 CLI 操作运行，请先退出后维护。');
      }
    }
  }
  await check(root);
}
export async function backupData(root,destination) {
  root=path.resolve(root);destination=path.resolve(destination);
  if(inside(root,destination))throw new Error('备份目录必须位于用户数据目录之外。');
  await assertOffline(root);
  const files=await walk(root);
  const staging=`${destination}.pending-${randomUUID()}`;
  await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});
  if(await fs.lstat(destination).catch(e=>{if(e.code==='ENOENT')return null;throw e;}))throw new Error('备份目标已存在，不覆盖。');
  await fs.mkdir(staging,{mode:0o700});
  try {
    for(const file of files){
      const target=path.join(staging,'data',file.path);
      await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
      await fs.copyFile(path.join(root,file.path),target,fs.constants.COPYFILE_EXCL);
      await fs.chmod(target,0o600);
      if(await digest(target)!==file.sha256)throw new Error('备份时文件发生变化，请退出其他入口后重试。');
    }
    await assertOffline(root);
    if(JSON.stringify(await walk(root))!==JSON.stringify(files))throw new Error('备份时源目录发生变化，未生成可用备份。');
    await fs.writeFile(path.join(staging,'manifest.json'),JSON.stringify({format:1,createdAt:new Date().toISOString(),files},null,2),{mode:0o600});
    await fs.rename(staging,destination);
    return {
      backup: destination,
      files: files.length,
      containsPrivateConfig: true,
      canvasStorageIncluded: true,
      browserProfileIncluded: false,
    };
  } catch(e){await fs.rm(staging,{recursive:true,force:true});throw e;}
}
export async function restoreData(root,backup) {
  root=path.resolve(root);backup=path.resolve(backup);
  if(inside(root,backup)||inside(backup,root))throw new Error('恢复来源必须位于用户数据目录之外。');
  await assertOffline(root);
  const manifest=await readJson(path.join(backup,'manifest.json'));
  if(manifest?.format!==1||!Array.isArray(manifest.files))throw new Error('备份清单格式无效。');
  const paths=new Set();
  for(const file of manifest.files){
    if(typeof file.path!=='string'||file.path.includes('\\')||file.path.includes(':')||file.path.split('/').some(s=>!s||s==='.'||s==='..')||paths.has(file.path)||!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<0)throw new Error('备份清单路径或哈希无效。');
    paths.add(file.path);
  }
  const actual=await walk(path.join(backup,'data'));
  if(JSON.stringify(actual)!==JSON.stringify([...manifest.files].sort((a,b)=>a.path.localeCompare(b.path))))throw new Error('备份文件缺失、变化或多出文件，恢复已拒绝。');
  const staging=`${root}.restore-${randomUUID()}`;
  const rollback=`${root}.before-restore-${randomUUID()}`;
  await fs.mkdir(staging,{recursive:true,mode:0o700});
  let moved=false;
  try {
    for(const file of actual){
      const target=path.join(staging,file.path);
      await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
      await fs.copyFile(path.join(backup,'data',file.path),target,fs.constants.COPYFILE_EXCL);
      await fs.chmod(target,0o600);
      if(await digest(target)!==file.sha256)throw new Error('恢复复制校验失败，未替换当前数据。');
    }
    await assertOffline(root);
    try{await fs.rename(root,rollback);moved=true;}catch(e){if(e.code!=='ENOENT')throw e;}
    try{await fs.rename(staging,root);}catch(e){if(moved)await fs.rename(rollback,root);throw e;}
    return {restored:true,files:actual.length,previousData:moved?rollback:null};
  }finally{await fs.rm(staging,{recursive:true,force:true});}
}
