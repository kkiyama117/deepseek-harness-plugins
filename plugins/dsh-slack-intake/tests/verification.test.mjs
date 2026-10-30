import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { executeVerification, verifyRecordedRoute, runDevelopmentCommand } from '../verification-runtime.mjs';
import { atomicJSON } from '../automation-client.mjs';

class VerificationAdapter extends LlmAdapter {
  calls = [];
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model, reasoning: { efforts: [{ id: 'high', name: 'High' }] } }); }
  async *stream(options) {
    this.calls.push(options);
    const first = this.calls.length === 1;
    const name = first ? 'development_command' : 'verification_result';
    const args = JSON.stringify(first ? { command: "printf 'actual-development-command\\n'" } : { summary: '実コマンドで確認しました。', outcome: 'tested', verified: true, artifacts: [] });
    const id = ToolCallId('verification-' + this.calls.length);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}

test('real AgentLoop executes a bounded real command, captures result and saves route evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'slack-verification-core-'));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } });
  await ctx.plugin(AgentLoop, { agents: [] });
  const adapter = new VerificationAdapter();
  ctx.llm.registerAdapter(['fixture'], adapter);
  ctx.on('session/flush', session => atomicJSON(join(directory, 'session.json'), session.snapshotEvents()));
  const runtime = { agents: ctx.agents, sessions: ctx.sessions, agentPresets: { async mount() {} } };
  const route = { provider: 'fixture', model: 'fixed', reasoningEffort: 'high', maxTokens: 1024 };
  const config = { verificationPurpose: 'project-experiment', intendedUse: '合成コマンドの実行を確認する', targetRoot: directory, artifactsRoot: join(directory, 'artifacts'), presetId: 'fixture', route, jobTimeoutSeconds: 10, maxModelSteps: 3 };
  const job = { job_id: 'fixture-job', session_id: randomUUID(), target: directory, workflow: 'development-verification', input_hash: 'a'.repeat(64), reference: { identity: 'url:https://example.test', url: 'https://example.test', category: 'programming', summary: '合成資料' } };
  const result = await executeVerification(runtime, config, job, new AbortController().signal, { material: { status: 'available', text: '合成の承認済み公開記事。', content_hash: 'b'.repeat(64), scope: 'coordinator-approved-public-standalone-article', reason: '', truncated: false } });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.verified, true);
  assert.equal(adapter.calls.length, 2);
  assert.deepEqual(adapter.calls[0].tools.map(t => t.name).sort(), ['development_command', 'development_read', 'verification_result']);
  const evidence = JSON.parse(await readFile(result.artifacts.at(-1), 'utf8'));
  assert.equal(evidence.commands[0].exit_code, 0);
  assert.match(evidence.commands[0].output, /actual-development-command/);
  assert.deepEqual(evidence.route, route);
  assert.equal(evidence.reported_cost, null);
  assert.equal(ctx.agents.list().length, 0);
  assert.ok(JSON.parse(await readFile(join(directory, 'session.json'), 'utf8')).some(e => e.type === 'turn/end'));
});

test('route evidence refuses implicit replacement', () => {
  const route = { provider: 'fixed', model: 'expected', reasoningEffort: 'high', maxTokens: 100 };
  const events = [{ type: 'request/header', data: { header: { config: route } } }, { type: 'assistant/message', data: { message: { source: { kind: 'model', provider: 'other', model: 'expensive' } } } }];
  assert.throws(() => verifyRecordedRoute(events, route), error => error.code === 'MODEL_ROUTE_MISMATCH');
});

test('isolated command reports status, enforces deadline and cannot read outside mounts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'slack-command-isolation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const signal = new AbortController().signal;
  const artifacts = join(directory, 'artifacts');
  assert.equal((await runDevelopmentCommand('exit 7', directory, signal, 60000, artifacts)).exit_code, 7);
  const privacy = await runDevelopmentCommand('test ! -e /data/references/AI && test ! -e /home/kiyama/.dsh/.credentials.yaml && test ! -e /home/kiyama/.local/state/slack-intake && printf "PRIVATE_AREAS_HIDDEN\\n"', directory, signal, 60000, artifacts);
  assert.equal(privacy.exit_code, 0); assert.match(privacy.output, /PRIVATE_AREAS_HIDDEN/);
  const result = await runDevelopmentCommand('exec /usr/bin/sleep 30', directory, signal, 80, artifacts);
  assert.equal(result.timed_out, true); assert.equal(result.signal, 'SIGKILL');
});
