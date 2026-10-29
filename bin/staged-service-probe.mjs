/** Read-only service-profile mount check; no worker socket, intake batch, or provider inference starts. */
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
export const name = 'staged-service-probe';
export const inject = ['pluginManager', 'agentPresets', 'agents', 'tools', 'llm', 'configEditor'];
export function apply(ctx, config) {
  if (!['daily', 'worker'].includes(config.kind) || typeof config.output !== 'string') throw new Error('STAGED_SERVICE_CONFIG_INVALID');
  const ready = ctx.get('appReady'), exit = ctx.get('appExit');
  if (!ready || !exit) throw new Error('STAGED_SERVICE_REQUIRES_PROFILE');
  let inference = 0;
  ctx.on('llm/stream', () => (async function* () {
    inference++;
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'STAGED_INFERENCE_DISABLED', message: 'No model request is permitted in this service check.' } } };
  })());
  ctx.effect(() => {
    let active = true, task = Promise.resolve();
    const cancelReady = ready.onReady(() => {
      task = (async () => {
        const rows = await ctx.pluginManager.listPlugins();
        const unavailable = rows.filter(row => ['pending', 'failed'].includes(row.fiberPhase));
        assert.deepEqual(unavailable, []);
        const require = createRequire(join(process.env.DSH_HOME, 'profiles', config.kind === 'daily' ? 'ai-reference-store-daily' : 'headless', 'package.json'));
        const bridge = await import(require.resolve('@kkiyama117/dsh-slack-intake/bridge'));
        assert.equal(typeof bridge.apply, 'function');
        let checked;
        if (config.kind === 'daily') {
          const daily = await import(require.resolve('@kkiyama117/dsh-slack-intake/daily'));
          const entry = ctx.configEditor.entries().find(entry => entry.options.id === 'aistore-daily');
          assert(entry);
          checked = await daily.executeDaily({ credentials: ctx.get('credentials'), agentPresets: ctx.agentPresets,
            agents: ctx.agents, tools: ctx.tools, cmdlineArgs: { get: () => ['daily', 'check'] } },
          daily.resolveDailyConfig(entry.options.config), new AbortController().signal);
          assert.equal(checked, 0);
        } else {
          const preset = await ctx.agentPresets.resolve('slack-intake-verification');
          assert.equal(preset.broken, undefined);
          checked = 'worker module and configured preset ready; socket not started';
        }
        assert.equal(inference, 0);
        await writeFile(config.output, JSON.stringify({ status: 'passed', kind: config.kind, checked, realProviderCalls: inference,
          unavailable, plugins: rows.map(({ entryId, moduleName, enabled, fiberPhase }) => ({ entryId, moduleName, enabled, fiberPhase })) }, null, 2) + '\n', { mode: 0o600 });
        if (active) exit(0);
      })().catch(async error => {
        await writeFile(config.output, JSON.stringify({ status: 'failed', kind: config.kind, message: error.message, inference }, null, 2) + '\n', { mode: 0o600 });
        if (active) exit(1);
      });
    });
    return async () => { active = false; cancelReady(); await task; };
  });
}
