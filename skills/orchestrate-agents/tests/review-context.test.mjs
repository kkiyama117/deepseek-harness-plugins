import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createFlowRuntime } from '../scripts/runtime.mjs';
import { compileWorkflow } from '../scripts/compile.mjs';

const runtime = createFlowRuntime();
const clone = value => JSON.parse(JSON.stringify(value));
const done = (summary = 'Verified') => ({ status: 'done', summary, evidence: ['fake check passed'] });
const repairDone = label => ({ status: 'done', summary: `${label} repaired`, evidence: [`${label} repair evidence`] });
const reviewPass = label => ({ status: 'done', summary: `${label} passed`, evidence: [`${label} evidence`] });
const reviewFail = label => ({ status: 'changes_requested', summary: `${label} findings`, evidence: [`${label} finding one`, `${label} finding two`] });

function input(flow, repairRounds = 2) {
  const roleNames = ['executor', 'lead', 'worker', 'reviewer', 'designer', 'coordinator', 'advisor', 'customDesigner'];
  return {
    request: {
      version: 1, flow,
      task: { originalRequest: 'Implement the scoped task', goal: 'Verified artifacts', context: '', acceptance: ['Checks pass'], constraints: [], writeScope: ['/project'] },
      units: flow === 'single' ? [] : [{ id: 'u0', prompt: 'Implement unit 0', writeScope: ['/project/u0'] }],
      batches: flow === 'coordinator-advisor' ? [['u0']] : [],
      options: { concurrency: 2, repairRounds },
    },
    policy: {
      version: 1,
      roles: Object.fromEntries(roleNames.map(role => [role, { provider: 'fake', model: role }])),
      limits: { maxConcurrency: 4, maxCalls: 100, maxNodes: 100, maxWorkers: 10, maxBatches: 10, maxRepairRounds: 3 },
      customDesignerAllowlist: [{ provider: 'fake', model: 'customDesigner' }],
    },
  };
}

function recording(handler) {
  const calls = [];
  return {
    calls,
    hooks: { agent: async (prompt, options) => {
      const call = { prompt, ...options, data: JSON.parse(prompt.split('\n').at(-1)) };
      calls.push(call);
      return handler(call);
    } },
  };
}

const prefixFor = flow => flow === 'lead-workers' ? 'final' : 'batch0';
const round = label => { const match = /_review(\d+)$/.exec(label); return match ? Number(match[1]) : undefined; };

for (const flow of ['lead-workers', 'coordinator-advisor']) {
  for (const rounds of [0, 1, 2]) {
    for (let passRound = 0; passRound <= rounds; passRound++) {
      test(`${flow} with ${rounds} available and ${passRound} performed repair round(s) accepts and routes prior review evidence into re-review`, async () => {
        const prefix = prefixFor(flow);
        const fake = recording(call => {
          const r = round(call.label);
          if (r !== undefined) return r >= passRound ? reviewPass(call.label) : reviewFail(call.label);
          if (/_repair\d+$/.test(call.label)) return repairDone(call.label);
          return done(call.label);
        });
        const result = await runtime.run(input(flow, rounds), fake.hooks);
        assert.equal(result.status, 'completed');
        assert.deepEqual(
          fake.calls.filter(c => /_repair\d+$/.test(c.label)).map(c => c.label),
          Array.from({ length: passRound }, (_, i) => `${prefix}_repair${i + 1}`));
        assert.deepEqual(
          fake.calls.filter(c => /_review\d+$/.test(c.label)).map(c => c.label),
          Array.from({ length: passRound + 1 }, (_, i) => `${prefix}_review${i}`));
        if (passRound === 0) assert.equal(fake.calls.some(c => /_repair\d+$/.test(c.label)), false);

        const sourceId = flow === 'lead-workers' ? 'integrate' : 'batch0_integrate';
        const initial = fake.calls.find(c => c.label === `${prefix}_review0`);
        assert.match(initial.prompt, /Instruction: This is the initial review \(round 0\) in this review chain\./);
        assert.deepEqual(initial.data.context.dependencies.map(d => d.id), [sourceId]);

        for (let n = 1; n <= passRound; n++) {
          const review = fake.calls.find(c => c.label === `${prefix}_review${n}`);
          assert.match(review.prompt, new RegExp(`Instruction: This is re-review round ${n} after repair round ${n}\\.`));
          const dependencies = review.data.context.dependencies;
          assert.deepEqual(dependencies.map(d => d.id),
            [`${prefix}_repair${n}`, ...Array.from({ length: n }, (_, i) => `${prefix}_review${i}`)]);
          assert.equal(dependencies[0].status, 'done');
          assert.deepEqual(dependencies[0].output, repairDone(`${prefix}_repair${n}`));
          for (let i = 0; i < n; i++) {
            assert.equal(dependencies[i + 1].status, 'changes_requested');
            assert.deepEqual(dependencies[i + 1].output, reviewFail(`${prefix}_review${i}`));
          }
        }
      });
    }
  }

  test(`${flow} exhausts the configured repairs without reporting success`, async () => {
    const fake = recording(call => round(call.label) !== undefined ? reviewFail(call.label) : done(call.label));
    const result = await runtime.run(input(flow, 2), fake.hooks);
    assert.equal(result.status, 'needs-review');
    assert.equal(fake.calls.filter(c => /_repair\d+$/.test(c.label)).length, 2);
    assert.equal(fake.calls.filter(c => /_review\d+$/.test(c.label)).length, 3);
  });

  test(`${flow} stops on a blocked review or repair instead of entering the next repair`, async () => {
    const blockedReview = recording(call => round(call.label) !== undefined
      ? { status: 'blocked', summary: 'Cannot verify', evidence: ['blocked check'] } : done(call.label));
    const reviewed = await runtime.run(input(flow, 2), blockedReview.hooks);
    assert.equal(reviewed.status, 'blocked');
    assert.equal(blockedReview.calls.some(c => /_repair\d+$/.test(c.label)), false);

    const blockedRepair = recording(call => {
      if (call.label === `${prefixFor(flow)}_repair1`) return { status: 'blocked', summary: 'Cannot repair', evidence: ['blocked repair'] };
      if (round(call.label) !== undefined) return reviewFail(call.label);
      return done(call.label);
    });
    const repaired = await runtime.run(input(flow, 2), blockedRepair.hooks);
    assert.equal(repaired.status, 'blocked');
    assert.equal(repaired.callsStarted, blockedRepair.calls.length);
    assert.equal(blockedRepair.calls.some(c => c.label === `${prefixFor(flow)}_review1`), false);
  });
}

