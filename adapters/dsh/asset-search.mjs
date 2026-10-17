import { isDeepStrictEqual } from 'node:util';

const SEARCH_LIMIT = 5;
const PAGE_LIMIT = 500;
const MAX_FALLBACK_TERMS = 8;
const DEFAULT_FACT_BOUNDARY = '历史素材仅供参考，不作为本次创作的事实依据。';
export const LEGACY_SEARCH_RESULT_THRESHOLD_CHARS = 32_768;
const CURRENT_ATTACHMENT_TEXT_LIMIT = 16_000;
const CURRENT_ATTACHMENT_FILE_LIMIT = 4_000;

function boundedText(value, limit) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, limit);
}

function queryParts(query) {
  const parts = String(query ?? '').normalize('NFKC').trim().split(/[\s,，。；;、|/\\]+/u).filter(Boolean);
  const latin = [];
  const han = [];
  for (const part of parts) {
    for (const token of part.match(/[A-Za-z0-9]+|\p{Script=Han}+/gu) ?? []) {
      if (/^[A-Za-z0-9]+$/u.test(token)) latin.push(token);
      else if ([...token].length >= 2) han.push(token);
    }
  }
  const bigrams = [];
  for (const token of han) {
    const characters = [...token];
    for (let index = 0; index < characters.length - 1; index += 1) {
      bigrams.push(characters.slice(index, index + 2).join(''));
    }
  }
  return [...new Set([...latin, ...han, ...bigrams])].slice(0, MAX_FALLBACK_TERMS);
}

async function allMatches(query, queryAssets, root) {
  const unique = new Map();
  for (let offset = 0; ; offset += PAGE_LIMIT) {
    const page = await queryAssets({ query, offset, limit: PAGE_LIMIT }, { root });
    for (const asset of page) unique.set(asset.id, asset);
    if (page.length < PAGE_LIMIT) return [...unique.values()];
  }
}

function sourceFacts(source) {
  const value = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  return {
    kind: boundedText(value.kind, 80),
    platform: boundedText(value.platform, 80),
    factBoundary: boundedText(value.factBoundary, 320) || DEFAULT_FACT_BOUNDARY,
  };
}

function compactAsset(asset) {
  const files = Array.isArray(asset.files) ? asset.files : [];
  return {
    id: asset.id,
    revision: asset.revision,
    title: boundedText(asset.title, 160),
    summary: boundedText(asset.summary, 600),
    tags: (Array.isArray(asset.tags) ? asset.tags : []).slice(0, 8).map(tag => boundedText(tag, 60)).filter(Boolean),
    source: sourceFacts(asset.source),
    filesCount: files.length,
    previews: files.slice(0, 3).map(file => ({
      name: boundedText(file?.name, 100),
      mediaType: boundedText(file?.mimeType, 80),
      ...(Number.isInteger(file?.order) ? { order: file.order } : {}),
    })),
  };
}

/** Search one topic first, then try short terms from a longer query. Never return raw library records. */
export async function findAssetCandidates(query, { queryAssets, root } = {}) {
  if (typeof queryAssets !== 'function') throw new Error('queryAssets 必须是函数');
  const original = String(query ?? '').trim();
  if (!original) throw new Error('素材检索关键词不能为空');
  if (original.length > 2000) throw new Error('素材检索关键词不能超过 2000 个字符');

  let usedQuery = original;
  let matches = await allMatches(usedQuery, queryAssets, root);
  if (!matches.length) {
    for (const term of queryParts(original)) {
      if (term === original) continue;
      const found = await allMatches(term, queryAssets, root);
      if (found.length) {
        usedQuery = term;
        matches = found;
        break;
      }
    }
  }

  const items = matches.slice(0, SEARCH_LIMIT).map(compactAsset);
  return { query: usedQuery, hitCount: matches.length, returnedCount: items.length, items };
}

function compactSearchPayload(payload, call) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const rawItems = Array.isArray(payload.items) ? payload.items : Array.isArray(payload.assets) ? payload.assets : null;
  if (!rawItems) return null;
  const returnedCount = Number.isInteger(payload.returnedCount) && payload.returnedCount >= 0
    ? payload.returnedCount
    : rawItems.length;
  const exactHitCount = Number.isInteger(payload.hitCount) && payload.hitCount >= 0
    ? payload.hitCount
    : rawItems.length < 100 ? rawItems.length : null;
  let query = payload.query;
  if (typeof query !== 'string') {
    try { query = JSON.parse(call.arguments).query; } catch { query = ''; }
  }
  return {
    query: boundedText(query, 120),
    hitCount: exactHitCount,
    hitCountExact: exactHitCount !== null,
    returnedCount,
    items: rawItems.slice(0, SEARCH_LIMIT).map(compactAsset),
    ...(Number.isInteger(payload.stagedCount) && payload.stagedCount >= 0 ? { stagedCount: payload.stagedCount } : {}),
    ...(typeof payload.inputConfirmationInvalidated === 'boolean' ? { inputConfirmationInvalidated: payload.inputConfirmationInvalidated } : {}),
  };
}

