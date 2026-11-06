import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, classifyStream } from '../index.mjs';
const failure = (message, code = 'PI_AI_ERROR') => ({ type: 'finish', reason: { kind: 'error', failure: { message, code, requestId: 'preserved' } } });
const collect = async (chunks) => Array.fromAsync(classifyStream(chunks));

for (const phrase of ['Internal Server Error', 'Bad Gateway', 'Service Unavailable', 'servers are currently overloaded']) test(`corrects ${phrase} while preserving content, message and request id`, async () => {
  const partial = Object.freeze({ type: 'text-delta', index: 0, text: 'unfinished' });
  const original = failure(phrase);
  const result = await collect([partial, original]);
  assert.equal(result[0], partial);
  assert.equal(result[1].reason.failure.code, 'SERVER');
  assert.equal(result[1].reason.failure.message, phrase);
  assert.equal(result[1].reason.failure.requestId, 'preserved');
  assert.equal(original.reason.failure.code, 'PI_AI_ERROR');
});
test('matches the phrase case-insensitively inside a longer message', async () => {
  assert.equal((await collect([failure('upstream said: INTERNAL SERVER ERROR (try again)')]))[0].reason.failure.code, 'SERVER');
});
for (const [label, chunk] of [
  ['unknown provider error', failure('Something else')],
  ['authentication', failure('Internal Server Error', 'AUTH')],
  ['already classified', failure('500 Internal Server Error', 'SERVER')],
  ['a phrase inside a word', failure('xInternal Server Errorx')],
  ['a non-string message', { type: 'finish', reason: { kind: 'error', failure: { message: { text: 'Internal Server Error' }, code: 'PI_AI_ERROR' } } }],
  ['successful completion', { type: 'finish', reason: { kind: 'stop' } }],
  ['cancellation', { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Internal Server Error', code: 'ABORTED' } } }],
  ['a text delta', { type: 'text-delta', index: 0, text: 'Internal Server Error' }],
  ['a gateway timeout', failure('Gateway Timeout')],
]) test(`leaves ${label} unchanged`, async () => assert.equal((await collect([chunk]))[0], chunk));

test('uses one official event registration and delegates the original request once', async () => {
  let listener;
  let registrations = 0;
  apply({ on(event, callback) { registrations++; assert.equal(event, 'llm/stream'); listener = callback; } });
  const options = Object.freeze({ provider: 'ollama-cloud', model: 'deepseek-v4.1-flash' });
  let calls = 0;
  const result = await Array.fromAsync(listener(options, () => { calls++; return [failure('Internal Server Error')]; }));
  assert.equal(registrations, 1);
  assert.equal(calls, 1);
  assert.equal(result[0].reason.failure.code, 'SERVER');
  assert.equal(options.model, 'deepseek-v4.1-flash');
});
