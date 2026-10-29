import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const stores=new Set(['app_state','image_files','image_previews','image_generation_logs','video_generation_logs','media_files']);
const maximumBytes=64*1024*1024;
const canvasStoreKey='infinite-canvas:canvas_store';

/** Different open projects save independently; a stale tab must not erase newer history. */
function mergeCanvasHistory(previous, incoming) {
  const decode=record=>JSON.parse(Buffer.from(record.base64,'base64').toString('utf8'));
  const next=decode(incoming);
  const before=previous?decode(previous):{state:{projects:[],deletedProjects:[]}};
  for(const value of [next,before]) {
    if(!Array.isArray(value.state?.projects)||!Array.isArray(value.state?.deletedProjects))throw new Error('invalid canvas history');
  }
  const projects=new Map();
  const deleted=new Map();
  for(const value of [before,next]) {
    for(const project of value.state.projects) {
      if(typeof project.id!=='string'||!Number.isFinite(Date.parse(project.updatedAt)))throw new Error('invalid canvas project');
      if(!projects.has(project.id)||project.updatedAt>=projects.get(project.id).updatedAt)projects.set(project.id,project);
    }
    for(const item of value.state.deletedProjects) {
      if(typeof item.id!=='string'||!Number.isFinite(Date.parse(item.deletedAt)))throw new Error('invalid deleted project');
      if(!deleted.has(item.id)||item.deletedAt>=deleted.get(item.id).deletedAt)deleted.set(item.id,item);
    }
  }
  for(const [id,project] of projects)if(deleted.has(id)&&deleted.get(id).deletedAt>=project.updatedAt)projects.delete(id);
  next.state.projects=[...projects.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  next.state.deletedProjects=[...deleted.values()];
  return {...incoming,base64:Buffer.from(JSON.stringify(next)).toString('base64')};
}

/** Private shared-workspace persistence. No model credentials or browser profile is copied. */
export function canvasStorageHandler({data,authorize}) {
  const writes=new Map();
  return async(req,res,url)=>{
    if(!url.pathname.startsWith('/__studio/storage/'))return false;
    res.setHeader('cache-control','no-store');
    if(!authorize(req)){res.writeHead(403).end();return true;}
    try{
      const parts=url.pathname.slice('/__studio/storage/'.length).split('/');
      const store=parts[0];const key=parts.length===2?decodeURIComponent(parts[1]):null;
      if(!stores.has(store)||parts.length>2||key!==null&&(!key||key.length>1000))throw new Error('invalid storage key');
      const directory=path.join(data,'storage',store);
      const filename=key===null?null:path.join(directory,createHash('sha256').update(key).digest('hex')+'.json');
      if(req.method==='GET'&&key===null){
        const entries=await fs.readdir(directory).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
        const keys=[];
        for(const entry of entries.filter(e=>/^[a-f0-9]{64}\.json$/.test(e))){const value=JSON.parse(await fs.readFile(path.join(directory,entry),'utf8'));keys.push(value.key);}
        res.setHeader('content-type','application/json');res.end(JSON.stringify(keys.sort()));
      }else if(req.method==='GET'){
        let value;try{value=JSON.parse(await fs.readFile(filename,'utf8'));}catch(e){if(e.code==='ENOENT'){res.writeHead(404).end();return true;}throw e;}
        if(value.key!==key)throw new Error('storage identity mismatch');
        res.setHeader('content-type',value.contentType);res.end(Buffer.from(value.base64,'base64'));
      }else if(req.method==='PUT'&&key!==null){
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>maximumBytes)throw new Error('storage size limit');chunks.push(chunk);}
        const contentType=String(req.headers['content-type']||'application/octet-stream');
        if(contentType.length>200||/[\r\n]/.test(contentType))throw new Error('invalid content type');
        let record={key,contentType,base64:Buffer.concat(chunks).toString('base64')};
        const write=(writes.get(filename)||Promise.resolve()).then(async()=>{
          if(store==='app_state'&&key===canvasStoreKey){
            let before;
            try{before=JSON.parse(await fs.readFile(filename,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
            record=mergeCanvasHistory(before,record);
          }
          await fs.mkdir(directory,{recursive:true,mode:0o700});
          const temporary=filename+'.'+randomUUID()+'.tmp';
          try{await fs.writeFile(temporary,JSON.stringify(record),{mode:0o600,flag:'wx'});await fs.rename(temporary,filename);}finally{await fs.rm(temporary,{force:true});}
        });
        const settled=write.catch(()=>{});writes.set(filename,settled);
        try{await write;}finally{if(writes.get(filename)===settled)writes.delete(filename);}
        res.end('{}');
      }else if(req.method==='DELETE'&&key!==null){await fs.rm(filename,{force:true});res.end('{}');}
      else res.writeHead(405).end();
    }catch{if(!res.headersSent)res.writeHead(400).end();else res.destroy();}
    return true;
  };
}
