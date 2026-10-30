import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { mountAgentLoopTestDependencies, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import SubagentRuntime from '@deepseek-ai/dsh-subagent';
import * as SpawnProvider from '@deepseek-ai/dsh-subagent-spawn-in-process';
import * as agentPlugin from '../agent.mjs';
import SessionQuery from '@deepseek-ai/dsh-session-query';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Include from '@deepseek-ai/cordis-plugin-include';
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry';
import * as nativeRestriction from '../../../plugins/dsh-aistore-native-preset/index.mjs';

const taskId = 'task:reader:actual-agent';
const inputHash = 'a'.repeat(64);
const sourceHash = 'b'.repeat(64);
const claimSecret = 'CLAIM-GRANT-PRIVATE';
const slackOriginal = 'PRIVATE-SLACK-ORIGINAL';
const response = { items: [{ identity: 'x:1', status: 'ready', text: 'article', summary: 'summary',
  sources: [{ url: 'https://example.com', source_hash: sourceHash }],
  anchors: [{ source_hash: sourceHash, quote: 'evidence' }] }] };

class StructuredAdapter extends LlmAdapter {
  requests = [];

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model,
      reasoning: { efforts: [{ id: 'high', name: 'High' }] } });
  }

  async * stream(options) {
    this.requests.push(options);
    const argumentsJson = JSON.stringify(response);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id: ToolCallId('structured-1'),
      name: 'structured_output', argumentsDelta: argumentsJson };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('structured-1'),
      name: 'structured_output', arguments: argumentsJson } };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}

function executableSource() {
  return `#!${process.execPath}\nimport { readFile, writeFile } from 'node:fs/promises';\nimport { join } from 'node:path';\nconst argv = process.argv.slice(2);\nconst store = argv[1];\nconst op = argv.slice(3);\nlet result;\nif (op[0] === 'task' && op[1] === 'claim') {\n  result = { task_id: ${JSON.stringify(taskId)}, attempt: 1, token: ${JSON.stringify(claimSecret)}, slack_original: ${JSON.stringify(slackOriginal)} };\n} else if (op[0] === 'task' && op[1] === 'in-flight') {\n  const receipt = op[op.indexOf('--receipt') + 1];\n  await writeFile(join(store, 'claim.json'), await readFile(receipt));\n  result = { accepted: true };\n} else if (op[0] === 'intake' && op[1] === 'native' && op[2] === 'packet') {\n  result = { task_id: ${JSON.stringify(taskId)}, attempt: 1, kind: 'reader', input_hash: ${JSON.stringify(inputHash)},\n    route: { provider: 'openrouter', model: 'fixed-model', effort: 'high' }, max_tokens: 4096, timeout_seconds: 5,\n    packet: { items: [{ identity: 'x:1', materials: [{ url: 'https://example.com', source_hash: ${JSON.stringify(sourceHash)}, text: 'public evidence', scope: 'article' }] }] } };\n} else if (op[0] === 'intake' && op[1] === 'native' && op[2] === 'accept') {\n  const receipt = op[op.indexOf('--receipt') + 1];\n  await writeFile(join(store, 'native-receipt.json'), await readFile(receipt));\n  result = { accepted: true, result_hash: '${'c'.repeat(64)}' };\n} else {\n  process.stderr.write('unexpected operation');\n  process.exit(1);\n}\nprocess.stdout.write(JSON.stringify({ protocol_version: 1, result }) + '\\n');\n`;
}

test('agent entry registers a validated native task tool without credentials', async () => {
  let tool;
  const ctx = { tools: { register(value) { tool = value; return () => {}; } }, subagents: {} };
  agentPlugin.apply(ctx, { aistoreExecutable: '/trusted/aistore', storeRoot: '/private/store', subagentProvider: 'spawn' });
  assert.deepEqual(agentPlugin.inject, ['tools', 'subagents', 'sessionQuery']);
  assert.equal(tool.name, 'aistore_native_task');
  assert.deepEqual(tool.parameters.required, ['taskId', 'inputHash']);
  await assert.rejects(tool.execute({ taskId }, { agent: {}, signal: new AbortController().signal }), /invalid arguments/);
  assert.throws(() => agentPlugin.apply(ctx, { python: '/python', skillRoot: '/skill', subagentProvider: 'spawn' }), /legacy/);
});

test('real exec.agent drives one native child and accepts its recorded route and response', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aistore-native-agent-'));
  const executable = join(directory, 'aistore');
  await writeFile(executable, executableSource(), { mode: 0o700 });
  await chmod(executable, 0o700);

  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await ctx.plugin(Loader);
  ctx.loader.builtins.include = Include;
  ctx.loader.builtins.nativeRestriction = nativeRestriction;
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } });
  await ctx.plugin(AgentPresets, { default: 'aistore-native' });
  const releasePreset = await ctx.agentPresets.register({ id: 'aistore-native', plugins: [
    { id: 'restriction', name: 'cordis:nativeRestriction' },
  ] });
  t.after(releasePreset);
  await ctx.plugin(JsonlPersistence, { root: join(directory, 'sessions') });
  await ctx.plugin(SessionQuery);
  await ctx.plugin(AgentLoop, { agents: [] });
  provideWorkingDirectoryFixture(ctx, directory);
  // Native activations also assign their captured directory during setup.
  ctx.workingDirectory.set = async (_agent, cwd) => cwd;
  await ctx.plugin(SubagentRuntime);
  await ctx.plugin(SpawnProvider, { providerName: 'spawn' });
  const adapter = new StructuredAdapter();
  ctx.llm.registerAdapter(['openrouter'], adapter);
  await ctx.plugin(agentPlugin, { aistoreExecutable: executable, storeRoot: directory, subagentProvider: 'spawn' });
  const parent = await ctx.agentLoop.create(SessionId('parent:actual'), { provider: 'openrouter', model: 'parent-model' });

  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: ToolCallId('native-call'), name: 'aistore_native_task', arguments: JSON.stringify({ taskId, inputHash }) }],
    agent: parent, signal: new AbortController().signal,
  });
  assert.equal(batch.results.length, 1);
  const result = batch.results[0].result;
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(result.value, { status: 'accepted', taskId, attempt: 1 });
  assert.equal(adapter.requests.length, 1);
  assert.equal(adapter.requests[0].provider, 'openrouter');
  assert.equal(adapter.requests[0].model, 'fixed-model');
  assert.equal(adapter.requests[0].reasoningEffort, 'high');
  assert.equal(adapter.requests[0].maxTokens, 4096);
  assert.deepEqual(adapter.requests[0].tools.map(tool => tool.name), ['structured_output']);
  assert.ok(!JSON.stringify(adapter.requests[0]).includes(claimSecret));
  assert.ok(!JSON.stringify(adapter.requests[0]).includes(slackOriginal));

  const claim = JSON.parse(await readFile(join(directory, 'claim.json'), 'utf8'));
  assert.equal(claim.token, claimSecret);
  const receipt = JSON.parse(await readFile(join(directory, 'native-receipt.json'), 'utf8'));
  assert.deepEqual(receipt.actual_route, { provider: 'openrouter', model: 'fixed-model', effort: 'high' });
  assert.equal(receipt.reported_cost, null);
  assert.deepEqual(receipt.response, response);
  assert.notEqual(receipt.session_id, String(parent.id));
});
