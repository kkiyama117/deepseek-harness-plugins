import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireDailyLock, driveBatch, renderDailyReport, finishDailyProcess, executeDaily } from '../daily.mjs';

test('daily refuses a broken declared preset before creating an Agent or claiming work', async () => {
  const ctx = {
    cmdlineArgs: { get: () => ['daily', 'run'] },
    agentPresets: { resolve: async id => ({ id, broken: 'missing preset dependency' }) },
    agents: { create: () => assert.fail('broken preset created an Agent') },
  };
  await assert.rejects(executeDaily(ctx, { presetId: 'daily' }, new AbortController().signal),
    error => error.code === 'DAILY_PRESET_INVALID');
});

const batch = { batch_id: 'daily:synthetic', run_id: 'run:synthetic', status: 'processing' };
const handoff = (id, kind, status = 'pending') => ({ task: { task_id: id, input_hash: 'fixed', kind, status, attempts_used: status === 'pending' ? 0 : 1 } });

test('post-completion grace preserves launcher code only after application disposal', () => {
  for (const disposed of [false, true]) {
    const events = [];
    let expire;
    const runtime = { exitCode: undefined, stderr: { write: text => events.push(JSON.parse(text)) },
      getActiveResourcesInfo: () => ['SyntheticHandle'], exit: code => events.push(['exit', code]) };
    finishDailyProcess(code => { events.push(['launcher', code]); if (disposed) runtime.exitCode = code; }, 0, 15, runtime,
      (fn, ms) => { assert.equal(ms, 15000); expire = fn; return { unref() { events.push('unref'); } }; });
    assert.deepEqual(events, ['unref', ['launcher', 0]]);
    expire();
    assert.equal(events[2].application_disposed, disposed);
    assert.deepEqual(events[3], ['exit', disposed ? 0 : 1]);
  }
});

test('daily empty run invokes no native worker or network resume', async () => {
  const calls = [];
  const result = await driveBatch({ batch, maxTransitions: 10,
    run: async args => { calls.push(args); return { status: 'completed', run_status: { counts: {} } }; },
    native: () => assert.fail('empty run used a model'),
  });
  assert.equal(result.status, 'completed');
  assert.ok(!calls.some(args => args.includes('--allow-network')));
});

test('daily driver follows fetch, reader, content review, classifier and stops after registration', async () => {
  const stages = ['fetch', 'reader', 'content_review', 'classifier'];
  const calls = [];
  let index = 0;
  await driveBatch({ batch: { ...batch, status: 'collecting' }, maxTransitions: 10,
    run: async args => {
      calls.push(args.slice(0, 3).join('/'));
      if (args[2] === 'advance') return index < stages.length
        ? { status: 'open', handoffs: [handoff(`task:${index}`, stages[index])] }
        : { status: 'completed', run_status: { counts: { registered: 1 } } };
      if (args[1] === 'resume') index++;
      return {};
    },
    native: async task => { calls.push(`native/${task.kind}`); index++; },
  });
  assert.deepEqual(calls.filter(x => x.startsWith('native/')), ['native/reader', 'native/content_review']);
  assert.equal(calls.filter(x => x === 'intake/resume/--run').length, 2);
  assert.equal(calls[0], 'intake/slack/collect');
});

for (const state of ['unknown', 'claimed', 'in_flight', 'failed']) {
  test(`daily ${state} stops without dispatch or fallback`, async () => {
    await assert.rejects(driveBatch({ batch, maxTransitions: 10,
      run: async args => args[2] === 'advance' ? { status: 'open', handoffs: [handoff('task:old', 'classifier', state), handoff('task:new', 'reviewer')] } : {},
      native: () => assert.fail('unsettled run dispatched another task'),
    }), error => error.code === 'DAILY_TASK_NEEDS_RECONCILIATION');
  });
}

test('known rejected Reader is not retried and does not abandon other executable work', async () => {
  let stage = 0; const nativeCalls = []; let held = 0;
  const rejected = { task: { ...handoff('task:bad', 'reader', 'failed').task, reason: 'NATIVE_READER_ANCHOR_MISMATCH' } };
  const result = await driveBatch({ batch, maxTransitions: 10, quarantineNativeRejections: true,
    run: async args => {
      if (args[2] === 'advance') return { status: 'open', handoffs: stage === 0
        ? [handoff('task:bad', 'reader'), handoff('task:good', 'reader')]
        : stage === 1 ? [rejected, handoff('task:good', 'reader')]
          : stage === 2 ? [rejected, handoff('task:classify', 'classifier')] : [rejected] };
      if (args.includes('--allow-network')) { stage = 3; return {}; }
      if (args.includes('--finish-held')) {
        assert.equal(stage, 3, 'other work was discarded before registration'); held++;
        return { status: 'completed', run_status: { counts: { registered: 1, needs_review: 1 } } };
      }
      return {};
    },
    native: async task => {
      nativeCalls.push(task.task_id);
      if (task.task_id === 'task:bad') { stage = 1; throw Object.assign(new Error('rejected'), { code: 'NATIVE_READER_ANCHOR_MISMATCH' }); }
      stage = 2;
    },
  });
  assert.deepEqual(nativeCalls, ['task:bad', 'task:good']);
  assert.equal(held, 1); assert.equal(result.run_status.counts.registered, 1);
});

