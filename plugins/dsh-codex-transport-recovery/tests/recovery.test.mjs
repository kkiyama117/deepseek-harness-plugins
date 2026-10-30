import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, classifyStream } from '../index.mjs';
const failure = (message = 'WebSocket closed 1000', code = 'PI_AI_ERROR') => ({ type: 'finish', reason: { kind: 'error', failure: { message, code, requestId: 'preserved' } } });
const collect = async (chunks, provider = 'openai-codex') => Array.fromAsync(classifyStream(chunks, provider));

for (const code of [1000, 1012]) test(`corrects incomplete close ${code} while preserving content, original error and request id`, async () => {
  const partial = Object.freeze({ type: 'text-delta', index: 0, text: 'unfinished' });
  const original = failure(`WebSocket closed ${code}`);
  const result = await collect([partial, original]);
  assert.equal(result[0], partial);
  assert.equal(result[1].reason.failure.code, 'TRANSPORT');
  assert.equal(result[1].reason.failure.message, `WebSocket closed ${code}`);
  assert.equal(result[1].reason.failure.requestId, 'preserved');
  assert.equal(original.reason.failure.code, 'PI_AI_ERROR');
});
test('accepts service-restart close reason text', async () => {
  assert.equal((await collect([failure('WebSocket closed 1012 service restart')]))[0].reason.failure.code, 'TRANSPORT');
});
for (const [label, chunk, provider] of [
  ['message too big', failure('WebSocket closed 1009 message too big'), 'openai-codex'],
  ['authentication', failure('WebSocket closed 1000 unauthorized', 'AUTH'), 'openai-codex'],
  ['unknown provider error', failure('Something else'), 'openai-codex'],
  ['other provider', failure(), 'google'],
  ['already classified', failure('WebSocket closed 1000', 'TRANSPORT'), 'openai-codex'],
  ['successful completion', { type: 'finish', reason: { kind: 'stop' } }, 'openai-codex'],
  ['cancellation', { type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelled', code: 'ABORTED' } } }, 'openai-codex'],
]) test(`leaves ${label} unchanged`, async () => assert.equal((await collect([chunk], provider))[0], chunk));

test('uses one official event registration and delegates the original request once', async () => {
  let listener;
  apply({ on(event, callback) { assert.equal(event, 'llm/stream'); listener = callback; } });
  const options = Object.freeze({ provider: 'openai-codex', model: 'gpt-6-astra' });
  let calls = 0;
  const result = await Array.fromAsync(listener(options, () => { calls++; return [failure()]; }));
  assert.equal(calls, 1);
  assert.equal(result[0].reason.failure.code, 'TRANSPORT');
  assert.equal(options.model, 'gpt-6-astra');
});
