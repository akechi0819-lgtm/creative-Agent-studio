import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {taskDirectory} from '../creative/tasks.mjs';

/** Detect accidental edits to control records by trusted local scripts; this is not OS isolation. */
export async function withProtectedTaskState({taskId,root,onConflict=()=>{}},run) {
  const files=[path.join(taskDirectory(taskId,root),'task.json'),path.join(root,'config/studio.json')];
  const snapshot=()=>Promise.all(files.map(async file=>{
    try {return createHash('sha256').update(await readFile(file)).digest('hex');}
    catch(error){if(error.code==='ENOENT')return null;throw error;}
  }));
  const before=await snapshot();
  try {return await run();}
  finally {
    if(JSON.stringify(await snapshot())!==JSON.stringify(before)) {
      await onConflict();
      throw Object.assign(new Error('脚本改变了任务或模型配置记录，当前操作已停止。请检查任务状态；没有据此继续绘图、批准或导出。'),{code:'ERR_SCRIPT_STATE_CONFLICT'});
    }
  }
}
