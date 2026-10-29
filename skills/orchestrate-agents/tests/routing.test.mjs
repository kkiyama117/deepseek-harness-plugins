import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { routeStage } from '../scripts/route.mjs';
import { compileWorkflow } from '../scripts/compile.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = async name => JSON.parse(await readFile(join(root, 'examples', name + '.json'), 'utf8'));
const inputs = async () => ({ stage: await fixture('routing-stage'), policy: await fixture('routing-policy') });
const never = () => { throw new Error('unexpected network'); };
const syntheticThresholds = { readiness: 0.7, routine_fit: 0.7, separability: 0.7, delegation_value: 0.7 }; // Test values only, not calibrated safety claims.
function enable(policy) {
  Object.assign(policy, { mode: 'select', externalSend: true, workflowAuthorized: true, facts: {}, thresholds: syntheticThresholds });
}
function response(request, answers = {}) {
  return { model: request.model, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => {
    const choice = answers[id] ?? { readiness: 'ready', routine_fit: 'none', separability: 'research', delegation_value: 'worthwhile' }[id];
    return [id, { type: 'choice', choice, confidence: 0.95, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 0.94 : 0.06 / (Object.keys(q.criteria).length - 1)])) }];
  })), usage: { input_tokens: 100, output_tokens: 20 } };
}
function http(answers, mutate = v => v, requests = []) {
  return async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.redirect, 'error'); assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-key');
    const request = JSON.parse(options.body); requests.push(request);
    assert.deepEqual(Object.keys(request).sort(), ['model', 'questions', 'state']);
    return new Response(JSON.stringify(mutate(response(request, answers))), { headers: { 'x-request-id': 'synthetic-id' } });
  };
}
// Only this isolated Node test process sees the dummy credential. No test uses native fetch.
process.env.TYPESAFE_API_KEY = 'synthetic-key';

test('fixed direct selection and denied authority never call network', async () => {
  const { stage, policy } = await inputs();
  let r = await routeStage(stage, policy, { fetchImpl: never });
  assert.equal(r.flow, 'F1'); assert.equal(r.status, 'shadow'); assert.equal(r.request, null);
  policy.stageAuthorized = false;
  r = await routeStage(stage, policy, { fetchImpl: never }); assert.equal(r.status, 'hold');
  policy.stageAuthorized = true; policy.facts = {};
  r = await routeStage(stage, policy, { fetchImpl: never }); assert.equal(r.reason, 'external-send-not-authorized');
  policy.externalSend = true; policy.limits.maxCalls = 0;
  r = await routeStage(stage, policy, { fetchImpl: never }); assert.equal(r.reason, 'classification-budget-exhausted');
});

test('one batch classifies F3 and compiled unchanged payload executes fake runtime', async () => {
  const { stage, policy } = await inputs(); enable(policy);
  const requests = [];
  const r = await routeStage(stage, policy, { fetchImpl: http({}, undefined, requests) });
  assert.equal(r.status, 'compiled'); assert.equal(r.flow, 'F3'); assert.equal(r.ruleId, 'R6');
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.keys(requests[0].questions), ['readiness', 'separability', 'delegation_value']);
  assert.deepEqual(r.toolInput, compileWorkflow(r.routedRequest, policy.execution));
  const calls = [];
  const result = await new vm.Script(`(async () => {${r.toolInput.script}})()`).runInContext(vm.createContext({ args: r.toolInput.args, agent: async (prompt, options) => {
    calls.push(options); assert.match(prompt, /Implementation proposal based on the comparison/);
    return { status: 'done', summary: 'Synthetic current stage only', evidence: ['fixture'] };
  } }));
  assert.equal(result.status, 'completed'); assert.equal(calls.length, 5);
  assert.equal(r.stage.remainingGoals.length, 2); assert.equal(r.requestId, 'synthetic-id');
});

test('F4 accepts independent writes and compiler rejects overlap, scope, role and budget violations', async () => {
  const { stage, policy } = await inputs(); enable(policy);
  stage.task.writeScope = ['/tmp/synthetic']; stage.units[0].writeScope = ['/tmp/synthetic/a']; stage.units[1].writeScope = ['/tmp/synthetic/b'];
  const run = () => routeStage(stage, policy, { fetchImpl: http({ separability: 'work' }) });
  assert.equal((await run()).flow, 'F4');
  stage.units[1].writeScope = ['/tmp/synthetic/a']; assert.equal((await run()).status, 'fallback');
  stage.units[1].writeScope = ['/tmp/outside']; assert.equal((await run()).status, 'fallback');
  stage.units[1].writeScope = ['/tmp/synthetic/b']; policy.execution.limits.maxCalls = 4;
  assert.equal((await run()).status, 'fallback'); policy.execution.limits.maxCalls = 5;
  delete policy.execution.roles.reviewer; assert.equal((await run()).status, 'fallback');
});

