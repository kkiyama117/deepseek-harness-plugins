import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { execute, resolveConfig, runAistore } from '../intake.mjs';

const secret = 'sk-SYNTHETIC-DO-NOT-DISCLOSE';
const config = { aistoreExecutable: '/trusted/aistore', storeRoot: '/private/store' };
const refs = {
  openrouter: credentialRef('OPENROUTER_API_KEY'),
  slack: credentialRef('SLACK_BOT_TOKEN'),
};

function childResult({ code = 0, stdout = '{"protocol_version":1,"result":{"ok":true}}\n', stderr = '', delay = 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 1234;
    child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; };
    setTimeout(() => { child.stdout.emit('data', Buffer.from(stdout)); child.stderr.emit('data', Buffer.from(stderr)); child.emit('close', code, null); }, delay);
    return child;
  };
}

function fixture(overrides = {}) {
  let output = '';
  let stored;
  const calls = [];
  const credentials = {
    async describe(key) { calls.push(['describe', key]); return { configured: stored !== undefined, writable: true }; },
    async set(key, value) { calls.push(['set', key]); stored = value; },
    async resolve(key) { calls.push(['resolve', key]); return stored === undefined ? undefined : { value: stored, source: 'file' }; },
    ...overrides,
  };
  return {
    request: { credentials, refs, config, args: [], signal: new AbortController().signal,
      io: { stdout: { write: value => { output += value; } }, stderr: { write: value => { output += value; } } } },
    calls, output: () => output, stored: () => stored,
  };
}

test('configuration requires explicit Go executable/store and rejects legacy fields', () => {
  assert.deepEqual(resolveConfig(config), config);
  assert.throws(() => resolveConfig({ python: '/python', skillRoot: '/skill' }), /legacy/);
  assert.throws(() => resolveConfig({ aistoreExecutable: 'aistore', storeRoot: '/store' }), /absolute/);
});

test('Go invocation uses exact argv and child-only credential environment', async () => {
  let invocation;
  const spawnChild = (...args) => { invocation = args; return childResult({ code: 3, stdout: '{"protocol_version":1,"result":{"status":"open"}}\n' })(); };
  const result = await runAistore(config, ['intake', 'resume', '--run', 'run:1', '--allow-network'],
    new AbortController().signal, { name: 'OPENROUTER_API_KEY', value: secret }, spawnChild);
  assert.equal(result.exitCode, 3);
  assert.deepEqual(result.envelope.result, { status: 'open' });
  assert.deepEqual(invocation, ['/trusted/aistore', ['--store', '/private/store', '--json', 'intake', 'resume', '--run', 'run:1', '--allow-network'], {
    env: { LANG: 'C.UTF-8', OPENROUTER_API_KEY: secret }, shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'],
  }]);
  assert.ok(!invocation[1].includes(secret));
});

test('network resume resolves once while offline operations resolve no credential', async () => {
  const f = fixture({ async resolve(key) { f.calls.push(['resolve', key]); return { value: secret, source: 'file' }; } });
  assert.equal(await execute({ ...f.request, args: ['intake', 'resume', '--run', 'run:1', '--allow-network'],
    spawnChild: childResult({ code: 3, stdout: '{"protocol_version":1,"result":{"status":"open"}}\n' }) }), 3);
  assert.deepEqual(f.calls.map(([name]) => name), ['resolve']);
  assert.ok(!f.output().includes(secret));

  const offline = fixture({ async resolve() { assert.fail('offline operation must not resolve credential'); } });
  assert.equal(await execute({ ...offline.request, args: ['verify'], spawnChild: childResult() }), 0);
});

