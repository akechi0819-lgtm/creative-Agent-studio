/** Classify an explicit instruction, not a general sentiment or an agent recommendation.
 * Target + action are composed independently; extra clauses fail closed.
 */
export function classifyDialogueIntent(value) {
  const text = String(value || '').trim().replace(/\s+/gu, '').replace(/[。！!]+$/u, '');
  if (/[?？吗么]|(?:不|别|勿|没|否|取消|稍后|等等|如果|要是|讨论|考虑)/u.test(text)) return null;
  const target = '(?:当前)?(?:这(?:一)?(?:份|版|个|套)?|以上|该|本)?';
  const affirmation = text.match(new RegExp(`^(${target}(?:制作单|制作方案|方案|成品|图片|成果)(?:v\\d+)?)(?:可以|就)(.+?)(?:吧|了)?$`, 'iu'));
  const instruction = text.match(/^(?:请)?(?:就)?(?:确认|同意|按|照)(.+?)(?:吧|了)?$/u)?.[1]
    || (affirmation ? affirmation[1] + affirmation[2] : null);
  if (!instruction) return null;
  const link = '[，,]?(?:并)?';
  if (new RegExp(`^${target}(?:制作单|制作方案|方案)(?:v\\d+)?${link}(?:开始)?(?:绘图|制作|执行|出图|生成|做)$`, 'iu').test(instruction)) return 'sheet';
  if (new RegExp(`^${target}(?:(?:成品|图片|成果)(?:v\\d+)?${link})?(?:交付|打包)(?:${link}下载)?$`, 'iu').test(instruction)) return 'delivery';
  if (new RegExp(`^${target}参考方案(?:并继续|，继续|,继续)?$`, 'u').test(instruction)) return 'references';
  if (new RegExp(`^${target}(?:需求与参考|需求和参考|参考选择|素材选择)(?:并继续|，继续|,继续)?$`, 'u').test(instruction)) return 'inputs';
  return null;
}

/** Only the actual user message can approve the displayed version and image set. */
export function dialogueIntent(task, body) {
  const kind = classifyDialogueIntent(body.text);
  if (!kind) return null;
  const stale = () => Object.assign(new Error('展示版本已变化，请查看当前对话和预览后重新确认。'), { code: 'ERR_DIALOGUE_STALE', status: 409 });
  if (body.displayed?.revision !== task.revision || body.displayed?.sheetVersion !== task.sheetVersion) throw stale();
  const version = String(body.text).replace(/\s+/gu,'').match(/v(\d+)/iu)?.[1];
  if (version && Number(version) !== task.sheetVersion) throw stale();
  if ((kind === 'sheet' || kind === 'delivery') && !task.sheetVersion) throw stale();
  if (body.answers || body.attachmentSourceIds?.length) throw new Error('请先查看上传或回答后的版本，再单独确认。');
  if (kind === 'delivery') {
    const pages = task.execution?.pages || [];
    const sheet = task.sheets?.find(item => item.version === task.sheetVersion);
    const displayed = body.displayed.images;
    const images = pages.map(page => ({page:page.page,sha256:page.image?.sha256}));
    if (task.execution?.version !== task.sheetVersion || task.execution?.status !== 'succeeded'
      || !sheet?.pages?.length || pages.length !== sheet.pages.length
      || pages.some(page => page.status !== 'succeeded' || !/^[a-f0-9]{64}$/iu.test(page.image?.sha256 || ''))
      || sheet.pages.some(page => !pages.some(result => result.page === page.page))
      || !Array.isArray(displayed) || JSON.stringify(images) !== JSON.stringify(displayed)) throw stale();
  }
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
