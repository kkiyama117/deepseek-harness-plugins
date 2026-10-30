/** Validate a private xapp file against Socket hello, then save only the matching App credential. */
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { SlackClient } from './slack-client.mjs';
import { privateValue } from './credential-import.mjs';
import { atomicJSON } from './automation-client.mjs';
export const name = 'slack-intake-socket-token-check';
export const inject = ['credentials'];
async function appHello(url, signal) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'wss:' || !/^wss(?:-[a-z0-9-]+)?\.slack\.com$/.test(parsed.hostname) || parsed.username || parsed.password || parsed.port) throw new Error('INVALID_SOCKET_URL');
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const finish = (error, appId) => { clearTimeout(timer); signal.removeEventListener('abort', abort); socket.close(); if (error) reject(error); else resolve(appId); };
    const abort = () => finish(new Error('SOCKET_INTERRUPTED'));
    const timer = setTimeout(() => finish(new Error('SOCKET_HELLO_TIMEOUT')), 15000);
    signal.addEventListener('abort', abort, { once: true });
    socket.addEventListener('error', () => finish(new Error('SOCKET_CONNECTION_FAILED')), { once: true });
    socket.addEventListener('message', event => {
      try { const value = JSON.parse(String(event.data)); if (value.type === 'hello') finish(null, value.connection_info?.app_id); }
      catch { /* Ignore unsolicited non-hello payloads; never return their contents. */ }
    });
    if (signal.aborted) abort();
  });
}
export function apply(ctx, config) {
  const ready = ctx.get('appReady'); const exit = ctx.get('appExit');
  if (!ready || !exit) throw new Error('standalone lifecycle required');
  ctx.effect(() => {
    const controller = new AbortController(); let task = Promise.resolve();
    const off = ready.onReady(() => {
      task = (async () => {
        const ref = credentialRef('SLACK_INTAKE_APP_TOKEN');
        const stored = await ctx.credentials.resolve(ref);
        const token = stored?.value ?? await privateValue(config.appTokenFile, 'xapp-');
        const client = new SlackClient({ resolveToken: async () => token });
        const response = await client.call('apps.connections.open', {}, 'app', { signal: controller.signal });
        const appId = await appHello(response.url, controller.signal);
        if (appId !== config.expectedAppId) {
          await atomicJSON(config.reportPath, { ok: false, code: 'APP_MISMATCH', app_id: /^A[A-Z0-9]+$/.test(appId ?? '') ? appId : null, expected_app_id: config.expectedAppId });
          throw new Error('APP_MISMATCH');
        }
        if (!stored) await ctx.credentials.set(ref, token);
        if ((await ctx.credentials.resolve(ref))?.value !== token) throw new Error('CREDENTIAL_VERIFY_FAILED');
        const result = { ok: true, app_id: appId, socket_mode_confirmed: true, credential_configured: true, bot_credential_unchanged: true };
        await atomicJSON(config.reportPath, result);
        process.stdout.write(JSON.stringify(result) + '\n'); exit(0);
      })().catch(error => { process.stderr.write(`slack-socket-check: ${error.code ?? (['APP_MISMATCH','CREDENTIAL_VERIFY_FAILED','SOCKET_HELLO_TIMEOUT','SOCKET_CONNECTION_FAILED','INVALID_TOKEN_FORMAT'].includes(error.message) ? error.message : 'CHECK_FAILED')}\n`); exit(1); });
    });
    return async () => { controller.abort(); off(); await task; };
  });
}
