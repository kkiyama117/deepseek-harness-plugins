/** One recorded development-channel post and readback. Never prints raw messages or credentials. */
import { randomUUID } from 'node:crypto';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { SlackClient } from './slack-client.mjs';
import { atomicJSON, readJSON } from './automation-client.mjs';
export const name = 'slack-intake-posting-check';
export const inject = ['credentials'];
const TEXT = 'Slack Intake 接続確認：reference reader からの投稿・読み返しテストです。日報や検証の自動実行はまだ開始していません。';
export function apply(ctx, config) {
  const ready = ctx.get('appReady'); const exit = ctx.get('appExit');
  if (!ready || !exit) throw new Error('standalone lifecycle required');
  ctx.effect(() => {
    const controller = new AbortController(); let task = Promise.resolve();
    const off = ready.onReady(() => {
      task = (async () => {
        const client = new SlackClient({ resolveToken: async () => (await ctx.credentials.resolve(credentialRef('SLACK_BOT_TOKEN')))?.value });
        const auth = await client.call('auth.test', {}, 'bot', { signal: controller.signal });
        const info = await client.call('conversations.info', { channel: config.channelId }, 'bot', { signal: controller.signal });
        if (auth.team_id !== config.teamId || auth.user_id !== config.botUserId || info.channel?.id !== config.channelId || info.channel.name !== 'hermes_home' || !info.channel.is_member) throw new Error('TARGET_MISMATCH');
        let record = await readJSON(config.reportPath, null);
        if (record && record.status !== 'sent') throw new Error('POST_OUTCOME_UNKNOWN_NO_REPLAY');
        if (!record) {
          record = { status: 'sending', client_msg_id: randomUUID(), channel_id: config.channelId, bot_user_id: config.botUserId };
          await atomicJSON(config.reportPath, record);
          try {
            const posted = await client.call('chat.postMessage', { channel: config.channelId, text: TEXT, client_msg_id: record.client_msg_id, unfurl_links: false, unfurl_media: false }, 'bot', { signal: controller.signal });
            if (!posted.ts) throw new Error('POST_OUTCOME_UNKNOWN');
            record = { ...record, status: 'sent', ts: posted.ts, bot_id: posted.message?.bot_id ?? auth.bot_id, app_id: posted.message?.bot_profile?.app_id ?? posted.message?.app_id ?? null };
            await atomicJSON(config.reportPath, record);
          } catch (error) { record.status = error.outcome === 'definite' || error.outcome === 'not_sent' ? 'failed' : 'unknown'; record.error = error.code ?? 'POST_FAILED'; await atomicJSON(config.reportPath, record); throw error; }
        }
        const history = await client.call('conversations.history', { channel: config.channelId, oldest: record.ts, latest: record.ts, inclusive: true, limit: 1 }, 'bot', { signal: controller.signal });
        const own = history.messages?.find(message => message.ts === record.ts);
        if (!own || own.text !== TEXT || own.user !== config.botUserId) throw new Error('READBACK_MISMATCH');
        record.readback_verified = true;
        record.app_id ??= own.bot_profile?.app_id ?? own.app_id ?? null;
        await atomicJSON(config.reportPath, record);
        process.stdout.write(JSON.stringify(record) + '\n'); exit(0);
      })().catch(error => { process.stderr.write(`slack-posting-check: ${error.code ?? (['TARGET_MISMATCH','READBACK_MISMATCH','POST_OUTCOME_UNKNOWN_NO_REPLAY'].includes(error.message) ? error.message : 'CHECK_FAILED')}\n`); exit(1); });
    });
    return async () => { controller.abort(); off(); await task; };
  });
}
