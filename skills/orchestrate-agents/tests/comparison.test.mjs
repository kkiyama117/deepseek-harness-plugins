import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { compileWorkflow } from '../scripts/compile.mjs';

const json = async name => JSON.parse(await readFile(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const done = (summary = 'answer') => ({ status: 'done', summary, evidence: ['checked fixture'] });
async function payload() { return compileWorkflow(await json('comparison'), await json('comparison-policy')); }
async function execute(agent, compiled) {
  compiled ??= await payload();
  return new vm.Script(`(async () => {${compiled.script}})()`).runInContext(vm.createContext({ args: compiled.args, agent }));
}

test('no consultation: three fresh calls, same task, explicit routes and no cross-arm evidence', async () => {
  const calls = [];
  const result = await execute(async (prompt, opts) => { calls.push({ prompt, opts }); return done(`secret-${opts.label}`); });
  assert.equal(result.callsStarted, 3);
  assert.equal(result.status, 'awaiting-evaluation');
  assert.deepEqual(calls.map(c => c.opts.model), ['deepseek-v4.1-flash', 'gpt-6-astra', 'deepseek-v4.1-flash']);
  const packets = calls.map(c => JSON.parse(c.prompt.split('\n').at(-1)));
  assert.deepEqual(packets[0].task, packets[1].task);
  assert.deepEqual(packets[1].task, packets[2].task);
  assert(calls.every(c => !c.prompt.includes('secret-')));
  assert(result.results.every(a => a.measurements.cost === null && a.measurements.independentAcceptance === 'pending'));
});

test('consultation: one Astra answer and one fresh Flash continuation retain question and evidence', async () => {
  const calls = [];
  const result = await execute(async (prompt, opts) => {
    calls.push({ prompt, opts });
    if (opts.label === 'flash-advisor/attempt') return { status: 'needs_advice', summary: 'specific-question', evidence: ['attempt-evidence'] };
    if (opts.label === 'flash-advisor/advice') return done('scoped-advice');
    return done();
  });
  assert.equal(result.callsStarted, 5);
  assert.deepEqual(calls.map(c => c.opts.model), ['deepseek-v4.1-flash', 'gpt-6-astra', 'deepseek-v4.1-flash', 'gpt-6-astra', 'deepseek-v4.1-flash']);
  assert.match(calls[3].prompt, /specific-question/);
  assert.match(calls[4].prompt, /attempt-evidence/);
  assert.match(calls[4].prompt, /scoped-advice/);
});

test('one blocked arm does not cancel the other independent arms', async () => {
  const result = await execute(async (_, opts) => opts.label === 'flash/execute' ? { status: 'blocked', summary: 'missing input', evidence: [] } : done());
  assert.equal(result.callsStarted, 3);
  assert.equal(result.results[0].record.status, 'blocked');
  assert.equal(result.results[1].record.status, 'completed');
});

test('blocked advice stops continuation, never silently falls back', async () => {
  const result = await execute(async (_, opts) => {
    if (opts.label === 'flash-advisor/attempt') return { status: 'needs_advice', summary: 'question', evidence: [] };
    if (opts.label === 'flash-advisor/advice') return { status: 'blocked', summary: 'unresolved', evidence: [] };
    return done();
  });
  assert.equal(result.callsStarted, 4);
  assert.equal(result.results[2].record.status, 'blocked');
});

test('second advice request is not executed or accepted', async () => {
  const result = await execute(async (_, opts) => opts.label.startsWith('flash-advisor/') && opts.label !== 'flash-advisor/advice'
    ? { status: 'needs_advice', summary: 'question', evidence: [] } : done());
  assert.equal(result.callsStarted, 5);
  assert.equal(result.results[2].record.status, 'needs-review');
});

test('host failure aborts subsequent arms', async () => {
  let calls = 0;
  await assert.rejects(execute(async () => { calls++; throw new Error('host cancellation'); }), /host cancellation/);
  assert.equal(calls, 1);
});

test('malformed output and null stay failures, not accepted answers', async () => {
  for (const output of [null, { status: 'done' }]) {
    const result = await execute(async (_, opts) => opts.label === 'flash/execute' ? output : done());
    assert.equal(result.results[0].record.status, 'blocked');
    assert.equal(result.callsStarted, 3);
  }
});

test('total budget, writable scope and duplicate arm fail before dispatch', async () => {
  const request = await json('comparison'), policy = await json('comparison-policy');
  assert.throws(() => compileWorkflow(request, { ...policy, limits: { ...policy.limits, maxCalls: 4 } }), /total worst-case/);
  assert.throws(() => compileWorkflow({ ...request, task: { ...request.task, writeScope: ['/tmp/task'] } }, policy), /read-only/);
  assert.throws(() => compileWorkflow({ ...request, order: ['flash', 'flash', 'astra'] }, policy), /permutation/);
});

test('explicit arm order is preserved and task text is never code', async () => {
  const request = await json('comparison'), policy = await json('comparison-policy');
  const baseline = compileWorkflow(request, policy);
  request.order.reverse();
  request.task.context = '`; throw new Error("injected"); //';
  const compiled = compileWorkflow(request, policy);
  assert.equal(compiled.script, baseline.script);
  const calls = [];
  await execute(async (_, opts) => { calls.push(opts.label); return done(); }, compiled);
  assert.deepEqual(calls, ['flash-advisor/attempt', 'astra/execute', 'flash/execute']);
});
