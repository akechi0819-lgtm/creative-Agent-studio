import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createCanvasRuntime } from './runtime.mjs';
import { dataRoot } from './client.mjs';
import {
  getSetupStatus,
  imageAcceptanceTrackingPending,
  recordCanvasMcpCheck,
  recordImageGenerationSubmission,
  recordImageMcpRead,
} from '../lite/setup.mjs';
import { checkCompanyCopy } from '../lite/risk.mjs';
import { canvasImportErrorCodes, canvasImportFailureText, createCanvasImportError } from './import-errors.mjs';
import { toolInputSchemas, toolDescriptions } from '../../third_party/canvas/canvas-agent/dist/canvas/schemas.js';
import { readConfigRecord } from '../lite/config.mjs';

const canvasTools = [
  'site_navigate','canvas_list_projects','canvas_read_image','canvas_crop_image','canvas_split_image',
  'canvas_resample_image','canvas_stitch_images','canvas_compose_images','canvas_import_image',
  'canvas_get_state','canvas_get_selection','canvas_export_snapshot','canvas_apply_ops',
  'canvas_create_node','canvas_create_text_node','canvas_create_text_nodes','canvas_create_config_node',
  'canvas_create_image_prompt_flow','canvas_generate_image','canvas_update_node','canvas_update_node_text',
  'canvas_adapt_logo','canvas_move_nodes','canvas_resize_node','canvas_delete_nodes','canvas_connect_nodes',
  'canvas_select_nodes','canvas_set_viewport','canvas_run_generation','canvas_generate_video','generation_get_status',
];
const studioVideoModel = 'studio-video::minimax_h3';
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
function videoResult(value, nodeId) {
  const match = /^data:video\/mp4;base64,([A-Za-z0-9+/=\s]+)$/.exec(value?.dataUrl || '');
  if (!match || value.nodeId !== nodeId || value.mimeType !== 'video/mp4') throw new Error('Canvas 尚未返回可保存的 MP4 视频');
  const bytes = Buffer.from(match[1], 'base64');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (!bytes.length || value.bytes !== bytes.length || !/^[a-f\d]{64}$/i.test(value.sha256 || '')
    || value.sha256.toLowerCase() !== sha256
    || !Number.isInteger(value.width) || value.width < 1
    || !Number.isInteger(value.height) || value.height < 1
    || !Number.isFinite(value.durationMs) || value.durationMs <= 0) {
    throw new Error('Canvas 视频字节或元信息校验失败');
  }
  return { bytes, sha256, width: value.width, height: value.height, durationMs: value.durationMs };
}

