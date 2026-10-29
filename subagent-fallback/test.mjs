// Self-check for subagent-fallback: assert-based, no framework.
// Run: node subagent-fallback/test.mjs
import assert from 'node:assert/strict';
import { fallbackLoop, normalizeConfig } from './index.mjs';

const completed = { stopReason: 'completed', output: [{ type: 'text', text: 'plan ok' }] };
const error = (detail) => ({ stopReason: 'error', detail });
const refusal = { stopReason: 'refusal', output: [] };
const maxTokens = { stopReason: 'max-tokens', output: [] };

// 1. Primary completes → one attempt, no fallback.
{
  const attempts = [];
  const outcome = await fallbackLoop(
    [{ provider: 'kimi-coding', model: 'kimi-k3' }, { provider: 'cursor', model: 'grok-4.6' }],
    async (route) => { attempts.push(route.provider); return completed; },
  );
  assert.equal(outcome.ok, true);
  assert.deepEqual(attempts, ['kimi-coding']);
  console.log('ok 1: completed on primary → no fallback');
}

// 2. Primary errors → fallback route completes.
{
  const attempts = [];
  const outcome = await fallbackLoop(
    [{ provider: 'kimi-coding', model: 'kimi-k3' }, { provider: 'cursor', model: 'grok-4.6' }],
    async (route) => { attempts.push(route.provider); return route.provider === 'kimi-coding' ? error('Insufficient Balance') : completed; },
  );
  assert.equal(outcome.ok, true);
  assert.deepEqual(attempts, ['kimi-coding', 'cursor']);
  console.log('ok 2: error on primary → fallback route completes');
}

// 3. All routes error → last failure returned, ok false.
{
  const attempts = [];
  const outcome = await fallbackLoop(
    [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }, { provider: 'c', model: 'm3' }],
    async (route) => { attempts.push(route.provider); return error('fail ' + route.provider); },
  );
  assert.equal(outcome.ok, false);
  assert.deepEqual(attempts, ['a', 'b', 'c']);
  assert.equal(outcome.result.detail, 'fail c');
  console.log('ok 3: all routes error → last failure');
}

// 4. Non-error terminal reasons do NOT retry.
{
  for (const terminal of [refusal, maxTokens]) {
    const attempts = [];
    const outcome = await fallbackLoop(
      [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }],
      async (route) => { attempts.push(route.provider); return terminal; },
    );
    assert.equal(outcome.ok, false);
    assert.deepEqual(attempts, ['a'], 'no retry on ' + terminal.stopReason);
  }
  console.log('ok 4: refusal / max-tokens are final, no retry');
}

// 5. Config validation.
{
  assert.throws(() => normalizeConfig({}), /primary needs string provider and model/);
  assert.throws(() => normalizeConfig({ primary: { provider: 'kimi-coding' } }), /primary needs string provider and model/);
  assert.throws(() => normalizeConfig({ primary: { provider: 'kimi-coding', model: 'kimi-k3' }, fallbackRoutes: 'nope' }), /array of \{ provider, model \}/);
  assert.throws(() => normalizeConfig({ primary: { provider: 'kimi-coding', model: 'kimi-k3' }, fallbackRoutes: [{ provider: 'cursor' }] }), /array of \{ provider, model \}/);
  const cfg = normalizeConfig({ primary: { provider: 'kimi-coding', model: 'kimi-k3' }, fallbackRoutes: [{ provider: 'cursor', model: 'grok-4.6' }] });
  assert.equal(cfg.toolName, 'subagent_frontier');
  assert.equal(cfg.provider, 'spawn');
  assert.equal(cfg.fallbackRoutes.length, 1);
  console.log('ok 5: config validation and defaults');
}

console.log('all checks passed');