test('re-review dependencies add no nodes or calls beyond the existing budgets', () => {
  const data = input('lead-workers', 2);
  const graph = runtime.buildTemplate(data);
  const calls = runtime.validateGraph(graph, data).worstCaseCalls;
  assert.equal(graph.nodes.length, 8);
  assert.equal(calls, 8);
  const tightNodes = input('lead-workers', 2);
  tightNodes.policy.limits.maxNodes = graph.nodes.length;
  assert.doesNotThrow(() => runtime.prepare(tightNodes));
  tightNodes.policy.limits.maxNodes = graph.nodes.length - 1;
  assert.throws(() => runtime.prepare(tightNodes), /node count/);
  const tightCalls = input('lead-workers', 2);
  tightCalls.policy.limits.maxCalls = calls;
  assert.doesNotThrow(() => runtime.prepare(tightCalls));
  tightCalls.policy.limits.maxCalls = calls - 1;
  assert.throws(() => runtime.prepare(tightCalls), /call budget/);
});

// Deterministic prompt/context regression through the compiled payload. This is not a DSH session replay and does not prove model adherence.
async function observeCompiled(payload) {
  const reviews = {};
  const context = vm.createContext({
    args: payload.args,
    agent: async (prompt, options) => {
      const r = round(options.label);
      if (r === undefined) return done(options.label);
      const parsed = JSON.parse(prompt.split('\n').at(-1));
      const dependencies = parsed.context.dependencies;
      reviews[options.label] = {
        instruction: /Instruction: (.*)/.exec(prompt)[1],
        priorReviews: dependencies.filter(d => /_review\d+$/.test(d.id)).map(d => ({ id: d.id, status: d.status })),
        latestRepair: dependencies.filter(d => /_repair\d+$/.test(d.id)).map(d => ({ id: d.id, status: d.status })).at(-1) ?? null,
      };
      return r >= 2 ? reviewPass(options.label) : reviewFail(options.label);
    },
  });
  const result = await new vm.Script(`(async () => {${payload.script}})()`).runInContext(context);
  return { reviews, result };
}

test('compiled payload sends the initial and re-review instructions with prior review ids and statuses', async () => {
  const expected = JSON.parse(await readFile(new URL('./expected/review-context.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(expected).sort(), ['coordinator-advisor', 'lead-workers']);
  for (const flow of ['lead-workers', 'coordinator-advisor']) {
    const data = input(flow, 2);
    const payload = compileWorkflow(clone(data.request), clone(data.policy));
    const { reviews, result } = await observeCompiled(payload);
    assert.equal(result.status, 'completed');
    assert.deepEqual(reviews, expected[flow]);
  }
});
