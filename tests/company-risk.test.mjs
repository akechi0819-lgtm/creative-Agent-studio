import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCompanyCopy } from '../src/company/risk.mjs';

test('company copy checker loads the bundled lexicon and reports a real retained term', () => {
  const result = checkCompanyCopy('文案示例：承诺保录取需要人工判断。');
  assert.equal(result.recordCount, 990);
  assert.equal(result.termCount, 985);
  const match = result.matches.find((item) => item.term === '保录取');
  assert.ok(match);
  assert.deepEqual(match.category, ['education', 'study_abroad']);
  assert.equal(match.level, 'high');
  assert.ok(match.reason.length > 0);
  assert.equal(match.order, '文案示例：承诺'.length);
  assert.ok(match.index.length > 0);
  assert.equal(Object.hasOwn(result, 'approved'), false);
});

test('company copy checker handles empty copy and rejects invalid input', () => {
  assert.deepEqual(checkCompanyCopy('').matches, []);
  assert.throws(() => checkCompanyCopy({ text: '保录取' }), /必须是文字/);
  assert.throws(() => checkCompanyCopy('x'.repeat(500_001)), /超过 500000 字符限制/);
});
