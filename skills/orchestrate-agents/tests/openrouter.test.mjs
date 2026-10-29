import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { routeStage } from '../scripts/route.mjs';

const json = async name => JSON.parse(await readFile(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const never = () => { throw new Error('unexpected network'); };
process.env.OPENROUTER_API_KEY = 'synthetic-openrouter-key';

async function fixture() {
  const stage = await json('routing-stage'), policy = await json('routing-policy');
  Object.assign(policy, { gateway: 'openrouter', model: 'typesafe/jev-1.13', externalSend: true, facts: {} });
  return { stage, policy };
}
function mock(mutate = () => {}) {
  return async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-openrouter-key');
    assert.equal(options.redirect, 'error');
    const request = JSON.parse(options.body);
    assert.deepEqual(request.provider, { allow_fallbacks: false });
    const selected = { readiness: 'ready', separability: 'together', delegation_value: 'small' };
    const body = {
      id: 'gen-synthetic', provider: 'TypeSafe', model: 'typesafe/jev-1.13-20260917',
      answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, {
        type: 'choice', choice: selected[id], confidence: 1,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === selected[id] ? 1 : 0])),
      }])),
      usage: { input_tokens: 123, output_tokens: 0, cost: 0.000005166 },
    };
    mutate(body);
    return new Response(JSON.stringify(body));
  };
}

test('OpenRouter Decisions uses its own credential, pinned model and receipt metadata', async () => {
  const { stage, policy } = await fixture();
  const report = await routeStage(stage, policy, { fetchImpl: mock() });
  assert.equal(report.status, 'shadow'); assert.equal(report.flow, 'F1');
  assert.equal(report.gateway, 'openrouter'); assert.equal(report.requestId, 'gen-synthetic');
  assert.equal(report.response.model, 'typesafe/jev-1.13-20260917');
  assert.equal(report.response.provider, 'TypeSafe'); assert.equal(report.response.usage.cost, 0.000005166);
  assert(!JSON.stringify(report).includes('synthetic-openrouter-key'));
  policy.externalSend = false;
  const cached = await routeStage(stage, policy, { previous: report, fetchImpl: never });
  assert.equal(cached.cacheHit, true); assert.equal(cached.requestId, report.requestId);
  assert.deepEqual(cached.response, report.response);
});

test('gateway/model mismatch and unsupported aliases fail without sending', async () => {
  const { stage, policy } = await fixture();
  for (const model of ['typesafe/jev-latest', 'jev-latest', 'jev-1.13.0']) {
    policy.model = model;
    assert.equal((await routeStage(stage, policy, { fetchImpl: never })).status, 'fallback');
  }
  policy.model = 'typesafe/jev-1.13'; policy.gateway = 'unknown';
  assert.equal((await routeStage(stage, policy, { fetchImpl: never })).status, 'fallback');
});

test('OpenRouter never reuses direct-provider credentials or a different model receipt', async () => {
  const { stage, policy } = await fixture();
  delete process.env.OPENROUTER_API_KEY; process.env.TYPESAFE_API_KEY = 'wrong-provider-key';
  try {
    const report = await routeStage(stage, policy, { fetchImpl: never });
    assert.equal(report.reason, 'missing-OPENROUTER_API_KEY');
  } finally { process.env.OPENROUTER_API_KEY = 'synthetic-openrouter-key'; delete process.env.TYPESAFE_API_KEY; }
  const report = await routeStage(stage, policy, { fetchImpl: mock(body => { body.model = 'jev-1.13.0'; }) });
  assert.equal(report.status, 'fallback'); assert.equal(report.executable, false);
});

test('latest follows resolved Jev versions without reusing classifications or resetting usage', async () => {
  const { stage, policy } = await fixture(); policy.model = '~typesafe/jev-latest';
  const first = await routeStage(stage, policy, { fetchImpl: mock() });
  assert.equal(first.status, 'shadow'); assert.equal(first.flow, 'F1');
  assert.equal(first.cache, null); assert.equal(first.cachePolicy, 'no-reuse-for-latest');
  assert.equal(first.response.model, 'typesafe/jev-1.13-20260917');
  const second = await routeStage(stage, policy, { previous: first, fetchImpl: mock(body => { body.model = 'typesafe/jev-1.14-20261001'; }) });
  assert.equal(second.status, 'shadow'); assert.equal(second.response.model, 'typesafe/jev-1.14-20261001');
  assert.equal(second.cacheHit, undefined); assert.equal(second.cache, null); assert.equal(second.usage.calls, 2);
  const exhausted = await routeStage(stage, policy, { previous: second, fetchImpl: never });
  assert.equal(exhausted.reason, 'classification-budget-exhausted');
  policy.externalSend = false;
  const denied = await routeStage(stage, policy, { previous: first, fetchImpl: never });
  assert.equal(denied.reason, 'external-send-not-authorized'); assert.equal(denied.usage.calls, 1);
});

test('latest still requires a resolved Jev model and TypeSafe provider', async () => {
  const { stage, policy } = await fixture(); policy.model = '~typesafe/jev-latest';
  for (const mutate of [body => { body.model = '~typesafe/jev-latest'; }, body => { body.model = 'openai/other-20260917'; }, body => { body.provider = 'Unexpected'; }]) {
    const report = await routeStage(stage, policy, { fetchImpl: mock(mutate) });
    assert.equal(report.status, 'fallback'); assert.equal(report.executable, false);
  }
});

test('gateway optional probabilities still remain required for safe route adoption', async () => {
  const { stage, policy } = await fixture();
  for (const mutate of [body => { delete body.answers.readiness.confidence; }, body => { delete body.answers.readiness.probabilities; }, body => { body.usage.cost = -1; }, body => { body.provider = 'Unexpected'; }, body => { body.model = 'typesafe/jev-1.13-20990101'; }]) {
    const report = await routeStage(stage, policy, { fetchImpl: mock(mutate) });
    assert.equal(report.status, 'fallback'); assert.equal(report.executable, false);
  }
});
