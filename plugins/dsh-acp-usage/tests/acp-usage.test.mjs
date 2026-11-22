import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, createListener, inject, name, resolveConfig } from '../index.mjs';

const NOW = '2026-11-22T00:00:00.000Z';

function ev(type, data) {
  return { type, data };
}

function usageChunk(usage) {
  return { type: 'chunk', time: 0, chunk: { type: 'usage', usage } };
}

function sessionOf(header, config = { provider: 'p1', model: 'm1', reasoningEffort: 'high' }) {
  return { header, requestHeader: () => ({ config }) };
}

function session(id = 's1', extra = {}) {
  return sessionOf({ id, cwd: '/w', ...extra });
}

function stepEvents(turn, step, { usage, stream, attempts = [] } = {}) {
  const events = [ev('step/start', { turn, step })];
  for (const attemptStream of attempts) {
    events.push(ev('assistant/attempt', { turn, step, stream: attemptStream }));
  }
  const data = { turn, step, message: { role: 'assistant' } };
  if (usage !== undefined) data.usage = usage;
  if (stream !== undefined) data.stream = stream;
  events.push(ev('assistant/message', data));
  events.push(ev('step/end', { turn, step }));
  return events;
}

function turnEvents(turn, usage) {
  return [
    ev('turn/start', { turn }),
    ...stepEvents(turn, 1, { usage }),
    ev('turn/end', { turn, reason: 'stop' }),
  ];
}

function collect(options = {}) {
  const lines = [];
  const records = [];
  const warns = [];
  const listener = createListener({
    writeLine: text => lines.push(text),
    appendRecord: text => records.push(text),
    warn: message => warns.push(message),
    now: () => new Date(NOW),
    realpath: value => value,
    ...options,
  });
  return { listener, lines, records, warns };
}

function run(listener, subject, events) {
  let returned;
  for (const item of events) returned = listener(subject, item);
  return returned;
}

test('writes one line and one record for a two-step turn', () => {
  const { listener, lines, records } = collect();
  run(listener, session(), [
    ev('turn/start', { turn: 1 }),
    ...stepEvents(1, 1, { usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0, reasoningTokens: 3 } }),
    ...stepEvents(1, 2, { usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 150, cacheWriteTokens: 0, reasoningTokens: 2 } }),
    ev('turn/end', { turn: 1, reason: 'stop' }),
  ]);
  assert.deepEqual(lines, ['dsh: usage: session=s1 cwd=/w steps=2 input=120 output=15 cache_read=200 cache_write=0 reasoning=5\n']);
  assert.deepEqual(records, ['{"ts":"2026-11-22T00:00:00.000Z","session":"s1","cwd":"/w","provider":"p1","model":"m1","reasoning_effort":"high","steps":2,"input":120,"output":15,"cache_read":200,"cache_write":0,"reasoning":5,"first_request_input":150}\n']);
});

test('counts retried attempts once per step', () => {
  const { listener, lines, records } = collect();
  run(listener, session(), [
    ev('turn/start', { turn: 1 }),
    ...stepEvents(1, 1, {
      attempts: [[usageChunk({ inputTokens: 7, outputTokens: 1 })]],
      usage: { inputTokens: 9, outputTokens: 2 },
    }),
    ev('turn/end', { turn: 1, reason: 'stop' }),
  ]);
  assert.deepEqual(lines, ['dsh: usage: session=s1 cwd=/w steps=1 input=16 output=3\n']);
  const record = JSON.parse(records[0]);
  for (const key of ['cache_read', 'cache_write', 'reasoning', 'incomplete']) assert.equal(key in record, false);
});

test('uses the message stream when the message has no usage', () => {
  const { listener, lines } = collect();
  run(listener, session(), [
    ev('turn/start', { turn: 1 }),
    ...stepEvents(1, 1, {
      stream: [usageChunk({ inputTokens: 1, outputTokens: 1 }), usageChunk({ inputTokens: 4, outputTokens: 4 })],
    }),
    ev('turn/end', { turn: 1, reason: 'stop' }),
  ]);
  assert.deepEqual(lines, ['dsh: usage: session=s1 cwd=/w steps=1 input=4 output=4\n']);
});

