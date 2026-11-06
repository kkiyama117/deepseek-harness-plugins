import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

const script = fileURLToPath(new URL('../bin/session-route.mjs', import.meta.url));
const USAGE = 'node bin/session-route.mjs LOG';

const baseEvents = [
  { type: 'session', version: 4, id: 'child-1', createdAt: 1, cwd: '/secret/cwd', isSeeded: false, delegationDepth: 1 },
  {
    type: 'subagent/descriptor',
    seq: 1,
    data: {
      version: 3,
      mode: 'continuable',
      provider: 'dsh',
      label: 'SECRET-LABEL',
      agentProvider: 'openai-codex',
      agentModel: 'gpt-6-astra',
      agentReasoningEffort: 'high',
      persona: 'SECRET-PERSONA',
      toolFilter: { allow: ['read'] },
    },
  },
  {
    type: 'request/header',
    seq: 2,
    data: {
      reason: 'initial',
      header: {
        config: { provider: 'openai-codex', model: 'gpt-6-astra', reasoningEffort: 'high', maxTokens: 100 },
        tools: [{ name: 'SECRET-TOOL' }],
      },
    },
  },
  {
    type: 'assistant/message',
    seq: 3,
    data: { message: { content: [{ type: 'text', text: 'SECRET-TEXT' }] } },
  },
  {
    type: 'request/header',
    seq: 4,
    data: { reason: 'change', header: { config: { provider: 'openai-codex', model: 'gpt-6-astra', reasoningEffort: 'high' } } },
  },
  {
    type: 'request/header',
    seq: 5,
    data: { reason: 'change', header: { config: { provider: 'ollama-cloud', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } } },
  },
];

