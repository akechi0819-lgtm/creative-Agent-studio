import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { callCanvasTool, recoverImage, connection, health } from '../canvas/client.mjs';
import { withTask, taskDirectory, requiredRevision, readTaskReferenceImageBytes, readTaskUploadedImageBytes, readTaskOutputImageBytes, isSheetAuthorized } from './tasks.mjs';

function assertConfirmed(task, version) {
  if (!isSheetAuthorized(task, version)) throw new Error('制作单未确认或修改授权已过时');
  const sheet = task.sheets.find(s => s.version === version);
  if (!sheet) throw new Error('制作单版本不存在');
  return sheet;
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function referenceImageUrl(reference) {
  return `data:${reference.mimeType};base64,${reference.bytes.toString('base64')}`;
}

async function loadReferenceImages(taskId, sheet, pages, root) {
  const loaded = new Map();
  for (const page of pages) {
    const references = page.referenceImages || [];
    const outputReferences = (sheet.outputReferences || []).filter(reference => reference.forPage === page.page);
    const uploadedReferences = (sheet.pageEdit?.uploadedImageReferences || []).filter(reference => reference.page === page.page);
    if (references.length + outputReferences.length + uploadedReferences.length > 12) throw new Error(`第 ${page.page} 页参考图片超过 12 张`);
    const pageImages = [];
    const seen = new Set();
    for (const reference of uploadedReferences) {
      if (!['edit-base', 'style'].includes(reference.role)) throw new Error(`第 ${page.page} 页上传图片角色无效`);
      const key = `upload\u0000${reference.sourceId}\u0000${reference.fileOrder}\u0000${reference.role}`;
      if (seen.has(key)) throw new Error(`第 ${page.page} 页上传图片重复`);
      seen.add(key);
      const file = await readTaskUploadedImageBytes(taskId, reference.sourceId, reference.fileOrder, {
        sources: sheet.inputs?.sources,
        root,
      });
      if (file.sha256 !== reference.sha256) throw new Error(`第 ${page.page} 页上传图片 SHA-256 与授权记录不一致`);
      pageImages.push({
        kind: 'upload',
        sourceId: reference.sourceId,
        fileOrder: reference.fileOrder,
        role: reference.role,
        name: file.name,
        mimeType: file.mimeType,
        sha256: file.sha256,
        bytes: file.bytes,
        dataUrl: referenceImageUrl(file),
      });
    }
    for (const reference of outputReferences) {
      if (!Number.isInteger(reference.page) || reference.page < 1
        || !sheet.pageEdit?.pageBases?.some(base => base.page === reference.page
          && base.version === reference.baseVersion && base.sha256 === reference.sha256)
        || !['edit-base', 'style'].includes(reference.role)) {
        throw new Error(`第 ${page.page} 页的成品参考记录无效`);
      }
      const key = `output\u0000${reference.page}\u0000${reference.baseVersion}\u0000${reference.role}`;
      if (seen.has(key)) throw new Error(`第 ${page.page} 页成品参考重复`);
      seen.add(key);
      const file = await readTaskOutputImageBytes(taskId, reference, { root });
      pageImages.push({
        kind: 'output',
        page: reference.page,
        baseVersion: reference.baseVersion,
        role: reference.role,
        name: file.name,
        mimeType: file.mimeType,
        sha256: file.sha256,
        bytes: file.bytes,
        dataUrl: referenceImageUrl(file),
      });
    }
    for (const reference of references) {
      if (!sheet.sourceIds?.includes(reference.sourceId) || !page.sourceIds?.includes(reference.sourceId)) {
        throw new Error(`第 ${page.page} 页参考图片来源不在已确认的来源范围内`);
      }
      const key = `${reference.sourceId}\u0000${reference.fileOrder}`;
      if (seen.has(key)) throw new Error(`第 ${page.page} 页参考图片重复`);
      seen.add(key);
      const file = await readTaskReferenceImageBytes(taskId, reference.sourceId, reference.fileOrder, {
        sources: sheet.inputs?.sources,
        root,
      });
      pageImages.push({
        kind: 'source',
        sourceId: reference.sourceId,
        fileOrder: reference.fileOrder,
        name: file.name,
        mimeType: file.mimeType,
        sha256: file.sha256,
        bytes: file.bytes,
        dataUrl: referenceImageUrl(file),
      });
    }
    loaded.set(page.page, pageImages);
  }
  return loaded;
}

function imageBytesFromDataUrl(value) {
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value || '');
  return match ? Buffer.from(match[1], 'base64') : null;
}