test('marks incomplete when an attempt has no usage', () => {
  const { listener, lines, records } = collect();
  run(listener, session(), [
    ev('turn/start', { turn: 1 }),
    ...stepEvents(1, 1, { attempts: [[]], usage: { inputTokens: 5, outputTokens: 5 } }),
    ...stepEvents(1, 2, { usage: { inputTokens: 1, outputTokens: 1 } }),
    ev('turn/end', { turn: 1, reason: 'stop' }),
  ]);
  assert.deepEqual(lines, ['dsh: usage: session=s1 cwd=/w steps=2 input=1 output=1 incomplete\n']);
  const record = JSON.parse(records[0]);
  assert.equal(record.incomplete, true);
  assert.equal('first_request_input' in record, false);
});

test('marks incomplete when a step has no usage', () => {
  const { listener, lines, records } = collect();
  run(listener, session(), [
    ev('turn/start', { turn: 1 }),
    ...stepEvents(1, 1),
    ev('turn/end', { turn: 1, reason: 'stop' }),
  ]);
  assert.deepEqual(lines, ['dsh: usage: session=s1 cwd=/w steps=1 incomplete\n']);
  assert.deepEqual(Object.keys(JSON.parse(records[0])), ['ts', 'session', 'cwd', 'provider', 'model', 'reasoning_effort', 'steps', 'incomplete']);
});

test('writes steps=0 for a turn without steps', () => {
  const { listener, lines, records } = collect();
  run(listener, session(), [ev('turn/start', { turn: 1 }), ev('turn/end', { turn: 1, reason: 'stop' })]);
  assert.deepEqual(lines, ['dsh: usage: session=s1 cwd=/w steps=0\n']);
  const record = JSON.parse(records[0]);
  assert.equal(record.steps, 0);
  for (const key of ['input', 'output', 'cache_read', 'cache_write', 'reasoning']) assert.equal(key in record, false);
});

test('keeps turns apart', () => {
  const { listener, lines } = collect();
  const subject = session();
  for (const turn of [1, 2]) run(listener, subject, turnEvents(turn, { inputTokens: 10, outputTokens: 1 }));
  assert.deepEqual(lines, [
    'dsh: usage: session=s1 cwd=/w steps=1 input=10 output=1\n',
    'dsh: usage: session=s1 cwd=/w steps=1 input=10 output=1\n',
  ]);
});

test('keeps two sessions apart', () => {
  const { listener, lines } = collect();
  const first = session('s1');
  const second = session('s2');
  listener(first, ev('turn/start', { turn: 1 }));
  listener(second, ev('turn/start', { turn: 1 }));
  run(listener, first, stepEvents(1, 1, { usage: { inputTokens: 10, outputTokens: 1 } }));
  run(listener, second, stepEvents(1, 1, { usage: { inputTokens: 20, outputTokens: 2 } }));
  listener(second, ev('turn/end', { turn: 1, reason: 'stop' }));
  listener(first, ev('turn/end', { turn: 1, reason: 'stop' }));
  assert.deepEqual(lines, [
    'dsh: usage: session=s2 cwd=/w steps=1 input=20 output=2\n',
    'dsh: usage: session=s1 cwd=/w steps=1 input=10 output=1\n',
  ]);
});

test('writes subagent turns with parent_session', () => {
  const { listener, lines, records } = collect();
  run(listener, session('c1', { origin: 'subagent', parentSession: 's1' }), turnEvents(1, { inputTokens: 10, outputTokens: 1 }));
  run(listener, session('c2', { origin: 'subagent' }), turnEvents(1, { inputTokens: 10, outputTokens: 1 }));
  run(listener, session('s2', { parentSession: 'old' }), turnEvents(1, { inputTokens: 10, outputTokens: 1 }));
  assert.deepEqual(lines, [
    'dsh: usage: session=c1 parent_session=s1 cwd=/w steps=1 input=10 output=1\n',
    'dsh: usage: session=c2 parent_session= cwd=/w steps=1 input=10 output=1\n',
    'dsh: usage: session=s2 cwd=/w steps=1 input=10 output=1\n',
  ]);
  const first = JSON.parse(records[0]);
  assert.deepEqual(Object.keys(first).slice(0, 4), ['ts', 'session', 'parent_session', 'cwd']);
  assert.equal(first.parent_session, 's1');
  assert.equal(JSON.parse(records[1]).parent_session, '');
  assert.equal('parent_session' in JSON.parse(records[2]), false);
});

