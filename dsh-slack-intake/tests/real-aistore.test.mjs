import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import SubagentRuntime from '@deepseek-ai/dsh-subagent';
import * as SpawnProvider from '@deepseek-ai/dsh-subagent-spawn-in-process';
import * as agentPlugin from '../agent.mjs';

const execFile = promisify(execFileCallback);
const aistore = process.env.AISTORE_BINARY;
const fixtureBinary = process.env.AISTORE_FIXTURE_BINARY;
const privateSlackOriginal = 'PRIVATE-SLACK-ORIGINAL-IN-STORE';

class ScriptedAdapter extends LlmAdapter {
  requests = [];
  fixture;
  started = new Map();

  constructor(fixture) {
    super();
    this.fixture = fixture;
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model,
      reasoning: { efforts: [{ id: 'high', name: 'High' }] } });
  }

  waitForStart(name) {
    let entry = this.started.get(name);
    if (!entry) {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      entry = { promise, resolve };
      this.started.set(name, entry);
    }
    return entry.promise;
  }

  async * stream(options) {
    this.requests.push(options);
    const requestText = JSON.stringify(options);
    const scenario = Object.entries(this.fixture.tasks)
      .find(([, task]) => requestText.includes(task.identity))?.[0];
    assert.ok(scenario, 'scripted request must name one fixture identity');
    if (scenario === 'deadline' || scenario === 'cancel') {
      let entry = this.started.get(scenario);
      if (!entry) {
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        entry = { promise, resolve };
        this.started.set(scenario, entry);
      }
      entry.resolve();
      await new Promise(resolve => {
        if (options.signal?.aborted) resolve();
        else options.signal?.addEventListener('abort', resolve, { once: true });
      });
      return;
    }
    const response = scenario === 'reviewer'
      ? { status: 'classified', category: 'synthetic', reason: 'Exact synthetic evidence matches.' }
      : scenario === 'insufficient'
        ? { items: [{ identity: this.fixture.tasks.insufficient.identity, status: 'insufficient',
          reason: 'The synthetic excerpt lacks enough evidence.' }] }
        : { items: [{ identity: this.fixture.tasks[scenario].identity, status: 'ready',
          text: 'Synthetic reader article.', summary: 'Synthetic reader summary.',
          sources: [{ url: `https://example.com/${scenario}`, source_hash: this.fixture.material_hash }],
          anchors: [{ source_hash: this.fixture.material_hash, quote: 'Exact public evidence sentence' }] }] };
    const argumentsJson = JSON.stringify(response);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id: ToolCallId(`structured-${scenario}`),
      name: 'structured_output', argumentsDelta: argumentsJson };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`structured-${scenario}`),
      name: 'structured_output', arguments: argumentsJson } };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}

async function runJson(executable, args) {
  const { stdout, stderr } = await execFile(executable, args, { encoding: 'utf8', maxBuffer: 10_000_000 });
  assert.equal(stderr, '');
  return JSON.parse(stdout);
}

async function task(root, id) {
  return (await runJson(aistore, ['--store', root, '--json', 'task', 'show', '--id', id])).result;
}

const integrationTest = aistore && fixtureBinary && process.platform !== 'win32' ? test : test.skip;

