/** Deterministic daily application; only native handoffs create model turns. */
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { AdapterError, runAistore, resolveConfig } from './intake.mjs';

export const name = 'aistore-daily';
export const inject = ['credentials', 'cmdlineArgs', 'agents', 'agentPresets', 'tools'];

export function resolveDailyConfig(config) {
  const paths = resolveConfig(config);
  for (const key of ['intakeConfig', 'reportsRoot', 'backupsRoot', 'notifyExecutable']) {
    if (typeof config[key] !== 'string' || !isAbsolute(config[key])) throw new Error(`aistore-daily: invalid ${key}`);
  }
  for (const key of ['deadlineSeconds', 'cleanupSeconds', 'notificationSeconds', 'exitGraceSeconds', 'maxTransitions']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`aistore-daily: invalid ${key}`);
  }
  if (typeof config.presetId !== 'string' || config.presetId.length === 0) throw new Error('aistore-daily: presetId required');
  const route = config.parentRoute;
  if (!route || !['provider', 'model', 'reasoningEffort'].every(key => typeof route[key] === 'string' && route[key].length > 0)) {
    throw new Error('aistore-daily: explicit parentRoute required');
  }
  return { ...config, ...paths };
}

/** The lock child holds flock until stdin closes, including after a driver crash. */
export async function acquireDailyLock(config, signal, spawnChild = spawn) {
  if (signal.aborted) throw new AdapterError('DAILY_INTERRUPTED');
  const child = spawnChild(config.aistoreExecutable, ['--store', config.storeRoot, '--json', 'intake', 'daily', 'lock'],
    { env: { LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
  const abort = () => { child.kill('SIGKILL'); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let text = '';
  child.stdout.on('data', chunk => {
    text += chunk.toString('utf8');
    if (text.length > 1024) { readyReject(new AdapterError('DAILY_LOCK_PROTOCOL')); abort(); return; }
    if (!text.includes('\n')) return;
    try {
      const value = JSON.parse(text);
      if (value.protocol_version !== 1 || value.result?.locked !== true) throw new Error('invalid lock result');
      readyResolve();
    } catch { readyReject(new AdapterError('DAILY_LOCK_PROTOCOL')); abort(); }
  });
  child.stdin.on('error', () => { /* A closed lock child is reported by its close event. */ });
  child.once('error', () => readyReject(new AdapterError('DAILY_LOCK_FAILED')));
  const done = new Promise(resolve => child.once('close', (code, killed) => {
    signal.removeEventListener('abort', abort);
    readyReject(new AdapterError(code === 1 ? 'DAILY_ALREADY_RUNNING' : 'DAILY_LOCK_FAILED'));
    resolve({ code, signal: killed });
  }));
  try { await ready; } catch (error) { abort(); await done; throw error; }
  signal.removeEventListener('abort', abort);
  let released = false;
  const lost = done.then(() => { if (!released) throw new AdapterError('DAILY_LOCK_LOST'); });
  // The caller races its work against lost; this handler also covers setup before that race.
  void lost.catch(() => undefined);
  return { lost, async release() { released = true; child.stdin.end(); await done; } };
}

async function atomicWrite(path, text) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  await rename(temp, path);
}

export function renderDailyReport(report) {
  const counts = report.state?.run_status?.counts ?? {};
  const usage = report.state?.usage ?? {};
  const lines = ['# Slack日次取り込み', '', `**${report.status === 'completed' ? '完了' : '要対応'}**`, '',
    `- 確認時刻：${report.finished_at}`,
    `- 対象バッチの開始：${report.state?.batch?.created_at ?? '未確認'}`,
    `- 対象期間の投稿：${report.state?.collection?.new_message_count ?? '未確認'}件`, `- 新規登録：${counts.registered ?? 0}件`,
    `- 保留確定：${counts.needs_review ?? 0}件`, `- 未処理：${counts.pending ?? 0}件`,
    `- 状態：${report.reason || (report.status === 'completed' ? '正常終了' : '終了確認待ち')}`];
  const unresolved = (report.state?.run_status?.tasks ?? []).filter(task => ['unknown', 'claimed', 'in_flight', 'failed'].includes(task.status));
  if (unresolved.length) {
    lines.push('', '## 要確認の実行記録', '', report.batch_completed
      ? '対象項目は明示的に保留へ分離しました。実行履歴は保持し、自動再送はしません。後続期間は収集可能です。'
      : 'このバッチが未完了のため、後続期間の収集は進んでいません。');
    for (const task of unresolved) lines.push(`- ${task.kind}：${task.status}／${task.reason || '理由未記録'}（${task.task_id}）`);
  }
  lines.push('', '## AIの利用', '');
  for (const [kind, value] of Object.entries(usage)) {
    const cost = value.has_unknown_cost && value.reported_cost_usd === 0 ? '費用不明'
      : `判明分 $${value.reported_cost_usd}${value.has_unknown_cost ? '（費用不明の試行あり）' : ''}`;
    lines.push(`- ${kind}：${value.attempts}試行。${cost}`);
  }
  lines.push('', '費用不明は0ではありません。上記は全モデルの総費用ではありません。', '',
    `検証エラー：${report.verify?.errors?.length ?? '未確認'}。通知：${report.notification}。`, '',
    `batch: \`${report.batch_id ?? '未作成'}\``, `backup: \`${report.backup ?? 'なし'}\``, '');
  return lines.join('\n');
}

/** Explicit opt-in: retain timed-out attempts and hold this batch, never replay it. */
export async function quarantineTimedOutBatch({ batch, run, enabled }) {
  if (enabled !== true) return undefined;
  const tasks = await run(['task', 'list', '--id', batch.run_id]);
  const unresolved = tasks.filter(task => ['unknown', 'claimed', 'in_flight', 'failed'].includes(task.status)
    && !(task.kind === 'fetch' && task.status === 'failed'));
  if (unresolved.length === 0 || unresolved.some(task => task.status !== 'unknown' || task.reason !== 'NATIVE_TIMEOUT'
    || !['reader', 'content_review', 'reviewer'].includes(task.kind))) return undefined;
  return run(['intake', 'resume', '--run', batch.run_id, '--finish-held']);
}

/** Advance one frozen batch. run/native are injected so failure paths need no live paid requests. */
export async function driveBatch({ batch, run, native, maxTransitions, quarantineNativeTimeouts = false }) {
  if (batch.status === 'collecting') await run(['intake', 'slack', 'collect', '--batch', batch.batch_id]);
  await run(['intake', 'daily', 'reconcile', '--batch', batch.batch_id]);
  let previous;
  for (let step = 0; step < maxTransitions; step++) {
    const result = await run(['intake', 'daily', 'advance', '--batch', batch.batch_id]);
    if (result.status === 'completed') {
      const counts = result.run_status?.counts ?? {};
      if ((counts.pending ?? 0) > 0) throw new AdapterError('DAILY_UNPROCESSED_ITEMS');
      return result;
    }
    if (result.status === 'needs_attention') throw new AdapterError('DAILY_ITEM_LIMIT');
    const handoffs = result.handoffs ?? [];
    if (handoffs.some(({ task }) => ['unknown', 'claimed', 'in_flight', 'failed'].includes(task.status))) {
      const held = await quarantineTimedOutBatch({ batch, run, enabled: quarantineNativeTimeouts });
      if (held) return held;
      throw new AdapterError('DAILY_TASK_NEEDS_RECONCILIATION');
    }
    const signature = JSON.stringify(handoffs.map(({ task }) => [task.task_id, task.status, task.attempts_used]));
    if (signature === previous) throw new AdapterError('DAILY_NO_PROGRESS_OR_BUDGET');
    previous = signature;
    const task = handoffs.find(({ task }) => task.status === 'pending' && ['reader', 'content_review', 'reviewer'].includes(task.kind))?.task;
    if (task) {
      try { await native(task); }
      catch (error) {
        const held = await quarantineTimedOutBatch({ batch, run, enabled: quarantineNativeTimeouts });
        if (held) return held;
        throw error;
      }
      continue;
    }
    if (handoffs.some(({ task }) => task.status === 'pending' && ['fetch', 'classifier'].includes(task.kind))) {
      await run(['intake', 'resume', '--run', batch.run_id, '--allow-network']);
      continue;
    }
    throw new AdapterError('DAILY_NO_EXECUTABLE_WORK');
  }
  throw new AdapterError('DAILY_TRANSITION_LIMIT');
}

async function notify(config, summary) {
  try {
    await promisify(execFile)(config.notifyExecutable, ['--app-name=AI参照ストア', 'Slack日次取り込み', summary], {
      env: { PATH: '/usr/bin:/bin', LANG: 'ja_JP.UTF-8', ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}) },
      signal: AbortSignal.timeout(config.notificationSeconds * 1000), maxBuffer: 4096,
    });
    return 'sent';
  } catch { return 'failed'; }
}

/** Own one daily invocation, private reports, and parent disposal before application exit. */
export async function executeDaily(ctx, config, signal) {
  const controller = new AbortController();
  const workSignal = AbortSignal.any([signal, controller.signal]);
  const args = ctx.cmdlineArgs.get();
  if (args.length !== 2 || args[0] !== 'daily' || !['run', 'status', 'check'].includes(args[1])) throw new AdapterError('DAILY_ARGUMENTS_INVALID');
  const refs = { slack: credentialRef('SLACK_BOT_TOKEN'), openrouter: credentialRef('OPENROUTER_API_KEY') };
  const run = async (argv, ownedSignal = workSignal) => {
    let credential;
    const which = argv.slice(0, 3).join('/') === 'intake/slack/collect' ? 'slack'
      : argv[0] === 'intake' && argv[1] === 'resume' && argv.includes('--allow-network') ? 'openrouter' : undefined;
    if (which) {
      const resolved = await ctx.credentials.resolve(refs[which]);
      if (!resolved) throw new AdapterError('CREDENTIAL_NOT_CONFIGURED');
      credential = { name: which === 'slack' ? 'SLACK_BOT_TOKEN' : 'OPENROUTER_API_KEY', value: resolved.value };
    }
    return (await runAistore(config, argv, ownedSignal, credential)).envelope.result;
  };
  if (args[1] === 'status') { process.stdout.write(JSON.stringify(await run(['intake', 'daily', 'status'])) + '\n'); return 0; }
  const preset = await ctx.agentPresets.resolve(config.presetId);
  if (preset.broken) throw new AdapterError('DAILY_PRESET_INVALID');
  let parent;
  const getParent = async () => {
    if (!parent) parent = await ctx.agents.create({ sessionId: `aistore-daily-${randomUUID()}`, meta: { cwd: config.storeRoot },
      agentOptions: config.parentRoute, signal: workSignal, setup: async scope => {
        await ctx.agentPresets.mount(scope, config.presetId);
        scope.tools.restrict({ allow: ['aistore_native_task'] });
      } });
    return parent.agent;
  };
  if (args[1] === 'check') {
    try {
      const agent = await getParent();
      const listed = ctx.tools.schemas(agent);
      process.stdout.write(JSON.stringify({ preset: config.presetId, mounted: true, tools: listed.map(tool => tool.name), model_turns: 0, quarantine_native_timeouts: config.quarantineNativeTimeouts === true }) + '\n');
      return 0;
    } finally { await parent?.dispose(); }
  }
  const lock = await acquireDailyLock(config, workSignal);
  let lockLost = false;
  void lock.lost.catch(() => { lockLost = true; controller.abort('daily lock lost'); });
  let batch;
  let readyToFinish = false;
  const report = { schema_version: 1, batch_completed: false, status: 'needs_attention', reason: '', notification: 'pending', started_at: new Date().toISOString() };
  try {
    batch = await run(['intake', 'daily', 'prepare', '--config', config.intakeConfig, '--latest', `${Math.floor(Date.now() / 1000)}.000000`]);
    report.batch_id = batch.batch_id;
    await driveBatch({ batch, run, maxTransitions: config.maxTransitions, quarantineNativeTimeouts: config.quarantineNativeTimeouts, native: async task => {
      const result = await ctx.tools.execute({ callId: `daily-${randomUUID()}`, name: 'aistore_native_task',
        arguments: { taskId: task.task_id, inputHash: task.input_hash }, agent: await getParent(), signal: workSignal });
      if (result.isError) throw new AdapterError('DAILY_NATIVE_FAILED');
    } });
    report.verify = await run(['verify']);
    if (!Array.isArray(report.verify.errors) || report.verify.errors.length !== 0) throw new AdapterError('DAILY_VERIFY_FAILED');
    report.state = await run(['intake', 'daily', 'status', '--batch', batch.batch_id]);
    if ((report.state.run_status?.counts?.registered ?? 0) > 0) {
      await mkdir(config.backupsRoot, { recursive: true, mode: 0o700 });
      const backup = join(config.backupsRoot, batch.batch_id.replaceAll(':', '-'));
      let exists = false;
      try { exists = (await stat(backup)).isDirectory(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await run(exists ? ['backup', 'verify', '--from', backup] : ['backup', 'create', '--out', backup]);
      report.backup = backup;
    }
    readyToFinish = true;
    const held = (report.state.run_status?.counts?.needs_review ?? 0) > 0;
    report.status = held ? 'needs_attention' : 'completed';
    if (held) report.reason = 'DAILY_ITEMS_HELD';
  } catch (error) {
    report.reason = lockLost ? 'DAILY_LOCK_LOST' : signal.aborted ? 'DAILY_DEADLINE_OR_INTERRUPTED' : error instanceof AdapterError ? error.code : 'DAILY_FAILURE';
  } finally {
    try {
      await parent?.dispose();
      const cleanup = AbortSignal.timeout(config.cleanupSeconds * 1000);
      if (batch) {
        if (lockLost) { readyToFinish = false; report.status = 'needs_attention'; report.reason = 'DAILY_LOCK_LOST'; }
        else {
          await run(['intake', 'daily', 'reconcile', '--batch', batch.batch_id], cleanup);
          if (!readyToFinish) await run(['intake', 'daily', 'report', '--batch', batch.batch_id, '--reason', report.reason], cleanup);
        }
        report.state = await run(['intake', 'daily', 'status', '--batch', batch.batch_id], cleanup);
      }
      await mkdir(config.reportsRoot, { recursive: true, mode: 0o700 });
      const base = join(config.reportsRoot, batch ? batch.batch_id.replaceAll(':', '-') : `failed-${randomUUID()}`);
      report.finished_at = new Date().toISOString();
      const finalStatus = report.status;
      if (readyToFinish) report.status = 'finalizing';
      await atomicWrite(`${base}.json`, JSON.stringify(report, null, 2) + '\n');
      await atomicWrite(`${base}.md`, renderDailyReport(report));
      if (readyToFinish) {
        try {
          report.state = await run(['intake', 'daily', 'finish', '--batch', batch.batch_id], cleanup);
          report.status = finalStatus;
          report.batch_completed = true;
        } catch {
          report.status = 'needs_attention'; report.reason = 'DAILY_FINALIZATION_FAILED';
        }
      }
      const summary = `${report.status === 'completed' ? '完了' : '要対応'}・新規${report.state?.run_status?.counts?.registered ?? 0}件\n${base}.md`;
      report.notification = await notify(config, summary);
      await atomicWrite(`${base}.json`, JSON.stringify(report, null, 2) + '\n');
      await atomicWrite(`${base}.md`, renderDailyReport(report));
      process.stdout.write(JSON.stringify({ status: report.status, batch_completed: report.batch_completed, reason: report.reason, report: `${base}.md`, notification: report.notification }) + '\n');
    } finally { await lock.release(); }
  }
  return report.status === 'completed' ? 0 : 1;
}

/** Request launcher disposal, then bound residual process handles without keeping an idle process alive. */
export function finishDailyProcess(exit, code, graceSeconds, runtime = process, schedule = setTimeout) {
  const timer = schedule(() => {
    // The inspected CLI records exitCode only after its entire application disposer settles.
    const disposed = runtime.exitCode === code;
    runtime.stderr.write(JSON.stringify({ daily_shutdown: 'exit_grace_expired', application_disposed: disposed,
      resources: runtime.getActiveResourcesInfo() }) + '\n');
    runtime.exit(disposed ? code : 1);
  }, graceSeconds * 1000);
  timer.unref();
  exit(code);
}

export function apply(ctx, config) {
  const spec = resolveDailyConfig(config);
  const ready = ctx.get('appReady');
  const exit = ctx.get('appExit');
  if (!ready || !exit) throw new Error('aistore-daily: launch through an official dsh profile');
  ctx.effect(() => {
    const controller = new AbortController();
    let active = true;
    let task = Promise.resolve();
    let timer;
    const stop = ready.onReady(() => {
      timer = setTimeout(() => controller.abort('daily deadline'), spec.deadlineSeconds * 1000);
      task = executeDaily(ctx, spec, controller.signal).catch(error => {
        process.stderr.write(`aistore-daily: ${error instanceof AdapterError ? error.code : 'DAILY_FAILURE'}\n`);
        return 1;
      }).then(code => { clearTimeout(timer); if (active) finishDailyProcess(exit, code, spec.exitGraceSeconds); });
    });
    return async () => { active = false; stop(); clearTimeout(timer); controller.abort(); await task; };
  }, 'daily intake invocation');
}