test('independent units need known empty dependencies; research cannot write', async () => {
  const { stage, policy } = await inputs(); enable(policy);
  stage.dependencies.policy_b = ['policy_a'];
  assert.equal((await routeStage(stage, policy, { fetchImpl: http() })).status, 'fallback');
  stage.dependencies.policy_b = []; stage.task.writeScope = ['/tmp/test'];
  assert.equal((await routeStage(stage, policy, { fetchImpl: http() })).status, 'fallback');
});

test('routine IDs are registered candidates; decisive routine ignores optional uncertainty', async () => {
  const { stage, policy } = await inputs(); enable(policy);
  policy.routines = { aggregate: { description: 'Registered synthetic aggregation; no shell command.', eligible: true } };
  stage.routineCandidates = ['aggregate'];
  const r = await routeStage(stage, policy, { fetchImpl: http({ routine_fit: 'aggregate', separability: 'unknown', delegation_value: 'unknown' }, v => {
    v.answers.delegation_value.confidence = 0.01; return v;
  }) });
  assert.equal(r.flow, 'F0'); assert.equal(r.handoff.routineId, 'aggregate'); assert.equal(r.executable, false);
  policy.facts = { readiness: 'ready', routine_fit: 'aggregate' }; policy.externalSend = false;
  assert.equal((await routeStage(stage, policy, { fetchImpl: never })).flow, 'F0');
  policy.routines.aggregate.eligible = false;
  assert.equal((await routeStage(stage, policy, { fetchImpl: never })).status, 'fallback');
});

test('F2 bounded handoff precedes routine; needs_input holds; unknown readiness falls back', async () => {
  const { stage, policy } = await inputs(); enable(policy);
  stage.investigation = { question: 'Which API is present?', target: 'Local docs', exitCriteria: 'Identify documented method', maxSteps: 2 };
  let r = await routeStage(stage, policy, { fetchImpl: http({ readiness: 'investigate', separability: 'unknown' }) });
  assert.equal(r.flow, 'F2'); assert.equal(r.handoff.returnStage, stage.stageId); assert.equal(r.executable, false);
  r = await routeStage(stage, policy, { fetchImpl: http({ readiness: 'needs_input' }) }); assert.equal(r.status, 'hold');
  r = await routeStage(stage, policy, { fetchImpl: http({ readiness: 'unknown' }) }); assert.equal(r.status, 'fallback');
  stage.investigation = null;
  r = await routeStage(stage, policy, { fetchImpl: http({ readiness: 'investigate' }) }); assert.equal(r.status, 'fallback');
});

test('no division candidate cannot select multi-agent; new division design is a handback', async () => {
  const { stage, policy } = await inputs(); enable(policy);
  stage.units = []; stage.dependencies = {}; stage.division = 'none';
  const requests = [];
  let r = await routeStage(stage, policy, { fetchImpl: http({}, undefined, requests) });
  assert.equal(r.flow, 'F1'); assert.deepEqual(Object.keys(requests[0].questions), ['readiness']);
  assert.equal(r.toolInput.args.request.flow, 'single');
  stage.division = 'needs_design';
  r = await routeStage(stage, policy, { fetchImpl: http() }); assert.equal(r.status, 'fallback');
  stage.task.acceptance = [];
  r = await routeStage(stage, policy, { fetchImpl: never }); assert.equal(r.reason, 'acceptance-criteria-missing');
});

test('decisive together/small ignores unused optional unknown and thresholds', async () => {
  const { stage, policy } = await inputs(); enable(policy);
  policy.thresholds = { readiness: 0.7, separability: 0.7 };
  let r = await routeStage(stage, policy, { fetchImpl: http({ separability: 'together', delegation_value: 'unknown' }) });
  assert.equal(r.status, 'compiled'); assert.equal(r.flow, 'F1');
  policy.thresholds = { readiness: 0.7, delegation_value: 0.7 };
  r = await routeStage(stage, policy, { fetchImpl: http({ separability: 'unknown', delegation_value: 'small' }) });
  assert.equal(r.status, 'compiled'); assert.equal(r.flow, 'F1');
  policy.thresholds = syntheticThresholds;
  for (const uncertain of ['separability', 'delegation_value']) {
    r = await routeStage(stage, policy, { fetchImpl: http({ separability: 'together', delegation_value: 'small' }, v => {
      v.answers[uncertain].confidence = 0.1; return v;
    }) });
    assert.equal(r.status, 'compiled'); assert.equal(r.flow, 'F1');
  }
});

