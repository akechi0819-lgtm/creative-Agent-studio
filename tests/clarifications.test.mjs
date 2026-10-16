import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAnswers, validateQuestions } from '../src/web/clarifications.mjs';

const questions = [{
  id: 'audience',
  question: '内容主要面向谁？',
  options: [{ id: 'parents', label: '家长' }, { id: 'students', label: '学生' }],
  allowOther: true,
}];
const assistantMessage = { id: '12af39b1-66e6-4d78-b8b1-c6f0b31514a9', role: 'assistant', questions };

test('structured clarification questions enforce a small choice schema', () => {
  assert.deepEqual(validateQuestions(questions), questions);
  assert.throws(() => validateQuestions([]), { code: 'ERR_CLARIFICATION_INVALID' });
  assert.throws(() => validateQuestions(Array.from({ length: 4 }, (_, index) => ({ ...questions[0], id: `q${index}` }))), { code: 'ERR_CLARIFICATION_INVALID' });
  assert.throws(() => validateQuestions([{ ...questions[0], options: [questions[0].options[0]] }]), { code: 'ERR_CLARIFICATION_INVALID' });
  assert.throws(() => validateQuestions([{ ...questions[0], options: [...questions[0].options, ...questions[0].options, ...questions[0].options] }]), { code: 'ERR_CLARIFICATION_INVALID' });
  assert.throws(() => validateQuestions([{ ...questions[0], multiple: 'yes' }]), { code: 'ERR_CLARIFICATION_INVALID' });
});

test('answer validation binds every answer to the stored assistant question and canonicalizes labels', () => {
  const result = validateAnswers([assistantMessage], {
    messageId: assistantMessage.id,
    items: [{ questionId: 'audience', optionIds: ['parents'], otherText: '偏远地区家庭' }],
  });
  assert.deepEqual(result.answers, {
    messageId: assistantMessage.id,
    items: [{ questionId: 'audience', optionIds: ['parents'], otherText: '偏远地区家庭' }],
  });
  assert.match(result.summary, /家长/);
  assert.match(result.summary, /偏远地区家庭/);

  assert.throws(() => validateAnswers([assistantMessage, {
    id: '43d77887-0465-4bcc-a0d6-d0248a06ca2e',
    role: 'user',
    answers: { messageId: assistantMessage.id, items: [{ questionId: 'audience', optionIds: ['parents'] }] },
  }], {
    messageId: '94fe07ac-c6c1-4526-8dbc-877cf6cfb759',
    items: [{ questionId: 'audience', optionIds: ['parents'] }],
  }), { code: 'ERR_CLARIFICATION_NOT_FOUND' });
  assert.throws(() => validateAnswers([assistantMessage], {
    messageId: assistantMessage.id,
    items: [{ questionId: 'forged-question', optionIds: ['parents'] }],
  }), { code: 'ERR_CLARIFICATION_ANSWER_INVALID' });
  assert.throws(() => validateAnswers([assistantMessage], {
    messageId: assistantMessage.id,
    items: [{ questionId: 'audience', optionIds: ['forged-option'] }],
  }), { code: 'ERR_CLARIFICATION_ANSWER_INVALID' });
  assert.throws(() => validateAnswers([assistantMessage], {
    messageId: assistantMessage.id,
    items: [],
  }), { code: 'ERR_CLARIFICATION_ANSWER_INVALID' });
  assert.throws(() => validateAnswers([assistantMessage, {
    id: '43d77887-0465-4bcc-a0d6-d0248a06ca2e',
    role: 'user',
    answers: { messageId: assistantMessage.id, items: [{ questionId: 'audience', optionIds: ['parents'] }] },
  }], {
    messageId: assistantMessage.id,
    items: [{ questionId: 'audience', optionIds: ['parents'] }],
  }), { code: 'ERR_CLARIFICATION_ALREADY_ANSWERED' });
});
