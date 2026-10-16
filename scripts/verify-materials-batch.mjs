#!/usr/bin/env node
// Real batch validation: originals are read-only; reports never contain model credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {importAsset,readAsset,cleanAsset,confirmAsset,queryAssets,recoverClean} from '../src/assets/library.mjs';
import {dataRoot} from '../src/canvas/client.mjs';
import {cleanMaterial} from '../src/assets/cleaner.mjs';

async function readTestConfig(envPath, sourcePath) {
  if(envPath.endsWith('.json')) {
    const value=JSON.parse(await fs.readFile(envPath,'utf8'));
    if(!value.baseUrl || !value.model || !value.apiKey) throw new Error('模型配置不完整');
    return {baseUrl:value.baseUrl,model:value.model,apiKey:value.apiKey};
  }
  const text = await fs.readFile(envPath,'utf8');
  const values = {};
  for(const raw of text.split(/\r?\n/)) {
    const line=raw.trim().replace(/^export\s+/,'');
    if(!line || line.startsWith('#')) continue;
    const i=line.indexOf('=');if(i<1)continue;
    values[line.slice(0,i).trim()]=line.slice(i+1).trim().replace(/^(['"])(.*)\1$/,'$2');
  }
  const source = await fs.readFile(sourcePath,'utf8');
  const defaultValue = key => source.match(new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']`,'m'))?.[1] ?? '';
  const config={baseUrl:values.CLEAN_LLM_BASE_URL || values.MIMO_BASE_URL || values.XIAOMI_BASE_URL || defaultValue('DEFAULT_BASE'),model:values.CLEAN_LLM_MODEL || values.MIMO_MODEL || defaultValue('DEFAULT_MODEL'),apiKey:values.CLEAN_LLM_API_KEY || values.MIMO_API_KEY || values.XIAOMI_API_KEY || ''};
  if(!config.baseUrl || !config.model || !config.apiKey)throw new Error('模型配置不完整');
  return config;
}
const hash = bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const [selectionPath,modelEnvPath,modelSourcePath]=process.argv.slice(2);
if(!selectionPath || !modelEnvPath || (!modelEnvPath.endsWith('.json') && !modelSourcePath)) {
  console.error('用法：node scripts/verify-materials-batch.mjs SELECTION_JSON AUTHORIZED_CONFIG_JSON 或 SELECTION_JSON AUTHORIZED_MODEL_ENV MODEL_SOURCE（仅经用户授权的测试）');
  process.exit(2);
}
const controller=new AbortController();
const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
let batchDirectory;
try {
  batchDirectory=path.dirname(path.resolve(selectionPath));
  const {selected}=JSON.parse(await fs.readFile(selectionPath,'utf8'));
  const config=await readTestConfig(modelEnvPath,modelSourcePath);
  const manifestPath=path.join(batchDirectory,'batch.json');
  let manifest;
  try {manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;manifest={startedAt:new Date().toISOString(),model:config.model,selectionCount:selected.length,entries:[]};}
  manifest.model=config.model;
  const save=async()=>{const temporary=`${manifestPath}.${crypto.randomUUID()}.tmp`;await fs.writeFile(temporary,JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});await fs.rename(temporary,manifestPath);};
  for(const [index,input] of selected.entries()) {
    controller.signal.throwIfAborted();
    let entry=manifest.entries.find(item=>item.index===index);
    if(!entry){
      const originals=[];
      for(const file of input.files) originals.push({name:file.name,path:file.path,sha256:hash(await fs.readFile(file.path))});
      const asset=await importAsset(input);
      entry={index,assetId:asset.id,title:input.title,originals,status:asset.status};
      manifest.entries.push(entry);await save();
    }
    let asset=await readAsset(entry.assetId);
    if(asset.status==='confirmed'){entry.status=asset.status;continue;}
    if(asset.status==='cleaning'){
      try {asset=await recoverClean(asset.id,{deadPid:asset.cleaningJob?.pid,expectedRevision:asset.revision});}
      catch {entry.status='needs_interrupted_job_recovery';await save();continue;}
    }
    if(asset.status!=='needs_review'){
      try {asset=await cleanAsset(asset.id,{expectedRevision:asset.revision,config,signal:controller.signal,cleaner:async(input,options)=>{try{return await cleanMaterial(input,options);}catch(error){console.log(JSON.stringify({index,stage:'cleaner',errorCode:typeof error.code==='string'?error.code:'CLEANING_FAILED'}));throw error;}}});}
      catch {asset=await readAsset(asset.id);}
    }
    entry.status=asset.status;entry.revision=asset.revision;
    if(asset.status==='needs_review'){
      const count=asset.extractions.length;
      const expected=input.files.length;
      if(count!==expected){entry.status='review_file_count_mismatch';await save();continue;}
      if(!asset.summary.trim() || !asset.tags.length){entry.status='review_empty_model_result';await save();continue;}
      // User expressly authorized cleaning + ingestion of this historical-material test batch.
      asset=await confirmAsset(asset.id,{by:'用户',note:'用户于2026-10-14直接指定目录并授权本批历史素材清洗后入库；本记录为批量测试授权，未声称用户逐条微调标签。'},{expectedRevision:asset.revision});
      entry.status=asset.status;entry.revision=asset.revision;entry.tags=asset.tags;
      entry.files=asset.files.length;entry.extractedCharacters=asset.extractions.reduce((n,file)=>n+(file.text?.length ?? 0),0);
      entry.noTextFiles=asset.extractions.filter(file=>file.warnings?.includes('no_text')).map(file=>file.name);
      entry.confirmation=asset.confirmation;
      entry.originalsUnchanged=true;
      for(const original of entry.originals){if(hash(await fs.readFile(original.path))!==original.sha256)entry.originalsUnchanged=false;}
      const matches=await queryAssets({tags:asset.tags.slice(0,1),limit:500});
      entry.foundByTag=matches.some(item=>item.id===asset.id);
    } else entry.failure=asset.lastError;
    await save();
    console.log(JSON.stringify({processed:index+1,total:selected.length,status:entry.status,files:entry.files ?? input.files.length,tags:entry.tags?.length ?? 0}));
    if(process.argv.includes('--probe')) break;
  }
  manifest.finishedAt=new Date().toISOString();manifest.confirmed=manifest.entries.filter(entry=>entry.status==='confirmed').length;
  manifest.status=manifest.confirmed===selected.length?'passed':'incomplete';await save();
  console.log(JSON.stringify({status:manifest.status,confirmed:manifest.confirmed,total:selected.length,reportPath:manifestPath,dataRoot:dataRoot()}));
  if(manifest.status!=='passed')process.exitCode=1;
} catch {console.error('真实批次验证未完成；请查看批次状态或模型配置。凭据与服务响应未输出。');process.exitCode=1;}
finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