async function assertExistingReferenceNode(node, expected, call) {
  if (node.type !== 'image') throw new Error('画布中的参考节点类型已改变，停止生成');
  if (typeof node.metadata?.storageKey !== 'string' || !node.metadata.storageKey.startsWith('image:')) {
    throw new Error('Canvas 参考图片未保存到本地图片库，停止生成');
  }
  let content = node.metadata?.content;
  let bytes = imageBytesFromDataUrl(content);
  // Canvas 状态摘要会截短内联图片；实际字节必须通过图片读取工具核验。
  if (!bytes) {
    const result = await call('canvas_read_image', { nodeId: node.id });
    bytes = imageBytesFromDataUrl(result?.dataUrl);
  }
  if (!bytes || digest(bytes) !== expected.sha256) throw new Error('画布参考节点与已确认制作单中的图片不一致，停止生成');
}

async function ensurePageNodes({ page, sheet, record, images, model, call }) {
  if ((record.referenceNodes || []).length !== images.length) throw new Error('参考图片节点记录不完整，停止生成');
  const state = await call('canvas_get_state');
  const nodes = state.nodes || [];
  const connections = state.connections || [];
  const operations = [];
  const composerTokens = [record.textNodeId, ...(record.referenceNodes || []).map(reference => reference.nodeId)]
    .map(nodeId => `@[node:${nodeId}]`);
  const composerContent = composerTokens.join(' ');
  const imageRoles = images.some(image => image.role) ? '\n\n本次图片用途（图片编号与实际传入顺序一致）：\n' + images.map((image, index) => `图片${index + 1}：${image.role === 'edit-base' ? '待修改原图' : image.role === 'style' ? '仅供画风参考，不替换原图主体或引入品牌、文字' : '已保留的参考图片'}${image.kind === 'output' ? `（任务第${image.page}页）` : ''}`).join('\n') : '';
  const textContent = (page.copyMode === 'preserve-source-text'
    ? `${page.prompt}\n保留输入原图中的全部文字，不改写、删除或新增文字。`
    : `${page.prompt}\n以下是必须准确呈现的全部文字：\n${page.copy}`) + imageRoles;
  const textNode = nodes.find(node => node.id === record.textNodeId);
  const configNode = nodes.find(node => node.id === record.nodeId);
  if (textNode && textNode.type !== 'text') throw new Error('画布文案节点类型已改变，停止生成');
  if (textNode && (textNode.metadata?.contentSha256
    ? textNode.metadata.contentSha256 !== digest(Buffer.from(textContent))
    : textNode.metadata?.content !== textContent)) throw new Error('画布文案节点与已确认制作单不一致，停止生成');
  if (configNode && configNode.type !== 'config') throw new Error('画布生成节点类型已改变，停止生成');
  if (configNode && (configNode.metadata?.generationMode !== 'image' || configNode.metadata?.composerContent !== composerContent || configNode.metadata?.prompt !== composerContent)) {
    throw new Error('画布生成节点与已确认制作单中的文案或参考图不一致，停止生成');
  }
  if (!textNode) {
    operations.push({
      type: 'add_node',
      id: record.textNodeId,
      nodeType: 'text',
      title: `${sheet.title} v${sheet.version} 第${page.page}页`,
      position: { x: 0, y: (page.page - 1) * 700 },
      metadata: { content: textContent, status: 'success' },
    });
  }
  const newlyImported = [];
  for (const [index, reference] of (record.referenceNodes || []).entries()) {
    const expected = images[index];
    if (!expected || (reference.kind || 'source') !== expected.kind || expected.sha256 !== reference.sha256
      || (expected.kind === 'source' && (expected.sourceId !== reference.sourceId || expected.fileOrder !== reference.fileOrder))
      || (expected.kind === 'upload' && (expected.sourceId !== reference.sourceId || expected.fileOrder !== reference.fileOrder || expected.role !== reference.role))
      || (expected.kind === 'output' && (expected.page !== reference.page || expected.baseVersion !== reference.baseVersion || expected.role !== reference.role))) {
      throw new Error('参考图片记录与已确认制作单不一致，停止生成');
    }
    const existing = nodes.find(node => node.id === reference.nodeId);
    if (existing) await assertExistingReferenceNode(existing, expected, call);
    else {
      const title = expected.kind === 'output'
        ? `${expected.role === 'edit-base' ? '待改原图' : '风格参考'}：第${expected.page}页`
        : expected.kind === 'upload'
          ? `${expected.role === 'edit-base' ? '待改原图' : '风格参考'}：${expected.name}`
          : `参考图片 ${expected.name}`;
      const imported = await call('canvas_import_image', {
        nodeId: reference.nodeId,
        title,
        dataUrl: expected.dataUrl,
      });
      if (imported?.operation !== 'import' || imported.sourceNodeId !== reference.nodeId
        || !Array.isArray(imported.images) || imported.images.length !== 1
        || imported.images[0]?.nodeId !== reference.nodeId
        || !Number.isSafeInteger(imported.images[0]?.width) || imported.images[0].width < 1
        || !Number.isSafeInteger(imported.images[0]?.height) || imported.images[0].height < 1) {
        throw new Error('Canvas 参考图片导入结果无法核验，停止生成');
      }
      newlyImported.push({ reference, expected, index });
    }
  }
  if (newlyImported.length) {
    const importedState = await call('canvas_get_state');
    for (const { reference, expected, index } of newlyImported) {
      const importedNode = (importedState.nodes || []).find(node => node.id === reference.nodeId);
      if (!importedNode) throw new Error('Canvas 未能确认持久化的参考图片节点，停止生成');
      await assertExistingReferenceNode(importedNode, expected, call);
      operations.push({
        type: 'update_node',
        id: reference.nodeId,
        patch: { position: { x: 220, y: (page.page - 1) * 700 + index * 160 } },
      });
    }
  }
  if (!configNode) {
    operations.push({
      type: 'add_node',
      id: record.nodeId,
      nodeType: 'config',
      title: `第${page.page}页生成`,
      position: { x: 520, y: (page.page - 1) * 700 },
      metadata: {
        generationMode: 'image',
        composerContent,
        prompt: composerContent,
        status: 'idle',
        ...(model ? { model } : {}),
        size: page.size,
        count: 1,
        quality: 'low',
      },
    });
  }
  const inputNodeIds = [record.textNodeId, ...(record.referenceNodes || []).map(reference => reference.nodeId)];
  for (const fromNodeId of inputNodeIds) {
    if (!connections.some(connection => connection.fromNodeId === fromNodeId && connection.toNodeId === record.nodeId)) {
      operations.push({ type: 'connect_nodes', fromNodeId, toNodeId: record.nodeId });
    }
  }
  if (operations.length) await call('canvas_apply_ops', { ops: operations });
}

