/** Value-free credential and workspace probe. No Slack message bodies are returned. */
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SlackClient } from './slack-client.mjs';
export const name = 'slack-intake-probe';
export const inject = ['credentials'];
export function apply(ctx, config) {
  const ready = ctx.get('appReady');
  const exit = ctx.get('appExit');
  if (!ready || !exit) throw new Error('probe requires standalone lifecycle');
  ctx.effect(() => {
    const controller = new AbortController();
    let operation = Promise.resolve();
    const off = ready.onReady(() => {
      operation = (async () => {
        const report = { credentials: {}, auth: null, channel: null };
        for (const name of ['SLACK_BOT_TOKEN', 'SLACK_INTAKE_APP_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_USER_TOKEN', 'SLACK_APP_CONFIG_TOKEN', 'SLACK_APP_CONFIGURATION_TOKEN']) {
          const info = await ctx.credentials.describe(credentialRef(name));
          report.credentials[name] = { configured: info.configured, source: info.source ?? null };
        }
        const secret = await ctx.credentials.resolve(credentialRef('SLACK_BOT_TOKEN'));
        if (secret) {
          for (const [method, input] of [['auth.test', {}], ['conversations.info', { channel: config.channelId }]]) {
            try {
              const client = new SlackClient({ resolveToken: async () => (await ctx.credentials.resolve(credentialRef('SLACK_BOT_TOKEN')))?.value });
              const response = await client.inspect(method, input, 'bot', { signal: controller.signal });
              const value = response.body;
              const data = { ok: true, error: null, scopes: response.scopes.join(',') };
              if (method === 'auth.test' && value.ok) Object.assign(data, { team_id: value.team_id, team_name: value.team ?? null, user_id: value.user_id, bot_user_name: value.user ?? null, bot_id: value.bot_id, app_id: value.app_id ?? null, enterprise_id: value.enterprise_id ?? null, workspace_url: value.url });
              if (method === 'conversations.info' && value.ok) Object.assign(data, { id: value.channel?.id, name: value.channel?.name, is_member: value.channel?.is_member, is_private: value.channel?.is_private });
              report[method === 'auth.test' ? 'auth' : 'channel'] = data;
            } catch (error) { report[method === 'auth.test' ? 'auth' : 'channel'] = { ok: false, error: error.code ?? 'probe_network_failed' }; }
          }
        }
        await mkdir(dirname(config.reportPath), { recursive: true, mode: 0o700 });
        await writeFile(config.reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
        process.stdout.write(JSON.stringify(report) + '\n');
        exit(0);
      })().catch(() => { process.stderr.write('slack-probe: failed\n'); exit(1); });
    });
    return async () => { controller.abort(); off(); await operation; };
  });
}