/** Identify only the exact legacy replacement emitted for an oversized search result. */
export function isLegacyAssetSearchReplacement(event, events, { thresholdChars = LEGACY_SEARCH_RESULT_THRESHOLD_CHARS } = {}) {
  if (event?.type !== 'tool/result' || event.surfaceOp?.op !== 'replace'
    || event.surfaceOp.startSeq !== event.surfaceOp.endSeq
    || !Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length !== 1
    || event.sourceEventSeqs[0] !== event.surfaceOp.startSeq) return false;
  const original = events[event.surfaceOp.startSeq];
  if (original?.seq !== event.surfaceOp.startSeq || original.type !== 'tool/result' || original.surfaceOp !== 'append') return false;
  const originalMessage = original.data?.message;
  if (originalMessage?.role !== 'tool' || originalMessage.isError
    || originalMessage.source?.kind !== 'tool'
    || originalMessage.source.callId !== originalMessage.toolCallId
    || !Array.isArray(originalMessage.content) || originalMessage.content.length !== 1
    || originalMessage.content[0]?.type !== 'text' || typeof originalMessage.content[0].text !== 'string') return false;
  const call = events.slice(0, original.seq).findLast(candidate => candidate?.type === 'tool/call'
    && candidate.data?.callId === originalMessage.toolCallId);
  if (call?.data?.name !== 'studio_search_assets'
    || call.data.turn !== original.data.turn || call.data.step !== original.data.step) return false;
  const rawText = originalMessage.content[0].text;
  if (rawText.length <= thresholdChars) return false;
  let payload;
  try { payload = JSON.parse(rawText); } catch { return false; }
  const projection = compactSearchPayload(payload, call.data);
  if (!projection) return false;
  const expected = structuredClone(original.data);
  expected.message.content = [{ type: 'text', text: JSON.stringify(projection) }];
  return isDeepStrictEqual(event.data, expected);
}

/** Replace only oversized legacy search-result content while preserving its tool message identity and pairing. */
export function compactLegacyAssetSearchResults(session, events, { thresholdChars = LEGACY_SEARCH_RESULT_THRESHOLD_CHARS } = {}) {
  if (!session?.surface || typeof session.append !== 'function' || !Array.isArray(events)) throw new Error('session/events 无效');
  const searchCalls = new Map();
  for (const event of events) {
    if (event?.type === 'tool/call' && event.data?.name === 'studio_search_assets' && typeof event.data.callId === 'string') {
      searchCalls.set(event.data.callId, event.data);
    }
  }
  const active = new Set(session.surface.nodes);
  let replacedCount = 0;
  let charactersRemoved = 0;
  for (const event of events) {
    if (event?.type !== 'tool/result' || !active.has(event.seq)) continue;
    const original = event.data?.message;
    if (original?.role !== 'tool' || original.isError || original.source?.kind !== 'tool' || original.source.callId !== original.toolCallId) continue;
    const call = searchCalls.get(original.toolCallId);
    if (!call) continue;
    const content = original.content;
    if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text' || typeof content[0].text !== 'string') continue;
    const rawText = content[0].text;
    if (rawText.length <= thresholdChars) continue;
    let payload;
    try { payload = JSON.parse(rawText); } catch { continue; }
    const projection = compactSearchPayload(payload, call);
    if (!projection) continue;
    const summary = JSON.stringify(projection);
    const replacement = session.append('tool/result', {
      ...event.data,
      message: { ...original, content: [{ type: 'text', text: summary }] },
    }, {
      surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq },
      sourceEventSeqs: [event.seq],
    });
    active.delete(event.seq);
    active.add(replacement.seq);
    replacedCount += 1;
    charactersRemoved += rawText.length - summary.length;
  }
  return { replacedCount, charactersRemoved };
}

