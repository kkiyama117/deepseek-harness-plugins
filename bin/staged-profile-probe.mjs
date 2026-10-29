/** Isolated profile probe: deny provider traffic, exercise one synthetic Agent and read active rows. */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const root = process.env.DSH_UPGRADE_TARGET;
const output = process.env.DSH_UPGRADE_PROBE_OUTPUT;
if (!root || !output) throw new Error('STAGED_PROBE_ENV_REQUIRED');
const require = createRequire(join(root, 'apps/cli/package.json'));
const { LlmAdapter, createUserMessage, ToolCallId } = await import(require.resolve('@deepseek-ai/dsh-llm'));
const { SessionId } = await import(require.resolve('@deepseek-ai/dsh-session'));
export const name = 'staged-profile-probe';
export const inject = ['llm', 'agents', 'agentPresets', 'pluginManager', 'tools', 'sessions', 'goals', 'subagents'];
export function apply(ctx) {
  const ready = ctx.get('appReady');
  if (!ready) throw new Error('STAGED_PROBE_REQUIRES_PROFILE');
  let blocked = 0;
  let requests = 0;
  ctx.on('llm/stream', (options, next) => {
    if (options.provider === 'upgrade-fixture') return next();
    blocked++;
    return (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'STAGED_NO_PROVIDER_CALLS', message: 'Provider inference is disabled in this isolated probe.' } } }; })();
  });
  class FixtureAdapter extends LlmAdapter {
    async listModels() { return [{ provider: 'upgrade-fixture', id: 'fixture', name: 'Upgrade fixture' }]; }
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    async *stream() {
      requests++;
      if (requests === 1) {
        const id = ToolCallId('upgrade-read');
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'read', arguments: JSON.stringify({ file_path: join(process.env.DSH_HOME, 'profiles/web/cordis.yml') }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else if (requests === 2) {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'STAGED_RUNTIME_OK' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'STAGED_RUNTIME_OK' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } else {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'STAGED_PROBE_LIMIT', message: 'Unexpected additional fixture request.' } } };
      }
    }
  }
  ctx.llm.registerAdapter(['upgrade-fixture'], new FixtureAdapter());
  ctx.effect(() => {
    const controller = new AbortController();
    let task = Promise.resolve();
    let handle;
    const cancelReady = ready.onReady(() => {
      task = (async () => {
        const { default: OfficialGoal } = await import(require.resolve('@deepseek-ai/dsh-goal'));
        const { default: OfficialSubagent } = await import(require.resolve('@deepseek-ai/dsh-subagent'));
        assert.equal(OfficialGoal.prototype.registerCompletionCheck, undefined);
        assert.equal(OfficialSubagent.prototype.registerPromptContext, undefined);
        const profileRequire = createRequire(join(process.env.DSH_HOME, 'profiles/web/package.json'));
        const { default: ExternalGoal } = await import(profileRequire.resolve('@kkiyama117/dsh-goal-acceptance/goal-provider'));
        const { default: ExternalSubagent } = await import(profileRequire.resolve('@kkiyama117/dsh-goal-acceptance/subagent-provider'));
        assert(ctx.goals instanceof ExternalGoal); assert(ctx.subagents instanceof ExternalSubagent);
        assert.equal(ctx.subagents.resolveMaxDepth(), 2);
        const rows = await ctx.pluginManager.listPlugins();
        const unavailable = rows.filter(row => ['pending', 'failed'].includes(row.fiberPhase));
        const presets = {};
        for (const id of ['cordis-kura', 'managed-cordis', 'managed-standard', 'ai-reference-store-next', 'aistore-native', 'intake-knowledge']) {
          const value = await ctx.agentPresets.resolve(id);
          presets[id] = value.broken ?? null;
        }
        assert.equal(unavailable.length, 0, 'Required profile entries are not active');
        assert(Object.values(presets).every(value => value === null), 'Broken preset');
        handle = await ctx.agents.create({ sessionId: SessionId('upgrade-profile-probe-' + randomUUID()),
          meta: { cwd: process.env.DSH_HOME, agentPreset: 'cordis-kura' },
          agentOptions: { provider: 'upgrade-fixture', model: 'fixture' }, signal: controller.signal,
          setup: async scope => { await ctx.agentPresets.mount(scope, 'cordis-kura'); },
        });
        const agent = handle.agent;
        const done = Promise.withResolvers();
        const stop = ctx.on('session/event', (session, event) => {
          if (session.id === agent.id && event.type === 'turn/end') done.resolve(event.data.reason);
        });
        const deadline = setTimeout(() => done.reject(new Error('STAGED_PROBE_TIMEOUT')), 30000);
        try {
          agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic upgrade check: read the isolated fixture configuration, then finish.' }] }));
          const reason = await done.promise;
          await agent.whenIdle();
          assert.equal(reason.kind, 'completed');
          const events = agent.session.snapshotEvents();
          assert(events.some(event => event.type === 'tool/result' && event.data.message.toolCallId === 'upgrade-read' && !event.data.message.isError));
          assert.equal(requests, 2); assert.equal(blocked, 0);
          await ctx.sessions.flush(agent.session);
          const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
          await writeFile(output, JSON.stringify({ status: 'passed', version, coreAcceptanceHooksAbsent: true, externalAcceptanceProviders: true, subagentMaxDepth: ctx.subagents.resolveMaxDepth(), realProviderCalls: 0, scriptedRequests: requests,
            sessionId: agent.id, presets, unavailable, plugins: rows.map(({ entryId, moduleName, enabled, fiberPhase }) => ({ entryId, moduleName, enabled, fiberPhase })),
            tools: ctx.tools.schemas(agent).map(tool => tool.name) }, null, 2) + '\n', { mode: 0o600 });
        } finally { clearTimeout(deadline); stop(); }
      })().catch(async error => {
        await writeFile(output, JSON.stringify({ status: 'failed', message: error.message, blocked, requests }, null, 2) + '\n', { mode: 0o600 });
      });
    });
    return async () => { cancelReady(); controller.abort(); await handle?.dispose(); await task; };
  });
}
