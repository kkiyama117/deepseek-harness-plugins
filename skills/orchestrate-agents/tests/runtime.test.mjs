import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlowRuntime } from '../scripts/runtime.mjs';

const runtime = createFlowRuntime();
const done = (summary = 'Verified') => ({ status: 'done', summary, evidence: ['fake check passed'] });
const outcome = status => ({ ...done(), status });
const clone = value => JSON.parse(JSON.stringify(value));

function input(flow = 'lead-workers', count = 2) {
  const roleNames = ['executor', 'lead', 'worker', 'reviewer', 'designer', 'coordinator', 'advisor', 'customDesigner'];
  return {
    request: {
      version: 1, flow,
      task: { originalRequest: 'Implement the scoped task', goal: 'Verified artifacts', context: '', acceptance: ['Checks pass'], constraints: [], writeScope: ['/project'] },
      units: flow === 'single' ? [] : Array.from({ length: count }, (_, i) => ({ id: `u${i}`, prompt: `Implement unit ${i}`, writeScope: [`/project/u${i}`] })),
      batches: flow === 'coordinator-advisor' ? Array.from({ length: count }, (_, i) => [`u${i}`]) : [],
      options: { concurrency: 2, repairRounds: 0 },
    },
    policy: {
      version: 1,
      roles: Object.fromEntries(roleNames.map(role => [role, { provider: 'fake', model: role }])),
      limits: { maxConcurrency: 4, maxCalls: 100, maxNodes: 100, maxWorkers: 10, maxBatches: 10, maxRepairRounds: 3 },
      customDesignerAllowlist: [{ provider: 'fake', model: 'customDesigner' }],
    },
  };
}

