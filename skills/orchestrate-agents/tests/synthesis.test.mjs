import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { compileWorkflow } from '../scripts/compile.mjs';

const json = async name => JSON.parse(await readFile(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const done = summary => ({ status: 'done', summary, evidence: ['artifact.txt:1'] });
async function execute(flow, handler, repairRounds = 0) {
  const request = await json(flow);
  request.options.repairRounds = repairRounds;
  const payload = compileWorkflow(request, await json('policy'));
  const calls = [];
  const context = vm.createContext({ args: payload.args, agent: async (prompt, options) => {
    calls.push({ prompt, ...options });
    return handler(options.label, prompt);
  } });
  const result = JSON.parse(JSON.stringify(await new vm.Script(`(async () => {${payload.script}})()`).runInContext(context)));
  return { payload, calls, result, projected: Object.fromEntries(payload.resultKeys.map(key => [key, result[key]])) };
}

for (const flow of ['lead-workers', 'coordinator-advisor']) {
  test(`${flow} reuses integration/review calls and keeps successful worker detail outside the projection`, async () => {
    const detail = 'WORKER_DETAIL_'.repeat(4000);
    const { payload, calls, result, projected } = await execute(flow, id => done(id.includes('workers/') ? detail : `Decision ${id}`));
    assert.deepEqual(payload.resultKeys, ['status', 'callsStarted', 'summary']);
    assert.equal(result.status, 'completed');
    assert(JSON.stringify(result.results).includes(detail));
    assert(!JSON.stringify(projected).includes('WORKER_DETAIL_'));
    assert(JSON.stringify(projected).length < JSON.stringify(result).length / 10);
    assert(!Object.hasOwn(projected, 'request'));
    assert(!Object.hasOwn(projected, 'graph'));
    assert(result.summary.acceptance.length > 0);
    assert.equal(result.summary.nonDone.length, 0);
    const integration = calls.filter(c => c.label.endsWith('integrate'));
    const judging = calls.filter(c => /review\d+$|_accept$/.test(c.label));
    assert(integration.length > 0 && judging.length > 0);
    for (const call of [...integration, ...judging]) {
      assert.match(call.prompt, /Agreement between agents is not independent evidence/);
      assert.match(call.prompt, /preserve contradictions, important minority findings and missing checks/);
      assert.match(call.prompt, /accepted, rejected and deferred/);
      assert.match(call.prompt, /route mechanically enforceable lessons to code/);
    }
    assert.equal(calls.length, result.callsStarted);
    assert(!calls.some(c => c.label === 'synthesizer'));
  });
}

test('batch acceptance caveats survive even when a later batch omits them', async () => {
  const { projected, payload } = await execute('coordinator-advisor', id => done(
    id === 'batch0_accept' ? 'Accepted with a deferred compatibility question; see artifact.txt:1' : id));
  assert.equal(projected.status, 'completed');
  assert(payload.args.request.batches.length > 1);
  assert.equal(projected.summary.acceptance.length, payload.args.request.batches.length);
  assert.match(projected.summary.acceptance[0].output.summary, /deferred compatibility question/);
});

test('a null worker remains visible as a blocker while full worker output stays available', async () => {
  let failed = false;
  const { projected, result } = await execute('lead-workers', id => {
    if (id.includes('workers/') && !failed) { failed = true; return null; }
    return done(id);
  });
  assert.equal(projected.status, 'blocked');
  assert.equal(projected.summary.acceptance.length, 0);
  assert(projected.summary.nonDone.some(n => n.status === 'blocked' && n.output === null));
  assert(projected.summary.skippedNodes > 0);
  assert(result.results.some(n => n.items));
});

test('exhausted review findings and evidence survive compact selection', async () => {
  const { projected } = await execute('lead-workers', id => id.includes('_review')
    ? { status: 'changes_requested', summary: 'Conflicting evidence; check artifact.txt', evidence: ['artifact.txt:2'] }
    : done(id), 1);
  assert.equal(projected.status, 'needs-review');
  assert.equal(projected.summary.acceptance.at(-1).output.summary, 'Conflicting evidence; check artifact.txt');
  assert.deepEqual(projected.summary.acceptance.at(-1).output.evidence, ['artifact.txt:2']);
});

for (const proposal of [null, { nodes: [], success: [] }]) {
  test(`custom ${proposal === null ? 'failure' : 'invalid graph'} retains its reason in the projection`, async () => {
    const { projected, calls } = await execute('custom', () => proposal);
    assert.equal(projected.status, 'blocked');
    assert.match(projected.summary.reason, /Custom designer failed|Invalid graph/);
    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /Give integration and acceptance nodes this synthesis instruction/);
  });
}

test('repaired acceptance does not label historical findings as outstanding defects', async () => {
  const { projected } = await execute('coordinator-advisor', id => id.endsWith('_review0')
    ? { status: 'changes_requested', summary: 'Historical finding', evidence: ['old check'] }
    : done(id), 1);
  assert.equal(projected.status, 'completed');
  assert(projected.summary.nonDone.some(n => n.output.summary === 'Historical finding'));
  assert.match(projected.summary.note, /not necessarily unresolved issues/);
});