/** 单任务持锁执行；每次外部操作前保存意图，恢复只查原节点，不自动重发生成。 */
export async function executeTask(id, { version, expectedRevision, root, signal, config, model, pollMs = 1500, timeoutMs = 600000, retryPage, tool = callCanvasTool, recover = recoverImage, getHealth = health } = {}) {
  if (!Number.isInteger(version)) throw new Error('必须显式指定已确认的制作单 version');
  requiredRevision({expectedRevision});
  return withTask(id, async (task, save) => {
    const sheet = assertConfirmed(task, version);
    const ex = task.execution;
    if (ex.version !== version) throw new Error('执行版本与制作单不一致');
    const pagesNeedingFiles = sheet.pages.filter(page => {
      const record = ex.pages.find(item => item.page === page.page);
      return record?.status !== 'succeeded' && (!record?.submitted || retryPage === page.page);
    });
    const referenceImagesByPage = await loadReferenceImages(id, sheet, pagesNeedingFiles, root);
    let current;
    try {
      signal?.throwIfAborted();
      config ||= await connection();
      current = await getHealth(config, {signal});
    } catch (error) {
      ex.status=signal?.aborted?'cancelled':'failed';
      ex.error=signal?.aborted?'连接已取消，尚未提交生成':'Canvas 连接失败，尚未提交生成';
      await save();throw new Error(ex.error,{cause:error});
    }
    const targets = (current.targets || []).filter(t => t.hasCanvas && t.projectId === config.projectId);
    if (!config.clientId && targets.length !== 1) throw new Error('必须连接唯一目标或指定 clientId');
    config = {...config, clientId: config.clientId || targets[0].clientId};
    const target = {projectId:config.projectId, webUrl:config.webUrl, clientId:config.clientId};
    if (ex.target && (ex.target.projectId !== target.projectId || ex.target.webUrl !== target.webUrl)) throw new Error('恢复目标与原画布不一致，不能重放');
    ex.target = target;
    ex.status = 'running'; ex.error = null; await save();
    const call = (name, input = {}) => tool(name, input, config, {signal});
    let active;
    let canvasResultReadFailure = null;
    try {
      for (const page of sheet.pages) {
        signal?.throwIfAborted();
        let record = ex.pages.find(p => p.page === page.page);
        if (record?.status === 'succeeded') {
          if (digest(await readFile(record.image.path)) !== record.image.sha256) throw new Error('成品文件已改变，需重新选图与复审');
          continue;
        }
        active = record;
        if (!record) {
          const images = referenceImagesByPage.get(page.page) || [];
          record = {
            page:page.page,
            status:'preparing',
            nodeId:`config-${randomUUID()}`,
            textNodeId:`text-${randomUUID()}`,
            referenceNodes: images.map(image => ({
              kind: image.kind,
              ...(image.kind === 'output'
                ? {page:image.page,baseVersion:image.baseVersion,role:image.role}
                : image.kind === 'upload'
                  ? {sourceId:image.sourceId,fileOrder:image.fileOrder,role:image.role}
                : {sourceId:image.sourceId,fileOrder:image.fileOrder}),
              sha256:image.sha256,
              nodeId:`image-ref-${randomUUID()}`,
            })),
            submitted:false,
            attempt:1,
          };
          ex.pages.push(record); active = record; await save();
        }
        if (retryPage === page.page && record.submitted) {
          const status = await call('generation_get_status', {scope:'canvas',nodeIds:[record.nodeId]});
          if (status.tasks?.find(t => t.id === record.nodeId)?.status !== 'failed') throw new Error('只允许显式重试已确认失败的页；未知状态不能重放');
          record.history ||= []; record.history.push({nodeId:record.nodeId,status:record.status,attempt:record.attempt});
          record.nodeId=`config-${randomUUID()}`; record.textNodeId=`text-${randomUUID()}`; record.status='preparing';record.submitted=false;record.attempt++;
          task.reviews = task.reviews.filter(r => r.page !== page.page);task.finalApproval=null;await save();
        }
        if (record.status === 'preparing' || !record.submitted) {
          const images = referenceImagesByPage.get(page.page) || [];
          await ensurePageNodes({page, sheet, record, images, model, call});
          if (record.status === 'preparing') { record.status='prepared';await save(); }
        }
        if (!record.submitted) {
          signal?.throwIfAborted();
          record.status='submitting';record.submitted=true;record.submissionIntentAt=new Date().toISOString();await save();
          await call('canvas_run_generation', {nodeId:record.nodeId,mode:'image'});
          record.status='running';await save();
        }
        const deadline=Date.now()+timeoutMs;
        while (true) {
          signal?.throwIfAborted();
          const state = await call('canvas_get_state');
          if (!state.nodes.some(n => n.id === record.nodeId)) throw new Error('已提交节点不存在；无法确认收费状态，禁止重放');
          const outputs = new Set(state.connections.filter(e => e.fromNodeId === record.nodeId).map(e => e.toNodeId));
          const image = state.nodes.find(n => outputs.has(n.id) && n.type === 'image' && n.metadata?.status === 'success');
          if (image) {
            const destination=path.join(taskDirectory(id,root),'images',`v${version}`,`page-${page.page}-attempt-${record.attempt}.png`);
            const recovered=await recover(image.id,destination,config,{signal});
            record.imageNodeId=image.id;record.image={...recovered,sha256:digest(await readFile(destination))};
            record.status='succeeded';record.completedAt=new Date().toISOString();record.error=null;
            task.reviews=task.reviews.filter(r=>r.page!==page.page);task.finalApproval=null;await save();break;
          }
          const status = await call('generation_get_status', {scope:'canvas',nodeIds:[record.nodeId]});
          const item = status.tasks?.find(t=>t.id===record.nodeId);
          if (item?.status === 'failed') {
            record.status='failed';
            if (item.error === '读取图片失败') {
              const safeMessage = `第${page.page}页图片返回后读取失败，尚未保存；请查看画布错误并重试。`;
              canvasResultReadFailure = new Error(safeMessage);
              canvasResultReadFailure.code = 'ERR_CANVAS_RESULT_READ_FAILED';
              canvasResultReadFailure.safeMessage = safeMessage;
              throw canvasResultReadFailure;
            }
            throw new Error('Canvas 本页生成失败；显式重试前先核对节点');
          }
          if (!item || !['running','pending','queued','succeeded'].includes(item.status)) throw new Error('生成状态未知，保留提交记录，禁止自动重放');
          if (Date.now()>=deadline) throw new Error('等待超时，保留原节点；恢复时只查询');
          await delay(pollMs, undefined, {signal});
        }
      }
      ex.status='succeeded';ex.completedAt=new Date().toISOString();await save();
    } catch (error) {
      // 不持久化上游错误正文，可能含模型配置或凭据。
      ex.status=signal?.aborted?'cancelled':'failed';
      ex.error=signal?.aborted
        ? '已停止等待；已提交的上游生成不保证撤销'
        : error === canvasResultReadFailure
          ? canvasResultReadFailure.safeMessage
          : '执行失败；请核对原节点状态后恢复';
      if (active && active.status !== 'succeeded' && active.status !== 'failed') active.status=active.submitted?'uncertain':active.status;
      await save();
      if (error === canvasResultReadFailure) throw canvasResultReadFailure;
      throw new Error(ex.error, {cause:error});
    }
    return task;
  }, {root, expectedRevision});
}

