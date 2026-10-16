const SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clarificationError(code, message) {
  const error = new Error(message);
  error.code = code;
  if (code === 'ERR_CLARIFICATION_ALREADY_ANSWERED') error.statusCode = 409;
  if (code === 'ERR_CLARIFICATION_NOT_FOUND') error.statusCode = 404;
  return error;
}

function shortText(value, field, maxLength) {
  if (typeof value !== 'string') throw clarificationError('ERR_CLARIFICATION_INVALID', `${field} 必须是文本`);
  const result = value.trim();
  if (!result || result.length > maxLength) {
    throw clarificationError('ERR_CLARIFICATION_INVALID', `${field} 长度必须为 1 到 ${maxLength} 个字符`);
  }
  return result;
}

/** Validate the small, user-visible choice contract emitted by the DSH tool. */
export function validateQuestions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw clarificationError('ERR_CLARIFICATION_INVALID', '追问必须包含 1 到 3 个问题');
  }
  const questionIds = new Set();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !SAFE_ID.test(item.id || '')) {
      throw clarificationError('ERR_CLARIFICATION_INVALID', '追问问题 ID 无效');
    }
    if (questionIds.has(item.id)) throw clarificationError('ERR_CLARIFICATION_INVALID', '追问问题 ID 不能重复');
    questionIds.add(item.id);
    const question = shortText(item.question, '问题', 500);
    if (!Array.isArray(item.options) || item.options.length < 2 || item.options.length > 6) {
      throw clarificationError('ERR_CLARIFICATION_INVALID', '每个问题必须包含 2 到 6 个选项');
    }
    const optionIds = new Set();
    const options = item.options.map((option) => {
      if (!option || typeof option !== 'object' || Array.isArray(option) || !SAFE_ID.test(option.id || '')) {
        throw clarificationError('ERR_CLARIFICATION_INVALID', '选项 ID 无效');
      }
      if (optionIds.has(option.id)) throw clarificationError('ERR_CLARIFICATION_INVALID', '同一问题的选项 ID 不能重复');
      optionIds.add(option.id);
      return { id: option.id, label: shortText(option.label, '选项名称', 200) };
    });
    if (item.multiple !== undefined && typeof item.multiple !== 'boolean') {
      throw clarificationError('ERR_CLARIFICATION_INVALID', 'multiple 必须是布尔值');
    }
    if (item.allowOther !== undefined && typeof item.allowOther !== 'boolean') {
      throw clarificationError('ERR_CLARIFICATION_INVALID', 'allowOther 必须是布尔值');
    }
    return {
      id: item.id,
      question,
      options,
      ...(item.multiple === undefined ? {} : { multiple: item.multiple }),
      ...(item.allowOther === undefined ? {} : { allowOther: item.allowOther }),
    };
  });
}

/** Bind a complete, one-time answer set to an assistant message stored on this task. */
export function validateAnswers(conversation, submission) {
  if (!submission || typeof submission !== 'object' || Array.isArray(submission)
    || typeof submission.messageId !== 'string' || !UUID.test(submission.messageId)
    || !Array.isArray(submission.items)) {
    throw clarificationError('ERR_CLARIFICATION_ANSWER_INVALID', '追问答案格式无效');
  }
  const message = conversation.find((entry) => entry.id === submission.messageId && entry.role === 'assistant' && Array.isArray(entry.questions));
  if (!message) throw clarificationError('ERR_CLARIFICATION_NOT_FOUND', '找不到对应的助手追问，请刷新任务后重试');
  const questions = validateQuestions(message.questions);
  if (conversation.some((entry) => entry.role === 'user' && entry.answers?.messageId === message.id)) {
    throw clarificationError('ERR_CLARIFICATION_ALREADY_ANSWERED', '这组追问已经回答，请读取当前对话');
  }
  if (submission.items.length !== questions.length) {
    throw clarificationError('ERR_CLARIFICATION_ANSWER_INVALID', '请一次回答这组追问中的全部问题');
  }

  const byId = new Map(questions.map((question) => [question.id, question]));
  const seen = new Set();
  const items = submission.items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.questionId !== 'string' || !byId.has(item.questionId)
      || seen.has(item.questionId) || !Array.isArray(item.optionIds)) {
      throw clarificationError('ERR_CLARIFICATION_ANSWER_INVALID', '答案引用了无效或重复的问题');
    }
    seen.add(item.questionId);
    const question = byId.get(item.questionId);
    const optionById = new Map(question.options.map((option) => [option.id, option]));
    const selectedIds = new Set();
    for (const id of item.optionIds) {
      if (typeof id !== 'string' || !optionById.has(id) || selectedIds.has(id)) {
        throw clarificationError('ERR_CLARIFICATION_ANSWER_INVALID', '答案包含无效或重复的选项');
      }
      selectedIds.add(id);
    }
    const otherText = item.otherText === undefined ? '' : shortText(item.otherText, '其他补充', 500);
    if (otherText && question.allowOther !== true) {
      throw clarificationError('ERR_CLARIFICATION_ANSWER_INVALID', '该问题不接受自定义补充');
    }
    if (question.multiple === true) {
      if (selectedIds.size + Number(Boolean(otherText)) < 1) {
        throw clarificationError('ERR_CLARIFICATION_ANSWER_INVALID', '请至少选择一个选项或填写其他补充');
      }
    } else if (selectedIds.size > 1 || selectedIds.size + Number(Boolean(otherText)) < 1) {
      throw clarificationError('ERR_CLARIFICATION_ANSWER_INVALID', '单选题请选择一个选项或填写其他补充');
    }
    const optionIds = [...selectedIds];
    const labels = optionIds.map((id) => optionById.get(id).label);
    return {
      questionId: item.questionId,
      optionIds,
      ...(otherText ? { otherText } : {}),
      question: question.question,
      labels,
    };
  });
  if (seen.size !== questions.length) throw clarificationError('ERR_CLARIFICATION_ANSWER_INVALID', '请回答这组追问中的全部问题');
  const summary = `用户回答了助手的追问：\n${items.map((item) => `- ${item.question}：${[...item.labels, ...(item.otherText ? [`其他补充：${item.otherText}`] : [])].join('、')}`).join('\n')}`;
  const stored = {
    messageId: message.id,
    items: items.map(({ questionId, optionIds, otherText }) => ({ questionId, optionIds, ...(otherText ? { otherText } : {}) })),
  };
  return { answers: stored, summary };
}

