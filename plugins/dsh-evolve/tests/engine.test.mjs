import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, initialState } from '../schema.mjs';
import { EvolveStore } from '../state.mjs';
import { EvolveEngine } from '../engine.mjs';

function setup({ answers = ['bad', 'good'], configChange = {} } = {}) {
  let saved = initialState();
  const config = Config.parse({ mode: 'propose', route: { provider: 'mock', model: 'fixed' }, dailyRequestLimit: 20,
    request: { maxOutputTokens: 100, maxInputBytes: 10000, maxOutputBytes: 10000, timeoutMs: 1000 },
    assets: [{ name: 'evolve-test', description: 'test', initialContent: 'EXACT ORIGINAL\n', tests: [{ id: 't', prompt: 'test', equals: 'good' }] }], ...configChange });
  const handle = { get: () => saved, set: async value => { saved = structuredClone(value); } };
  const store = new EvolveStore(handle, config);
  const runner = { sessions: new Map(), calls: 0, async run() {
    const i = this.calls++;
    return { sessionId: `s${i}`, text: i === 0 ? JSON.stringify({ asset: 'evolve-test', description: 'new', content: 'NEW BODY' }) : answers[i - 1] };
  }, async close() {} };
  const ctx = { skills: { snapshot: async () => ({ complete: true, skills: [] }) } };
  const engine = new EvolveEngine(ctx, store, config, runner);
  return { engine, store, config, handle, ctx };
}
const receipt = { commandId: 'human-command', sessionId: 'human-session' };

test('validated candidates do not activate until human command; rollback restores exact old content after reopen', async () => {
  const { engine, store, config, handle, ctx } = setup();
  await engine.initialize();
  const original = store.read().active['evolve-test'];
  const result = await engine.cycle();
  assert.equal(result.kind, 'ready');
  assert.equal(store.read().active['evolve-test'], original);
  await engine.approve(result.id, result.digest, receipt);
  const reopened = new EvolveStore(handle, config);
  const nextEngine = new EvolveEngine(ctx, reopened, config, null);
  await nextEngine.rollback('evolve-test', result.id, receipt);
  const restored = reopened.read().revisions[reopened.read().active['evolve-test']];
  assert.equal(restored.content, 'EXACT ORIGINAL\n');
  assert.equal(restored.id, original);
  assert.equal(reopened.read().history.length, 2);
});

test('wrong output, no strict improvement, and stale approval are refused', async () => {
  for (const answers of [['bad', 'bad'], ['good', 'good']]) {
    const { engine, store } = setup({ answers });
    await engine.initialize();
    const result = await engine.cycle();
    assert.equal(result.kind, 'rejected');
    await assert.rejects(engine.approve(result.id, result.digest, receipt), { code: 'STALE_OR_UNVERIFIED' });
    assert.equal(store.read().history.length, 0);
  }
  const { engine } = setup();
  await engine.initialize();
  const result = await engine.cycle();
  await assert.rejects(engine.approve(result.id, 'wrong', receipt), { code: 'STALE_OR_UNVERIFIED' });
  await engine.approve(result.id, result.digest, receipt);
  await assert.rejects(engine.approve(result.id, result.digest, receipt), { code: 'STALE_OR_UNVERIFIED' });
  await assert.rejects(engine.rollback('evolve-test', 'wrong', receipt), { code: 'STALE_REVISION' });
});

test('rejecting a pending candidate cannot be undone by late validation', async () => {
  const { engine, store } = setup();
  await engine.initialize();
  const original = engine.runner.run.bind(engine.runner);
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  engine.runner.run = async args => {
    if (engine.runner.calls === 2) { entered(); await gate; }
    return original(args);
  };
  const cycle = engine.cycle();
  await started;
  const candidate = Object.values(store.read().candidates)[0];
  await engine.reject(candidate.id, candidate.digest, receipt);
  release();
  assert.equal((await cycle).kind, 'rejected');
  assert.equal(store.read().candidates[candidate.id].status, 'rejected');
});

test('rollback preserves the configured baseline even when skill discovery is incomplete', async () => {
  const { engine, store, ctx } = setup();
  await engine.initialize();
  const original = store.read().active['evolve-test'];
  const result = await engine.cycle();
  await engine.approve(result.id, result.digest, receipt);
  ctx.skills.snapshot = async () => ({ complete: false, skills: [] });
  await engine.rollback('evolve-test', result.id, receipt);
  assert.equal(store.read().active['evolve-test'], original);
  await assert.rejects(engine.rollback('evolve-test', original, receipt), { code: 'BASELINE_REVISION' });
  assert.equal(store.read().active['evolve-test'], original);
});

test('changing operator tests or model invalidates pending approval', async () => {
  const { engine, store, config, ctx } = setup();
  await engine.initialize();
  const result = await engine.cycle();
  for (const changed of [
    { ...config, route: { ...config.route, model: 'other' } },
    { ...config, assets: [{ ...config.assets[0], tests: [{ id: 'new', prompt: 'new', equals: 'good' }] }] },
  ]) {
    const next = new EvolveEngine(ctx, store, changed, null);
    await assert.rejects(next.approve(result.id, result.digest, receipt), { code: 'STALE_OR_UNVERIFIED' });
  }
});

test('observed failure thresholds generate proposals without transmitting secret arguments or errors', async () => {
  const { engine, store } = setup();
  await engine.initialize();
  const exec = { agent: { id: 'source-agent' }, name: 'fetch', callId: 'source-call', arguments: { token: 'PRIVATE_SECRET' } };
  const result = { isError: true, error: { message: 'PRIVATE_ERROR', info: { code: 'FETCH_FAILED' } } };
  await engine.observe(exec, result);
  await engine.observe(exec, result);
  assert.equal(Object.keys(store.read().candidates).length, 0);
  await engine.observe(exec, result);
  assert.equal(Object.keys(store.read().candidates).length, 1);
  assert.ok(Object.values(store.read().candidates).every(candidate => candidate.status === 'ready'));
  assert.doesNotMatch(JSON.stringify(store.read().observations), /PRIVATE_SECRET|PRIVATE_ERROR/);
});

test('validation cannot declare success with missing cases and namespace collisions are refused', async () => {
  const { engine, store, ctx } = setup();
  await engine.initialize();
  const result = await engine.cycle();
  await store.update(state => { state.candidates[result.id].validation.cases = []; });
  await assert.rejects(engine.approve(result.id, result.digest, receipt), { code: 'STALE_OR_UNVERIFIED' });
  ctx.skills.snapshot = async () => ({ complete: true, skills: [{ name: 'evolve-test', provider: 'external' }] });
  await assert.rejects(engine.approve(result.id, result.digest, receipt), { code: 'SKILL_COLLISION' });
});
