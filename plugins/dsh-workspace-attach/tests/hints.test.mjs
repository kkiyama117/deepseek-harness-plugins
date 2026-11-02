import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACH_FAILED,
  EXPIRED,
  HINT_VERSION,
  MALFORMED_HINT,
  NO_WORKSPACE_FOR_CWD,
  SESSION_NOT_READY,
  UNKNOWN_WORKSPACE,
  classifyAttachError,
  parseHint,
  processHint,
  serializeHint,
  workspaceSpecFromEnv,
} from '../hints.mjs';

const hintText = (sessionId, workspace) => JSON.stringify({ version: HINT_VERSION, sessionId, workspace });
const workspace = (id, path, attachSession) => ({ id, path, attachSession });
const registryFor = workspaces => ({
  get: id => workspaces.find(candidate => candidate.id === id),
  list: () => workspaces,
});
const attachTo = (id, path = '/repo') => workspace(id, path, async () => {});
const cwdMismatch = (sessionId, path, cwd) => new Error(
  `cannot attach session '${sessionId}' to workspace '${path}': its cwd resolves to '${cwd}'`,
);
const headerNotReady = sessionId => new Error(
  `cannot validate session '${sessionId}': session persistence holds no such session`,
);

const run = (overrides = {}) => processHint({
  fileName: 'session-a.json',
  text: hintText('session-a', { kind: 'id', id: 'ws-1' }),
  mtimeMs: 1_000,
  now: 2_000,
  registry: registryFor([attachTo('ws-1')]),
  maxPendingMs: 600_000,
  readSessionCwd: async () => undefined,
  ...overrides,
});

test('parses and reserializes an id hint', () => {
  const parsed = parseHint('session-a.json', serializeHint({ sessionId: 'session-a', workspace: { kind: 'id', id: 'ws-1' } }));
  assert.deepEqual(parsed, {
    ok: true,
    hint: { version: HINT_VERSION, sessionId: 'session-a', workspace: { kind: 'id', id: 'ws-1' } },
  });
});

test('parses a cwd hint', () => {
  const parsed = parseHint('session-a.json', hintText('session-a', { kind: 'cwd' }));
  assert.deepEqual(parsed, { ok: true, hint: { version: HINT_VERSION, sessionId: 'session-a', workspace: { kind: 'cwd' } } });
});

for (const [label, fileName, text] of [
  ['invalid JSON', 'session-a.json', 'not json'],
  ['a JSON array', 'session-a.json', '[]'],
  ['the wrong version', 'session-a.json', JSON.stringify({ version: 2, sessionId: 'session-a', workspace: { kind: 'cwd' } })],
  ['a missing sessionId', 'session-a.json', JSON.stringify({ version: HINT_VERSION, workspace: { kind: 'cwd' } })],
  ['an unknown workspace kind', 'session-a.json', hintText('session-a', { kind: 'title' })],
  ['an id kind without an id', 'session-a.json', hintText('session-a', { kind: 'id' })],
  ['a stem that differs from sessionId', 'session-b.json', hintText('session-a', { kind: 'cwd' })],
  ['a file name without .json', 'session-a.txt', hintText('session-a', { kind: 'cwd' })],
]) test(`rejects ${label}`, () => {
  assert.deepEqual(parseHint(fileName, text), { ok: false, reason: MALFORMED_HINT });
});

test('maps the env value to a workspace spec', () => {
  assert.equal(workspaceSpecFromEnv(undefined), undefined);
  assert.equal(workspaceSpecFromEnv(''), undefined);
  assert.deepEqual(workspaceSpecFromEnv('cwd'), { kind: 'cwd' });
  assert.deepEqual(workspaceSpecFromEnv('0bd7a1be'), { kind: 'id', id: '0bd7a1be' });
});

test('classifies cwd validation failures as attach-failed', () => {
  assert.equal(classifyAttachError(cwdMismatch('session-a', '/repo', '/elsewhere')), ATTACH_FAILED);
  assert.equal(classifyAttachError(new Error(
    "cannot attach session 'session-a' to workspace '/repo': its cwd '/gone' does not resolve, so it cannot be validated",
  )), ATTACH_FAILED);
  assert.equal(classifyAttachError(new Error(
    "cannot attach session 'session-a' to workspace '/repo': its cwd '/repo/file' is not a directory",
  )), ATTACH_FAILED);
});

