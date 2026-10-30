import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const launcher = fileURLToPath(new URL('../daily-start.sh', import.meta.url));
const options = { timeout: 10000, skip: process.platform !== 'linux' && 'Linux mountpoint and Bash launcher' };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'daily-start-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'cli.sh');
  await writeFile(cli, 'pwd\nprintf "arg=%s\\n" "$@"\nexit 7\n');
  return { root, cli, store: join(root, 'store') };
}

function start(t, args) {
  const child = spawn('/bin/bash', [launcher, ...args], {
    cwd: '/', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  return { child, done: closed.then(([code, signal]) => ({ code, signal, stdout, stderr })) };
}

test('ready storage changes directory and preserves arguments and exit status', options, async t => {
  const f = await fixture(t);
  await mkdir(f.store);
  const result = await start(t, ['3', '/', f.store, '/bin/sh', f.cli, 'one two', '--profile', 'synthetic']).done;
  assert.equal(result.code, 7);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, `${f.store}\narg=one two\narg=--profile\narg=synthetic\n`);
  assert.equal(result.stderr, '');
});

test('missing storage can become ready before the deadline', options, async t => {
  const f = await fixture(t);
  const run = start(t, ['5', '/', f.store, '/bin/sh', f.cli]);
  const [waiting] = await once(run.child.stderr, 'data');
  assert.match(waiting, /DAILY_START_WAITING_FOR_STORAGE/);
  await mkdir(f.store);
  const result = await run.done;
  assert.equal(result.code, 7);
  assert.equal(result.stdout, `${f.store}\narg=\n`);
});

test('unmounted path times out without starting the application', options, async t => {
  const f = await fixture(t);
  await mkdir(f.store);
  const result = await start(t, ['1', f.root, f.store, '/bin/sh', f.cli]).done;
  assert.equal(result.code, 75);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /DAILY_START_READINESS_TIMEOUT/);
});

test('placement guard becomes available after storage and runs before the application', options, async t => {
  const f = await fixture(t);
  const guard = join(f.root, 'guard.py');
  const run = start(t, ['--check-placement', guard, 'synthetic.service', 'synthetic', '5', '/', f.store, '/bin/sh', f.cli]);
  await once(run.child.stderr, 'data');
  await writeFile(guard, 'print("GUARD_OK", flush=True)\n');
  await mkdir(f.store);
  const result = await run.done;
  assert.equal(result.code, 7);
  assert.equal(result.stdout, `GUARD_OK\n${f.store}\narg=\n`);
});

test('placement rejection does not start intake or request readiness retry', options, async t => {
  const f = await fixture(t);
  await mkdir(f.store);
  const guard = join(f.root, 'guard.py');
  await writeFile(guard, 'raise SystemExit(75)\n');
  const result = await start(t, ['--check-placement', guard, 'synthetic.service', 'synthetic', '3', '/', f.store, '/bin/sh', f.cli]).done;
  assert.equal(result.code, 78);
  assert.equal(result.stdout, '');
});

test('application exit 75 cannot request an automatic intake retry', options, async t => {
  const f = await fixture(t);
  await mkdir(f.store);
  await writeFile(f.cli, 'exit 75\n');
  const result = await start(t, ['3', '/', f.store, '/bin/sh', f.cli]).done;
  assert.equal(result.code, 1);
});

test('missing CLI times out even when the store mount is ready', options, async t => {
  const f = await fixture(t);
  await mkdir(f.store);
  const result = await start(t, ['1', '/', f.store, '/bin/sh', join(f.root, 'absent')]).done;
  assert.equal(result.code, 75);
  assert.equal(result.stdout, '');
});