test('ignores events before the first turn/start and a turn/end of another turn', () => {
  const { listener, lines } = collect();
  const subject = session();
  run(listener, subject, stepEvents(1, 1, { usage: { inputTokens: 10, outputTokens: 1 } }));
  listener(subject, ev('turn/end', { turn: 1, reason: 'stop' }));
  listener(subject, ev('turn/start', { turn: 2 }));
  run(listener, subject, stepEvents(2, 1, { usage: { inputTokens: 10, outputTokens: 1 } }));
  listener(subject, ev('turn/end', { turn: 1, reason: 'stop' }));
  assert.deepEqual(lines, []);
  listener(subject, ev('turn/end', { turn: 2, reason: 'stop' }));
  assert.deepEqual(lines, ['dsh: usage: session=s1 cwd=/w steps=1 input=10 output=1\n']);
});

test('takes provider, model and effort at turn end', () => {
  let config = { provider: 'p1', model: 'm1' };
  const changing = { header: { id: 's1', cwd: '/w' }, requestHeader: () => ({ config }) };
  const first = collect();
  run(first.listener, changing, [
    ev('turn/start', { turn: 1 }),
    ...stepEvents(1, 1, { usage: { inputTokens: 10, outputTokens: 1 } }),
  ]);
  config = { provider: 'p2', model: 'm2', reasoningEffort: 'low' };
  first.listener(changing, ev('turn/end', { turn: 1, reason: 'stop' }));
  const changed = JSON.parse(first.records[0]);
  assert.equal(changed.provider, 'p2');
  assert.equal(changed.model, 'm2');
  assert.equal(changed.reasoning_effort, 'low');

  const missing = collect();
  run(missing.listener, { header: { id: 's1', cwd: '/w' }, requestHeader: () => undefined }, turnEvents(1, { inputTokens: 10, outputTokens: 1 }));
  const missingRecord = JSON.parse(missing.records[0]);
  assert.equal(missingRecord.provider, '');
  assert.equal(missingRecord.model, '');
  assert.equal(missingRecord.reasoning_effort, '');

  const throwing = collect();
  run(throwing.listener, { header: { id: 's1', cwd: '/w' }, requestHeader: () => { throw new Error('header failed'); } }, turnEvents(1, { inputTokens: 10, outputTokens: 1 }));
  const throwingRecord = JSON.parse(throwing.records[0]);
  assert.equal(throwingRecord.provider, '');
  assert.equal(throwingRecord.model, '');
  assert.equal(throwingRecord.reasoning_effort, '');
  assert.equal(throwing.lines.length, 1);
});

test('resolves cwd and falls back when realpath throws', () => {
  const resolved = collect({ realpath: value => '/real' + value });
  run(resolved.listener, session(), turnEvents(1, { inputTokens: 10, outputTokens: 1 }));
  assert.equal(JSON.parse(resolved.records[0]).cwd, '/real/w');

  const failing = collect({ realpath: () => { throw new Error('ENOENT'); } });
  run(failing.listener, session(), turnEvents(1, { inputTokens: 10, outputTokens: 1 }));
  assert.equal(JSON.parse(failing.records[0]).cwd, '/w');

  const absent = collect();
  run(absent.listener, sessionOf({ id: 's1' }), turnEvents(1, { inputTokens: 10, outputTokens: 1 }));
  assert.equal(JSON.parse(absent.records[0]).cwd, '');
});

test('escapes control characters in the stderr line', () => {
  const { listener, lines, records } = collect();
  run(listener, session('s\n1', { cwd: '/w\r\tx' }), [ev('turn/start', { turn: 1 }), ev('turn/end', { turn: 1, reason: 'stop' })]);
  assert.equal(lines[0], 'dsh: usage: session=s\\n1 cwd=/w\\r x steps=0\n');
  assert.equal(lines[0].split('\n').length, 2);
  assert.equal(lines[0].indexOf('\n'), lines[0].length - 1);
  const record = JSON.parse(records[0]);
  assert.equal(record.session, 's\n1');
  assert.equal(record.cwd, '/w\r\tx');
});

test('writes the file record even when stderr fails', () => {
  const records = [];
  const warns = [];
  const listener = createListener({
    writeLine: () => { throw new Error('EPIPE'); },
    appendRecord: text => records.push(text),
    warn: message => warns.push(message),
    now: () => new Date(NOW),
    realpath: value => value,
  });
  assert.equal(run(listener, session(), turnEvents(1, { inputTokens: 10, outputTokens: 1 })), undefined);
  assert.equal(records.length, 1);
  assert.deepEqual(warns, ['acp-usage: stderr write failed for session s1']);
});

