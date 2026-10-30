/** One-off private-file import through the supported credential service. Never prints values. */
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
export const name = 'slack-intake-credential-import';
export const inject = ['credentials'];
export async function privateValue(path, prefix) {
  if (!isAbsolute(path ?? '')) throw new Error('INVALID_PRIVATE_PATH');
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.mode & 0o077 || parent.uid !== process.getuid()) throw new Error('PRIVATE_DIRECTORY_REQUIRED');
  const info = await lstat(path);
  if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid() || info.size > 8192) throw new Error('PRIVATE_FILE_REQUIRED');
  const file = await open(path, 'r');
  try {
    const actual = await file.stat();
    if (actual.dev !== info.dev || actual.ino !== info.ino) throw new Error('PRIVATE_FILE_CHANGED');
    const value = (await file.readFile('utf8')).trim();
    if (!value.startsWith(prefix) || /[\s\x00-\x1f]/.test(value)) throw new Error('INVALID_TOKEN_FORMAT');
    return value;
  } finally { await file.close(); }
}
export function apply(ctx, config) {
  const ready = ctx.get('appReady'); const exit = ctx.get('appExit');
  if (!ready || !exit) throw new Error('standalone lifecycle required');
  ctx.effect(() => {
    let task = Promise.resolve(); let disposed = false;
    const off = ready.onReady(() => {
      task = (async () => {
        const inputs = [['SLACK_INTAKE_APP_TOKEN', config.appTokenFile, 'xapp-'], ['SLACK_BOT_TOKEN', config.botTokenFile, 'xoxb-']].filter(([, path]) => path);
        if (!inputs.length) throw new Error('PRIVATE_FILE_REQUIRED');
        const validated = [];
        for (const [name, path, prefix] of inputs) validated.push([name, await privateValue(path, prefix)]);
        for (const [name, value] of validated) {
          if (disposed) return;
          await ctx.credentials.set(credentialRef(name), value);
          if (disposed) return;
          const saved = await ctx.credentials.resolve(credentialRef(name));
          if (disposed) return;
          if (saved?.value !== value) throw new Error('CREDENTIAL_VERIFY_FAILED');
          process.stdout.write(JSON.stringify({ credential: name, configured: true, stored_verified: true }) + '\n');
        }
        if (!disposed) exit(0);
      })().catch(error => {
        const safe = new Set(['INVALID_PRIVATE_PATH', 'PRIVATE_DIRECTORY_REQUIRED', 'PRIVATE_FILE_REQUIRED', 'PRIVATE_FILE_CHANGED', 'INVALID_TOKEN_FORMAT', 'CREDENTIAL_VERIFY_FAILED']);
        const code = safe.has(error.message) ? error.message : error.code === 'ENOENT' ? 'PRIVATE_FILE_MISSING' : 'CREDENTIAL_WRITE_FAILED';
        if (!disposed) { process.stderr.write(`slack-credential-import: ${code}\n`); exit(1); }
      });
    });
    return async () => { disposed = true; off(); await task; };
  });
}
