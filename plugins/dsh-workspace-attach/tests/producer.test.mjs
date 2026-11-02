import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../producer.mjs';
import { HINT_VERSION } from '../hints.mjs';

const hintText = (sessionId, workspace) => JSON.stringify({ version: HINT_VERSION, sessionId, workspace });

async function hintRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-attach-producer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function workspaceEnv(t, value) {
  const previous = process.env.DSH_WORKSPACE_ID;
  if (value === undefined) delete process.env.DSH_WORKSPACE_ID;
  else process.env.DSH_WORKSPACE_ID = value;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_WORKSPACE_ID;
    else process.env.DSH_WORKSPACE_ID = previous;
  });
}

function context() {
  const listeners = new Map();
  return {
    listeners,
    logger: { warn() {} },
    on(event, listener) { listeners.set(event, listener); },
  };
}

const session = (id, header = {}) => ({ id, header: { id, ...header } });

test('writes exactly one hint per top-level session', async (t) => {
  const root = await hintRoot(t);
  workspaceEnv(t, 'ws-1');
  const ctx = context();
  apply(ctx, { hintRoot: root });
  const listener = ctx.listeners.get('session/created');

  await listener(session('session-a'));
  await listener(session('session-b'));

  assert.deepEqual((await readdir(root)).sort(), ['session-a.json', 'session-b.json']);
  assert.equal(await readFile(join(root, 'session-a.json'), 'utf8'), hintText('session-a', { kind: 'id', id: 'ws-1' }));
});

test('writes a cwd-relative hint for the literal cwd target', async (t) => {
  const root = await hintRoot(t);
  workspaceEnv(t, 'cwd');
  const ctx = context();
  apply(ctx, { hintRoot: root });

  await ctx.listeners.get('session/created')(session('session-a'));

  assert.equal(await readFile(join(root, 'session-a.json'), 'utf8'), hintText('session-a', { kind: 'cwd' }));
});

for (const [label, header] of [
  ['a forked subagent', { parentSession: 'session-parent' }],
  ['an origin-tagged subagent', { origin: 'subagent' }],
]) test(`skips ${label}`, async (t) => {
  const root = await hintRoot(t);
  workspaceEnv(t, 'ws-1');
  const ctx = context();
  apply(ctx, { hintRoot: root });

  await ctx.listeners.get('session/created')(session('session-child', header));

  assert.deepEqual(await readdir(root), []);
});

test('registers nothing when DSH_WORKSPACE_ID is unset', async (t) => {
  const root = await hintRoot(t);
  workspaceEnv(t, undefined);
  const ctx = context();

  apply(ctx, { hintRoot: root });

  assert.equal(ctx.listeners.size, 0);
  assert.deepEqual(await readdir(root), []);
});

test('does not overwrite an existing hint', async (t) => {
  const root = await hintRoot(t);
  workspaceEnv(t, 'ws-1');
  const ctx = context();
  apply(ctx, { hintRoot: root });
  const existing = hintText('session-a', { kind: 'id', id: 'ws-earlier' });
  await writeFile(join(root, 'session-a.json'), existing);

  await ctx.listeners.get('session/created')(session('session-a'));

  assert.equal(await readFile(join(root, 'session-a.json'), 'utf8'), existing);
});

test('does not overwrite a rejected record', async (t) => {
  const root = await hintRoot(t);
  workspaceEnv(t, 'ws-1');
  const ctx = context();
  apply(ctx, { hintRoot: root });
  await writeFile(join(root, 'session-a.rejected.json'), '{"reason":"malformed-hint"}');

  await ctx.listeners.get('session/created')(session('session-a'));

  assert.deepEqual(await readdir(root), ['session-a.rejected.json']);
});

test('rejects an invalid hintRoot', (t) => {
  workspaceEnv(t, undefined);
  assert.throws(() => apply(context(), { hintRoot: '' }), TypeError);
});