test('warns with the error code when the append fails', () => {
  const warns = [];
  const listener = createListener({
    writeLine: () => {},
    appendRecord: () => {
      const error = new Error('denied');
      error.code = 'EACCES';
      throw error;
    },
    warn: message => warns.push(message),
    now: () => new Date(NOW),
    realpath: value => value,
  });
  assert.equal(run(listener, session(), turnEvents(1, { inputTokens: 10, outputTokens: 1 })), undefined);

  const second = createListener({
    writeLine: () => {},
    appendRecord: () => { throw new TypeError('bad append'); },
    warn: message => warns.push(message),
    now: () => new Date(NOW),
    realpath: value => value,
  });
  assert.equal(run(second, session(), turnEvents(1, { inputTokens: 10, outputTokens: 1 })), undefined);

  assert.deepEqual(warns, [
    'acp-usage: usage file append failed for session s1: EACCES',
    'acp-usage: usage file append failed for session s1: TypeError',
  ]);
});

test('contains a throwing warn and internal failures', () => {
  const listener = createListener({
    writeLine: () => { throw new Error('EPIPE'); },
    appendRecord: () => { throw new Error('EIO'); },
    warn: () => { throw new Error('warn failed'); },
    now: () => new Date(NOW),
    realpath: value => value,
  });
  const subject = session();
  for (const item of turnEvents(1, { inputTokens: 10, outputTokens: 1 })) {
    assert.doesNotThrow(() => listener(subject, item));
  }

  const warns = [];
  const second = createListener({
    writeLine: () => {},
    appendRecord: () => {},
    warn: message => warns.push(message),
    now: () => new Date(NOW),
    realpath: value => value,
  });
  const broken = {
    get header() { throw new Error('header failed'); },
    requestHeader: () => ({ config: {} }),
  };
  for (const item of turnEvents(1, { inputTokens: 10, outputTokens: 1 })) {
    assert.doesNotThrow(() => second(broken, item));
  }
  assert.deepEqual(warns, ['acp-usage: usage tracking failed']);
});

test('writes no record when no file is configured', () => {
  const { listener, lines } = collect({ appendRecord: undefined });
  assert.equal(run(listener, session(), turnEvents(1, { inputTokens: 10, outputTokens: 1 })), undefined);
  assert.equal(lines.length, 1);
});

test('refuses invalid config', () => {
  const messageOf = config => {
    try {
      resolveConfig(config);
    } catch (error) {
      return error.message;
    }
    return assert.fail('expected resolveConfig to throw');
  };
  assert.deepEqual(
    [[], 'x', { other: 1 }, { file: '' }, { file: 'rel/u.jsonl' }, { file: 3 }, { file: '/a\0b' }].map(messageOf),
    [
      'acp-usage: config must be an object',
      'acp-usage: config must be an object',
      'acp-usage: unknown config key other',
      'acp-usage: file must be an absolute path',
      'acp-usage: file must be an absolute path',
      'acp-usage: file must be an absolute path',
      'acp-usage: file must be an absolute path',
    ],
  );
  for (const config of [undefined, null, {}]) assert.deepEqual(resolveConfig(config), { file: undefined });
  assert.deepEqual(resolveConfig({ file: '/abs/u.jsonl' }), { file: '/abs/u.jsonl' });
});

test('apply appends one line per turn to the configured file', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-usage-'));
  const file = path.join(temporary, 'sub', 'usage.jsonl');
  const originalWrite = process.stderr.write;
  const originalUmask = process.umask(0o022);
  const stderr = [];
  const warns = [];
  let callback;
  let registered = 0;
  process.stderr.write = text => {
    stderr.push(text);
    return true;
  };
  try {
    apply({
      on(event, listener) {
        registered += 1;
        assert.equal(event, 'session/event');
        callback = listener;
      },
      logger: { warn: message => warns.push(message) },
    }, { file });

    const subject = session('s1', { cwd: temporary });
    run(callback, subject, turnEvents(1, { inputTokens: 10, outputTokens: 1 }));
    run(callback, subject, turnEvents(2, { inputTokens: 20, outputTokens: 2 }));

    assert.equal(registered, 1);
    assert.equal(fs.existsSync(file), true);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(line => line !== '');
    assert.equal(lines.length, 2);
    for (const line of lines) assert.equal(JSON.parse(line).cwd, fs.realpathSync(temporary));
    assert.equal(stderr.length, 2);
    for (const line of stderr) assert.equal(line.startsWith('dsh: usage:'), true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(warns, []);
  } finally {
    process.stderr.write = originalWrite;
    process.umask(originalUmask);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('exports the plugin identity', () => {
  assert.equal(name, 'acp-usage');
  assert.deepEqual(inject, ['sessions']);
});
