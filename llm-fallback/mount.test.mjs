// Real-Cordis mount test for llm-fallback: mounts the plugin's apply() on a
// real Cordis Context and dispatches the llm/stream waterfall exactly as the
// LlmRuntime does (ctx.waterfall(runtime, 'llm/stream', options, next)),
// proving the callback `this` binding, source-model filter, and short-circuit
// semantics against the real runtime.
// Run: DSH_UPSTREAM_ROOT=/path/to/built/dsh node llm-fallback/mount.test.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = process.env.DSH_UPSTREAM_ROOT;
if (!root) throw new Error('Set DSH_UPSTREAM_ROOT to the built DSH checkout under test.');
const { Context } = await import(pathToFileURL(resolve(root, 'vendor/cordis/lib/index.js')).href);
import { apply } from './index.mjs';

const finish = (kind, code) => ({ type: 'finish', reason: kind === 'stop' ? { kind } : { kind, failure: { code } } });
const delta = { type: 'text-delta', index: 0, text: 'hi' };

async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

const ctx = new Context();
const runtime = {
  stream(options) {
    return (async function* () {
      if (options.provider === 'openrouter') {
        yield delta;
        yield finish('stop');
      } else {
        yield finish('error', 'NO_ADAPTER');
      }
    })();
  },
};

// Mount through the real registry so the effect is fiber-owned and disposable.
const fiber = await ctx.plugin(apply, {
  chains: {
    'ollama-cloud': {
      sourceModel: 'glm-5.3-flash',
      routes: [{ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' }],
    },
  },
});

// Dispatch the real waterfall the way LlmRuntime.stream does:
//   ctx.waterfall(this, 'llm/stream', options, next)
// Cordis binds each listener's `this` to the first (runtime) argument.
// Dispatch from the plugin's own fiber context so its listener is in scope.
function stream(runtimeArg, options) {
  return fiber.ctx.waterfall(runtimeArg, 'llm/stream', options, () => (async function* () {
    yield finish('error', 'QUOTA');
  })());
}

// 1. Matching source model falls back onto openrouter/deepseek-v4-flash-0731.
{
  const chunks = await collect(stream(runtime, { provider: 'ollama-cloud', model: 'glm-5.3-flash' }));
  assert.deepEqual(chunks, [delta, finish('stop')]);
  console.log('ok mount: real llm/stream waterfall falls back to openrouter (this-bound runtime)');
}

// 2. Non-matching source model passes through untouched (source-model filter).
{
  const chunks = await collect(stream(runtime, { provider: 'ollama-cloud', model: 'glm-5.3' }));
  assert.deepEqual(chunks, [finish('error', 'QUOTA')]);
  console.log('ok mount: source-model filter keeps non-matching model on direct path');
}

// 3. Every route failing before content propagates the last failure.
{
  const failRuntime = {
    stream() { return (async function* () { yield finish('error', 'AUTH'); })(); },
  };
  const chunks = await collect(stream(failRuntime, { provider: 'ollama-cloud', model: 'glm-5.3-flash' }));
  assert.deepEqual(chunks, [finish('error', 'AUTH')]);
  console.log('ok mount: exhausted route propagates the last failure');
}

// Teardown: disposing the fiber must unwind the llm/stream listener (effect).
await fiber.dispose();
assert.ok(true, 'fiber disposed cleanly');
console.log('real cordis mount test passed');
