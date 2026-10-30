/** Disposable fixture support, never a production Goal policy or shared preset change. */
import { createScope } from '/data/softwares/deepseek-harness/packages/core/scope/lib/index.js';
export const name = 'acceptance-pilot-isolation';
export const inject = ['agents', 'goals', 'systemPrompt'];
const ids = new Set(['session-2b468884-e9fe-46c5-8816-c8620c9e73c3', 'session-2be5c73f-cea2-4fb9-aa9f-77bf31e78681']);
export function apply(ctx) {
  const disarm = agent => { if (ids.has(agent.id)) ctx.goals.disarm(agent); };
  ctx.on('goal/changed', ({ agent }) => disarm(agent));
  const mount = agent => {
    if (!ids.has(agent.id)) return;
    disarm(agent);
    ctx.effect(() => {
      const scope = createScope(ctx, agent);
      scope.ctx.systemPrompt.section({
        name: 'deployment:persona-prefix', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: 'You are executing a clearly labeled synthetic acceptance fixture. No real article results or paid model calls are claimed.',
        complete: false,
      });
      return agent.ctx.effect(() => () => scope.dispose());
    });
  };
  ctx.on('agent/created', ({ agent }) => mount(agent));
  for (const agent of ctx.agents.list()) mount(agent);
}