test('shadow never exposes executable script, missing thresholds and low confidence never compile', async () => {
  const { stage, policy } = await inputs(); enable(policy); delete policy.mode; delete policy.thresholds;
  let r = await routeStage(stage, policy, { fetchImpl: http() });
  assert.equal(r.status, 'shadow'); assert.equal(r.proposal.flow, 'lead-workers'); assert.equal(r.toolInput, undefined); assert.equal(r.routedRequest, undefined);
  policy.mode = 'select'; r = await routeStage(stage, policy, { fetchImpl: http() });
  assert.equal(r.reason, 'missing-calibrated-threshold'); assert.equal(r.executable, false);
  policy.thresholds = syntheticThresholds;
  r = await routeStage(stage, policy, { fetchImpl: http({}, v => { v.answers.readiness.confidence = 0.3; return v; }) });
  assert.equal(r.reason, 'low-confidence');
});

test('explicit flow/model precede classification without silently replacing routes', async () => {
  const { stage, policy } = await inputs(); enable(policy);
  policy.facts = { readiness: 'ready' }; policy.thresholds = {};
  policy.explicit = { flow: 'single', models: { executor: { provider: 'fixture', model: 'synthetic-only' } } };
  let r = await routeStage(stage, policy, { fetchImpl: never }); assert.equal(r.status, 'compiled'); assert.equal(r.ruleId, 'R1');
  policy.workflowAuthorized = false;
  r = await routeStage(stage, policy, { fetchImpl: never }); assert.equal(r.status, 'hold');
  policy.explicit.models.executor.model = 'unavailable';
  r = await routeStage(stage, policy, { fetchImpl: never }); assert.equal(r.status, 'fallback');
  policy.explicit = { flow: 'F2' }; policy.facts = { readiness: 'investigate' };
  stage.investigation = { question: 'Which?', target: 'Docs', exitCriteria: 'Name method', maxSteps: 1 };
  r = await routeStage(stage, policy, { fetchImpl: never }); assert.equal(r.flow, 'F2');
});

test('workflow permission is separate from external-send and cached answers', async () => {
  const { stage, policy } = await inputs(); enable(policy);
  const previous = await routeStage(stage, policy, { fetchImpl: http() });
  policy.workflowAuthorized = false;
  let r = await routeStage(stage, policy, { previous, fetchImpl: never });
  assert.equal(r.cacheHit, true); assert.equal(r.executable, false); assert.equal(r.handoff.kind, 'normal-agent-decision');
  policy.workflowAuthorized = true; policy.execution.limits.maxCalls = 1;
  r = await routeStage(stage, policy, { previous, fetchImpl: never }); assert.equal(r.status, 'fallback'); assert.equal(r.cacheHit, true);
  policy.externalSend = false; policy.execution.limits.maxCalls = 5;
  r = await routeStage(stage, policy, { previous, fetchImpl: never }); assert.equal(r.executable, true); assert.equal(r.cacheHit, true);
  policy.stageAuthorized = false;
  r = await routeStage(stage, policy, { previous, fetchImpl: never }); assert.equal(r.status, 'hold');
});

test('same semantic JSON reuses cache; stage/source/goals/criteria changes reclassify', async () => {
  const { stage, policy } = await inputs(); enable(policy); policy.limits.maxCalls = 10;
  const previous = await routeStage(stage, policy, { fetchImpl: http() });
  let r = await routeStage(Object.fromEntries(Object.entries(stage).reverse()), policy, { previous, fetchImpl: never });
  assert.equal(r.cacheHit, true); assert.equal(r.usage.calls, 1);
  for (const field of ['stageId', 'sourceRevision', 'remainingGoals', 'task']) {
    const changed = structuredClone(stage);
    if (field === 'remainingGoals') changed.remainingGoals.push('Another outcome');
    else if (field === 'task') changed.task.acceptance.push('One more check');
    else changed[field] += '-next';
    const requests = [];
    r = await routeStage(changed, policy, { previous, fetchImpl: http({}, undefined, requests) });
    assert.equal(requests.length, 1); assert.equal(r.usage.calls, 2);
  }
  const corrupt = structuredClone(previous); delete corrupt.cache.response.answers.readiness;
  r = await routeStage(stage, policy, { previous: corrupt, fetchImpl: never }); assert.equal(r.status, 'fallback');
});

