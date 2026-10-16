import path from 'node:path';
import {
  withTask, readTask, requiredRevision, taskDirectory, readTaskOutputImageBytes,
  readTaskReferenceImageBytes, readTaskUploadedImageBytes, taskInputFingerprint,
  isSheetAuthorized, assertNoCredentials,
} from './tasks.mjs';
import { executeTask } from './executor.mjs';
import { latestReviewForSnapshot } from './reviews.mjs';

const now = () => new Date().toISOString();

function text(value, label, limit = 20000) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
  const result = value.trim();
  if (result.length > limit) throw new Error(`${label}不能超过 ${limit} 个字符`);
  return result;
}

function normalizeAuthorization(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('局部改图必须记录聊天授权');
  const requestId = text(value.requestId, '聊天修改 requestId', 300);
  const requestText = text(value.text, '聊天修改原文');
  assertNoCredentials([requestId, requestText], '聊天修改授权');
  return { requestId, text: requestText };
}

function normalizeOutputEdits(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) throw new Error('局部改图必须指定 1 到 5 页');
  const seen = new Set();
  const edits = value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('局部改图页记录无效');
    if (!Number.isInteger(item.page) || item.page < 1 || item.page > 5 || seen.has(item.page)) throw new Error('局部改图页码无效或重复');
    if (item.image !== undefined || item.styleImages !== undefined) throw new Error('已有成品改图不能混用上传图片引用');
    seen.add(item.page);
    const instruction = text(item.instruction, `第 ${item.page} 页改图指令`);
    const copy = item.copy === undefined ? undefined : text(item.copy, `第 ${item.page} 页准确文案`);
    const stylePages = item.stylePages === undefined ? [] : item.stylePages;
    if (!Array.isArray(stylePages) || stylePages.some((page) => !Number.isInteger(page) || page < 1)) {
      throw new Error(`第 ${item.page} 页风格参考页码无效`);
    }
    if (new Set(stylePages).size !== stylePages.length || stylePages.includes(item.page)) {
      throw new Error(`第 ${item.page} 页风格参考不能重复或包含待改页自身`);
    }
    assertNoCredentials([instruction, ...(copy === undefined ? [] : [copy])], `第 ${item.page} 页改图内容`);
    return { page: item.page, instruction, ...(copy === undefined ? {} : { copy }), stylePages: [...stylePages] };
  });
  edits.sort((a, b) => a.page - b.page);
  return edits;
}

