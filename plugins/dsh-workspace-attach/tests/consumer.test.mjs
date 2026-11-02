import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, scanOnce, sessionCwdReader } from '../index.mjs';
import { HINT_VERSION } from '../hints.mjs';

const hintText = (sessionId, workspace) => JSON.stringify({ version: HINT_VERSION, sessionId, workspace });
const workspace = (id, path, attachSession) => ({ id, path, attachSession });
const registryFor = workspaces => ({
  get: id => workspaces.find(candidate => candidate.id === id),
  list: () => workspaces,
});
const cwdMismatch = (sessionId, path, cwd) => new Error(
  `cannot attach session '${sessionId}' to workspace '${path}': its cwd resolves to '${cwd}'`,
);
const headerNotReady = sessionId => new Error(
  `cannot validate session '${sessionId}': session persistence holds no such session`,
);
const quietly = () => {};

async function hintRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-attach-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const scan = (root, registry, options = {}) => scanOnce({
  hintRoot: root,
  registry,
  readSessionCwd: async () => undefined,
  maxPendingMs: 600_000,
  log: quietly,
  ...options,
});

const rejectedRecord = async (root, stem) => JSON.parse(await readFile(join(root, `${stem}.rejected.json`), 'utf8'));

test('attaches a valid hint and deletes the file', async (t) => {
  const root = await hintRoot(t);
  const calls = [];
  const registry = registryFor([workspace('ws-1', '/repo', async sessionId => { calls.push(sessionId); })]);
  await writeFile(join(root, 'session-a.json'), hintText('session-a', { kind: 'id', id: 'ws-1' }));

  await scan(root, registry);

  assert.deepEqual(calls, ['session-a']);
  assert.deepEqual(await readdir(root), []);
});

test('rejects an unknown workspace and records the reason', async (t) => {
  const root = await hintRoot(t);
  await writeFile(join(root, 'session-a.json'), hintText('session-a', { kind: 'id', id: 'gone' }));

  await scan(root, registryFor([]));

  const record = await rejectedRecord(root, 'session-a');
  assert.equal(record.reason, 'unknown-workspace');
  assert.equal(record.hint.sessionId, 'session-a');
  assert.equal(new Date(record.at).toISOString(), record.at);
  assert.deepEqual(await readdir(root), ['session-a.rejected.json']);
});

test('rejects a cwd mismatch as attach-failed', async (t) => {
  const root = await hintRoot(t);
  const registry = registryFor([workspace('ws-1', '/repo', async sessionId => { throw cwdMismatch(sessionId, '/repo', '/elsewhere'); })]);
  await writeFile(join(root, 'session-a.json'), hintText('session-a', { kind: 'id', id: 'ws-1' }));

  await scan(root, registry);

  assert.equal((await rejectedRecord(root, 'session-a')).reason, 'attach-failed');
  assert.deepEqual(await readdir(root), ['session-a.rejected.json']);
});

test('keeps a hint while the session header is not readable yet', async (t) => {
  const root = await hintRoot(t);
  const registry = registryFor([workspace('ws-1', '/repo', async sessionId => { throw headerNotReady(sessionId); })]);
  await writeFile(join(root, 'session-a.json'), hintText('session-a', { kind: 'id', id: 'ws-1' }));

  await scan(root, registry);

  assert.deepEqual(await readdir(root), ['session-a.json']);
});

test('rejects a stale retried hint as expired', async (t) => {
  const root = await hintRoot(t);
  const registry = registryFor([workspace('ws-1', '/repo', async sessionId => { throw headerNotReady(sessionId); })]);
  const file = join(root, 'session-a.json');
  await writeFile(file, hintText('session-a', { kind: 'id', id: 'ws-1' }));
  const stale = new Date(Date.now() - 10_000);
  await utimes(file, stale, stale);

  await scan(root, registry, { maxPendingMs: 1_000 });

  assert.equal((await rejectedRecord(root, 'session-a')).reason, 'expired');
});

test('rejects malformed JSON with the raw text as evidence', async (t) => {
  const root = await hintRoot(t);
  await writeFile(join(root, 'session-a.json'), 'not json');

  await scan(root, registryFor([]));

  const record = await rejectedRecord(root, 'session-a');
  assert.equal(record.reason, 'malformed-hint');
  assert.equal(record.hint, 'not json');
});

test('rejects a file whose stem differs from its sessionId', async (t) => {
  const root = await hintRoot(t);
  await writeFile(join(root, 'other.json'), hintText('session-a', { kind: 'cwd' }));

  await scan(root, registryFor([]));

  assert.equal((await rejectedRecord(root, 'other')).reason, 'malformed-hint');
  assert.deepEqual(await readdir(root), ['other.rejected.json']);
});

