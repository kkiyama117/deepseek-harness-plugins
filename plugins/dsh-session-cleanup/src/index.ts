/** Release only the disposed Session's pi-ai resources through its public API. */
import { cleanupSessionResources } from '@earendil-works/pi-ai';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-session';
export const name = 'local-session-cleanup';
export const inject = ['sessions'];
export function apply(ctx: Context): void {
  ctx.on('session/disposed', session => { cleanupSessionResources(session.id); });
}