export function createCompanyCanvasMcp({ root = dataRoot(), runtime = createCanvasRuntime({root}) } = {}) {
  const server = new McpServer({name:'company-lite-canvas',version:'0.1.0'});
  const register = (name,config,handler) => server.registerTool(name,config,async args=>{
    try { return await handler(args); }
    catch(error) {
      const text = name === 'canvas_import_file' || name === 'canvas_import_image'
        ? canvasImportFailureText(error)
        : error.message;
      return {isError:true,content:[{type:'text',text} ]};
    }
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
    if (name === 'canvas_generate_video') {
      const ratios = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
      const durations = Array.from({ length: 12 }, (_, index) => String(index + 4));
      const resolutions = ['768', '1080p', '2K', '4K'];
      const videoInput = {
        prompt: z.string().trim().min(1).max(20_000),
        model: z.literal(studioVideoModel).optional(),
        size: z.enum(ratios).default('16:9'),
        seconds: z.enum(durations).default('4'),
        resolution: z.enum(resolutions).default('768'),
        run: z.literal(true).default(true),
        mode: z.never().optional(),
        quality: z.never().optional(),
        ratio: z.never().optional(),
        n: z.never().optional(),
        metadata: z.never().optional(),
        generateAudio: z.never().optional(),
        generate_audio: z.never().optional(),
        watermark: z.never().optional(),
        referenceNodeIds: z.never().optional(),
        media_inputs: z.never().optional(),
        images: z.never().optional(),
        videos: z.never().optional(),
        audios: z.never().optional(),
        ...targetSchema,
      };
      register(name, {
        description: '在当前画布以 H3 纯文生视频提交一次生成。固定使用 studio-video::minimax_h3；支持 4–15 秒、768/1080p/2K/4K 和六种固定比例。结果返回 sourceNodeId（配置节点）及 textNodeId；用 canvas_get_state 沿 sourceNodeId 的连线查找唯一 video 子节点，完成后以该 video nodeId 调 canvas_save_video。若提交响应丢失，错误会给出两个节点 ID；先查当前画布，不要重提。',
        inputSchema: videoInput,
      }, async ({ projectId, clientId, ...input }) => {
        const record = await readConfigRecord({ root });
        if (!record.video.apiKey) throw new Error('H3 视频 API 尚未配置；请先运行 node scripts/setup.mjs configure-video。');
        const target = { projectId, clientId };
        const state = await runtime.call('canvas_get_state', {}, target);
        const right = (state.nodes || []).reduce((value, node) => Math.max(value, (node.position?.x || 0) + (node.width || 0)), 0);
        const x = state.nodes?.length ? right + 96 : 0;
        const textNodeId = `text-${randomUUID()}`;
        const sourceNodeId = `config-${randomUUID()}`;
        const ops = [
          {
            type: 'add_node', nodeType: 'text', id: textNodeId, title: '视频提示词',
            position: { x, y: 0 }, width: 360, height: 180,
            metadata: { content: input.prompt, status: 'success', fontSize: 14 },
          },
          {
            type: 'add_node', nodeType: 'config', id: sourceNodeId, title: 'H3 视频生成',
            position: { x: x + 420, y: 0 }, width: 360, height: 180,
            metadata: {
              generationMode: 'video', composerContent: input.prompt, prompt: input.prompt, status: 'idle',
              model: studioVideoModel, size: input.size, seconds: input.seconds, vquality: input.resolution,
            },
          },
          { type: 'connect_nodes', fromNodeId: textNodeId, toNodeId: sourceNodeId },
          { type: 'select_nodes', ids: [sourceNodeId] },
          { type: 'run_generation', nodeId: sourceNodeId, mode: 'video', prompt: input.prompt },
        ];
        try {
          await runtime.call('canvas_apply_ops', { ops }, target);
        } catch {
          throw new Error(`视频提交结果未知；不要再次调用 canvas_generate_video。请用 canvas_get_state 查询 sourceNodeId=${sourceNodeId} 和 textNodeId=${textNodeId}；若配置节点存在，沿连线继续查询唯一 video 子节点。`);
        }
        return output({ submitted: true, sourceNodeId, textNodeId, model: studioVideoModel, size: input.size, seconds: input.seconds, resolution: input.resolution });
      });
      continue;
    }
    const excludedFields=new Set(['seconds','vquality','generateAudio','watermark','videoMode','audioVoice','audioFormat','audioSpeed','audioInstructions','taskId']);
    // Split has a cross-field refinement; the bridge validates the original schema again.
    const schema=['canvas_split_image','canvas_adapt_logo'].includes(name) ? toolInputSchemas[name].innerType() : toolInputSchemas[name];
    const shape=Object.fromEntries(Object.entries(schema.shape).filter(([key])=>!excludedFields.has(key)));
    if(shape.mode)shape.mode=z.literal('image').optional();
    if(shape.nodeType)shape.nodeType=z.enum(['image','text','config']);
    if(name==='generation_get_status')shape.scope=z.literal('canvas').default('canvas');
    register(name,{description,inputSchema:{...shape,...targetSchema}},async({projectId,clientId,...input})=>{
      if(name==='canvas_adapt_logo')toolInputSchemas[name].parse(input);
      if (name==='site_navigate' && !/^\/canvas(?:\/[A-Za-z0-9_-]+)?(?:\?mode=(?:new|recent|choose))?$/.test(input.path)) throw new Error('只允许本地画布与历史项目页面');
      if ((input.mode && input.mode!=='image') || input.ops?.some(op=>op.type==='run_generation' && op.mode && op.mode!=='image')) throw new Error('通用 Canvas 操作仅支持图片生成；H3 视频请使用 canvas_generate_video。');
      if (name==='generation_get_status') input.scope='canvas';
      const target = {projectId,clientId};
      const trackImageAcceptance = (name === 'canvas_run_generation' || name === 'canvas_read_image')
        && await imageAcceptanceTrackingPending({root});
      const generationBefore = name==='canvas_run_generation' && trackImageAcceptance
        ? await runtime.call('canvas_get_state',{},target)
        : null;
      const result=await runtime.call(name,input,{projectId,clientId});
      if (name==='canvas_run_generation' && trackImageAcceptance && result?.submitted===true && result.nodeId===input.nodeId && generationBefore) {
        try {
          await recordImageGenerationSubmission({projectId:generationBefore.projectId,sourceNodeId:input.nodeId,canvasState:generationBefore},{root});
        } catch (error) {
          return output({ ...result, installationEvidenceRecorded:false,
            warning:`图片请求已提交，但安装验收记录未能保存：${error.message}。先查询 generation_get_status，不要重新提交。` });
        }
      }
      if(name==='canvas_read_image') {
        const image=imageResult(result);
        let evidenceWarning;
        if (trackImageAcceptance) {
          try {
            const canvasState=await runtime.call('canvas_get_state',{},target);
            await recordImageMcpRead({projectId:canvasState.projectId,imageNodeId:input.nodeId,canvasState,imageResult:result},{root});
          } catch (error) { evidenceWarning=`安装验收读图记录未能保存：${error.message}`; }
        }
        return {content:[{type:'image',...image},
          {type:'text',text:JSON.stringify({nodeId:result.nodeId,width:result.width,height:result.height})},
          ...(evidenceWarning?[{type:'text',text:evidenceWarning}]:[])]};
      }
      return output(result);
    });
  }
  register('canvas_import_file',{
    description:'把已从 Teedy 下载或用户提供的本机 PNG/JPEG/WebP 原件加入当前画布，不调用 AI。',
    inputSchema:{path:z.string(),title:z.string(),nodeId:z.string().optional(),...targetSchema},
  },async({path:file,title,nodeId=randomUUID(),projectId,clientId})=>{
    const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[path.extname(file).toLowerCase()];
    if(!mime)throw createCanvasImportError(canvasImportErrorCodes.unsupportedFile);
    let info;
    try { info=await fs.stat(file); }
    catch(error) {
      throw createCanvasImportError(['ENOENT','ENOTDIR'].includes(error?.code)
        ? canvasImportErrorCodes.fileMissing
        : canvasImportErrorCodes.fileUnreadable);
    }
    if(!info.isFile())throw createCanvasImportError(canvasImportErrorCodes.notFile);
    const maxBytes=20*1024*1024;
    if(info.size>maxBytes)throw createCanvasImportError(canvasImportErrorCodes.fileTooLarge);
    let bytes;
    try { bytes=await fs.readFile(file); }
    catch { throw createCanvasImportError(canvasImportErrorCodes.fileUnreadable); }
    if(bytes.length>maxBytes)throw createCanvasImportError(canvasImportErrorCodes.fileTooLarge);
    if(bytes.length===0)throw createCanvasImportError(canvasImportErrorCodes.invalidImage);
    const dataUrl=`data:${mime};base64,${bytes.toString('base64')}`;
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
  register('canvas_save_video', {
    description: '用户在当前对话明确确认视频成品后，读取成功视频节点并保存本机 MP4；不覆盖已有文件。',
    inputSchema: { nodeId: z.string(), destination: z.string().optional(), ...targetSchema },
  }, async ({ nodeId, destination, projectId, clientId }) => {
    const result = await runtime.call('canvas_read_video', { nodeId }, { projectId, clientId });
    const media = videoResult(result, nodeId);
    const file = destination ? path.resolve(destination) : path.join(root, 'exports', `${randomUUID()}.mp4`);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, media.bytes, { flag: 'wx', mode: 0o600 });
    return output({
      nodeId,
      path: file,
      bytes: media.bytes.length,
      mimeType: 'video/mp4',
      width: media.width,
      height: media.height,
      durationMs: media.durationMs,
      sha256: media.sha256,
    });
  });
  return server;
}