test('wire validation rejects wrong model, omitted answers, invalid choice/probabilities and usage', async () => {
  const { stage, policy } = await inputs(); enable(policy);
  for (const mutate of [v => { v.model = 'jev-latest'; }, v => { delete v.answers.readiness; }, v => { v.answers.readiness.choice = 'invented'; }, v => { delete v.answers.readiness.probabilities.unknown; }, v => { v.answers.readiness.probabilities.ready = 0.1; }, v => { v.usage.input_tokens = -1; }]) {
    const r = await routeStage(stage, policy, { fetchImpl: http({}, v => { mutate(v); return v; }) });
    assert.equal(r.status, 'fallback'); assert.equal(r.cache, null); assert.equal(r.executable, false);
  }
});

test('timeouts, HTTP, non-JSON, transport, request/response limits and missing auth are safe errors', async () => {
  const { stage, policy } = await inputs(); enable(policy); policy.limits.timeoutMs = 10;
  let r = await routeStage(stage, policy, { fetchImpl: () => new Promise(() => {}) });
  assert.equal(r.reason, 'classification-cancelled-or-timeout');
  for (const fetchImpl of [async () => new Response('synthetic-key', { status: 503 }), async () => new Response('synthetic-key'), async () => { throw new Error('synthetic-key'); }]) {
    r = await routeStage(stage, policy, { fetchImpl });
    assert.equal(r.status, 'fallback'); assert(!JSON.stringify(r).includes('synthetic-key')); assert.equal(r.cache, null);
  }
  policy.limits.maxResponseBytes = 1;
  r = await routeStage(stage, policy, { fetchImpl: http() }); assert.equal(r.reason, 'response-byte-limit');
  policy.limits.maxRequestBytes = 1;
  r = await routeStage(stage, policy, { fetchImpl: never }); assert.equal(r.reason, 'request-byte-limit');
  policy.limits.maxRequestBytes = 16000; delete process.env.TYPESAFE_API_KEY;
  try { r = await routeStage(stage, policy, { fetchImpl: never }); assert.equal(r.reason, 'missing-TYPESAFE_API_KEY'); }
  finally { process.env.TYPESAFE_API_KEY = 'synthetic-key'; }
  const controller = new AbortController(); controller.abort();
  r = await routeStage(stage, policy, { fetchImpl: never, signal: controller.signal }); assert.equal(r.reason, 'cancelled');
});

test('reject unsupported endpoint/alias and snapshot inputs before asynchronous transport', async () => {
  const { stage, policy } = await inputs(); enable(policy);
  policy.endpoint = 'https://evil.invalid';
  assert.equal((await routeStage(stage, policy, { fetchImpl: never })).status, 'fallback'); delete policy.endpoint;
  policy.model = 'jev'; assert.equal((await routeStage(stage, policy, { fetchImpl: never })).status, 'fallback'); policy.model = 'jev-1.13.0';
  const r = await routeStage(stage, policy, { fetchImpl: async (url, options) => {
    stage.task.goal = 'mutated'; policy.workflowAuthorized = false;
    return http()(url, options);
  } });
  assert.equal(r.status, 'compiled'); assert.notEqual(r.routedRequest.task.goal, 'mutated');
});

test('request persistence precedes network and a save failure prevents the call', async () => {
  const { stage, policy } = await inputs(); enable(policy);
  let saved = null;
  let r = await routeStage(stage, policy, { onRequest: async request => { saved = request; }, fetchImpl: async (url, options) => {
    assert.deepEqual(saved, JSON.parse(options.body)); return http()(url, options);
  } });
  assert.equal(r.status, 'compiled');
  r = await routeStage(stage, policy, { onRequest: async () => { throw new Error('disk full synthetic-key'); }, fetchImpl: never });
  assert.equal(r.status, 'fallback'); assert.equal(r.usage.calls, 0); assert(!JSON.stringify(r).includes('synthetic-key'));
});

