import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../daily-start.sh', import.meta.url));
const options = { timeout: 30000, skip: process.env.DSH_TEST_SYSTEMD !== '1' && 'Requires explicit local systemd user-manager test' };
async function command(file, args) { return exec(file, args, { timeout: 5000 }); }
async function state(unit) {
  const { stdout } = await command('systemctl', ['--user', 'show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'NRestarts', '-p', 'ExecMainStatus']);
  return Object.fromEntries(stdout.trim().split('\n').map(line => line.split('=')));
}
async function until(unit, accept) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const current = await state(unit);
    if (accept(current)) return current;
    await delay(100);
  }
  throw new Error(`Unit did not reach expected state: ${JSON.stringify(await state(unit))}`);
}
async function fixture(t, code) {
  const root = await mkdtemp(join(tmpdir(), 'daily-systemd-'));
  const unit = `daily-readiness-test-${randomUUID()}.service`;
  t.after(async () => {
    await command('systemctl', ['--user', 'stop', unit]).catch(() => undefined);
    await command('systemctl', ['--user', 'reset-failed', unit]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const store = join(root, 'store');
  const cli = join(root, 'cli.sh');
  const marker = join(root, 'calls');
  await writeFile(cli, `printf 'called\\n' >> '${marker}'\nexit ${code}\n`);
  const start = () => command('systemd-run', ['--user', '--no-block', '--unit=' + unit,
    '-p', 'Type=oneshot', '-p', 'RemainAfterExit=yes', '-p', 'Restart=no',
    '-p', 'RestartForceExitStatus=75', '-p', 'RestartSec=1s',
    '/bin/bash', launcher, '1', '/', store, '/bin/sh', cli]);
  return { root, store, unit, marker, start };
}

test('systemd retries readiness without invoking intake, then invokes it once', options, async t => {
  const f = await fixture(t, 0);
  await f.start();
  await until(f.unit, value => value.SubState === 'auto-restart');
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
  await mkdir(f.store);
  const result = await until(f.unit, value => value.SubState === 'exited');
  assert.ok(Number(result.NRestarts) >= 1);
  assert.equal(await readFile(f.marker, 'utf8'), 'called\n');
});

test('systemd does not retry an application failure using the reserved readiness exit', options, async t => {
  const f = await fixture(t, 75);
  await mkdir(f.store);
  await f.start();
  const result = await until(f.unit, value => value.ActiveState === 'failed');
  assert.equal(result.ExecMainStatus, '1');
  assert.equal(result.NRestarts, '0');
  assert.equal(await readFile(f.marker, 'utf8'), 'called\n');
});
