/** Disposable official-runtime mount check; no prompt, no Slack request, no model call. */
import { randomUUID } from 'node:crypto';
import { executeVerification } from './verification-runtime.mjs';
import { atomicJSON } from './automation-client.mjs';
export const name = 'slack-verification-mount-check';
export const inject = ['agents', 'agentPresets', 'tools', 'systemPrompt', 'sessions'];
export function apply(ctx, config) {
  const ready = ctx.get('appReady'); const exit = ctx.get('appExit');
  if (!ready || !exit) throw new Error('standalone lifecycle required');
  ctx.effect(() => {
    const controller = new AbortController(); let task = Promise.resolve();
    const off = ready.onReady(() => {
      task = (async () => {
        const id = randomUUID();
        const result = await executeVerification(ctx, config, { job_id: 'mount-check-' + id, session_id: id, target: config.targetRoot, workflow: 'development-verification' }, controller.signal, { mountOnly: true });
        await atomicJSON(config.reportPath, result);
        process.stdout.write(JSON.stringify(result) + '\n'); exit(0);
      })().catch(async error => {
        const result = { status: 'failed', code: error.code ?? 'MOUNT_CHECK_FAILED', diagnostic: String(error.message).slice(0, 1000), model_called: false };
        await atomicJSON(config.reportPath, result); process.stderr.write(JSON.stringify(result) + '\n'); exit(1);
      });
    });
    return async () => { controller.abort(); off(); await task; };
  });
}