test('unchanged investigation awaits evidence, native handoff cannot bypass scope checks', async () => {
  const { stage, policy } = await inputs(); enable(policy);
  policy.facts = { readiness: 'investigate' };
  stage.investigation = { question: 'Which?', target: 'Docs', exitCriteria: 'Name method', maxSteps: 1 };
  const previous = await routeStage(stage, policy, { fetchImpl: never });
  let r = await routeStage(stage, policy, { previous, fetchImpl: never });
  assert.equal(r.reason, 'investigation-awaits-new-evidence');
  stage.sourceRevision = 'new-evidence';
  r = await routeStage(stage, policy, { previous, fetchImpl: never }); assert.equal(r.status, 'handoff');
  policy.facts = { readiness: 'ready', separability: 'work', delegation_value: 'worthwhile' }; policy.workflowAuthorized = false;
  stage.task.writeScope = ['/tmp/synthetic']; stage.units.forEach(u => { u.writeScope = ['/tmp/synthetic']; });
  r = await routeStage(stage, policy, { fetchImpl: never }); assert.equal(r.status, 'fallback'); assert.equal(r.handoff, undefined);
});

test('failed calls consume finite history budget; input byte ceiling prevents fresh calls', async () => {
  const { stage, policy } = await inputs(); enable(policy); policy.limits.maxCalls = 1;
  const previous = await routeStage(stage, policy, { fetchImpl: async () => new Response('error', { status: 500 }) });
  assert.equal(previous.usage.calls, 1); assert.equal(previous.cache, null);
  let r = await routeStage(stage, policy, { previous, fetchImpl: never }); assert.equal(r.reason, 'classification-budget-exhausted');
  policy.limits.maxInputBytes = 1;
  r = await routeStage(stage, policy, { fetchImpl: never }); assert.equal(r.reason, 'classification-budget-exhausted');
});

test('denied or explicit handoff records retain spent classification budget and cache', async () => {
  const { stage, policy } = await inputs(); enable(policy); policy.limits.maxCalls = 1;
  const first = await routeStage(stage, policy, { fetchImpl: http() });
  policy.stageAuthorized = false;
  const denied = await routeStage(stage, policy, { previous: first, fetchImpl: never });
  assert.equal(denied.usage.calls, 1); assert.deepEqual(denied.cache, first.cache);
  policy.stageAuthorized = true;
  assert.equal((await routeStage(stage, policy, { previous: denied, fetchImpl: never })).cacheHit, true);
  stage.sourceRevision += '-next';
  assert.equal((await routeStage(stage, policy, { previous: denied, fetchImpl: never })).reason, 'classification-budget-exhausted');
  policy.explicit = { flow: 'direct' }; policy.facts = { readiness: 'ready' };
  const direct = await routeStage(stage, policy, { previous: first, fetchImpl: never }); assert.equal(direct.usage.calls, 1);
  delete policy.explicit; policy.facts = {};
  assert.equal((await routeStage(stage, policy, { previous: direct, fetchImpl: never })).reason, 'classification-budget-exhausted');
});

test('caller abort and streaming body timeout cannot produce accepted artifacts', async () => {
  const { stage, policy } = await inputs(); enable(policy); policy.limits.timeoutMs = 10;
  const controller = new AbortController();
  let r = await routeStage(stage, policy, { signal: controller.signal, fetchImpl: async () => {
    controller.abort(); return new Response('{}');
  } });
  assert.equal(r.status, 'fallback'); assert.equal(r.executable, false);
  r = await routeStage(stage, policy, { fetchImpl: async () => new Response(new ReadableStream({ start() {} })) });
  assert.equal(r.reason, 'classification-cancelled-or-timeout'); assert.equal(r.cache, null);
});

test('CLI writes exclusive private shadow report without credentials or tool-input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrate-routing-'));
  try {
    const output = join(dir, 'run');
    const args = [join(root, 'bin/route.mjs'), join(root, 'examples/routing-stage.json'), join(root, 'examples/routing-policy.json'), output];
    const first = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '' } });
    assert.equal(first.status, 0, first.stderr);
    const report = await readFile(join(output, 'report.json'), 'utf8'); assert(!report.includes('synthetic-key'));
    assert.deepEqual(await readdir(output), ['report.json']);
    if (process.platform !== 'win32') {
      assert.equal((await stat(output)).mode & 0o777, 0o700);
      assert.equal((await stat(join(output, 'report.json'))).mode & 0o777, 0o600);
    }
    assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