test('classifies every other attach failure as session-not-ready', () => {
  assert.equal(classifyAttachError(headerNotReady('session-a')), SESSION_NOT_READY);
  assert.equal(classifyAttachError(new Error('storage exploded')), SESSION_NOT_READY);
  assert.equal(classifyAttachError('string rejection'), SESSION_NOT_READY);
});

test('attaches a valid id hint', async () => {
  const calls = [];
  const target = workspace('ws-1', '/repo', async (sessionId) => { calls.push(sessionId); });
  assert.deepEqual(await run({ registry: registryFor([target]) }), { kind: 'attached', workspaceId: 'ws-1' });
  assert.deepEqual(calls, ['session-a']);
});

test('rejects a hint naming an unknown workspace', async () => {
  assert.deepEqual(await run({ registry: registryFor([]) }), { kind: 'rejected', reason: UNKNOWN_WORKSPACE });
});

test('rejects a hint whose attach fails cwd validation', async () => {
  const target = workspace('ws-1', '/repo', async (sessionId) => { throw cwdMismatch(sessionId, '/repo', '/elsewhere'); });
  assert.deepEqual(await run({ registry: registryFor([target]) }), { kind: 'rejected', reason: ATTACH_FAILED });
});

test('retries while the session header is not readable yet', async () => {
  const target = workspace('ws-1', '/repo', async (sessionId) => { throw headerNotReady(sessionId); });
  assert.deepEqual(await run({ registry: registryFor([target]) }), { kind: 'retry', reason: SESSION_NOT_READY });
});

test('expires a stale retried hint', async () => {
  const target = workspace('ws-1', '/repo', async (sessionId) => { throw headerNotReady(sessionId); });
  const outcome = await run({ registry: registryFor([target]), mtimeMs: 0, now: 600_001, maxPendingMs: 600_000 });
  assert.deepEqual(outcome, { kind: 'rejected', reason: EXPIRED });
});

test('does not expire a stale hint that attaches', async () => {
  const outcome = await run({ mtimeMs: 0, now: 600_001, maxPendingMs: 600_000 });
  assert.deepEqual(outcome, { kind: 'attached', workspaceId: 'ws-1' });
});

test('rejects a malformed hint', async () => {
  assert.deepEqual(await run({ text: '{' }), { kind: 'rejected', reason: MALFORMED_HINT });
});

test('picks the workspace whose path equals the session cwd', async () => {
  const calls = [];
  const first = workspace('ws-1', '/first', async () => { calls.push('ws-1'); });
  const second = workspace('ws-2', '/second', async () => { calls.push('ws-2'); });
  const outcome = await run({
    text: hintText('session-a', { kind: 'cwd' }),
    registry: registryFor([first, second]),
    readSessionCwd: async () => '/second',
  });
  assert.deepEqual(outcome, { kind: 'attached', workspaceId: 'ws-2' });
  assert.deepEqual(calls, ['ws-2']);
});

test('rejects a cwd hint when no workspace owns the cwd', async () => {
  const outcome = await run({
    text: hintText('session-a', { kind: 'cwd' }),
    registry: registryFor([attachTo('ws-1', '/first')]),
    readSessionCwd: async () => '/second',
  });
  assert.deepEqual(outcome, { kind: 'rejected', reason: NO_WORKSPACE_FOR_CWD });
});

test('retries a cwd hint while the session cwd is unreadable', async () => {
  const failing = await run({
    text: hintText('session-a', { kind: 'cwd' }),
    readSessionCwd: async () => { throw headerNotReady('session-a'); },
  });
  assert.deepEqual(failing, { kind: 'retry', reason: SESSION_NOT_READY });
  const missing = await run({ text: hintText('session-a', { kind: 'cwd' }), readSessionCwd: async () => undefined });
  assert.deepEqual(missing, { kind: 'retry', reason: SESSION_NOT_READY });
});
