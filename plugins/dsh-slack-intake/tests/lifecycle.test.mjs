import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../index.mjs';

const config = { aistoreExecutable: '/trusted/aistore', storeRoot: '/private/store' };

async function mount(t, describe) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const listeners = new Set();
  const exits = [];
  ctx.provide('cmdlineArgs', { get: () => ['credential', 'status'] });
  ctx.provide('appExit', code => exits.push(code));
  ctx.provide('appReady', { onReady(callback) { listeners.add(callback); return () => listeners.delete(callback); } });
  ctx.provide('credentials', { describe, resolve() { assert.fail('status must not resolve credentials'); } });
  const fiber = await ctx.plugin(plugin, config);
  return { ctx, fiber, listeners, exits, commit() { for (const callback of [...listeners]) callback(); listeners.clear(); } };
}

test('real Cordis effect waits for appReady and cancels before startup commits', async t => {
  let calls = 0;
  const f = await mount(t, async () => { calls++; return { configured: false, writable: true }; });
  assert.equal(calls, 0);
  assert.equal(f.listeners.size, 1);
  await f.fiber.dispose();
  assert.equal(f.listeners.size, 0);
  f.commit();
  assert.equal(calls, 0);
  assert.deepEqual(f.exits, []);
  assert.deepEqual(plugin.inject, ['credentials', 'cmdlineArgs']);
  assert.equal('default' in plugin, false);
});

test('disposal awaits an in-flight credential operation and suppresses late exit/output', async t => {
  const pending = Promise.withResolvers();
  const started = Promise.withResolvers();
  const f = await mount(t, async () => { started.resolve(); return pending.promise; });
  f.commit();
  await started.promise;
  let disposed = false;
  const disposal = f.fiber.dispose().then(() => { disposed = true; });
  assert.equal(disposed, false);
  pending.resolve({ configured: false, writable: true });
  await disposal;
  assert.equal(disposed, true);
  assert.deepEqual(f.exits, []);
});

test('successful startup requests the launcher exit rather than process.exit', async t => {
  const done = Promise.withResolvers();
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  ctx.provide('cmdlineArgs', { get: () => ['--help'] });
  ctx.provide('appExit', done.resolve);
  ctx.provide('appReady', { onReady(callback) { callback(); return () => {}; } });
  ctx.provide('credentials', { describe() { assert.fail('help must not use credentials'); } });
  await ctx.plugin(plugin, config);
  assert.equal(await done.promise, 0);
});