function normalizeUploadReference(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须选择任务中的上传图片`);
  const sourceId = text(value.sourceId, `${label}来源 ID`, 300);
  if (!Number.isInteger(value.fileOrder) || value.fileOrder < 1) throw new Error(`${label}附件顺序必须是正整数`);
  return { sourceId, fileOrder: value.fileOrder };
}

function normalizeUploadedEdits(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) throw new Error('上传图片改图必须指定 1 到 5 页');
  const seen = new Set();
  const edits = value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('上传图片改图页记录无效');
    if (!Number.isInteger(item.page) || item.page < 1 || item.page > 5 || seen.has(item.page)) throw new Error('上传图片改图页码无效或重复');
    if (item.stylePages !== undefined) throw new Error('上传图片改图不能混用已有成品风格页引用');
    seen.add(item.page);
    const instruction = text(item.instruction, `第 ${item.page} 页改图指令`);
    const image = normalizeUploadReference(item.image, `第 ${item.page} 页原图`);
    const styleImages = item.styleImages === undefined ? [] : item.styleImages;
    if (!Array.isArray(styleImages) || styleImages.length > 11) throw new Error(`第 ${item.page} 页风格参考最多 11 张`);
    const normalizedStyles = styleImages.map((reference, index) => normalizeUploadReference(reference, `第 ${item.page} 页风格参考 ${index + 1}`));
    const imageKey = `${image.sourceId}\u0000${image.fileOrder}`;
    const styleKeys = normalizedStyles.map((reference) => `${reference.sourceId}\u0000${reference.fileOrder}`);
    if (new Set(styleKeys).size !== styleKeys.length || styleKeys.includes(imageKey)) throw new Error(`第 ${item.page} 页原图和风格参考不能重复`);
    const copy = item.copy === undefined ? undefined : text(item.copy, `第 ${item.page} 页准确文案`);
    assertNoCredentials([instruction, ...(copy === undefined ? [] : [copy])], `第 ${item.page} 页改图内容`);
    return { page: item.page, image, styleImages: normalizedStyles, instruction, ...(copy === undefined ? {} : { copy }) };
  });
  edits.sort((a, b) => a.page - b.page);
  return edits;
}

function executionsFor(task) {
  const values = [...(task.executionHistory || [])];
  if (task.execution?.version != null) values.push(task.execution);
  const byVersion = new Map();
  for (const execution of values) if (Number.isInteger(execution.version)) byVersion.set(execution.version, execution);
  return [...byVersion.values()].sort((a, b) => a.version - b.version);
}

function sheetFor(task, version) {
  return task.sheets.find((sheet) => sheet.version === version) || null;
}

function completeExecution(task, execution) {
  const sheet = sheetFor(task, execution?.version);
  if (!sheet || execution.status !== 'succeeded' || !Array.isArray(execution.pages)
    || execution.pages.length !== sheet.pages.length) return null;
  const pages = new Map(execution.pages.map((page) => [page.page, page]));
  if (!sheet.pages.every((page) => pages.get(page.page)?.status === 'succeeded')) return null;
  return { sheet, pages };
}

function hasConfirmedInputSnapshot(sheet) {
  return Number.isInteger(sheet?.inputsRevision) && sheet.inputs?.confirmation?.revision === sheet.inputsRevision;
}

function selectConfirmedBaseline(task, requestedVersion) {
  const successes = executionsFor(task)
    .filter((execution) => completeExecution(task, execution))
    .filter((execution) => hasConfirmedInputSnapshot(sheetFor(task, execution.version)))
    .sort((a, b) => b.version - a.version);
  const selected = requestedVersion == null
    ? successes[0]
    : successes.find((execution) => execution.version === requestedVersion);
  if (!selected) throw new Error(requestedVersion == null ? '任务没有带原始输入确认记录的完整成功基线' : `制作单版本 ${requestedVersion} 没有成功执行`);
  return selected;
}

function imageReference(taskId, snapshot, forPage, role, root) {
  const image = snapshot.record?.image;
  if (typeof image?.path !== 'string' || !/^[0-9a-f]{64}$/i.test(image.sha256 || '')) {
    throw new Error(`基线第 ${snapshot.page} 页缺少有效成品记录`);
  }
  const directory = taskDirectory(taskId, root);
  const resolved = path.resolve(image.path);
  const relativePath = path.relative(directory, resolved).split(path.sep).join('/');
  if (!relativePath || relativePath.startsWith('../') || path.isAbsolute(relativePath)) throw new Error('基线成品路径越出任务目录');
  return { forPage, page: snapshot.page, baseVersion: snapshot.version, role, relativePath, sha256: image.sha256.toLowerCase() };
}

function imageSnapshotSheetPage(task, execution, record) {
  const sheet = sheetFor(task, execution.version);
  return sheet?.pages?.find((page) => page.page === record.page) || null;
}

async function successfulPageSnapshots(taskId, task, root, { maxVersion = task.sheetVersion, lineage } = {}) {
  const latest = new Map();
  for (const execution of executionsFor(task).filter((item) => item.version <= maxVersion).sort((a, b) => b.version - a.version)) {
    if (!belongsToSnapshotLineage(task, execution.version, lineage)) continue;
    for (const record of execution.pages || []) {
      if (latest.has(record.page) || record.status !== 'succeeded' || !record.image?.path) continue;
      const page = imageSnapshotSheetPage(task, execution, record);
      if (!page) continue;
      const reference = imageReference(taskId, { page: record.page, version: execution.version, record }, record.page, 'edit-base', root);
      const file = await readTaskOutputImageBytes(taskId, reference, { root });
      latest.set(record.page, { page: record.page, version: execution.version, execution, sheet: sheetFor(task, execution.version), definition: page, record, reference, sha256: file.sha256 });
    }
  }
  return latest;
}

async function verifyExecutionImages(taskId, task, execution, root) {
  const complete = completeExecution(task, execution);
  if (!complete) throw new Error(`制作单版本 ${execution?.version ?? '?'} 没有完整成功的执行结果`);
  if (!hasConfirmedInputSnapshot(complete.sheet)) throw new Error(`成功基线 v${execution.version} 缺少其原始输入确认记录`);
  const images = new Map();
  for (const page of complete.sheet.pages) {
    const record = complete.pages.get(page.page);
    const reference = imageReference(taskId, { page: page.page, version: execution.version, record }, page.page, 'edit-base', root);
    const file = await readTaskOutputImageBytes(taskId, reference, { root });
    images.set(page.page, { page: page.page, version: execution.version, sheet: complete.sheet, definition: page, record, reference, sha256: file.sha256 });
  }
  return { ...complete, images };
}

function assertEditSourcesRetained(page, sourceIds) {
  for (const sourceId of page.sourceIds || []) {
    if (!sourceIds.has(sourceId)) throw new Error(`基线第 ${page.page} 页引用的来源 ${sourceId} 当前未保留，不能局部改图`);
  }
  for (const reference of page.referenceImages || []) {
    if (!sourceIds.has(reference.sourceId)) throw new Error(`基线第 ${page.page} 页参考图来源 ${reference.sourceId} 当前未保留，不能局部改图`);
  }
}

function reviewsForVersion(task, version) {
  return [...(task.reviewHistory || []), ...(task.reviews || [])]
    .filter((review) => review.version === version);
}

function archiveCurrentReviews(task) {
  if (!Array.isArray(task.reviews) || task.reviews.length === 0) return;
  task.reviewHistory ||= [];
  task.reviewHistory.push(...task.reviews.map((review) => structuredClone(review)));
}

function requestForId(task, requestId) {
  return (task.sheets || []).find((sheet) => sheet.kind === 'page-edit' && sheet.pageEdit?.chatEdit?.kind === 'chat-edit'
    && sheet.pageEdit.chatEdit.requestId === requestId);
}

function assertSameRequest(sheet, authorization, mode, edits) {
  if (sheet.pageEdit.chatEdit.text !== authorization.text || sheet.pageEdit.mode !== mode
    || JSON.stringify(sheet.pageEdit.edits) !== JSON.stringify(edits)) {
    throw new Error('同一 requestId 已用于不同的局部改图内容');
  }
}

async function executeOrReadExisting(id, sheet, task, root, executionOptions) {
  if (task.sheetVersion !== sheet.version || task.execution?.version !== sheet.version) return task;
  if (task.execution.status === 'succeeded') return task;
  return executeTask(id, { ...executionOptions, version: sheet.version, expectedRevision: task.revision, root });
}

function nextVersion(task) {
  return Math.max(task.sheetVersion || 0, ...(task.sheets || []).map((sheet) => sheet.version || 0)) + 1;
}

async function readUploadedImage(taskId, task, reference, root, page, role) {
  const file = await readTaskUploadedImageBytes(taskId, reference.sourceId, reference.fileOrder, { sources: task.sources, root });
  return { page, role, sourceId: reference.sourceId, fileOrder: reference.fileOrder, sha256: file.sha256 };
}

function sameUploadedBasis(left, right) {
  return left?.kind === 'uploaded-images' && right?.kind === 'uploaded-images'
    && left.inputFingerprint === right.inputFingerprint
    && left.originVersion === right.originVersion
    && JSON.stringify(left.uploadedImages) === JSON.stringify(right.uploadedImages);
}

function belongsToUploadedLineage(task, version, expectedBasis, seen = new Set()) {
  if (!Number.isInteger(version) || version < 1 || seen.has(version)) return false;
  seen.add(version);
  const sheet = sheetFor(task, version);
  const edit = sheet?.pageEdit;
  if (sheet?.kind !== 'page-edit' || edit?.version !== version || !sameUploadedBasis(edit.basis, expectedBasis)) return false;
  const originVersion = expectedBasis.originVersion;
  if (!Number.isInteger(originVersion) || originVersion < 1 || originVersion > version) return false;
  const sourceVersion = edit.baselineEvidence?.sourceVersion;
  if (version === originVersion) {
    return sourceVersion == null && edit.baselineEvidence?.basis === 'uploaded-image-input'
      && edit.mode === 'uploaded-images';
  }
  return Number.isInteger(sourceVersion) && sourceVersion > 0 && sourceVersion < version
    && edit.baselineEvidence?.basis === 'successful-uploaded-image-edit'
    && belongsToUploadedLineage(task, sourceVersion, expectedBasis, seen);
}

function belongsToConfirmedOutputBranch(task, version, proofVersion, seen = new Set()) {
  if (!Number.isInteger(version) || !Number.isInteger(proofVersion) || version < proofVersion || seen.has(version)) return false;
  if (version === proofVersion) return Boolean(sheetFor(task, version));
  seen.add(version);
  const sheet = sheetFor(task, version);
  const edit = sheet?.pageEdit;
  const sourceVersion = edit?.baselineEvidence?.sourceVersion;
  if (sheet?.kind !== 'page-edit' || edit?.version !== version || edit?.basis?.kind !== 'confirmed-output'
    || edit?.baselineEvidence?.basis !== 'successful-execution-requires-confirmed-sheet'
    || !Number.isInteger(sourceVersion) || sourceVersion < proofVersion || sourceVersion >= version) return false;
  return belongsToConfirmedOutputBranch(task, sourceVersion, proofVersion, seen);
}

function belongsToSnapshotLineage(task, version, lineage) {
  if (!lineage) return true;
  if (lineage.kind === 'uploaded-images') return belongsToUploadedLineage(task, version, lineage);
  if (lineage.kind === 'confirmed-output') return belongsToConfirmedOutputBranch(task, version, lineage.proofVersion);
  return false;
}

function lineageFromCurrent(task) {
  const current = sheetFor(task, task.sheetVersion);
  const basis = current?.pageEdit?.basis;
  if (basis?.kind !== 'uploaded-images' || basis.inputFingerprint !== taskInputFingerprint(task)
    || !Array.isArray(basis.uploadedImages) || !basis.uploadedImages.length) return null;
  if (!isSheetAuthorized(task, current.version)) return null;
  return structuredClone(basis);
}

function archiveExecution(task) {
  if (task.execution?.pages?.length) task.executionHistory.push(structuredClone(task.execution));
}

function makeInputsSnapshot(task) {
  return {
    brief: structuredClone(task.brief),
    sources: structuredClone(task.sources),
    confirmation: task.inputConfirmation ? structuredClone(task.inputConfirmation) : null,
    dna: structuredClone(task.dna ?? { revision: 1, enabled: false, content: '', savedAt: null }),
  };
}

function makeDerivedSheet(task, { version, title, sourceIds, pages, inputs, inputsRevision, pageEdit, outputReferences = [] }) {
  return {
    version,
    kind: 'page-edit',
    parentVersion: task.sheetVersion || null,
    title,
    sourceIds,
    pages,
    inputsRevision: inputsRevision ?? null,
    inputs,
    outputReferences,
    pageEdit,
    createdAt: pageEdit.createdAt,
  };
}

async function createUploadedEdit(id, task, { authorization, edits, root }) {
  const pages = [];
  const sourceIds = new Set();
  const uploadedImages = [];
  const uploadedImageReferences = [];
  for (const edit of edits) {
    const base = await readUploadedImage(id, task, edit.image, root, edit.page, 'edit-base');
    sourceIds.add(edit.image.sourceId);
    uploadedImages.push(base);
    uploadedImageReferences.push(base);
    for (const style of edit.styleImages) {
      const reference = await readUploadedImage(id, task, style, root, edit.page, 'style');
      sourceIds.add(style.sourceId);
      uploadedImages.push(reference);
      uploadedImageReferences.push(reference);
    }
    if (1 + edit.styleImages.length > 12) throw new Error(`第 ${edit.page} 页参考图片超过 12 张`);
    pages.push({
      page: edit.page,
      copy: edit.copy ?? '保留原图文字',
      ...(edit.copy === undefined ? { copyMode: 'preserve-source-text' } : {}),
      prompt: edit.instruction,
      size: '3:4',
      sourceIds: [edit.image.sourceId, ...edit.styleImages.map((item) => item.sourceId)],
      referenceImages: [],
    });
  }
  const uniqueImages = new Map();
  for (const image of uploadedImages) uniqueImages.set(`${image.page}\u0000${image.role}\u0000${image.sourceId}\u0000${image.fileOrder}`, image);
  const fingerprint = taskInputFingerprint(task);
  const createdAt = now();
  const version = nextVersion(task);
  const pageEdit = {
    version,
    action: 'edit',
    mode: 'uploaded-images',
    baseVersion: null,
    edits,
    basis: { kind: 'uploaded-images', inputFingerprint: fingerprint, originVersion: version, uploadedImages: [...uniqueImages.values()] },
    uploadedImageReferences,
    chatEdit: { kind: 'chat-edit', requestId: authorization.requestId, text: authorization.text, authorizedAt: createdAt },
    baselineEvidence: { sourceVersion: null, basis: 'uploaded-image-input' },
    createdAt,
  };
  const sheet = makeDerivedSheet(task, {
    version,
    title: text(task.title || '上传图片局部改图', '任务标题', 500),
    sourceIds: [...sourceIds],
    pages,
    inputs: makeInputsSnapshot(task),
    inputsRevision: task.inputConfirmation?.revision ?? null,
    pageEdit,
  });
  archiveExecution(task);
  archiveCurrentReviews(task);
  task.sheetVersion = version;
  task.sheetInputsRevision = task.inputConfirmation?.revision ?? null;
  task.sheets.push(sheet);
  task.sheetConfirmation = null;
  task.execution = { version, status: 'pending', pages: [] };
  task.reviews = [];
  task.finalApproval = null;
  return sheet;
}

async function createOutputEdit(id, task, { authorization, edits, baseVersion, root }) {
  const currentSources = new Set(task.sources.filter((source) => source.decision === 'retained').map((source) => source.id));
  const uploadedLineage = !task.inputConfirmation ? lineageFromCurrent(task) : null;
  if (uploadedLineage) {
    // A one-off uploaded-image branch remains authorized through later local edits as long as its input fingerprint is unchanged.
  } else if (!task.inputConfirmation || task.sheetInputsRevision !== task.inputConfirmation.revision
    || task.sources.some((source) => !['retained', 'excluded'].includes(source.decision))) {
    throw new Error('需求和来源尚未完成人工确认');
  }

  const proof = uploadedLineage ? null : selectConfirmedBaseline(task, baseVersion);
  if (!uploadedLineage && baseVersion !== undefined && proof.version !== baseVersion) throw new Error(`制作单版本 ${baseVersion} 不能作为成功基线`);
  if (uploadedLineage && baseVersion !== undefined) throw new Error('上传图片改图不接受成功输出 baseVersion');
  const snapshotLineage = uploadedLineage
    ? uploadedLineage
    : { kind: 'confirmed-output', proofVersion: proof.version };
  const effectivePages = await successfulPageSnapshots(id, task, root, {
    maxVersion: baseVersion ?? task.sheetVersion,
    lineage: snapshotLineage,
  });
  const verifiedProof = proof ? await verifyExecutionImages(id, task, proof, root) : null;
  const pagePlan = (proof ? sheetFor(task, proof.version)?.pages : null) ?? sheetFor(task, task.sheetVersion)?.pages ?? [];
  const allowedPages = new Map();
  for (const plannedPage of pagePlan) {
    const snapshot = effectivePages.get(plannedPage.page) || verifiedProof?.images.get(plannedPage.page);
    if (snapshot) allowedPages.set(plannedPage.page, snapshot);
  }
  const missingPages = pagePlan.filter((plannedPage) => !allowedPages.has(plannedPage.page)).map((plannedPage) => plannedPage.page);
  if (missingPages.length) {
    throw new Error(`当前基线第 ${missingPages.join('、')} 页没有同一谱系内的成功成品；请先单独完成或恢复这些页`);
  }
  for (const edit of edits) {
    if (!allowedPages.has(edit.page)) throw new Error(`任务没有第 ${edit.page} 页可用的成功成品`);
    for (const stylePage of edit.stylePages) if (!allowedPages.has(stylePage)) throw new Error(`任务没有第 ${stylePage} 页成功成品可作风格参考`);
  }
  const snapshots = [...allowedPages.values()].sort((a, b) => a.page - b.page);
  const editByPage = new Map(edits.map((edit) => [edit.page, edit]));
  const pages = [];
  const pageBases = [...allowedPages.values()].map((snapshot) => ({ page: snapshot.page, version: snapshot.version, sha256: snapshot.sha256 }));
  const outputReferences = [];
  const affectedPages = new Set(edits.map((edit) => edit.page));
  for (const snapshot of snapshots) {
    const edit = editByPage.get(snapshot.page);
    const page = structuredClone(snapshot.definition);
    if (edit) {
      if (!uploadedLineage) assertEditSourcesRetained(page, currentSources);
      for (const reference of page.referenceImages || []) {
        await readTaskReferenceImageBytes(id, reference.sourceId, reference.fileOrder, { sources: task.sources, root });
      }
      if (1 + edit.stylePages.length + (page.referenceImages || []).length > 12) {
        throw new Error(`第 ${edit.page} 页参考图片超过 12 张`);
      }
      page.prompt = `${page.prompt}\n\n对话局部改图要求：${edit.instruction}`;
      if (edit.copy !== undefined) {
        page.copy = edit.copy;
        delete page.copyMode;
      }
      outputReferences.push(imageReference(id, snapshot, edit.page, 'edit-base', root));
      for (const stylePage of edit.stylePages) {
        outputReferences.push(imageReference(id, allowedPages.get(stylePage), edit.page, 'style', root));
      }
    }
    pages.push(page);
  }

  const version = nextVersion(task);
  const createdAt = now();
  const proofVersion = proof?.version ?? (Math.max(0, ...[...allowedPages.values()].map((snapshot) => snapshot.version)) || null);
  const pageEdit = {
    version,
    action: 'edit',
    mode: 'successful-output',
    baseVersion: proof?.version ?? task.sheetVersion,
    pageBases,
    edits,
    ...(uploadedLineage ? { basis: uploadedLineage } : { basis: { kind: 'confirmed-output' } }),
    uploadedImageReferences: [],
    chatEdit: { kind: 'chat-edit', requestId: authorization.requestId, text: authorization.text, authorizedAt: createdAt },
    baselineEvidence: uploadedLineage
      ? { sourceVersion: proofVersion || null, basis: proofVersion ? 'successful-uploaded-image-edit' : 'uploaded-image-input' }
      : {
        sourceVersion: proof.version,
        basis: 'successful-execution-requires-confirmed-sheet',
        executionCompletedAt: proof.completedAt ?? null,
      },
    pageRestorationHistory: [],
    createdAt,
  };
  const sheet = makeDerivedSheet(task, {
    version,
    title: snapshots[0]?.sheet?.title || text(task.title || '局部改图', '任务标题', 500),
    sourceIds: structuredClone(snapshots[0]?.sheet?.sourceIds || [...currentSources]),
    pages,
    inputs: makeInputsSnapshot(task),
    inputsRevision: task.inputConfirmation?.revision ?? null,
    pageEdit,
    outputReferences,
  });
  const inheritedPages = snapshots.filter((snapshot) => !affectedPages.has(snapshot.page)).map((snapshot) => structuredClone(snapshot.record));
  const inheritedReviews = snapshots.flatMap((snapshot) => !affectedPages.has(snapshot.page)
    ? reviewsForVersion(task, snapshot.version)
      .filter((review) => review.page === snapshot.page && review.sha256 === snapshot.sha256)
      .map((review) => ({ ...structuredClone(review), version }))
    : []);
  archiveExecution(task);
  archiveCurrentReviews(task);
  task.sheetVersion = version;
  task.sheetInputsRevision = task.inputConfirmation?.revision ?? null;
  task.sheets.push(sheet);
  task.sheetConfirmation = null;
  task.execution = { version, status: 'pending', pages: inheritedPages };
  task.reviews = inheritedReviews;
  task.finalApproval = null;
  return sheet;
}

/** Create a chat-authorized derived sheet and execute only the edited pages. */
export async function editTaskPages(id, {
  mode = 'successful-output',
  edits: requestedEdits,
  authorization: requestedAuthorization,
  baseVersion,
  expectedRevision,
  root,
  ...executionOptions
} = {}) {
  requiredRevision({ expectedRevision });
  if (executionOptions.retryPage !== undefined) throw new Error('局部改图不接受隐式页重试；请先核对失败页状态');
  if (!['successful-output', 'uploaded-images'].includes(mode)) throw new Error('局部改图 mode 无效');
  const authorization = normalizeAuthorization(requestedAuthorization);
  const edits = mode === 'uploaded-images' ? normalizeUploadedEdits(requestedEdits) : normalizeOutputEdits(requestedEdits);
  if (baseVersion !== undefined && (!Number.isInteger(baseVersion) || baseVersion < 1)) throw new Error('基线 version 必须是正整数');
  if (mode === 'uploaded-images' && baseVersion !== undefined) throw new Error('上传图片改图不接受成功输出 baseVersion');
  const normalizedMode = mode;

  const initial = await readTask(id, root);
  const prior = requestForId(initial, authorization.requestId);
  if (prior) {
    assertSameRequest(prior, authorization, normalizedMode, edits);
    return executeOrReadExisting(id, prior, initial, root, executionOptions);
  }

  let created;
  try {
    created = await withTask(id, async (task) => {
      const concurrent = requestForId(task, authorization.requestId);
      if (concurrent) {
        assertSameRequest(concurrent, authorization, normalizedMode, edits);
        return;
      }
      const sheet = mode === 'uploaded-images'
        ? await createUploadedEdit(id, task, { authorization, edits, root })
        : await createOutputEdit(id, task, { authorization, edits, baseVersion, root });
      return sheet;
    }, { root, expectedRevision });
  } catch (error) {
    if (error.code !== 'ERR_TASK_REVISION_CONFLICT') throw error;
    const current = await readTask(id, root);
    const concurrent = requestForId(current, authorization.requestId);
    if (!concurrent) throw error;
    assertSameRequest(concurrent, authorization, normalizedMode, edits);
    return executeOrReadExisting(id, concurrent, current, root, executionOptions);
  }

  const sheet = requestForId(created, authorization.requestId);
  if (!sheet) throw new Error('局部改图版本没有保存聊天授权记录');
  return executeOrReadExisting(id, sheet, created, root, executionOptions);
}

function executionPage(execution, page) {
  return execution?.pages?.find((record) => record.page === page) || null;
}

async function latestSuccessfulSnapshots(taskId, task, root, maxVersion, lineage) {
  return successfulPageSnapshots(taskId, task, root, { maxVersion, lineage });
}

async function successfulSnapshotAtVersion(taskId, task, version, pageNumber, root, lineage) {
  if (lineage && !belongsToSnapshotLineage(task, version, lineage)) return null;
  const execution = executionsFor(task).find((entry) => entry.version === version);
  const record = executionPage(execution, pageNumber);
  if (!execution || record?.status !== 'succeeded') return null;
  const definition = imageSnapshotSheetPage(task, execution, record);
  if (!definition) return null;
  const reference = imageReference(taskId, { page: pageNumber, version, record }, pageNumber, 'edit-base', root);
  const file = await readTaskOutputImageBytes(taskId, reference, { root });
  return { page: pageNumber, version, execution, sheet: sheetFor(task, version), definition, record, reference, sha256: file.sha256 };
}

function currentPageDefinition(task, page) {
  const sheet = sheetFor(task, task.sheetVersion);
  return sheet?.pages?.find((entry) => entry.page === page) || null;
}

function lineageBasisForRestore(task, currentSheet) {
  if (currentSheet.pageEdit?.basis?.kind === 'uploaded-images') return structuredClone(currentSheet.pageEdit.basis);
  return { kind: 'confirmed-output' };
}

function proofForRestore(currentSheet) {
  const evidence = currentSheet.pageEdit?.baselineEvidence;
  if (evidence) return structuredClone(evidence);
  return {
    sourceVersion: currentSheet.version,
    basis: 'successful-execution-requires-confirmed-sheet',
    executionCompletedAt: null,
  };
}

/** Restore one page into a new version without generating; prior failed or uncertain runs remain untouched. */
export async function restorePageEdit(id, { page, sourceVersion, expectedRevision, root } = {}) {
  requiredRevision({ expectedRevision });
  if (!Number.isInteger(page) || page < 1) throw new Error('恢复页码必须是正整数');
  if (sourceVersion !== undefined && (!Number.isInteger(sourceVersion) || sourceVersion < 1)) throw new Error('恢复来源 version 必须是正整数');
  return withTask(id, async (task) => {
    const currentVersion = task.sheetVersion;
    if (!isSheetAuthorized(task, currentVersion)) throw new Error('当前制作单没有有效执行授权');
    const currentSheet = sheetFor(task, currentVersion);
    const currentExecution = executionsFor(task).find((execution) => execution.version === currentVersion);
    if (!currentExecution) throw new Error('当前制作单没有执行结果');
    const currentPage = currentPageDefinition(task, page);
    if (!currentPage) throw new Error(`当前制作单没有第 ${page} 页`);
    const currentRecord = executionPage(currentExecution, page);
    const currentHash = currentRecord?.status === 'succeeded' ? currentRecord.image?.sha256 : null;

    const basis = lineageBasisForRestore(task, currentSheet);
    const lineage = basis.kind === 'uploaded-images'
      ? basis
      : { kind: 'confirmed-output', proofVersion: Number.isInteger(currentSheet.pageEdit?.baselineEvidence?.sourceVersion)
        ? currentSheet.pageEdit.baselineEvidence.sourceVersion
        : currentVersion };
    const before = await latestSuccessfulSnapshots(id, task, root, currentVersion - 1, lineage);
    let restored = sourceVersion === undefined
      ? before.get(page)
      : await successfulSnapshotAtVersion(id, task, sourceVersion, page, root, lineage);
    if (sourceVersion !== undefined && sourceVersion >= currentVersion) restored = null;
    if (restored && currentHash && restored.sha256 === currentHash) {
      const alternatives = [...executionsFor(task)].filter((execution) => execution.version < currentVersion
        && (sourceVersion === undefined || execution.version === sourceVersion))
        .sort((a, b) => b.version - a.version);
      for (const execution of alternatives) {
        const candidate = await successfulSnapshotAtVersion(id, task, execution.version, page, root, lineage);
        if (!candidate || candidate.sha256 === currentHash) continue;
        restored = candidate;
        break;
      }
    }
    if (!restored) throw new Error(sourceVersion === undefined
      ? `第 ${page} 页没有可恢复的旧成品`
      : `制作单版本 ${sourceVersion} 没有第 ${page} 页可恢复的旧成品`);

    const version = nextVersion(task);
    const createdAt = now();
    const allLatest = await latestSuccessfulSnapshots(id, task, root, currentVersion, lineage);
    const pageNumbers = new Set(currentSheet.pages.map((item) => item.page));
    const latest = new Map([...pageNumbers].flatMap((pageNumber) => allLatest.has(pageNumber)
      ? [[pageNumber, allLatest.get(pageNumber)]]
      : []));
    latest.set(page, restored);
    const pages = [...pageNumbers].sort((a, b) => a - b).map((pageNumber) => {
      const snapshot = latest.get(pageNumber);
      const definition = pageNumber === page ? restored.definition : snapshot?.definition || currentPageDefinition(task, pageNumber);
      return structuredClone(definition);
    }).filter(Boolean);
    const recordsByPage = new Map();
    for (const pageNumber of pageNumbers) {
      const snapshot = latest.get(pageNumber);
      const fallback = executionPage(currentExecution, pageNumber);
      const record = pageNumber === page ? restored.record : snapshot?.record || fallback;
      if (record) recordsByPage.set(pageNumber, structuredClone(record));
    }
    const pageRecords = [...recordsByPage.values()];
    const failedOrUnknown = pageRecords.some((record) => record.status !== 'succeeded');
    const baselineEvidence = proofForRestore(currentSheet);
    const pageEdit = {
      version,
      action: 'restore',
      mode: currentSheet.pageEdit?.mode || 'successful-output',
      baseVersion: currentSheet.pageEdit?.baseVersion ?? currentVersion,
      pageBases: [...latest.values()].map((snapshot) => ({ page: snapshot.page, version: snapshot.version, sha256: snapshot.sha256 })),
      edits: [],
      basis,
      uploadedImageReferences: [],
      chatEdit: currentSheet.pageEdit?.chatEdit ? structuredClone(currentSheet.pageEdit.chatEdit) : undefined,
      restore: { kind: 'restore', page, sourceVersion: restored.version, authorizedAt: createdAt },
      restoredFromVersion: restored.version,
      baselineEvidence,
      pageRestorationHistory: [
        ...(currentSheet.pageEdit?.pageRestorationHistory || []),
        { page, restoredFromVersion: restored.version, sha256: restored.sha256, at: createdAt },
      ],
      createdAt,
    };
    if (pageEdit.chatEdit === undefined) delete pageEdit.chatEdit;
    const sheet = makeDerivedSheet(task, {
      version,
      title: currentSheet.title,
      sourceIds: structuredClone(currentSheet.sourceIds || []),
      pages,
      inputs: makeInputsSnapshot(task),
      inputsRevision: task.inputConfirmation?.revision ?? null,
      pageEdit,
    });
    const reviewRecords = [];
    for (const pageNumber of pageNumbers) {
      const snapshot = latest.get(pageNumber);
      if (!snapshot) continue;
      const review = latestReviewForSnapshot(task, snapshot);
      if (review) reviewRecords.push({ ...structuredClone(review), version });
    }
    archiveExecution(task);
    archiveCurrentReviews(task);
    task.sheetVersion = version;
    task.sheetInputsRevision = task.inputConfirmation?.revision ?? null;
    task.sheets.push(sheet);
    task.sheetConfirmation = null;
    task.execution = {
      ...structuredClone(currentExecution),
      version,
      status: failedOrUnknown ? currentExecution.status === 'cancelled' ? 'cancelled' : 'failed' : 'succeeded',
      pages: pageRecords,
      completedAt: failedOrUnknown ? null : createdAt,
      restoredFromVersion: restored.version,
    };
    task.reviews = reviewRecords;
    task.finalApproval = null;
    return task;
  }, { root, expectedRevision });
}
