// Self-check for llm-fallback: assert-based, no framework.
// Run: node llm-fallback/test.mjs
import assert from 'node:assert/strict';
import { apply, buildOptions, normalizeChains, normalizeFallbackOn, withFallback } from './index.mjs';

const finish = (kind, code) => ({ type: 'finish', reason: kind === 'stop' ? { kind } : { kind, failure: { code } } });
const delta = { type: 'text-delta', index: 0, text: 'hi' };

async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

const CHAIN = normalizeChains({
  'kimi-coding': {
    sourceModel: 'kimi-k3',
    routes: [
      { provider: 'cursor', model: 'grok-4.6', reasoningEffort: 'xhigh', strip: ['maxTokens', 'temperature', 'stop'] },
      { provider: 'deepseek', model: 'deepseek-v4-pro' },
    ],
  },
});
const ON = new Set(normalizeFallbackOn(['QUOTA', 'RATE_LIMIT']));

// 1. QUOTA before content → first route wins, strip applied, yield untouched.
{
  const calls = [];
  const runtime = {
    stream(options) {
      calls.push(options);
      return (async function* () { yield delta; yield finish('stop'); })();
    },
  };
  const next = () => (async function* () { yield finish('error', 'QUOTA'); })();
  const chunks = await collect(withFallback(runtime, { provider: 'kimi-coding', model: 'kimi-k3', maxTokens: 32768, temperature: 0.2, stop: ['x'] }, next, CHAIN['kimi-coding'].routes, ON));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'cursor');
  assert.equal(calls[0].model, 'grok-4.6');
  assert.equal(calls[0].reasoningEffort, 'xhigh');
  assert.equal(calls[0].maxTokens, undefined);
  assert.equal(calls[0].temperature, undefined);
  assert.equal(calls[0].stop, undefined);
  assert.deepEqual(chunks, [delta, finish('stop')]);
  console.log('ok 1: QUOTA falls back to the first route with strip applied');
}

// 2. First route fails before content → second route is tried.
{
  const calls = [];
  const runtime = {
    stream(options) {
      calls.push(options.provider);
      return options.provider === 'cursor'
        ? (async function* () { yield finish('error', 'RATE_LIMIT'); })()
        : (async function* () { yield delta; yield finish('stop'); })();
    },
  };
  const next = () => (async function* () { yield finish('error', 'RATE_LIMIT'); })();
  const chunks = await collect(withFallback(runtime, { provider: 'kimi-coding', model: 'kimi-k3' }, next, CHAIN['kimi-coding'].routes, ON));
  assert.deepEqual(calls, ['cursor', 'deepseek']);
  assert.deepEqual(chunks, [delta, finish('stop')]);
  console.log('ok 2: failed first route falls through to the next');
}

// 3. All routes fail before content → last failure reaches the caller.
{
  const runtime = {
    stream(options) {
      return (async function* () { yield finish('error', options.provider === 'cursor' ? 'QUOTA' : 'RATE_LIMIT'); })();
    },
  };
  const next = () => (async function* () { yield finish('error', 'QUOTA'); })();
  const chunks = await collect(withFallback(runtime, { provider: 'kimi-coding', model: 'kimi-k3' }, next, CHAIN['kimi-coding'].routes, ON));
  assert.deepEqual(chunks, [finish('error', 'RATE_LIMIT')]);
  console.log('ok 3: all routes failed → last failure propagates');
}

// 4. Content before the error blocks the fallback (primary and routes).
{
  let streamed = false;
  const runtime = { stream() { streamed = true; return (async function* () {})(); } };
  const next = () => (async function* () { yield delta; yield finish('error', 'QUOTA'); })();
  const chunks = await collect(withFallback(runtime, { provider: 'kimi-coding', model: 'kimi-k3' }, next, CHAIN['kimi-coding'].routes, ON));
  assert.equal(streamed, false);
  assert.deepEqual(chunks, [delta, finish('error', 'QUOTA')]);
  console.log('ok 4: content before the error blocks the fallback');
}

// 5. Unlisted code (e.g. AUTH) does not trigger a fallback.
{
  let streamed = false;
  const runtime = { stream() { streamed = true; return (async function* () {})(); } };
  const next = () => (async function* () { yield finish('error', 'AUTH'); })();
  const chunks = await collect(withFallback(runtime, { provider: 'kimi-coding', model: 'kimi-k3' }, next, CHAIN['kimi-coding'].routes, ON));
  assert.equal(streamed, false);
  assert.deepEqual(chunks, [finish('error', 'AUTH')]);
  console.log('ok 5: unlisted failure codes pass through');
}

// 6. No chain for the provider → apply() guard (normalizeChains lookup).
{
  assert.equal(normalizeChains({})['kimi-coding'], undefined);
  assert.equal(normalizeChains(CHAIN)['cursor'], undefined);
  console.log('ok 6: providers without a chain are untouched');
}

