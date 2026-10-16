import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalImageGenerationErrorDetails } from '../third_party/canvas/web/src/lib/canvas/image-generation-errors.js';

test('keeps the first image upload failure visible on the aggregate image node', () => {
  assert.equal(finalImageGenerationErrorDetails({
    hasSuccess: false,
    firstError: '读取图片失败',
    fallback: '全部图片生成失败',
  }), '读取图片失败');
});

test('uses the aggregate fallback only when no per-image error was captured', () => {
  assert.equal(finalImageGenerationErrorDetails({
    hasSuccess: false,
    firstError: '',
    fallback: '全部图片生成失败',
  }), '全部图片生成失败');
});

test('does not leave an aggregate error after at least one image succeeds', () => {
  assert.equal(finalImageGenerationErrorDetails({
    hasSuccess: true,
    firstError: '读取图片失败',
    fallback: '全部图片生成失败',
  }), undefined);
});
