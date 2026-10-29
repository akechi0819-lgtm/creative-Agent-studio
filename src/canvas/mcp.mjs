import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createCanvasRuntime } from './runtime.mjs';
import { dataRoot } from './client.mjs';
import { getSetupStatus, recordCanvasMcpCheck } from '../lite/setup.mjs';
import { checkCompanyCopy } from '../lite/risk.mjs';
import { toolInputSchemas, toolDescriptions } from '../../third_party/canvas/canvas-agent/dist/canvas/schemas.js';

const canvasTools = [
  'site_navigate','canvas_list_projects','canvas_read_image','canvas_crop_image','canvas_split_image',
  'canvas_resample_image','canvas_stitch_images','canvas_compose_images','canvas_import_image',
  'canvas_get_state','canvas_get_selection','canvas_export_snapshot','canvas_apply_ops',
  'canvas_create_node','canvas_create_text_node','canvas_create_text_nodes','canvas_create_config_node',
  'canvas_create_image_prompt_flow','canvas_generate_image','canvas_update_node','canvas_update_node_text',
  'canvas_move_nodes','canvas_resize_node','canvas_delete_nodes','canvas_connect_nodes',
  'canvas_select_nodes','canvas_set_viewport','canvas_run_generation','generation_get_status',
];
const targetSchema = {
  projectId:z.string().optional().describe('当前对话选用的画布项目 ID；多画布连接时必须明确目标'),
  clientId:z.string().optional().describe('canvas_status 返回的页面连接 ID；多页面时指定'),
};
const output = value => ({content:[{type:'text',text:JSON.stringify(value)}]});
function imageResult(value) {
  const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(value.dataUrl || '');
  if (!match) throw new Error('画布尚未返回可读取的图片');
  return {mimeType:match[1],data:match[2]};
}

export function createCompanyCanvasMcp({ root = dataRoot(), runtime = createCanvasRuntime({root}) } = {}) {
  const server = new McpServer({name:'company-lite-canvas',version:'0.1.0'});
  const register = (name,config,handler) => server.registerTool(name,config,async args=>{
    try { return await handler(args); }
    catch(error) { return {isError:true,content:[{type:'text',text:error.message}]}; }
  });
  register('company_setup_status',{description:'读取本机安装五步状态；在宿主对话中展示进度与当前需处理的一步。',inputSchema:{}},async()=>output(await getSetupStatus({root})));
  register('canvas_status',{description:'查看共享本地画布是否运行及当前各项目/页面连接；不生成图片。',inputSchema:{}},async()=>{
    const state=await runtime.status();
    await recordCanvasMcpCheck({root});
    return output(state);
  });
  register('canvas_open',{
    description:'打开或复用本地通用画布。recent继续最近项目，new新建项目，choose查看全部历史；projectId打开已有项目。不会出图。',
    inputSchema:{mode:z.enum(['recent','new','choose']).default('recent'),projectId:z.string().optional()},
  },async args=>output(await runtime.open(args)));
  register('company_check_copy',{description:'给出文案词表提示，不验证事实，也不替代人工审核。',inputSchema:{text:z.string()}},async({text})=>output(checkCompanyCopy(text)));

  for (const name of canvasTools) {
    const description = name === 'site_navigate' ? '在共享本地画布中切换 /canvas 历史页或 /canvas/:id 项目。' :
      name === 'generation_get_status' ? '查询当前画布节点生成状态；结果未知时先查状态，不重新提交收费请求。' :
      name === 'canvas_create_node' ? '创建图片、文本或图片生成配置节点。' :
      name === 'canvas_create_config_node' ? '创建图片生成配置节点；autoRun 会收费，需用户已授权。' :
      name === 'canvas_run_generation' ? '向指定节点提交一次图片生成；返回后查询 generation_get_status，未知状态不得重提。' : toolDescriptions[name];
    const excludedFields=new Set(['seconds','vquality','generateAudio','watermark','videoMode','audioVoice','audioFormat','audioSpeed','audioInstructions','taskId']);
    // Split has a cross-field refinement; the bridge validates the original schema again.
    const schema=name==='canvas_split_image' ? toolInputSchemas[name].innerType() : toolInputSchemas[name];
    const shape=Object.fromEntries(Object.entries(schema.shape).filter(([key])=>!excludedFields.has(key)));
    if(shape.mode)shape.mode=z.literal('image').optional();
    if(shape.nodeType)shape.nodeType=z.enum(['image','text','config']);
    if(name==='generation_get_status')shape.scope=z.literal('canvas').default('canvas');
    register(name,{description,inputSchema:{...shape,...targetSchema}},async({projectId,clientId,...input})=>{
      if (name==='site_navigate' && !/^\/canvas(?:\/[A-Za-z0-9_-]+)?(?:\?mode=(?:new|recent|choose))?$/.test(input.path)) throw new Error('只允许本地画布与历史项目页面');
      if ((input.mode && input.mode!=='image') || input.ops?.some(op=>op.type==='run_generation' && op.mode && op.mode!=='image')) throw new Error('Company Lite 仅配置图片生成');
      if (name==='generation_get_status') input.scope='canvas';
      const result=await runtime.call(name,input,{projectId,clientId});
      if(name==='canvas_read_image') return {content:[{type:'image',...imageResult(result)},
        {type:'text',text:JSON.stringify({nodeId:result.nodeId,width:result.width,height:result.height})}]};
      return output(result);
    });
  }
  register('canvas_import_file',{
    description:'把已从 Teedy 下载或用户提供的本机 PNG/JPEG/WebP 原件加入当前画布，不调用 AI。',
    inputSchema:{path:z.string(),title:z.string(),nodeId:z.string().optional(),...targetSchema},
  },async({path:file,title,nodeId=randomUUID(),projectId,clientId})=>{
    const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[path.extname(file).toLowerCase()];
    if(!mime)throw new Error('原件需为 PNG、JPEG 或 WebP');
    const info=await fs.stat(file);if(!info.isFile() || info.size>20*1024*1024)throw new Error('原件不是文件或超过20 MiB');
    const dataUrl=`data:${mime};base64,${(await fs.readFile(file)).toString('base64')}`;
    return output(await runtime.call('canvas_import_image',{title,nodeId,dataUrl},{projectId,clientId}));
  });
  register('canvas_save_image',{
    description:'把当前画布图片保存为本机可交付原图。确认用户要导出后调用；不覆盖已有文件。',
    inputSchema:{nodeId:z.string(),destination:z.string().optional(),...targetSchema},
  },async({nodeId,destination,projectId,clientId})=>{
    const image=imageResult(await runtime.call('canvas_read_image',{nodeId},{projectId,clientId}));
    const extension={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[image.mimeType];
    const file=destination ? path.resolve(destination) : path.join(root,'exports',`${randomUUID()}.${extension}`);
    await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
    const bytes=Buffer.from(image.data,'base64');
    await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});
    return output({nodeId,path:file,bytes:bytes.length,mimeType:image.mimeType});
  });
  return server;
}