test('ignores rejected files', async (t) => {
  const root = await hintRoot(t);
  const calls = [];
  const registry = registryFor([workspace('ws-1', '/repo', async sessionId => { calls.push(sessionId); })]);
  await writeFile(join(root, 'session-b.rejected.json'), '{"reason":"malformed-hint"}');
  await writeFile(join(root, 'session-a.json'), hintText('session-a', { kind: 'id', id: 'ws-1' }));

  await scan(root, registry);

  assert.deepEqual(calls, ['session-a']);
  assert.equal(await readFile(join(root, 'session-b.rejected.json'), 'utf8'), '{"reason":"malformed-hint"}');
});

test('a second scan over the same root is a no-op', async (t) => {
  const root = await hintRoot(t);
  const calls = [];
  const registry = registryFor([workspace('ws-1', '/repo', async sessionId => { calls.push(sessionId); })]);
  await writeFile(join(root, 'session-a.json'), hintText('session-a', { kind: 'id', id: 'ws-1' }));

  await scan(root, registry);
  await scan(root, registry);

  assert.deepEqual(calls, ['session-a']);
  assert.deepEqual(await readdir(root), []);
});

test('a cwd hint attaches through the public session persistence service', async (t) => {
  const root = await hintRoot(t);
  const calls = [];
  const context = fakeContext(registryFor([
    workspace('ws-1', '/first', async () => { calls.push('ws-1'); }),
    workspace('ws-2', '/second', async () => { calls.push('ws-2'); }),
  ]), { stat: async () => ({ header: { cwd: '/second' } }) });
  await writeFile(join(root, 'session-a.json'), hintText('session-a', { kind: 'cwd' }));

  await scan(root, context.workspaceRegistry, { readSessionCwd: sessionCwdReader(context) });

  assert.deepEqual(calls, ['ws-2']);
  assert.deepEqual(await readdir(root), []);
});

function fakeContext(workspaceRegistry, persistence) {
  const disposers = [];
  let disposed = false;
  return {
    workspaceRegistry,
    logger: { warn() {} },
    get: name => (name === 'sessionPersistence' ? persistence : undefined),
    effect: (callback) => {
      // Cordis refuses effects on a disposed fiber (fiber.ts `assertActive`).
      if (disposed) throw new Error('cannot create effect on inactive context');
      disposers.push(callback());
    },
    on() {},
    async dispose() {
      disposed = true;
      for (const dispose of disposers.reverse()) await dispose();
    },
  };
}

test('apply creates the hint root, processes pending hints, and stops on dispose', async (t) => {
  const root = await hintRoot(t);
  const calls = [];
  const context = fakeContext(registryFor([workspace('ws-1', '/repo', async sessionId => { calls.push(sessionId); })]));
  await writeFile(join(root, 'session-a.json'), hintText('session-a', { kind: 'id', id: 'ws-1' }));

  await apply(context, { hintRoot: root, scanIntervalMs: 10, maxPendingMs: 1_000 });
  assert.deepEqual(calls, ['session-a']);

  await context.dispose();
  await writeFile(join(root, 'late.json'), hintText('late', { kind: 'id', id: 'ws-1' }));
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(calls, ['session-a']);
});

test('apply leaves no watcher or timer behind when disposed during the first scan', async (t) => {
  const root = await hintRoot(t);
  const calls = [];
  let releaseFirstScan;
  let firstScanStarted;
  const gate = new Promise(resolve => { releaseFirstScan = resolve; });
  const started = new Promise(resolve => { firstScanStarted = resolve; });
  const registry = registryFor([workspace('ws-1', '/repo', async sessionId => {
    calls.push(sessionId);
    if (sessionId !== 'session-a') return;
    firstScanStarted();
    await gate;
  })]);
  const context = fakeContext(registry);
  await writeFile(join(root, 'session-a.json'), hintText('session-a', { kind: 'id', id: 'ws-1' }));

  const applied = apply(context, { hintRoot: root, scanIntervalMs: 10, maxPendingMs: 1_000 }).catch(error => error);
  await started;
  await context.dispose();
  releaseFirstScan();
  const applyFailure = await applied;

  await writeFile(join(root, 'late.json'), hintText('late', { kind: 'id', id: 'ws-1' }));
  await new Promise(resolve => setTimeout(resolve, 400));

  assert.deepEqual(calls, ['session-a']);
  assert.deepEqual(await readdir(root), ['late.json']);
  assert.equal(applyFailure, undefined);
});

test('apply rejects an invalid config', async () => {
  await assert.rejects(apply(fakeContext(registryFor([])), { scanIntervalMs: 0 }), TypeError);
  await assert.rejects(apply(fakeContext(registryFor([])), { hintRoot: '' }), TypeError);
  await assert.rejects(apply(fakeContext(registryFor([])), { maxPendingMs: Number.NaN }), TypeError);
});
