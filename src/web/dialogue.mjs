/** Only the actual user message can approve a displayed version. Model tool output is never approval. */
export function dialogueIntent(task, body) {
  const text = String(body.text || '').trim().replace(/\s+/gu, '').replace(/[。！!]+$/u, '');
  let kind = null;
  if (/^(?:确认|同意)(?:当前)?(?:制作单|方案)(?:\s*v\d+)?(?:并|，)?(?:开始绘图|开始制作|执行|出图)$/iu.test(text)) kind = 'sheet';
  if (/^(?:确认|同意)(?:当前)?(?:需求与参考|需求和参考|参考选择|素材选择)(?:并继续|，继续)?$/u.test(text)) kind = 'inputs';
  if (/^(?:确认|同意)(?:以上|这份|当前)?参考方案(?:并继续)?$/u.test(text)) kind = 'references';
  if (!kind) return null;
  if (body.displayed?.revision !== task.revision || body.displayed?.sheetVersion !== task.sheetVersion) {
    throw Object.assign(new Error('展示版本已变化，请查看当前对话卡片后重新确认。'), { code: 'ERR_DIALOGUE_STALE', status: 409 });
  }
  const version = text.match(/v(\d+)/iu)?.[1];
  if (version && Number(version) !== task.sheetVersion) throw Object.assign(new Error('你确认的制作单不是当前展示版本。'), { code: 'ERR_DIALOGUE_STALE', status: 409 });
  if (body.answers || body.attachmentSourceIds?.length) throw new Error('请先查看上传或回答后的版本，再单独确认。');
  return kind;
}

export function referenceProposal(task, items) {
  if (!Array.isArray(items) || items.length !== task.sources.length) throw new Error('参考方案必须逐项列出当前全部来源。');
  const seen = new Set();
  return items.map(item => {
    const source = task.sources.find(source => source.id === item.id);
    if (!source || seen.has(item.id) || !['retained','excluded'].includes(item.decision)) throw new Error('参考方案来源或选择无效。');
    seen.add(item.id);
    if (typeof item.purpose !== 'string' || !item.purpose.trim() || item.purpose.length > 2000) throw new Error('请说明参考用于内容或风格。');
    return { kind:'existing', id:item.id, decision:item.decision, purpose:item.purpose.trim(), factBoundary:source.factBoundary };
  });
}
