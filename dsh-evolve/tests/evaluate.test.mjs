import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOutput, digest } from '../evaluate.mjs';

test('output correctness is independent of call counts or completion status', () => {
  assert.equal(checkOutput({ equals: '正しい' }, '間違い'), false);
  assert.equal(checkOutput({ equals: 'ok' }, 'ok\n'), false);
  assert.equal(checkOutput({ contains: ['alpha'], notContains: ['error'] }, 'alpha error'), false);
  assert.equal(checkOutput({ jsonEquals: { answer: 42 } }, '{"answer":42}'), true);
  assert.equal(checkOutput({ jsonEquals: { answer: 42 } }, '```json\n{"answer":42}\n```'), false);
  assert.equal(checkOutput({ jsonEquals: { answer: 42 } }, '{"answer":42,"extra":true}'), false);
});

test('approval digests preserve exact text but ignore JSON object key order', () => {
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  assert.notEqual(digest({ content: 'old' }), digest({ content: 'old\n' }));
  assert.notEqual(digest(['a', 'b']), digest(['b', 'a']));
});
