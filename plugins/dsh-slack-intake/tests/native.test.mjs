import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { buildNativeReceipt, runNativeTask as executeNativeTask } from '../native.mjs';

function runNativeTask(options) {
  return executeNativeTask({ ...options, sessionQuery: options.subagents.sessionQuery });
}

const config = { aistoreExecutable: '/trusted/aistore', storeRoot: '/private/store', subagentProvider: 'spawn' };
const taskId = 'task:reader:1';
const inputHash = 'a'.repeat(64);
const claimSecret = 'CLAIM-SECRET-NEVER-VISIBLE';
const response = { items: [{ identity: 'x:1', status: 'ready', text: 'article', summary: 'summary',
  sources: [{ url: 'https://example.com', source_hash: 'b'.repeat(64) }],
  anchors: [{ source_hash: 'b'.repeat(64), quote: 'evidence' }] }] };
const insufficientResponse = { items: [{ identity: 'x:1', status: 'insufficient', reason: 'The supplied excerpt lacks enough evidence.' }] };

function packet(overrides = {}) {
  return { task_id: taskId, attempt: 1, kind: 'reader', input_hash: inputHash,
    route: { provider: 'openrouter', model: 'fixed-model', effort: 'high' },
    max_tokens: 4096, timeout_seconds: 5,
    packet: { items: [{ identity: 'x:1', materials: [{ url: 'https://example.com', source_hash: 'b'.repeat(64), text: 'public evidence', scope: 'article' }] }] },
    ...overrides };
}