for (const [kind, status, reason] of [['reader', 'unknown', 'NATIVE_READER_ANCHOR_MISMATCH'],
  ['reader', 'failed', 'AISTORE_OPERATION_FAILED'], ['content_review', 'failed', 'NATIVE_READER_ANCHOR_MISMATCH']]) {
  test(`rejection isolation does not bypass ${kind}/${status}/${reason}`, async () => {
    await assert.rejects(driveBatch({ batch, maxTransitions: 10, quarantineNativeRejections: true,
      run: async args => args[2] === 'advance' ? { status: 'open', handoffs: [{ task: { ...handoff('task:bad', kind, status).task, reason } }] } : {},
      native: () => assert.fail('unresolved task was dispatched'),
    }), error => error.code === 'DAILY_TASK_NEEDS_RECONCILIATION');
  });
}

test('rejection isolation preserves pending semantic approvals instead of holding them', async () => {
  await assert.rejects(driveBatch({ batch, maxTransitions: 10, quarantineNativeRejections: true,
    run: async args => {
      assert(!args.includes('--finish-held'));
      return args[2] === 'advance' ? { status: 'open', approvals: [{}], handoffs: [{ task: {
        ...handoff('task:bad', 'reader', 'failed').task, reason: 'NATIVE_READER_ANCHOR_MISMATCH' } }] } : {};
    }, native: () => assert.fail('unexpected native dispatch'),
  }), error => error.code === 'DAILY_NO_EXECUTABLE_WORK');
});

test('daily rejection report names the cause without source text or claims', () => {
  const text = renderDailyReport({ status: 'needs_attention', finished_at: 'synthetic', reason: 'NATIVE_READER_ANCHOR_MISMATCH', notification: 'sent',
    state: { run_status: { tasks: [{ kind: 'reader', status: 'failed', task_id: 'task:1', reason: 'NATIVE_READER_ANCHOR_MISMATCH' }] } } });
  assert.match(text, /引用が保存原文と一致しない/); assert.match(text, /自動再送しません/);
});

test('unchanged pending work stops rather than spinning or resetting a budget', async () => {
  let network = 0;
  await assert.rejects(driveBatch({ batch, maxTransitions: 10,
    run: async args => {
      if (args[1] === 'resume') network++;
      return { status: 'open', handoffs: [handoff('task:1', 'classifier')] };
    }, native: () => assert.fail('unexpected model'),
  }), error => error.code === 'DAILY_NO_PROGRESS_OR_BUDGET');
  assert.equal(network, 1);
});

test('terminal held items remain visible while processing can finish without retries', async () => {
  const result = await driveBatch({ batch, maxTransitions: 10,
    run: async () => ({ status: 'completed', run_status: { counts: { registered: 2, needs_review: 1 } } }),
    native: () => assert.fail('held item was retried'),
  });
  assert.equal(result.run_status.counts.needs_review, 1);
});

test('daily report distinguishes unknown cost and missing verification', () => {
  const report = renderDailyReport({ status: 'needs_attention', finished_at: 'synthetic', reason: 'DAILY_NATIVE_FAILED', notification: 'failed',
    state: { usage: { reader: { attempts: 1, reported_cost_usd: 0, has_unknown_cost: true } } } });
  assert.match(report, /reader：1試行。費用不明/);
  assert.doesNotMatch(report, /reader：1試行。.*\$0/);
  assert.match(report, /検証エラー：未確認/);
  assert.doesNotMatch(report, /正常終了/);
});

test('real Go driver lock survives operation cancellation and releases only on disposal', { skip: !process.env.AISTORE_BINARY }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aistore-lock-test-'));
  const config = { storeRoot: root, aistoreExecutable: process.env.AISTORE_BINARY };
  let first;
  let third;
  try {
    await promisify(execFile)(config.aistoreExecutable, ['--store', root, '--json', 'init']);
    const controller = new AbortController();
    first = await acquireDailyLock(config, controller.signal);
    controller.abort();
    await assert.rejects(acquireDailyLock(config, new AbortController().signal), error => error.code === 'DAILY_ALREADY_RUNNING');
    await first.release(); first = undefined;
    third = await acquireDailyLock(config, new AbortController().signal);
  } finally {
    await third?.release(); await first?.release(); await rm(root, { recursive: true, force: true });
  }
});