integrationTest('built Go aistore completes real DSH reader/reviewer runs and contains interrupted attempts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aistore-real-dsh-smoke-'));
  const storeRoot = join(directory, 'store');
  const fixture = await runJson(fixtureBinary, ['--store', storeRoot]);
  assert.equal(fixture.schema_version, 7);

  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } });
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(SubagentRuntime);
  await ctx.plugin(SpawnProvider, { providerName: 'spawn' });
  const adapter = new ScriptedAdapter(fixture);
  ctx.llm.registerAdapter(['scripted'], adapter);
  await ctx.plugin(agentPlugin, { aistoreExecutable: aistore, storeRoot, subagentProvider: 'spawn' });
  const parent = await ctx.agentLoop.create(SessionId('parent:real-aistore-smoke'), { provider: 'scripted', model: 'sol' });
  const residentAgents = ctx.agents.list().length;
  const starts = [];
  const ends = [];
  ctx.on('subagent/start', info => void starts.push(info));
  ctx.on('subagent/end', info => void ends.push(info));

  async function invoke(name, signal = new AbortController().signal) {
    const item = fixture.tasks[name];
    return ctx.tools.execute({ callId: ToolCallId(`native-${name}`), name: 'aistore_native_task',
      arguments: { taskId: item.task_id, inputHash: item.input_hash }, agent: parent, signal });
  }

  for (const name of ['reader', 'insufficient', 'reviewer']) {
    const result = await invoke(name);
    assert.equal(result.isError, false);
    assert.deepEqual(result.value, { status: 'accepted', taskId: fixture.tasks[name].task_id, attempt: 1 });
    const stored = await task(storeRoot, fixture.tasks[name].task_id);
    assert.equal(stored.status, 'accepted');
    assert.equal(stored.attempts_used, 1);
    assert.equal(stored.route.provider, 'scripted');
    assert.equal(stored.route.model, 'sol');
    assert.equal(stored.route.effort, 'high');
    const attempt = await runJson(fixtureBinary, ['--store', storeRoot, '--inspect-task', fixture.tasks[name].task_id]);
    assert.equal(attempt.status, 'accepted');
    assert.deepEqual(attempt.actual_route, { provider: 'scripted', model: 'sol', effort: 'high' });
    assert.equal(attempt.session_id, String(starts.at(-1).id));
    assert.notEqual(attempt.session_id, String(parent.id));
    assert.equal(attempt.response_hash, stored.result_hash);
    assert.equal(ends.at(-1).stopReason, 'completed');
    const resultObject = JSON.parse(await readFile(join(storeRoot, 'data', 'objects', 'sha256', stored.result_hash), 'utf8'));
    if (name === 'reader') {
      assert.equal(resultObject.items[0].identity, fixture.tasks.reader.identity);
      assert.equal(resultObject.items[0].status, 'ready');
    } else if (name === 'insufficient') {
      assert.equal(resultObject.items[0].identity, fixture.tasks.insufficient.identity);
      assert.equal(resultObject.items[0].status, 'insufficient');
      assert.equal(resultObject.items[0].reason, 'The synthetic excerpt lacks enough evidence.');
    } else {
      assert.equal(resultObject.status, 'classified');
      assert.equal(resultObject.category, 'synthetic');
    }
    assert.equal(ctx.agents.list().length, residentAgents, 'native run must be disposed before the tool returns');
  }

  const deadlineResult = await invoke('deadline');
  assert.equal(deadlineResult.isError, true);
  assert.equal((await task(storeRoot, fixture.tasks.deadline.task_id)).status, 'unknown');
  assert.equal(ctx.agents.list().length, residentAgents);
  const requestsBeforeUnknownRetry = adapter.requests.length;
  const unknownRetry = await invoke('deadline');
  assert.equal(unknownRetry.isError, true);
  assert.equal(adapter.requests.length, requestsBeforeUnknownRetry, 'unknown task must not reach the model again');
  assert.equal((await task(storeRoot, fixture.tasks.deadline.task_id)).attempts_used, 1);

  const cancellation = new AbortController();
  const cancelling = invoke('cancel', cancellation.signal);
  await adapter.waitForStart('cancel');
  cancellation.abort('synthetic caller cancellation');
  const cancelledResult = await cancelling;
  assert.equal(cancelledResult.isError, true);
  assert.equal((await task(storeRoot, fixture.tasks.cancel.task_id)).status, 'unknown');
  assert.equal(ctx.agents.list().length, residentAgents);

  assert.equal(adapter.requests.length, 5);
  for (const request of adapter.requests) {
    assert.equal(request.provider, 'scripted');
    assert.equal(request.model, 'sol');
    assert.equal(request.reasoningEffort, 'high');
    const visible = JSON.stringify(request);
    assert.ok(!visible.includes(privateSlackOriginal));
    assert.ok(!visible.includes('authority_hash'));
    assert.doesNotMatch(visible, /"token"\s*:/);
  }
  assert.equal(starts.length, 5);
  assert.equal(ends.length, 5);
  assert.deepEqual(ends.map(info => String(info.id)).sort(), starts.map(info => String(info.id)).sort());
  assert.ok(starts.every(info => String(info.id) !== String(parent.id)));
  assert.deepEqual(ends.map(info => info.stopReason), ['completed', 'completed', 'completed', 'aborted', 'aborted']);

  const verification = await runJson(aistore, ['--store', storeRoot, '--json', 'verify']);
  assert.deepEqual(verification.result.errors, []);
});
