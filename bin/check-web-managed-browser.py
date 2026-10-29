# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Check the live managed Web UI without restarting it or running a model turn.

Requires the canonical checkout, its Playwright dependency, and installed Chrome.
Writes a private JSON receipt beside the upgrade reports; never prints the token.
"""
from pathlib import Path
import subprocess

subprocess.run(['node', '--input-type=module'], input=r'''
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { openSettings } from './browser-settings-navigation.mjs';
const root = '/data/softwares/deepseek-harness';
const report = '../reports/upgrade-20261026-master';
const unit = 'dsh-web-managed.service';
const serviceState = () => execFileSync('systemctl', ['--user', 'show', unit, '-p', 'MainPID', '-p', 'NRestarts'], { encoding: 'utf8' });
execFileSync('systemctl', ['--user', 'is-active', '--quiet', unit]);
const initial = serviceState();
const pid = initial.match(/MainPID=(\d+)/)[1];
const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
assert.equal(argv[1], `${root}/apps/cli/lib/bin.js`);
const journal = execFileSync('journalctl', ['--user', '-u', unit, `_PID=${pid}`, '--no-pager'], { encoding: 'utf8' });
const token = journal.match(/http:\/\/127\.0\.0\.1:3080\/\?token=([^\s\u001b]+)/)?.[1];
assert(token, 'Authentication URL missing');
const { chromium } = createRequire(`${root}/apps/web/package.json`)('playwright');
const expected = JSON.parse(await readFile(`${report}/expected-active-plugins.json`, 'utf8'));
const browser = await chromium.launch({ headless: true, executablePath: '/opt/google/chrome/chrome' });
const result = { checkedAt: new Date().toISOString(), pid: Number(pid), status: 'failed', pages: [] };
let activePage;
try {
  for (const origin of ['http://127.0.0.1:3080', 'https://boiled.colobus-powan.ts.net']) {
    const page = await browser.newPage();
    activePage = page;
    const errors = [], sockets = [], failedResponses = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', ws => { if (new URL(ws.url()).pathname === '/api/remote.mux') sockets.push(ws); });
    page.on('response', response => { if (response.status() >= 400) failedResponses.push(response); });
    await page.addLocatorHandler(page.getByText('Preview Notice', { exact: true }), async () => {
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
    });
    const response = await page.goto(`${origin}/?token=${token}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    assert.equal(response.status(), 200);
    await openSettings(page);
    const reply = await page.evaluate(async () => {
      const method = 'pluginManager/listPlugins';
      const response = await fetch('/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: {} } }) });
      return response.json();
    });
    assert.equal(reply.result?.ok, true, 'Plugin inventory unavailable');
    const plugins = reply.result.value;
    assert.deepEqual(plugins.filter(row => ['pending', 'failed'].includes(row.fiberPhase)), [], 'Unavailable plugins');
    for (const id of expected) assert(plugins.some(row => row.entryId === id && row.fiberPhase === 'active'), `Inactive required plugin: ${id}`);
    assert.deepEqual(errors, []);
    assert(sockets.some(ws => !ws.isClosed()), 'No open remote.mux WebSocket');
    const knownRefusals = [];
    for (const failed of failedResponses) {
      const url = new URL(failed.url());
      // The family settings bridge is deliberately loopback-only; preserve that restriction.
      assert(origin === 'https://boiled.colobus-powan.ts.net' && url.origin === origin
        && url.pathname === '/api/dsh-web-ui-settings/describe' && failed.status() === 403,
        `Unexpected HTTP ${failed.status()}: ${url.pathname}`);
      assert.deepEqual(await failed.json(), { error: 'forbidden' });
      knownRefusals.push({ path: url.pathname, status: 403, reason: 'loopback-only settings bridge' });
    }
    result.pages.push({ origin, status: response.status(), settingsRendered: true, pluginCount: plugins.length,
      requiredPlugins: expected.length, pageErrors: errors, remoteMuxConnected: true, knownRefusals });
    await page.close();
  }
  assert.equal(serviceState(), initial, 'Service restarted during browser verification');
  result.status = 'passed';
} catch (error) {
  result.error = String(error.message).split(token).join('[REDACTED]');
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: `${report}/web-managed-check-failure.png` });
    await writeFile(`${report}/web-managed-check-failure.txt`, await activePage.locator('body').innerText(), { mode: 0o600 });
  }
  process.exitCode = 1;
} finally {
  await browser.close();
  const receipt = JSON.stringify(result, null, 2) + '\n';
  await writeFile(`${report}/web-managed-recovery-check.json`, receipt, { mode: 0o600 });
  console.log(receipt);
}
''', text=True, cwd=Path(__file__).resolve().parent, check=True, timeout=120)