function recording(handler = () => done()) {
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

function node(id, after = [], writeScope = []) {
  return { id, kind: 'agent', role: 'worker', prompt: `Perform ${id}`, after, match: 'all', when: [], writeScope };
}

function customGraph() {
  return { nodes: [node('work', [], ['/project/u0']), { ...node('accept', ['work']), role: 'reviewer' }], success: ['accept'] };
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('single executes once with the configured route and authorized scope', async () => {
  const data = input('single');
  const fake = recording();
  const result = await runtime.run(data, fake.hooks);
  assert.equal(result.status, 'completed');
  assert.equal(result.callsStarted, 1);
  assert.equal(fake.calls[0].provider, 'fake');
  assert.equal(fake.calls[0].model, 'executor');
  assert.deepEqual(fake.calls[0].data.writeScope, ['/project']);
  assert.deepEqual(result.results[0].output, done());
});

test('lead-workers plans before workers, integrates their evidence, then independently reviews', async () => {
  const fake = recording(call => done(call.label));
  const result = await runtime.run(input(), fake.hooks);
  assert.equal(result.status, 'completed');
  const labels = fake.calls.map(c => c.label);
  assert.equal(labels[0], 'plan');
  assert.deepEqual(labels.slice(1, 3), ['workers/u0', 'workers/u1']);
  assert.deepEqual(labels.slice(3), ['integrate', 'final_review0']);
  const integration = fake.calls.find(c => c.label === 'integrate');
  assert.deepEqual(integration.data.context.dependencies[0].items.map(i => i.output.summary), ['workers/u0', 'workers/u1']);
  assert.equal(fake.calls.at(-1).model, 'reviewer');
  assert.deepEqual(fake.calls.at(-1).data.writeScope, []);
});

for (const advice of [false, true]) {
  test(`coordinator ${advice ? 'requests advice' : 'skips advice'} and accepts each batch before starting the next`, async () => {
    const accepted = deferred();
    const enteredAcceptance = deferred();
    const fake = recording(async call => {
      if (call.label.endsWith('_coordinate')) return outcome(advice ? 'needs_advice' : 'done');
      if (call.label === 'batch0_accept') { enteredAcceptance.resolve(); await accepted.promise; }
      return done(call.label);
    });
    const running = runtime.run(input('coordinator-advisor'), fake.hooks);
    await enteredAcceptance.promise;
    const premature = fake.calls.some(c => c.label.startsWith('batch1_'));
    accepted.resolve();
    const result = await running;
    assert.equal(premature, false);
    assert.equal(result.status, 'completed');
    assert.equal(fake.calls.filter(c => c.model === 'advisor').length, advice ? 2 : 0);
    const labels = fake.calls.map(c => c.label);
    assert.ok(labels.indexOf('batch1_coordinate') > labels.indexOf('batch0_accept'));
    if (advice) {
      const worker = fake.calls.find(c => c.label === 'batch0_workers/u0');
      assert.equal(worker.data.context.dependencies.find(d => d.id === 'batch0_advice').output.summary, 'batch0_advice');
    }
  });
}

for (const flow of ['lead-workers', 'coordinator-advisor']) {
  for (const repaired of [true, false]) {
    test(`${flow} repair is bounded and ${repaired ? 'stops after acceptance' : 'exhausts without success'}`, async () => {
      const data = input(flow, 1);
      data.request.options.repairRounds = 2;
      const fake = recording(call => /_review\d+$/.test(call.label)
        ? outcome(repaired && call.label.endsWith('review1') ? 'done' : 'changes_requested')
        : done());
      const result = await runtime.run(data, fake.hooks);
      assert.equal(result.status, repaired ? 'completed' : 'needs-review');
      assert.equal(fake.calls.filter(c => /_repair\d+$/.test(c.label)).length, repaired ? 1 : 2);
      assert.equal(fake.calls.filter(c => /_review\d+$/.test(c.label)).length, repaired ? 2 : 3);
      if (flow === 'coordinator-advisor') assert.equal(fake.calls.some(c => c.label === 'batch0_accept'), repaired);
    });
  }
}

for (const [name, failed] of [
  ['null', null], ['missing evidence', { status: 'done', summary: 'Incomplete' }],
  ['invalid status', { ...done(), status: 'success' }], ['invalid evidence', { ...done(), evidence: 'not an array' }],
  ['blocked', outcome('blocked')],
  ['map changes_requested', outcome('changes_requested')],
  ['map needs_advice', outcome('needs_advice')],
]) {
  test(`${name} child output stops admission of queued units and downstream work`, async () => {
    const data = input('lead-workers', 3);
    data.request.options.concurrency = 1;
    const fake = recording(call => call.label === 'workers/u0' ? failed : done());
    const result = await runtime.run(data, fake.hooks);
    assert.equal(result.status, 'blocked');
    assert.deepEqual(fake.calls.map(c => c.label), ['plan', 'workers/u0']);
    assert.equal(result.callsStarted, 2);
    assert.equal(result.results.find(n => n.id === 'integrate').status, 'skipped');
  });
}

test('fatal hook rejection propagates unchanged and prevents queued work admission', async () => {
  const fatal = new Error('host cancelled');
  const data = input('lead-workers', 3);
  data.request.options.concurrency = 1;
  const fake = recording(call => { if (call.label === 'workers/u0') throw fatal; return done(); });
  await assert.rejects(runtime.run(data, fake.hooks), error => error === fatal);
  assert.deepEqual(fake.calls.map(c => c.label), ['plan', 'workers/u0']);
});

test('unit concurrency is capped while aggregation preserves input order, not completion order', async t => {
  const gates = Array.from({ length: 4 }, deferred);
  const started = Array.from({ length: 4 }, deferred);
  let active = 0, peak = 0;
  const finished = [];
  const fake = recording(async call => {
    if (!call.label.startsWith('workers/')) return done();
    const index = Number(call.data.context.unit.id.slice(1));
    active++; peak = Math.max(peak, active); started[index].resolve();
    await gates[index].promise;
    active--; finished.push(index);
    return done(`result ${index}`);
  });
  const running = runtime.run(input('lead-workers', 4), fake.hooks);
  t.after(async () => { gates.forEach(g => g.resolve()); await running; });
  await Promise.all([started[0].promise, started[1].promise]);
  assert.equal(active, 2);
  assert.equal(fake.calls.filter(c => c.label.startsWith('workers/')).length, 2);
  gates[1].resolve();
  // Cross an event-loop boundary so all promise reactions can settle, without a timed sleep.
  await new Promise(setImmediate);
  assert.deepEqual(finished, [1]);
  assert.equal(fake.calls.filter(c => c.label.startsWith('workers/')).length, 2);
  gates[0].resolve();
  await Promise.all([started[2].promise, started[3].promise]);
  gates[3].resolve();
  await new Promise(setImmediate);
  gates[2].resolve();
  const result = await running;
  assert.equal(peak, 2);
  assert.deepEqual(finished, [1, 0, 3, 2]);
  assert.equal(result.status, 'completed');
  const items = result.results.find(n => n.id === 'workers').items;
  assert.deepEqual(items.map(i => i.id), ['u0', 'u1', 'u2', 'u3']);
  assert.deepEqual(items.map(i => i.output.summary), ['result 0', 'result 1', 'result 2', 'result 3']);
});

test('fixed admission waves admit identical units when done and blocked finish in reversed orders', async t => {
  const admitted = [];
  for (const order of [[0, 1], [1, 0]]) {
    const gates = Array.from({ length: 4 }, deferred);
    const started = Array.from({ length: 4 }, deferred);
    const finished = [];
    const fake = recording(async call => {
      if (!call.label.startsWith('workers/')) return done();
      const index = Number(call.data.context.unit.id.slice(1));
      started[index].resolve();
      await gates[index].promise;
      finished.push(index);
      return outcome(index === 1 ? 'blocked' : 'done');
    });
    const running = runtime.run(input('lead-workers', 4), fake.hooks);
    t.after(async () => { gates.forEach(g => g.resolve()); await running; });
    await Promise.all([started[0].promise, started[1].promise]);
    gates[order[0]].resolve();
    await new Promise(setImmediate);
    assert.deepEqual(finished, [order[0]]);
    assert.equal(fake.calls.filter(c => c.label.startsWith('workers/')).length, 2);
    gates[order[1]].resolve();
    const result = await running;
    assert.equal(result.status, 'blocked');
    assert.deepEqual(finished, order);
    admitted.push(fake.calls.map(c => c.label));
  }
  assert.deepEqual(admitted[0], ['plan', 'workers/u0', 'workers/u1']);
  assert.deepEqual(admitted[1], admitted[0]);
});

test('fatal rejection waits for in-flight workers to settle before rejecting the run', async t => {
  const fatal = new Error('fatal wave failure');
  const gates = [deferred(), deferred()];
  const started = [deferred(), deferred()];
  let siblingSettled = false, rejected = false;
  const fake = recording(async call => {
    if (!call.label.startsWith('workers/')) return done();
    const index = Number(call.data.context.unit.id.slice(1));
    assert.ok(index < 2, 'no later wave may start after a fatal failure');
    started[index].resolve();
    await gates[index].promise;
    if (index === 0) throw fatal;
    siblingSettled = true;
    return done();
  });
  const running = runtime.run(input('lead-workers', 4), fake.hooks);
  const rejection = assert.rejects(running, error => { rejected = true; return error === fatal; });
  t.after(async () => { gates.forEach(g => g.resolve()); await rejection; });
  await Promise.all(started.map(s => s.promise));
  gates[0].resolve();
  await new Promise(setImmediate);
  assert.equal(rejected, false);
  assert.equal(siblingSettled, false);
  assert.deepEqual(fake.calls.map(c => c.label), ['plan', 'workers/u0', 'workers/u1']);
  gates[1].resolve();
  await rejection;
  assert.equal(siblingSettled, true);
  assert.equal(rejected, true);
});

for (const scopes of [
  ['/project/shared', '/project/shared'], ['/project/shared', '/project/shared/child'], ['/project/shared/child', '/project/shared'],
]) {
  test(`parallel units reject overlapping scopes ${scopes.join(' and ')}`, () => {
    const data = input();
    data.request.units.forEach((u, i) => { u.writeScope = [scopes[i]]; });
    assert.throws(() => runtime.prepare(data), /write conflict/);
  });
}

test('sibling scopes with shared string prefixes do not conflict', () => {
  const data = input();
  data.request.units[0].writeScope = ['/project/a'];
  data.request.units[1].writeScope = ['/project/ab'];
  assert.doesNotThrow(() => runtime.prepare(data));
});

test('unordered graph writers conflict, but dependency-ordered ancestor writers are allowed', () => {
  const data = runtime.prepare(input('custom'));
  const graph = { nodes: [node('first', [], ['/project']), node('second', [], ['/project/u0']), node('accept', ['first', 'second'])], success: ['accept'] };
  assert.throws(() => runtime.validateGraph(graph, data), /unordered node write conflict/);
  graph.nodes[1].after = ['first'];
  assert.doesNotThrow(() => runtime.validateGraph(graph, data));
});

const badInputs = [
  ['missing role', d => { delete d.policy.roles.worker; }],
  ['route with unknown option', d => { d.policy.roles.worker.temperature = 0; }],
  ['unknown request option', d => { d.request.options.retries = 1; }],
  ['zero concurrency', d => { d.request.options.concurrency = 0; }],
  ['fractional concurrency', d => { d.request.options.concurrency = 1.5; }],
  ['concurrency over cap', d => { d.request.options.concurrency = 5; }],
  ['negative repair rounds', d => { d.request.options.repairRounds = -1; }],
  ['repair rounds over cap', d => { d.request.options.repairRounds = 4; }],
  ['call budget', d => { d.policy.limits.maxCalls = 4; }],
  ['node budget', d => { d.policy.limits.maxNodes = 2; }],
  ['worker budget', d => { d.policy.limits.maxWorkers = 1; }],
  ['invalid policy budget', d => { d.policy.limits.maxCalls = 0; }],
  ['unit outside task scope', d => { d.request.units[0].writeScope = ['/project-other']; }],
  ['noncanonical scope', d => { d.request.units[0].writeScope = ['/project/../elsewhere']; }],
  ['batch reference', d => { d.request.flow = 'coordinator-advisor'; d.request.batches = [['unknown']]; }],
  ['duplicate batch assignment', d => { d.request.flow = 'coordinator-advisor'; d.request.batches = [['u0'], ['u0']]; }],
];
for (const [name, mutate] of badInputs) {
  test(`invalid ${name} rejects before any agent call`, async () => {
    const data = input(); mutate(data);
    const fake = recording();
    await assert.rejects(runtime.run(data, fake.hooks));
    assert.equal(fake.calls.length, 0);
  });
}

const badGraphs = [
  ['unknown role', g => { g.nodes[0].role = 'unconfigured'; }],
  ['reserved customDesigner work role', g => { g.nodes[0].role = 'customDesigner'; }],
  ['agent selecting units', g => { g.nodes[0].units = ['u0']; }],
  ['cycle', g => { g.nodes[0].after = ['accept']; }],
  ['unknown dependency', g => { g.nodes[0].after = ['absent']; }],
  ['unknown success reference', g => { g.success = ['absent']; }],
  ['multiple independent acceptance nodes', g => { g.nodes = [node('a'), node('b')]; g.success = ['a', 'b']; }],
  ['unknown unit reference', g => { Object.assign(g.nodes[0], { kind: 'map', units: ['absent'], writeScope: [] }); }],
  ['condition outside dependencies', g => { g.nodes[1].when = [{ node: 'absent', status: 'done' }]; }],
  ['invalid condition status', g => { g.nodes[1].when = [{ node: 'work', status: 'success' }]; }],
  ['orphan work', g => { g.nodes.push(node('orphan')); }],
  ['unknown graph option', g => { g.retries = 5; }],
  ['supplied authoredBy', g => { g.authoredBy = { provider: 'fake', model: 'customDesigner' }; }],
];
for (const [name, mutate] of badGraphs) {
  test(`custom designer proposal with ${name} starts zero work calls`, async () => {
    const graph = customGraph(); mutate(graph);
    const fake = recording(call => call.label === 'custom_design' ? graph : done());
    const result = await runtime.run(input('custom'), fake.hooks);
    assert.equal(result.status, 'blocked');
    assert.match(result.reason, /Invalid graph/);
    assert.deepEqual(fake.calls.map(c => c.label), ['custom_design']);
    assert.equal(result.callsStarted, 1);
  });
}

test('native graph schema distinguishes agent nodes without units from map nodes requiring units', () => {
  const alternatives = runtime.graphSchema.properties.nodes.items.oneOf;
  assert.equal(alternatives.length, 2);
  const agent = alternatives.find(schema => schema.properties.kind.const === 'agent');
  const map = alternatives.find(schema => schema.properties.kind.const === 'map');
  assert.ok(agent);
  assert.ok(map);
  assert.ok(agent.required.includes('kind'));
  assert.ok(map.required.includes('kind'));
  assert.equal(Object.hasOwn(agent.properties, 'units'), false);
  assert.equal(agent.required.includes('units'), false);
  assert.equal(agent.additionalProperties, false);
  assert.equal(map.properties.units.type, 'array');
  assert.equal(map.properties.units.items.type, 'string');
  assert.ok(map.required.includes('units'));
});

test('custom designer allowlist requires both provider and model before invocation', async () => {
  for (const allowlist of [[], [{ provider: 'other', model: 'customDesigner' }], [{ provider: 'fake', model: 'other' }]]) {
    const data = input('custom'); data.policy.customDesignerAllowlist = allowlist;
    const fake = recording();
    await assert.rejects(runtime.run(data, fake.hooks), /allowlisted/);
    assert.equal(fake.calls.length, 0);
  }
});

test('custom call budget reserves the designer call before executing proposed work', async () => {
  const data = input('custom'); data.policy.limits.maxCalls = 2;
  const fake = recording(call => call.label === 'custom_design' ? customGraph() : done());
  const result = await runtime.run(data, fake.hooks);
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /budget/);
  assert.equal(fake.calls.length, 1);
});

test('valid custom graph uses the allowlisted designer and freezes execution against proposal mutation', async () => {
  const data = input('custom');
  const proposal = customGraph();
  const expected = clone(proposal);
  const fake = recording(call => {
    if (call.label === 'custom_design') return proposal;
    if (call.label === 'work' && !Object.isFrozen(proposal.nodes[1])) {
      proposal.nodes[1].prompt = 'MUTATED instruction';
      proposal.nodes[1].role = 'executor';
    }
    return done(call.label);
  });
  const result = await runtime.run(data, fake.hooks);
  assert.equal(result.status, 'completed');
  assert.deepEqual(fake.calls.map(c => c.label), ['custom_design', 'work', 'accept']);
  assert.equal(fake.calls[0].provider, 'fake');
  assert.equal(fake.calls[0].model, 'customDesigner');
  assert.equal(fake.calls[2].model, 'reviewer');
  assert.ok(fake.calls[2].prompt.includes(expected.nodes[1].prompt));
  assert.ok(!fake.calls[2].prompt.includes('MUTATED instruction'));
});

test('caller mutation after run starts cannot replace task scope or selected routes', async () => {
  const data = input('single');
  const fake = recording(() => {
    data.request.task.writeScope.push('/unauthorized');
    data.policy.roles.executor.model = 'replacement';
    return done();
  });
  const result = await runtime.run(data, fake.hooks);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.request.task.writeScope, ['/project']);
  assert.equal(result.selectedRoutes[0].model, 'executor');
});
