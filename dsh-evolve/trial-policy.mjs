/** Standing execution denial for the explicitly mounted evaluation preset. */
export const name = 'evolve-trial-policy';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.guard(() => 'DSH Evolve trials cannot execute tools.');
}
