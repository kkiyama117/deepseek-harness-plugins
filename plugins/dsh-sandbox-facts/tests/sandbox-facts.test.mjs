import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, createListener, factsLine, inject, name } from '../index.mjs';

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function bash(sandbox, callId = 'call-1') {
  return deepFreeze([
    { name: 'bash', callId },
    {
      isError: false,
      value: {
        kind: 'foreground',
        cwd: '/w',
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: 1000,
        stdout: { text: 'secret-out', truncated: false },
        stderr: { text: '', truncated: false },
        ...(sandbox === undefined ? {} : { sandbox }),
      },
      content: [],
    },
  ]);
}

const collector = (writes, warns = []) => createListener(chunk => writes.push(chunk), message => warns.push(message));

test('writes partial enforcement into the tool_facts line', () => {
  const writes = [];
  const [exec, result] = bash({ mode: 'workspace-write', denied: false, enforcement: 'partial' });
  const returned = collector(writes)(exec, result);
  assert.equal(returned, undefined);
  assert.equal(writes.length, 1);
  assert.equal(writes[0], '{"type":"tool_facts","callId":"call-1","tool":"bash","sandbox":{"mode":"workspace-write","denied":false,"enforcement":"partial","runnerFailed":false}}\n');
});

test('writes runnerFailed true and denied true as given', () => {
  const writes = [];
  const listener = collector(writes);
  listener(...bash({ mode: 'read-only', denied: false, enforcement: 'full', runnerFailed: true }));
  listener(...bash({ mode: 'read-only', denied: true, enforcement: 'full' }));
  assert.equal(writes.length, 2);
  assert.deepEqual(JSON.parse(writes[0]).sandbox, { mode: 'read-only', denied: false, enforcement: 'full', runnerFailed: true });
  assert.deepEqual(JSON.parse(writes[1]).sandbox, { mode: 'read-only', denied: true, enforcement: 'full', runnerFailed: false });
});

test('writes enforcement null when the value has none', () => {
  const writes = [];
  collector(writes)(...bash({ mode: 'danger-full-access', denied: false }));
  assert.equal(writes.length, 1);
  const parsed = JSON.parse(writes[0]);
  assert.equal(parsed.sandbox.enforcement, null);
  assert.deepEqual(Object.keys(parsed.sandbox), ['mode', 'denied', 'enforcement', 'runnerFailed']);
});

test('writes runnerFailed false when the value has none', () => {
  const writes = [];
  collector(writes)(...bash({ mode: 'workspace-write', denied: false, enforcement: 'full' }));
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0]).sandbox.runnerFailed, false);
});

test('writes nothing for a background handle', () => {
  const writes = [];
  const warns = [];
  const [exec] = bash({ mode: 'workspace-write', denied: false });
  collector(writes, warns)(exec, { isError: false, value: { kind: 'background', jobId: 'j1', cwd: '/w' }, content: [] });
  assert.equal(writes.length, 0);
  assert.equal(warns.length, 0);
});

test('writes nothing for a value without sandbox', () => {
  const writes = [];
  const warns = [];
  collector(writes, warns)(...bash(undefined));
  assert.equal(writes.length, 0);
  assert.equal(warns.length, 0);
});

test('writes nothing for a failed call', () => {
  const writes = [];
  const [exec] = bash({ mode: 'workspace-write', denied: false });
  collector(writes)(exec, { isError: true, error: { message: 'sandbox runner failed' }, content: [] });
  assert.equal(writes.length, 0);
});

test('writes nothing for another tool', () => {
  const writes = [];
  const [, result] = bash({ mode: 'workspace-write', denied: false });
  collector(writes)({ name: 'read', callId: 'call-2' }, result);
  assert.equal(writes.length, 0);
});

test('writes nothing for unexpected sandbox field types', () => {
  const writes = [];
  const warns = [];
  const listener = collector(writes, warns);
  for (const sandbox of [
    { mode: 1, denied: false },
    { mode: 'workspace-write', denied: 'no' },
    { mode: 'workspace-write', denied: false, enforcement: 'none' },
    { mode: 'workspace-write', denied: false, enforcement: null },
    { mode: 'workspace-write', denied: false, runnerFailed: 'yes' },
    { mode: 'workspace-write', denied: false, runnerFailed: null },
    null,
    Object.assign([], { mode: 'workspace-write', denied: false }),
  ]) listener(...bash(sandbox));
  const [, result] = bash({ mode: 'workspace-write', denied: false });
  listener({ name: 'bash', callId: 1 }, result);
  assert.equal(writes.length, 0);
  assert.equal(warns.length, 0);
});

test('writes nothing for malformed calls and results', () => {
  const [exec] = bash({ mode: 'workspace-write', denied: false });
  for (const [callExec, callResult] of [
    [exec, null],
    [exec, 'x'],
    [exec, { isError: false, value: null, content: [] }],
    [exec, { isError: false, value: 'x', content: [] }],
    [exec, { isError: false, value: [], content: [] }],
    [exec, { value: { sandbox: { mode: 'workspace-write', denied: false } }, content: [] }],
    [undefined, undefined],
    [null, 'x'],
  ]) assert.equal(factsLine(callExec, callResult), undefined);
});

test('copies any mode string as given', () => {
  const writes = [];
  collector(writes)(...bash({ mode: 'x', denied: false }));
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0]).sandbox.mode, 'x');
});

test('writes one valid JSON line per call without leaking output', () => {
  const writes = [];
  const listener = collector(writes);
  const calls = ['a', 'b', 'c'].map(id => bash({ mode: 'workspace-write', denied: false }, id));
  const snapshots = calls.map(call => JSON.stringify(call));
  for (const call of calls) listener(...call);
  assert.equal(writes.length, 3);
  assert.deepEqual(writes.map(chunk => JSON.parse(chunk).callId), ['a', 'b', 'c']);
  for (const [index, chunk] of writes.entries()) {
    assert.equal(chunk.endsWith('\n'), true);
    assert.equal(chunk.slice(0, -1).includes('\n'), false);
    assert.equal(chunk.includes('secret-out'), false);
    assert.equal(JSON.stringify(calls[index]), snapshots[index]);
  }
});

test('contains a failing write and warns', () => {
  const warns = [];
  const listener = createListener(() => { throw new Error('EPIPE'); }, message => warns.push(message));
  const returned = listener(...bash({ mode: 'workspace-write', denied: false }));
  assert.equal(returned, undefined);
  assert.equal(warns.length, 1);
  assert.equal(warns[0].startsWith('sandbox-facts: write failed for call-1'), true);
});

test('contains a failing warn', () => {
  const listener = createListener(() => { throw new Error('EPIPE'); }, () => { throw new Error('warn failed'); });
  const returned = listener(...bash({ mode: 'workspace-write', denied: false }));
  assert.equal(returned, undefined);
});

test('registers one tools/result listener', () => {
  const registrations = [];
  const ctx = {
    on(event, callback) { registrations.push([event, callback]); },
    logger: { warn() {} },
  };
  apply(ctx);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0][0], 'tools/result');
  assert.equal(typeof registrations[0][1], 'function');
  assert.equal(name, 'sandbox-facts');
  assert.deepEqual(inject, ['tools']);
});