/** Keep library asset candidates compact in prompts until the user retains one. */
export function taskSourcesForPrompt(sources = []) {
  let currentAttachmentTextRemaining = CURRENT_ATTACHMENT_TEXT_LIMIT;
  let currentAttachmentFilesRemaining = Math.floor(CURRENT_ATTACHMENT_TEXT_LIMIT / CURRENT_ATTACHMENT_FILE_LIMIT);
  let referenceNumber = 0;
  return sources.map(source => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
    const compact = {
      id: source.id,
      title: boundedText(source.title, 160),
      ...(typeof source.type === 'string' ? { type: boundedText(source.type, 80) } : {}),
      decision: source.decision,
      purpose: boundedText(source.purpose, 1000),
      factBoundary: boundedText(source.factBoundary, 1000),
      filesCount: Array.isArray(source.files) ? source.files.length : 0,
      ...((source.decision === 'retained' || (source.type === 'current_attachment' && source.decision !== 'excluded')) ? {files:(source.files || []).slice(0,100).map(file=>({order:file.order,name:boundedText(file.name,100),mediaType:boundedText(file.mimeType,80)}))} : {}),
      imageFiles: source.decision === 'excluded' ? [] : (source.files || []).filter(file => /\.(png|jpe?g|webp)$/iu.test(file.name || '')).slice(0, 30).map(file => ({ order: file.order, name: boundedText(file.name, 100), mediaType: boundedText(file.mimeType, 80) })),
    };
    if (source.asset) {
      compact.referenceNumber = ++referenceNumber;
      compact.asset = { id: source.asset.id, revision: source.asset.revision };
      compact.summary = boundedText(source.summary, 1200);
      compact.tags = (Array.isArray(source.tags) ? source.tags : []).slice(0, 8).map(tag => boundedText(tag, 60)).filter(Boolean);
      compact.source = sourceFacts(source.source);
    }
    if (source.decision === 'retained') {
      if (source.body) compact.body = boundedText(source.body, 4000);
      if (source.url) compact.url = boundedText(source.url, 2000);
    }
    if (source.type === 'current_attachment' && source.decision !== 'excluded' && Array.isArray(source.extractions) && currentAttachmentTextRemaining > 0 && currentAttachmentFilesRemaining > 0) {
      const extractions = [];
      for (const entry of source.extractions) {
        if (currentAttachmentTextRemaining <= 0 || currentAttachmentFilesRemaining <= 0) break;
        const originalText = typeof entry?.text === 'string' ? entry.text : '';
        if (!originalText) continue;
        const limit = Math.min(CURRENT_ATTACHMENT_FILE_LIMIT, currentAttachmentTextRemaining);
        const text = boundedText(originalText, limit);
        extractions.push({
          ...(typeof entry?.name === 'string' ? { name: boundedText(entry.name, 100) } : {}),
          ...(typeof entry?.kind === 'string' ? { kind: boundedText(entry.kind, 80) } : {}),
          text,
          ...(text.length < originalText.length ? { truncated: true } : {}),
        });
        currentAttachmentTextRemaining -= text.length;
        currentAttachmentFilesRemaining -= 1;
      }
      if (extractions.length) {
        compact.extractions = extractions;
        compact.extractionNote = '上传附件提取文字仅用于理解资料，未经用户确认不得作为已核实事实。';
      }
    }
    return compact;
  });
}

/** Keep only the latest editable sheet; prior input snapshots duplicate full source/OCR data. */
export function taskSheetsForPrompt(sheets = []) {
  if (!Array.isArray(sheets) || !sheets.length) return [];
  const sheet = sheets.at(-1);
  if (!sheet || typeof sheet !== 'object' || Array.isArray(sheet)) return [];
  return [{
    ...(typeof sheet.kind === 'string' ? { kind: boundedText(sheet.kind, 80) } : {}),
    version: sheet.version,
    title: boundedText(sheet.title, 160),
    sourceIds: Array.isArray(sheet.sourceIds) ? sheet.sourceIds.slice(0, 20) : [],
    inputsRevision: sheet.inputsRevision,
    pages: (Array.isArray(sheet.pages) ? sheet.pages : []).slice(0, 5).map(page => ({
      page: page.page,
      copy: boundedText(page.copy, 4000),
      prompt: boundedText(page.prompt, 4000),
      size: boundedText(page.size, 40),
      referenceImages: (Array.isArray(page.referenceImages) ? page.referenceImages : []).slice(0,12).map(ref => ({sourceId: ref.sourceId, fileOrder: ref.fileOrder, ...(ref.role ? {role:ref.role} : {})})),
      sourceIds: Array.isArray(page.sourceIds) ? page.sourceIds.slice(0, 20) : [],
    })),
  }];
}

export const assetSearchLimits = Object.freeze({ results: SEARCH_LIMIT, page: PAGE_LIMIT });
