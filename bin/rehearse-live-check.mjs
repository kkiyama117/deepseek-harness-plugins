/** Run the exact production verifier against an isolated, OS-assigned listener. */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
const root = '/data/softwares/deepseek-harness-upgrade-master';
const home = '/home/kiyama/.dsh-upgrade-retry-20261005';
const child = spawn(process.execPath, [`${root}/apps/cli/lib/bin.js`, 'web', '--port', '0', '--no-open'], {
  cwd: root, env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
let exited = false;
let timer;
const exitedPromise = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
try {
  const authUrl = await new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Listener startup deadline exceeded')), 60000);
    const data = chunk => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\u001b]+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    };
    child.stdout.on('data', data); child.stderr.on('data', data);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Listener exited before readiness: ${code}`)));
  });
  const result = await promisify(execFile)(process.execPath, ['/data/softwares/deepseek-harness-plugins/bin/verify-live-upgrade-web.mjs'], {
    env: { ...process.env, DSH_VERIFY_PID: String(child.pid), DSH_VERIFY_AUTH_URL: authUrl,
      DSH_VERIFY_ORIGINS: JSON.stringify([new URL(authUrl).origin]), DSH_VERIFY_OUTPUT: home,
      DSH_VERIFY_DATA_HOME: home, DSH_ACCEPTANCE_FIXTURE: `${home}/session-acceptance.json` },
    timeout: 180000, maxBuffer: 1024 * 1024,
  });
  console.log(result.stdout.trim());
} finally {
  clearTimeout(timer);
  if (!exited) child.kill('SIGTERM');
  const killer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 10000);
  await exitedPromise; clearTimeout(killer);
  await writeFile(`${home}/server.log`, output, { mode: 0o600 });
}