function eventsFor(value = response, route = { provider: 'openrouter', model: 'fixed-model', effort: 'high' }) {
  const raw = JSON.stringify(value);
  return [
    { type: 'request/header', data: { header: { config: { provider: route.provider, model: route.model, reasoningEffort: route.effort, maxTokens: 4096 } } } },
    { type: 'assistant/message', data: { message: { source: { kind: 'model', provider: route.provider, model: route.model }, content: [] } } },
    { type: 'tool/call', data: { name: 'structured_output', arguments: raw } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ];
}

function successfulSubagents({ result = { output: [], structured: response, stopReason: 'completed' }, events = eventsFor(), onStart, onDispose } = {}) {
  return {
    getProvider(name) { return name === 'spawn' ? {} : undefined; },
    sessionQuery: { async readSession(id) {
      assert.equal(id, 'session:actual');
      return { session: { id }, events };
    } },
    async startActivation(spec) {
      assert.equal(spec.delivery, 'caller');
      onStart?.(spec.provider, spec.request);
      return { childId: 'session:actual', result: Promise.resolve(result),
        async dispose() { await onDispose?.(); } };
    },
  };
}

function protocolSpawn(handler, calls) {
  return (executable, argv, options) => {
    calls.push({ executable, argv, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 123;
    child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; };
    queueMicrotask(async () => {
      try {
        const result = await handler(argv);
        const text = result.raw ?? JSON.stringify({ protocol_version: 1, result: result.result });
        child.stdout.emit('data', Buffer.from(text + '\n'));
        child.emit('close', result.code ?? 0, null);
      } catch {
        child.emit('close', 1, null);
      }
    });
    return child;
  };
}

function command(argv) {
  return argv.slice(3);
}

function standardHandler(state, packetValue = packet()) {
  return async argv => {
    const op = command(argv);
    if (op[0] === 'task' && op[1] === 'claim') return { result: { task_id: taskId, attempt: 1, token: claimSecret, authority_hash: 'private' } };
    if (op[0] === 'task' && op[1] === 'in-flight') {
      state.claimReceipt = await readFile(op[3], 'utf8');
      return { result: { accepted: true } };
    }
    if (op[0] === 'intake' && op[1] === 'native' && op[2] === 'packet') return { result: packetValue };
    if (op[0] === 'intake' && op[1] === 'native' && op[2] === 'accept') {
      state.nativeReceipt = await readFile(op[8], 'utf8');
      return { result: { accepted: true, result_hash: 'c'.repeat(64) } };
    }
    if (op[0] === 'task' && op[1] === 'unknown') { state.unknown = op; return { result: { accepted: true } }; }
    throw new Error('unexpected operation');
  };
}

test('claims once, hides private grant, fixes route, disposes, and accepts actual recorded response', async () => {
  const calls = [];
  const state = {};
  let nativeRequest;
  let disposed = false;
  const subagents = successfulSubagents({ onStart(_provider, request) { nativeRequest = request; }, onDispose() { disposed = true; } });
  const value = await runNativeTask({ config, taskId, inputHash, parent: { id: 'parent' },
    signal: new AbortController().signal, subagents, spawnChild: protocolSpawn(standardHandler(state), calls) });
  assert.deepEqual(value, { status: 'accepted', taskId, attempt: 1 });
  assert.equal(calls.filter(call => command(call.argv).slice(0, 2).join('/') === 'task/claim').length, 1);
  assert.equal(calls.filter(call => command(call.argv).slice(0, 2).join('/') === 'task/in-flight').length, 1);
  assert.match(state.claimReceipt, new RegExp(claimSecret));
  assert.ok(!JSON.stringify(nativeRequest).includes(claimSecret));
  assert.ok(!JSON.stringify(nativeRequest).includes('authority_hash'));
  assert.deepEqual(nativeRequest.agentOptions, { provider: 'openrouter', model: 'fixed-model', reasoningEffort: 'high', maxTokens: 4096 });
  assert.equal(nativeRequest.agentPreset, 'aistore-native');
  assert.equal(Object.hasOwn(nativeRequest, 'toolFilter'), false);
  assert.equal(nativeRequest.outputSchema.type, 'object');
  assert.deepEqual(validateJsonSchemaValue(nativeRequest.outputSchema, response), []);
  assert.deepEqual(validateJsonSchemaValue(nativeRequest.outputSchema, insufficientResponse), []);
  assert.notEqual(validateJsonSchemaValue(nativeRequest.outputSchema,
    { items: [{ ...response.items[0], status: 'verified' }] }).length, 0);
  assert.match(nativeRequest.prompt[0].text, /only statuses are ready and insufficient/);
  assert.match(nativeRequest.prompt[0].text, /no missing, extra, or duplicate identities/);
  assert.match(nativeRequest.prompt[0].text, /verbatim anchor/);
  assert.match(nativeRequest.prompt[0].text, /non-empty reason/);
  assert.equal(disposed, true);
  const receipt = JSON.parse(state.nativeReceipt);
  assert.deepEqual(receipt.actual_route, { provider: 'openrouter', model: 'fixed-model', effort: 'high' });
  assert.equal(receipt.session_id, 'session:actual');
  assert.equal(receipt.reported_cost, null);
  assert.deepEqual(receipt.response, response);
});

test('receipt validation rejects missing, extra, and duplicate reader identities', () => {
  const second = { ...response.items[0], identity: 'x:2' };
  const packetValue = packet({ packet: { items: [{ identity: 'x:1' }, { identity: 'x:2' }] } });
  const cases = [
    { name: 'missing', value: { items: [response.items[0]] } },
    { name: 'extra', value: { items: [response.items[0], second, { ...second, identity: 'x:3' }] } },
    { name: 'duplicate', value: { items: [response.items[0], response.items[0]] } },
  ];
  for (const fixture of cases) {
    const agent = { id: `session:${fixture.name}`, session: { snapshotEvents: () => eventsFor(fixture.value) } };
    assert.throws(() => buildNativeReceipt({ id: agent.id, events: agent.session.snapshotEvents() },
      { structured: fixture.value, stopReason: 'completed' }, packetValue),
    error => error.code === 'NATIVE_READER_RESULT_INVALID', fixture.name);
  }
});

test('a committed Reader rejection retains its receipt and never becomes unknown or retries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aistore-native-rejection-test-'));
  assert(root.startsWith(join(tmpdir(), 'aistore-native-rejection-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = []; const state = {};
  const base = standardHandler(state);
  const handler = async argv => {
    const op = command(argv);
    if (op.slice(0, 3).join('/') === 'intake/native/accept') {
      state.receiptPath = op[8];
      return { code: 4, result: { status: 'rejected', final_status: 'failed', code: 'NATIVE_READER_ANCHOR_MISMATCH',
        task_id: taskId, attempt: 1, result_hash: 'c'.repeat(64) } };
    }
    return base(argv);
  };
  await assert.rejects(runNativeTask({ config: { ...config, receiptRoot: root }, taskId, inputHash, parent: { id: 'parent' },
    signal: new AbortController().signal, subagents: successfulSubagents(), spawnChild: protocolSpawn(handler, calls) }),
  error => error.code === 'NATIVE_READER_ANCHOR_MISMATCH' && error.nativeRejected === true);
  assert.deepEqual(JSON.parse(await readFile(state.receiptPath, 'utf8')).response, response);
  assert.equal(calls.filter(c => command(c.argv)[1] === 'claim').length, 1);
  assert.equal(calls.filter(c => command(c.argv)[1] === 'unknown').length, 0);
});

test('route mismatch is never replaced and marks the in-flight attempt unknown', async () => {
  const calls = [];
  const state = {};
  const mismatched = eventsFor(response, { provider: 'openrouter', model: 'other-model', effort: 'high' });
  await assert.rejects(runNativeTask({ config, taskId, inputHash, parent: { id: 'parent' },
    signal: new AbortController().signal, subagents: successfulSubagents({ events: mismatched }),
    spawnChild: protocolSpawn(standardHandler(state), calls) }), error => error.code === 'NATIVE_ROUTE_OR_COMPLETION_MISMATCH');
  assert.equal(calls.filter(call => command(call.argv)[1] === 'claim').length, 1);
  assert.deepEqual(state.unknown.slice(0, 4), ['task', 'unknown', '--id', taskId]);
  assert.ok(!calls.some(call => command(call.argv)[2] === 'accept'));
});

test('failed native result is not accepted and becomes unknown without retry', async () => {
  const calls = [];
  const state = {};
  await assert.rejects(runNativeTask({ config, taskId, inputHash, parent: { id: 'parent' },
    signal: new AbortController().signal,
    subagents: successfulSubagents({ result: { output: [], stopReason: 'error', diagnostic: 'synthetic failure' } }),
    spawnChild: protocolSpawn(standardHandler(state), calls) }), error => error.code === 'NATIVE_RESULT_FAILED');
  assert.equal(calls.filter(call => command(call.argv)[1] === 'claim').length, 1);
  assert.equal(calls.filter(call => command(call.argv)[1] === 'unknown').length, 1);
  assert.ok(!calls.some(call => command(call.argv)[2] === 'accept'));
});

test('deadline aborts the native signal and waits for result plus dispose before returning', async () => {
  const calls = [];
  const state = {};
  const order = [];
  const subagents = {
    getProvider() { return {}; },
    async startActivation() {
      // Published activations ignore their admission signal; dispose must cancel them.
      const result = Promise.withResolvers();
      return { childId: 'session:timeout', result: result.promise,
        async dispose() {
          order.push('aborted');
          order.push('result');
          result.resolve({ output: [], stopReason: 'aborted' });
          await Promise.resolve();
          order.push('disposed');
        } };
    },
  };
  const timedPacket = packet({ timeout_seconds: 1 });
  await assert.rejects(runNativeTask({ config, taskId, inputHash, parent: { id: 'parent' },
    signal: new AbortController().signal, subagents,
    spawnChild: protocolSpawn(standardHandler(state, timedPacket), calls) }), error => error.code === 'NATIVE_TIMEOUT');
  assert.deepEqual(order, ['aborted', 'result', 'disposed']);
  assert.equal(calls.filter(call => command(call.argv)[1] === 'unknown').length, 1);
});

test('content review uses a separate packet and rejects missing or foreign article hashes', async () => {
  const hash = 'd'.repeat(64);
  const output = { items: [{ article_hash: hash, status: 'approve', reason: 'Claims match supplied source.' }] };
  const reviewPacket = packet({ kind: 'content_review', packet: { items: [{ article_hash: hash, article: response.items[0], materials: [] }] } });
  let request;
  const state = {};
  await runNativeTask({ config, taskId, inputHash, parent: { id: 'parent' }, signal: new AbortController().signal,
    subagents: successfulSubagents({ result: { structured: output, stopReason: 'completed' }, events: eventsFor(output), onStart(_p, r) { request = r; } }),
    spawnChild: protocolSpawn(standardHandler(state, reviewPacket), []),
  });
  assert.match(request.prompt[0].text, /Independently review/);
  assert.match(request.prompt[0].text, /pointer post/);
  assert.deepEqual(validateJsonSchemaValue(request.outputSchema, output), []);
  for (const invalid of [{ items: [] }, { items: [{ ...output.items[0], article_hash: 'foreign' }] }, { items: [{ ...output.items[0], reason: '' }] }]) {
    const agent = { id: 'session:actual', session: { snapshotEvents: () => eventsFor(invalid) } };
    assert.throws(() => buildNativeReceipt({ id: agent.id, events: agent.session.snapshotEvents() }, { structured: invalid, stopReason: 'completed' }, reviewPacket),
      error => error.code === 'NATIVE_CONTENT_REVIEW_INVALID');
  }
});

test('reviewer rejects reader statuses and invented categories before acceptance', () => {
  const reviewPacket = packet({ kind: 'reviewer', packet: { taxonomy: { categories: { misc: 'Science news' } } } });
  for (const output of [{ status: 'ready', category: 'misc', reason: 'matches' }, { status: 'classified', category: 'invented', reason: 'matches' }, { status: 'excluded', category: 'misc', reason: 'outside' }]) {
    const agent = { id: 'session:actual', session: { snapshotEvents: () => eventsFor(output) } };
    assert.throws(() => buildNativeReceipt({ id: agent.id, events: agent.session.snapshotEvents() }, { structured: output, stopReason: 'completed' }, reviewPacket),
      error => error.code === 'NATIVE_REVIEWER_RESULT_INVALID');
  }
});

test('unavailable configured provider fails without fallback and records unknown', async () => {
  const calls = [];
  const state = {};
  const subagents = { getProvider() { return undefined; }, start() { assert.fail('must not start another provider'); } };
  await assert.rejects(runNativeTask({ config, taskId, inputHash, parent: { id: 'parent' },
    signal: new AbortController().signal, subagents,
    spawnChild: protocolSpawn(standardHandler(state), calls) }), error => error.code === 'NATIVE_PROVIDER_UNAVAILABLE');
  assert.equal(calls.filter(call => command(call.argv)[1] === 'unknown').length, 1);
});
