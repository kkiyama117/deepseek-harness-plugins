/** Observe the remote policy/channel lifecycle without pairing or changing settings. */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { chromium } from '/data/softwares/deepseek-harness-upgrade-master/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const pid = execFileSync('systemctl', ['--user', 'show', 'dsh-web-managed.service', '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim();
const log = execFileSync('journalctl', ['--user', '-u', 'dsh-web-managed.service', `_PID=${pid}`, '--no-pager'], { encoding: 'utf8' });
const token = log.match(/http:\/\/127\.0\.0\.1:3080\/\?token=([^\s\u001b]+)/)[1];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const policies = [];
  const failures = [];
  const reads = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname === '/api/pair/status') reads.push(response.json().then(value => policies.push({ status: response.status(), policy: value.requirePairingForLan })));
    if (response.status() >= 400) failures.push({ path: url.pathname, status: response.status() });
  });
  await page.goto(`https://boiled.colobus-powan.ts.net/?token=${token}`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Device pairing required', { exact: true }).waitFor({ timeout: 30000 });
  await Promise.all(reads);
  const state = await page.evaluate(() => ({
    bootSeatPresent: !!window.__DSH_REMOTE_CHANNEL_BOOT__,
    pendingUnpaired: window.__DSH_REMOTE_CHANNEL_BOOT__?.pendingUnpaired,
    ownsHost: window.__DSH_TRANSPORT__?.ownsHost,
    fenceVisible: !!document.querySelector('#remote-fence-title'),
  }));
  const result = { policies, failures, state };
  await writeFile('/home/kiyama/.dsh/backups/master-upgrade-20261005/retry/remote-policy-diagnostic.json', JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
