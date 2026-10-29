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
import { executeVerification } from '../verification-runtime.mjs';
import { atomicJSON } from '../automation-client.mjs';

class BudgetAdapter extends LlmAdapter {
  count = 0;
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model, reasoning: { efforts: [{ id: 'high', name: 'High' }] } }); }
  async *stream(options) {
    this.count++;
    const final = this.count === 6;
    if (final) assert.match(JSON.stringify(options), /FINAL STEP/);
    const name = final ? 'verification_result' : 'development_command';
    const args = final ? { summary: '実験4回の後、未確認事項を明示して終了します。', outcome: 'insufficient', verified: false, artifacts: [] } : { command: "printf 'bounded-experiment\\n'" };
    const id = ToolCallId('budget-' + this.count);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}

test('four-command bound and final-result-only step are enforced by the actual registry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'slack-verification-bound-'));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } }); await ctx.plugin(AgentLoop, { agents: [] });
  const adapter = new BudgetAdapter(); ctx.llm.registerAdapter(['fixture'], adapter);
  ctx.on('session/flush', session => atomicJSON(join(directory, 'session.json'), session.snapshotEvents()));
  const runtime = { agents: ctx.agents, sessions: ctx.sessions, agentPresets: { async mount() {} } };
  const route = { provider: 'fixture', model: 'fixed', reasoningEffort: 'high', maxTokens: 1024 };
  const config = { verificationPurpose: 'project-experiment', intendedUse: '合成コマンドの実行上限を確認する', targetRoot: directory, artifactsRoot: join(directory, 'artifacts'), presetId: 'fixture', route, jobTimeoutSeconds: 10, maxModelSteps: 6 };
  const job = { job_id: 'bounded', session_id: randomUUID(), target: directory, workflow: 'development-verification', input_hash: 'a'.repeat(64), reference: { identity: 'url:https://example.test', summary: '合成資料' } };
  const material = { status: 'available', text: '承認済み合成本文', content_hash: 'b'.repeat(64), scope: 'coordinator-approved-public-standalone-article', truncated: false };
  const result = await executeVerification(runtime, config, job, new AbortController().signal, { material });
  assert.equal(result.status, 'succeeded'); assert.equal(result.verified, false); assert.equal(adapter.count, 6);
  const record = JSON.parse(await readFile(result.artifacts.at(-1), 'utf8'));
  assert.equal(record.commands.length, 4); assert.equal(record.model_request_proposals, 6);
  assert.equal(record.request_anchors, 1); assert.equal(record.assistant_completions, 6);
  const events = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8'));
  assert.equal(events.filter(event => event.type === 'tool/call' && event.data.name === 'development_command').length, 5);
});

test('missing approved material finishes as unverified without starting a model', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'slack-verification-insufficient-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { targetRoot: directory, artifactsRoot: join(directory, 'artifacts') };
  const job = { job_id: 'insufficient', session_id: randomUUID(), target: directory, workflow: 'development-verification', input_hash: 'a'.repeat(64) };
  const result = await executeVerification({}, config, job, new AbortController().signal, { material: { status: 'insufficient', text: '', content_hash: '', scope: '', reason: 'not found', truncated: false } });
  assert.equal(result.status, 'succeeded'); assert.equal(result.verified, false);
  const record = JSON.parse(await readFile(result.artifacts[0], 'utf8'));
  assert.equal(record.model_called, false); assert.equal(record.model_requests, 0);
});
