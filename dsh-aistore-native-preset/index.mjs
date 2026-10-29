/** Keep global tools out of structured-only aistore children. */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
export const name = 'aistore-native-restriction';
export const inject = ['tools'];
export async function apply(ctx) {
  await ctx.plugin(NativeToolExecutor);
  ctx.tools.restrict({ allow: [] });
}
