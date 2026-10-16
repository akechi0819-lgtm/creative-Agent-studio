import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const stores=new Set(['app_state','image_files','image_previews','image_generation_logs','video_generation_logs','media_files']);
const maximumBytes=64*1024*1024;
/** Private, task-scoped persistence. No model credentials or browser profile is copied. */
export function canvasStorageHandler({data,authorize}) {
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
        const record={key,contentType,base64:Buffer.concat(chunks).toString('base64')};
        await fs.mkdir(directory,{recursive:true,mode:0o700});
        const temporary=filename+'.'+randomUUID()+'.tmp';
        try{await fs.writeFile(temporary,JSON.stringify(record),{mode:0o600,flag:'wx'});await fs.rename(temporary,filename);}finally{await fs.rm(temporary,{force:true});}
        res.end('{}');
      }else if(req.method==='DELETE'&&key!==null){await fs.rm(filename,{force:true});res.end('{}');}
      else res.writeHead(405).end();
    }catch{if(!res.headersSent)res.writeHead(400).end();else res.destroy();}
    return true;
  };
}