/** 人工在 Canvas 修改/选图后回收实际 Blob；每次选择都使旧审核与最终确认失效。 */
export async function selectImage(id,{version,page,nodeId,expectedRevision,root,config,signal,recover=recoverImage}={}) {
  requiredRevision({expectedRevision});
  return withTask(id,async(task,save)=>{
    const sheet=assertConfirmed(task,version);
    if(!sheet.pages.some(p=>p.page===page))throw new Error('页码不存在');
    const record=task.execution.pages.find(p=>p.page===page);
    if(!record)throw new Error('该页尚未执行');
    config ||= await connection();
    if(task.execution.target && (config.webUrl!==task.execution.target.webUrl||config.projectId!==task.execution.target.projectId))throw new Error('选图目标与执行画布不一致');
    const file=path.join(taskDirectory(id,root),'images',`v${version}`,`page-${page}-selection-${randomUUID()}.png`);
    const image=await recover(nodeId,file,config,{signal});
    record.imageNodeId=nodeId;record.image={...image,sha256:digest(await readFile(file))};record.status='succeeded';
    task.execution.status=sheet.pages.every(p=>task.execution.pages.find(r=>r.page===p.page)?.status==='succeeded')?'succeeded':'pending';
    task.reviews=task.reviews.filter(r=>r.page!==page);task.finalApproval=null;await save();return task;
  },{root,expectedRevision});
}