// 7. Config validation: bad chain spec, missing sourceModel, self-loop, strip.
{
  assert.throws(() => normalizeChains({ 'kimi-coding': 'nope' }), /sourceModel, routes/);
  assert.throws(() => normalizeChains({ 'kimi-coding': { routes: [{ provider: 'cursor', model: 'x' }] } }), /sourceModel filter/);
  assert.throws(() => normalizeChains({ 'kimi-coding': { sourceModel: 'kimi-k3', routes: [{ provider: 'kimi-coding', model: 'x' }] } }), /cycle/);
  assert.throws(() => normalizeChains({ 'kimi-coding': { sourceModel: 'kimi-k3', routes: [{ provider: 'cursor', model: 'grok-4.6', strip: 'maxTokens' }] } }), /array of field names/);
  assert.throws(() => normalizeFallbackOn('QUOTA'), /array of failure codes/);
  assert.deepEqual(normalizeFallbackOn(undefined), ['QUOTA', 'RATE_LIMIT']);
  console.log('ok 7: config validation');
}

// 8. buildOptions keeps unrelated fields and drops only the strip list.
{
  const built = buildOptions({ provider: 'kimi-coding', model: 'kimi-k3', maxTokens: 1, system: 's', tools: [] }, CHAIN['kimi-coding'].routes[0]);
  assert.equal(built.provider, 'cursor');
  assert.equal(built.model, 'grok-4.6');
  assert.equal(built.reasoningEffort, 'xhigh');
  assert.equal(built.maxTokens, undefined);
  assert.equal(built.system, 's');
  assert.deepEqual(built.tools, []);
  console.log('ok 8: buildOptions');
}

// 9. Source-model filter: only the configured source model falls back.
{
  const calls = [];
  const runtime = { stream(o) { calls.push(o); return (async function* () { yield finish('stop'); })(); } };
  const rows = [];
  const ctx = {
    on(name, fn) { if (name === 'llm/stream') rows.push(fn); },
  };
  apply(ctx, {
    chains: { 'ollama-cloud': { sourceModel: 'glm-5.3-flash', routes: [{ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' }] } },
  });
  assert.equal(rows.length, 1);
  const cb = rows[0];
  // Non-matching model (glm-5.3) → next() untouched, no fallback stream.
  const nonMatching = await collect(cb.call(runtime, { provider: 'ollama-cloud', model: 'glm-5.3' }, () => (async function* () { yield finish('error', 'RATE_LIMIT'); })()));
  assert.deepEqual(nonMatching, [finish('error', 'RATE_LIMIT')]);
  assert.equal(calls.length, 0);
  // Matching model (glm-5.3-flash) → falls back to openrouter.
  const matching = await collect(cb.call(runtime, { provider: 'ollama-cloud', model: 'glm-5.3-flash' }, () => (async function* () { yield finish('error', 'RATE_LIMIT'); })()));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'openrouter');
  assert.deepEqual(matching, [finish('stop')]);
  console.log('ok 9: source-model filter lets only the configured model fall back');
}

// 10. Exact requested target: ollama-cloud/glm-5.3-flash → openrouter/deepseek-v4-flash-0731.
{
  const calls = [];
  const runtime = {
    stream(options) {
      calls.push(options);
      return (async function* () { yield delta; yield finish('stop'); })();
    },
  };
  const next = () => (async function* () { yield finish('error', 'RATE_LIMIT'); })();
  const TARGET = normalizeChains({
    'ollama-cloud': { sourceModel: 'glm-5.3-flash', routes: [{ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' }] },
  })['ollama-cloud'];
  const chunks = await collect(withFallback(runtime, { provider: 'ollama-cloud', model: 'glm-5.3-flash' }, next, TARGET.routes, ON));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'openrouter');
  assert.equal(calls[0].model, 'deepseek/deepseek-v4-flash-0731');
  assert.deepEqual(chunks, [delta, finish('stop')]);
  console.log('ok 10: ollama-cloud/glm-5.3-flash RATE_LIMIT falls back once to openrouter/deepseek-v4-flash-0731');
}

// 11. Disposal: a consumer return() closes the route generator and runs its finally.
{
  let routeClosed = false;
  const runtime = {
    stream() {
      return (async function* () {
        try { yield delta; yield finish('stop'); } finally { routeClosed = true; }
      })();
    },
  };
  const next = () => (async function* () { yield finish('error', 'QUOTA'); })();
  const iter = withFallback(runtime, { provider: 'kimi-coding', model: 'kimi-k3' }, next, CHAIN['kimi-coding'].routes, ON);
  const first = await iter.next();
  assert.equal(first.value.type, 'text-delta');
  await iter.return();
  assert.equal(routeClosed, true);
  const after = await iter.next();
  assert.equal(after.done, true);
  console.log('ok 11: disposal closes the route generator; no further chunks');
}

assert.throws(() => normalizeChains({ a: { sourceModel: 'm' } }), /routes array/);
assert.throws(() => normalizeChains({
  a: { sourceModel: 'm', routes: [{ provider: 'b', model: 'm' }] },
  b: { sourceModel: 'm', routes: [{ provider: 'a', model: 'm' }] },
}), /chained fallback/);
{
  let calls = 0;
  const runtime = { async *stream() { calls++; yield finish('error', 'AUTH'); } };
  const chunks = await collect(withFallback(runtime, { provider: 'a' },
    async function* () { yield finish('error', 'RATE_LIMIT'); },
    [{ provider: 'b', model: 'm', strip: [] }, { provider: 'c', model: 'm', strip: [] }], ON));
  assert.equal(calls, 1);
  assert.deepEqual(chunks, [finish('error', 'AUTH')]);
}
console.log('additional checks: malformed routes, chained providers, terminal alternative error');
console.log('all checks passed');
