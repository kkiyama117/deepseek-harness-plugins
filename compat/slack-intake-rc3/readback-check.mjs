/** Readback only: compare our delivered result texts without exposing any other Slack messages. */
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { SlackClient } from './slack-client.mjs';
import { buildJobResult } from './slack-cards.mjs';
import { callManagement, readJSON, atomicJSON } from './automation-client.mjs';
export const name = 'slack-intake-readback-check';
export const inject = ['credentials'];
export function apply(ctx, config) {
  const ready = ctx.get('appReady'); const exit = ctx.get('appExit');
  ctx.effect(() => {
    const controller = new AbortController(); let task = Promise.resolve();
    const off = ready.onReady(() => { task = (async () => {
      const client = new SlackClient({ resolveToken: async () => (await ctx.credentials.resolve(credentialRef('SLACK_BOT_TOKEN')))?.value });
      const auth = await client.call('auth.test', {}, 'bot', { signal: controller.signal });
      if (auth.team_id !== 'T0BBABWEYBF' || auth.user_id !== 'U0C1C58TT32') throw new Error('TARGET_MISMATCH');
      const ledger = await readJSON('/home/kiyama/.local/state/slack-intake-bridge/delivery.json', null);
      const jobs = (await callManagement(config, { action: 'list' }, { signal: controller.signal })).filter(job => config.jobIds.includes(job.job_id));
      const thread = Object.values(ledger.cards)[0].thread_ts;
      const response = await client.call('conversations.replies', { channel: 'C0BBHF3REDS', ts: thread, limit: 100 }, 'bot', { signal: controller.signal });
      const own = response.messages.filter(message => message.user === 'U0C1C58TT32');
      const checks = jobs.map(job => {
        const delivered = ledger.deliveries['result:' + job.job_id];
        const message = own.find(message => message.ts === delivered?.ts);
        const expected = buildJobResult(job);
        const visible = blocks => blocks?.filter(block => block.text).map(block => ({ type: block.type, text: block.text.text }));
        return { job_id: job.job_id, ts: delivered?.ts, exists: !!message, blocks_match: JSON.stringify(visible(message?.blocks)) === JSON.stringify(visible(expected.blocks)), sender_matches: !!message, notified: job.notified };
      });
      if (checks.length !== config.jobIds.length || !checks.every(check => check.exists && check.blocks_match && check.notified)) throw new Error('READBACK_MISMATCH');
      const report = { all_result_readbacks_verified: true, channel: 'C0BBHF3REDS', checks };
      await atomicJSON(config.reportPath, report); process.stdout.write(JSON.stringify(report) + '\n'); exit(0);
    })().catch(error => { process.stderr.write(`slack-readback-check: ${error.code ?? 'CHECK_FAILED'}\n`); exit(1); }); });
    return async () => { controller.abort(); off(); await task; };
  });
}
