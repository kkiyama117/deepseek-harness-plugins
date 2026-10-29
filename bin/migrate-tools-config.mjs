/** One-shot supported ConfigEditor migration, run through the old DSH profile before replacing its runtime. */
export const name = 'upgrade-tools-config-migration';
export const inject = ['configEditor'];
export function apply(ctx, config) {
  if (typeof config?.expectedPatch !== 'string' || ctx.configEditor.documentPath !== config.expectedPatch) {
    throw new Error('UPGRADE_PROFILE_MISMATCH');
  }
  const ready = ctx.get('appReady');
  const exit = ctx.get('appExit');
  if (!ready || !exit) throw new Error('UPGRADE_REQUIRES_PROFILE_LAUNCH');
  ctx.effect(() => {
    let active = true;
    let task = Promise.resolve();
    const cancelReady = ready.onReady(() => {
      task = (async () => {
        const entries = ctx.configEditor.entries().filter(entry => entry.options.id === 'tools');
        if (entries.length !== 1) throw new Error('UPGRADE_TOOLS_ENTRY_AMBIGUOUS');
        const entry = entries[0];
        const original = entry.options.config ?? {};
        if (original.mode !== undefined && original.mode !== 'native') throw new Error('UPGRADE_NON_NATIVE_MODE_REQUIRES_REVIEW');
        if (original.maxParallelSubCalls !== undefined) throw new Error('UPGRADE_PTC_LIMIT_REQUIRES_REVIEW');
        const changed = Object.hasOwn(original, 'mode');
        if (changed) await ctx.configEditor.edit(entry, current => {
          if (current.mode !== 'native' || current.maxParallelSubCalls !== undefined) throw new Error('UPGRADE_CONFIG_CHANGED');
          const next = { ...current }; delete next.mode; return next;
        });
        console.log(JSON.stringify({ migration: 'tools.mode', changed, modelCalls: 0 }));
        if (active) exit(0);
      })().catch(error => {
        console.error(JSON.stringify({ migration: 'tools.mode', failed: true, error: error.message }));
        if (active) exit(1);
      });
    });
    return async () => { active = false; cancelReady(); await task; };
  });
}
