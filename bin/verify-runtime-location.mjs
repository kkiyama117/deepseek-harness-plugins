import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { openSettings } from './browser-settings-navigation.mjs';

execFileSync('/usr/bin/python3', ['-B', fileURLToPath(new URL('./check-runtime-placement.py', import.meta.url)), '--all'], { stdio: 'inherit' });

const root = process.argv[2] ?? '/data/softwares/deepseek-harness';
const origins = process.argv.slice(3);
if (!origins.length) origins.push('http://127.0.0.1:3080', 'https://boiled.colobus-powan.ts.net');
const units = ['dsh-web-managed.service', 'slack-intake-bridge.service'];
const processes = [];
for (const unit of units) {
  execFileSync('systemctl', ['--user', 'is-active', '--quiet', unit]);
  const pid = execFileSync('systemctl', ['--user', 'show', unit, '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim();
  const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
  assert.equal(argv[1], `${root}/apps/cli/lib/bin.js`, unit);
  const cwd = await readlink(`/proc/${pid}/cwd`);
  if (unit === units[0]) assert.equal(cwd, root);
  processes.push({ unit, pid, executable: argv[1], cwd });
}
const worker = JSON.parse(await readFile('/home/kiyama/.local/state/slack-intake-bridge/status.json', 'utf8'));
assert.equal(worker.phase, 'online');
assert.equal(worker.socket.status, 'connected');
assert.equal(worker.last_error, null);
assert(Date.now() - Date.parse(worker.updated_at) < 180_000, 'Worker status is stale');
const journal = execFileSync('journalctl', ['--user', '-u', units[0], `_PID=${processes[0].pid}`, '--no-pager'], { encoding: 'utf8' });
const token = journal.match(/http:\/\/127\.0\.0\.1:3080\/\?token=([^\s\u001b]+)/)?.[1];
assert(token, 'Missing authentication URL');
const { chromium } = createRequire(`${root}/apps/web/package.json`)('playwright');
const browser = await chromium.launch({ headless: true });
const pages = [];
try {
  for (const origin of origins) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addLocatorHandler(page.getByText('Preview Notice', { exact: true }), async () => {
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
    });
    const response = await page.goto(`${origin}/?token=${token}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    assert.equal(response.status(), 200);
    await openSettings(page);
    const pluginReply = await page.evaluate(async () => {
      const method = 'pluginManager/listPlugins';
      const response = await fetch('/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: {} } }) });
      return response.json();
    });
    assert.equal(pluginReply.result?.ok, true, 'Plugin inventory unavailable');
    const plugins = pluginReply.result.value;
    const unavailable = plugins.filter(row => ['pending', 'failed'].includes(row.fiberPhase));
    assert.deepEqual(unavailable, [], 'Profile contains unavailable plugins');
    if (process.env.DSH_EXPECTED_PLUGIN_IDS) {
      const expected = JSON.parse(await readFile(process.env.DSH_EXPECTED_PLUGIN_IDS, 'utf8'));
      for (const id of expected) assert(plugins.some(row => row.entryId === id && row.fiberPhase === 'active'), `Required plugin inactive: ${id}`);
    }
    assert.deepEqual(errors, []);
    pages.push({ origin, status: response.status(), settingsRendered: true, pageErrors: errors, pluginCount: plugins.length, unavailablePlugins: unavailable.length });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify({ processes, worker: { phase: worker.phase, socket: worker.socket.status, updatedAt: worker.updated_at }, pages }, null, 2));
