import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as importer from '../credential-import.mjs';

async function fixture(t, botValue = 'xoxb-SYNTHETIC-BOT') {
  const directory = await mkdtemp(join(tmpdir(), 'slack-credential-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { appTokenFile: join(directory, 'app-token'), botTokenFile: join(directory, 'bot-token') };
  await writeFile(config.appTokenFile, 'xapp-SYNTHETIC-APP\n', { mode: 0o600 });
  await writeFile(config.botTokenFile, botValue + '\n', { mode: 0o600 });
  const writes = []; const values = new Map(); let onReady; let dispose; let exitResolve;
  const exited = new Promise(resolve => { exitResolve = resolve; });
  const stdout = []; const stderr = [];
  const originalOut = process.stdout.write; const originalErr = process.stderr.write;
  process.stdout.write = text => { stdout.push(String(text)); return true; };
  process.stderr.write = text => { stderr.push(String(text)); return true; };
  t.after(() => { process.stdout.write = originalOut; process.stderr.write = originalErr; });
  const ctx = {
    credentials: { async set(name, value) { writes.push(name); values.set(name, value); }, async resolve(name) { return { value: values.get(name) }; } },
    get(name) { if (name === 'appReady') return { onReady(fn) { onReady = fn; return () => {}; } }; if (name === 'appExit') return exitResolve; },
    effect(fn) { dispose = fn(); },
  };
  importer.apply(ctx, config);
  return { config, ctx, writes, values, stdout, stderr, exited, ready: () => onReady(), dispose: () => dispose() };
}

test('private token files use credential service and print metadata only', async t => {
  const f = await fixture(t);
  f.ready(); assert.equal(await f.exited, 0); await f.dispose();
  assert.deepEqual(f.writes, ['SLACK_INTAKE_APP_TOKEN', 'SLACK_BOT_TOKEN']);
  assert.ok(!f.stdout.join('').includes('SYNTHETIC'));
  assert.ok(!f.stderr.join('').includes('SYNTHETIC'));
  assert.equal(f.values.get('SLACK_INTAKE_APP_TOKEN'), 'xapp-SYNTHETIC-APP');
});

test('an empty second token file cannot partially overwrite credentials', async t => {
  const f = await fixture(t, '');
  f.ready(); assert.equal(await f.exited, 1); await f.dispose();
  assert.deepEqual(f.writes, []);
});

test('group-readable file is rejected without credential writes', async t => {
  const f = await fixture(t);
  await chmod(f.config.appTokenFile, 0o640);
  f.ready(); assert.equal(await f.exited, 1); await f.dispose();
  assert.deepEqual(f.writes, []);
});

test('disposal during admitted write waits but suppresses late metadata and exit', async t => {
  const f = await fixture(t);
  let release; let enteredResolve; const entered = new Promise(resolve => { enteredResolve = resolve; });
  f.ctx.credentials.set = async (name, value) => { enteredResolve(); await new Promise(resolve => { release = resolve; }); f.values.set(name, value); };
  f.ready(); await entered;
  const disposed = f.dispose(); release(); await disposed;
  assert.deepEqual(f.stdout, []); assert.deepEqual(f.stderr, []);
});
