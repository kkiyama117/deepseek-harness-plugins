/** Local acceptance policy plus a one-time, exactly scoped synthetic GUI command. */
import * as acceptance from '@kkiyama117/dsh-goal-acceptance';
import { applyProbe } from './probe.js';
export const name = 'request-acceptance-pilot';
export const Config = acceptance.Config;
export const inject = [...acceptance.inject, 'sessions', 'commands', 'llm', 'subagents', 'connection', 'sessionTitle'];
export async function apply(ctx, config) {
  await acceptance.apply(ctx, config);
  applyProbe(ctx);
}