test('Slack credential is injected only for collection', async () => {
  let invocation;
  const slackSecret = 'xoxb-SYNTHETIC-SLACK-SECRET';
  const f = fixture({ async resolve(key) {
    f.calls.push(['resolve', key]);
    assert.deepEqual(key, refs.slack);
    return { value: slackSecret, source: 'env' };
  } });
  assert.equal(await execute({ ...f.request,
    args: ['intake', 'slack', 'collect', '--config', '/private/config.toml', '--latest', '3.0'],
    spawnChild: (...args) => { invocation = args; return childResult()(); },
  }), 0);
  assert.deepEqual(invocation[2].env, { LANG: 'C.UTF-8', SLACK_BOT_TOKEN: slackSecret });
  assert.ok(!invocation[1].includes(slackSecret));
  assert.ok(!f.output().includes(slackSecret));

  const offline = fixture({ async resolve() { assert.fail('Slack plan must not resolve a credential'); } });
  assert.equal(await execute({ ...offline.request,
    args: ['intake', 'slack', 'plan', '--config', '/private/config.toml', '--latest', '3.0'],
    spawnChild: childResult(),
  }), 0);
});

test('protocol, nonzero exit, and secret output use fixed diagnostics only', async () => {
  for (const [child, code] of [
    [childResult({ stdout: 'not json' }), 'AISTORE_PROTOCOL_ERROR'],
    [childResult({ code: 1, stdout: secret }), 'AISTORE_OPERATION_FAILED'],
    [childResult({ stdout: `{"protocol_version":1,"result":"${secret}"}` }), 'AISTORE_SECRET_OUTPUT'],
  ]) {
    const f = fixture({ async resolve() { return { value: secret, source: 'file' }; } });
    assert.equal(await execute({ ...f.request, args: ['intake', 'resume', '--run', 'r', '--allow-network'], spawnChild: child }), 1);
    assert.match(f.output(), new RegExp(code));
    assert.ok(!f.output().includes(secret));
  }
});

test('Slack failures expose only bounded allowlisted conditions, never raw stderr', async () => {
  for (const [stderr, expected] of [
    ['slack limited-without-anchor: http 200\n', 'AISTORE_SLACK_LIMITED_WITHOUT_ANCHOR'],
    ['slack invalid_auth: http 200\n', 'AISTORE_SLACK_INVALID_AUTH'],
    ['slack request failed without a response\n', 'AISTORE_SLACK_NETWORK_FAILED'],
    [`slack ${secret}: http 200\n`, 'AISTORE_OPERATION_FAILED'],
    ['slack untrusted_body: http 200\n', 'AISTORE_OPERATION_FAILED'],
    ['slack invalid_auth: http 200\nPRIVATE BODY', 'AISTORE_OPERATION_FAILED'],
    ['x'.repeat(1025), 'AISTORE_OPERATION_FAILED'],
  ]) {
    const f = fixture({ async resolve() { return { value: secret, source: 'file' }; } });
    assert.equal(await execute({ ...f.request, args: ['intake', 'slack', 'collect'],
      spawnChild: childResult({ code: 1, stderr }) }), 1);
    assert.equal(f.output(), `aistore-adapter: ${expected}\n`);
  }
});

test('credential status and private import remain value-free', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aistore-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o700);
  const file = join(directory, 'key');
  await writeFile(file, secret + '\n', { mode: 0o600 });
  const f = fixture();
  assert.equal(await execute({ ...f.request, args: ['credential', 'import', '--file', file] }), 0);
  assert.equal(f.stored(), secret);
  assert.ok(!f.output().includes(secret));
  assert.equal(await execute({ ...f.request, args: ['credential', 'status'] }), 0);
  assert.ok(!f.output().includes(secret));
});

test('real synthetic child preserves handoff exit 3 and bounded versioned JSON', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aistore-child-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'aistore');
  await writeFile(executable, '#!/bin/sh\nprintf \'%s\\n\' \'{"protocol_version":1,"result":{"status":"open"}}\'\nexit 3\n', { mode: 0o700 });
  const result = await runAistore({ aistoreExecutable: executable, storeRoot: '/private/store' }, ['intake', 'resume', '--run', 'r'], new AbortController().signal);
  assert.equal(result.exitCode, 3);
  assert.equal(result.envelope.protocol_version, 1);
});

test('package exports both separated entries and no package bin', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.bin, undefined);
  assert.equal(manifest.exports['.'], './index.mjs');
  assert.equal(manifest.exports['./agent'], './agent.mjs');
  assert.equal(manifest.exports['./native'], './native.mjs');
});
