import fs from 'node:fs/promises';
import { createCanvasRuntime, mcpConfiguration } from '../src/canvas/runtime.mjs';
import { checkCompanyCopy } from '../src/lite/risk.mjs';

const runtime = createCanvasRuntime();
const [command='status', argument] = process.argv.slice(2);
async function payload() {
  if (!argument?.startsWith('@')) throw new Error('请用 @JSON文件 传入参数');
  const value = JSON.parse(await fs.readFile(argument.slice(1),'utf8'));
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('参数必须为 JSON 对象');
  return value;
}
async function main() {
  switch(command) {
    case 'status': return runtime.status();
    case 'start': await runtime.ensure(); return runtime.status();
    case 'open': return runtime.open(argument ? await payload() : {});
    case 'stop': return runtime.stop();
    case 'mcp-config': return mcpConfiguration();
    case 'check-copy': return checkCompanyCopy((await payload()).text);
    default: throw new Error('用法：Studio status | start | open [@JSON] | stop | mcp-config | check-copy @JSON');
  }
}
main().then(value=>console.log(JSON.stringify(value,null,2))).catch(error=>{
  console.error(JSON.stringify({ok:false,error:error.message})); process.exitCode=1;
});
