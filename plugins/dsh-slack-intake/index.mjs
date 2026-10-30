/** Standalone aistore application: starts after appReady and exits through appExit. */
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { execute, resolveConfig } from './intake.mjs';

/** Stable plugin name. */
export const name = 'aistore-adapter';
/** The standalone authentication/CLI side has no Agent dependency. */
export const inject = ['credentials', 'cmdlineArgs'];

/** Mount one owned invocation; disposal cancels and awaits its subprocess. */
export function apply(ctx, config) {
  const spec = resolveConfig(config);
  const exit = ctx.get('appExit');
  const ready = ctx.get('appReady');
  if (!exit || !ready) throw new Error('aistore-adapter: launch through a dsh profile with appExit and appReady');
  const credentials = ctx.credentials;
  const args = ctx.cmdlineArgs.get();
  const refs = {
    openrouter: credentialRef('OPENROUTER_API_KEY'),
    slack: credentialRef('SLACK_BOT_TOKEN'),
  };
  ctx.effect(() => {
    const controller = new AbortController();
    let active = true;
    let task = Promise.resolve();
    const cancelReady = ready.onReady(() => {
      task = execute({ credentials, refs, args, config: spec, signal: controller.signal,
        io: { stdout: process.stdout, stderr: process.stderr },
      }).then(code => { if (active) exit(code); });
    });
    return async () => {
      active = false;
      cancelReady();
      controller.abort();
      await task;
    };
  }, 'aistore adapter invocation');
}
