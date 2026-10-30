import test from 'node:test';
import assert from 'node:assert/strict';
import { TrialRunner } from '../runner.mjs';
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { Config, initialState } from '../schema.mjs';
import { EvolveStore } from '../state.mjs';

function harness(change = {}) {
  const config = Config.parse({ mode: 'propose', route: { provider: 'mock', model: 'fixed' }, dailyRequestLimit: 2,
    request: { maxOutputTokens: 20, maxInputBytes: 1000, maxOutputBytes: 1000, timeoutMs: 1000 },
    assets: [{ name: 'evolve-test', description: 'test', tests: [{ id: 't', prompt: 'p', equals: 'ok' }] }], ...change });
  let value = initialState();
  const store = new EvolveStore({ get: () => value, set: async next => { value = next; } }, config);
  let removed = false;
  const ctx = { get: () => ({}), on: () => () => { removed = true; } };
  const runner = new TrialRunner(ctx, store, config);
  const run = { requests: 0, signal: new AbortController().signal, error: null };
  const options = markAgentLoopRequest({ provider: 'mock', model: 'fixed', maxTokens: 20, messages: [] });
  return { runner, run, options, store, removed: () => removed };
}
async function collect(chunks) { const out = []; for await (const chunk of chunks) out.push(chunk); return out; }
function stream(onDispatch = () => {}) {
  return async function* () { onDispatch(); yield { type: 'finish', reason: { kind: 'stop' } }; };
}

test('route and token changes are denied before adapter dispatch or budget consumption', async () => {
  for (const change of [{ provider: 'other' }, { model: 'other' }, { maxTokens: 100 }, { purpose: 'session-title' }]) {
    const { runner, run, options, store } = harness();
    let dispatched = false;
    await assert.rejects(collect(runner.boundedStream(run, markAgentLoopRequest({ ...options, ...change }), stream(() => { dispatched = true; }))));
    assert.equal(dispatched, false);
    assert.equal(store.read().budget.requests, 0);
    await runner.close();
  }
});

test('auxiliary calls cannot consume budget or invalidate the evaluation answer', async () => {
  const { runner, run, options, store } = harness();
  await assert.rejects(collect(runner.boundedStream(run, { ...options, purpose: 'session-title' }, stream())), { code: 'AUXILIARY_REQUEST' });
  assert.equal(run.error, null);
  assert.equal(store.read().budget.requests, 0);
  await collect(runner.boundedStream(run, options, stream()));
  assert.equal(run.error, null);
  await runner.close();
});

test('concurrent dispatch attempts cannot both pass the reservation boundary', async () => {
  const { runner, run, options, store } = harness();
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const reserve = store.reserveRequest.bind(store);
  let reservations = 0;
  store.reserveRequest = async () => { reservations++; entered(); await gate; return reserve(); };
  const first = collect(runner.boundedStream(run, options, stream()));
  await started;
  await assert.rejects(collect(runner.boundedStream(run, options, stream())), { code: 'REQUEST_LIMIT' });
  assert.equal(reservations, 1);
  release();
  await first;
  assert.equal(store.read().budget.requests, 1);
  await runner.close();
});

test('every dispatch reserves persistently, retries cannot bypass single-request bound', async () => {
  const { runner, run, options, store } = harness();
  let calls = 0;
  await collect(runner.boundedStream(run, options, stream(() => calls++)));
  await assert.rejects(collect(runner.boundedStream(run, options, stream(() => calls++))), { code: 'REQUEST_LIMIT' });
  assert.equal(calls, 1);
  assert.equal(store.read().budget.requests, 1);
  await runner.close();
});

test('the complete input, including schemas and multibyte text, is bounded', async () => {
  const { runner, run, options, store } = harness();
  let dispatched = false;
  await assert.rejects(collect(runner.boundedStream(run, markAgentLoopRequest({ ...options, tools: [{ description: '日'.repeat(400) }] }),
    stream(() => { dispatched = true; }))), { code: 'INPUT_LIMIT' });
  assert.equal(dispatched, false);
  assert.equal(store.read().budget.requests, 0);
  await runner.close();
});

test('tool requests, truncated output, and oversized streams are not valid answers', async () => {
  for (const [chunk, code] of [
    [{ type: 'tool-call-delta', id: 'x', index: 0, name: 'bash', argumentsDelta: '{}' }, 'TOOL_REQUESTED'],
    [{ type: 'finish', reason: { kind: 'max-tokens' } }, 'MODEL_INCOMPLETE'],
    [{ type: 'text-delta', index: 0, text: '日'.repeat(400) }, 'OUTPUT_LIMIT'],
  ]) {
    const { runner, run, options, store } = harness();
    await assert.rejects(collect(runner.boundedStream(run, options, async function* () { yield chunk; })), { code });
    assert.equal(store.read().budget.requests, 1, 'failed requests are not refunded');
    assert.equal(run.error.code, code);
    await runner.close();
  }
});

test('deadline expiration is a failed trial and waits for its agent disposal', { timeout: 5000 }, async () => {
  const { runner } = harness({ request: { maxOutputTokens: 20, maxInputBytes: 1000, maxOutputBytes: 1000, timeoutMs: 1 } });
  let disposed = false;
  runner.agents = { create: async () => ({ agent: { followup() {} }, dispose: async () => { disposed = true; } }) };
  await assert.rejects(runner.run({ prompt: 'x', instructions: 'x' }), { code: 'TIMEOUT' });
  assert.equal(disposed, true);
  assert.equal(runner.sessions.size, 0);
  assert.equal(runner.pending.size, 0);
  await runner.close();
});

test('already-cancelled requests do not dispatch; closed runner removes policy and refuses admission', async () => {
  const { runner, run, options, store, removed } = harness();
  const abort = new AbortController();
  abort.abort(new Error('cancelled'));
  run.signal = abort.signal;
  let dispatched = false;
  await assert.rejects(collect(runner.boundedStream(run, options, stream(() => { dispatched = true; }))));
  assert.equal(dispatched, false);
  assert.equal(store.read().budget.requests, 0);
  await runner.close();
  assert.equal(removed(), true);
  await assert.rejects(runner.run({ prompt: 'x', instructions: 'x' }), { code: 'CLOSED' });
});