const text = events => `${events.map(event => JSON.stringify(event)).join('\n')}\n`;
const encoded = events => Buffer.concat(events.map(event => zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`))));
const expected = log => [
  `log ${log}`,
  'inherited 0',
  'descriptor mode=continuable subagentProvider=dsh agentProvider=openai-codex agentModel=gpt-6-astra agentReasoningEffort=high',
  'route seq=2 provider=openai-codex model=gpt-6-astra reasoningEffort=high',
  'route seq=5 provider=ollama-cloud model=deepseek-v4.1-flash reasoningEffort=high',
  '',
].join('\n');

const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
const scratch = () => mkdtemp(join(tmpdir(), 'session-route-'));

test('session-route prints the descriptor and distinct routes', async () => {
  const directory = await scratch();
  try {
    const log = join(directory, 'session.v4.jsonl');
    await writeFile(log, text(baseEvents));
    const result = run([log]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected(log));
    assert.equal(result.stderr, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-route reads a compressed log', async () => {
  const directory = await scratch();
  try {
    const log = join(directory, 'session.v4.jsonl.zstd');
    await writeFile(log, encoded(baseEvents));
    const result = run([log]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected(log));
    assert.equal(result.stderr, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-route never prints other content', async () => {
  const directory = await scratch();
  try {
    const plain = join(directory, 'session.v4.jsonl');
    const compressed = join(directory, 'session.v4.jsonl.zstd');
    await writeFile(plain, text(baseEvents));
    await writeFile(compressed, encoded(baseEvents));
    const runs = [run([plain]), run([compressed])];
    for (const result of runs) {
      assert.equal(result.status, 0, result.stderr);
      for (const stream of [result.stdout, result.stderr]) {
        for (const secret of ['SECRET-LABEL', 'SECRET-PERSONA', 'SECRET-TOOL', 'SECRET-TEXT', '/secret/cwd', 'toolFilter']) {
          assert.equal(stream.includes(secret), false, `${secret} leaked`);
        }
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-route reports a log without a descriptor', async () => {
  const directory = await scratch();
  try {
    const log = join(directory, 'session.v4.jsonl');
    await writeFile(log, text(baseEvents.filter(event => event.type !== 'subagent/descriptor')));
    const result = run([log]);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split('\n');
    assert.equal(lines[2], 'descriptor none');
    assert.deepEqual(lines.slice(3, 5), [
      'route seq=2 provider=openai-codex model=gpt-6-astra reasoningEffort=high',
      'route seq=5 provider=ollama-cloud model=deepseek-v4.1-flash reasoningEffort=high',
    ]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-route skips the inherited prefix', async () => {
  const directory = await scratch();
  try {
    const log = join(directory, 'session.v4.jsonl');
    const events = [
      baseEvents[0],
      { type: 'subagent/descriptor', seq: 1, data: { version: 3, mode: 'one-shot', provider: 'parent' } },
      { type: 'request/header', seq: 2, data: { reason: 'initial', header: { config: { provider: 'parent-p', model: 'parent-m' } } } },
      { type: 'session/end-seed', seq: 3, data: { inherited: true } },
      ...baseEvents.slice(1),
    ];
    await writeFile(log, text(events));
    const result = run([log]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected(log).replace('inherited 0', 'inherited 4'));
    for (const line of result.stdout.split('\n')) assert.equal(line.includes('parent'), false, line);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-route skips request headers without a config object', async () => {
  const directory = await scratch();
  try {
    const log = join(directory, 'session.v4.jsonl');
    const events = [
      ...baseEvents.slice(0, -1),
      { type: 'request/header', seq: 6, data: null },
      { type: 'request/header', seq: 7, data: { header: { config: null } } },
      baseEvents[baseEvents.length - 1],
    ];
    await writeFile(log, text(events));
    const result = run([log]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected(log));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-route quotes unusual values', async () => {
  const directory = await scratch();
  try {
    const log = join(directory, 'session.v4.jsonl');
    const events = baseEvents.map(event => JSON.parse(JSON.stringify(event)));
    events[5].data.header.config.model = 'two words';
    await writeFile(log, text(events));
    const result = run([log]);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split('\n');
    assert.equal(lines[lines.length - 2], 'route seq=5 provider=ollama-cloud model="two words" reasoningEffort=high');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-route fails without a route', async () => {
  const directory = await scratch();
  try {
    const log = join(directory, 'session.v4.jsonl');
    await writeFile(log, text(baseEvents.slice(0, 2)));
    const result = run([log]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `session-route: no request/header route in ${log}\n`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-route ignores an incomplete final line', async () => {
  const directory = await scratch();
  try {
    const log = join(directory, 'session.v4.jsonl');
    await writeFile(log, `${baseEvents.map(event => JSON.stringify(event)).join('\n')}\n{"type":"request/he`);
    const result = run([log]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected(log));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-route rejects a malformed line', async () => {
  const directory = await scratch();
  try {
    const log = join(directory, 'session.v4.jsonl');
    const lines = [JSON.stringify(baseEvents[0]), 'not json', ...baseEvents.slice(1).map(event => JSON.stringify(event))];
    await writeFile(log, `${lines.join('\n')}\n`);
    const result = run([log]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `session-route: ${log}:2: not a JSON event\n`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-route rejects a damaged compressed log', async () => {
  const directory = await scratch();
  try {
    const log = join(directory, 'session.v4.jsonl.zstd');
    await writeFile(log, Buffer.from('not zstd'));
    const result = run([log]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.startsWith(`session-route: cannot decompress ${log}: `), result.stderr);
    assert.equal(result.stderr.split('\n').length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-route rejects other file names', async () => {
  const directory = await scratch();
  try {
    const log = join(directory, 'notes.jsonl');
    await writeFile(log, text(baseEvents));
    const result = run([log]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'session-route: not a Session log name: notes.jsonl\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-route reports an unreadable log', async () => {
  const directory = await scratch();
  try {
    const log = join(directory, 'session.v4.jsonl');
    const result = run([log]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `session-route: cannot read ${log}: ENOENT\n`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-route rejects bad usage', async () => {
  const directory = await scratch();
  try {
    const cases = [[], [join(directory, 'a.jsonl'), join(directory, 'b.jsonl')], ['']];
    for (const args of cases) {
      const result = run(args);
      assert.equal(result.status, 2, `exit status for ${JSON.stringify(args)}`);
      assert.equal(result.stdout, '', `stdout for ${JSON.stringify(args)}`);
      assert.equal(result.stderr, `Usage: ${USAGE}\n`, `stderr for ${JSON.stringify(args)}`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-route refuses a seeded log without its marker', async () => {
  const directory = await scratch();
  try {
    const log = join(directory, 'session.v4.jsonl');
    const events = [
      { ...baseEvents[0], isSeeded: true },
      { type: 'request/header', seq: 1, data: { reason: 'initial', header: { config: { provider: 'parent-p', model: 'parent-m' } } } },
    ];
    await writeFile(log, `${events.map(event => JSON.stringify(event)).join('\n')}\n{"type":"session/end-se`);
    const result = run([log]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `session-route: ${log}: a seeded log has no inherited marker\n`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-route refuses a log cut inside an inherited marker', async () => {
  const directory = await scratch();
  try {
    const log = join(directory, 'session.v4.jsonl');
    const events = [
      { ...baseEvents[0], isSeeded: true },
      { type: 'request/header', seq: 1, data: { reason: 'initial', header: { config: { provider: 'grand-p', model: 'grand-m' } } } },
      { type: 'session/end-seed', seq: 2, data: { inherited: true } },
      { type: 'request/header', seq: 3, data: { reason: 'initial', header: { config: { provider: 'parent-p', model: 'parent-m' } } } },
    ];
    await writeFile(log, `${text(events)}{"type":"session/end-se`);
    const result = run([log]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `session-route: ${log}: the log ends in an unfinished inherited marker\n`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-route refuses a whole marker without its newline', async () => {
  const directory = await scratch();
  try {
    const log = join(directory, 'session.v4.jsonl');
    const events = [
      { ...baseEvents[0], isSeeded: true },
      { type: 'request/header', seq: 1, data: { reason: 'initial', header: { config: { provider: 'grand-p', model: 'grand-m' } } } },
      { type: 'session/end-seed', seq: 2, data: { inherited: true } },
      { type: 'request/header', seq: 3, data: { reason: 'initial', header: { config: { provider: 'parent-p', model: 'parent-m' } } } },
    ];
    await writeFile(log, `${text(events)}{"type":"session/end-seed","seq":4,"data":{"inherited":true}}`);
    const result = run([log]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `session-route: ${log}: the log ends in an unfinished inherited marker\n`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-route reads a seeded log with its marker', async () => {
  const directory = await scratch();
  try {
    const log = join(directory, 'session.v4.jsonl');
    const events = [
      { ...baseEvents[0], isSeeded: true },
      { type: 'request/header', seq: 1, data: { reason: 'initial', header: { config: { provider: 'parent-p', model: 'parent-m' } } } },
      { type: 'session/end-seed', seq: 2, data: { inherited: true } },
      ...baseEvents.slice(1),
    ];
    await writeFile(log, text(events));
    const result = run([log]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected(log).replace('inherited 0', 'inherited 3'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
