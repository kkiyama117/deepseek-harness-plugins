/** Own an isolated Web process, browser verification, bounded readiness, and complete teardown. */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { openSettings } from './browser-settings-navigation.mjs';
const [targetArg, homeArg, pluginsArg, reportArg] = process.argv.slice(2);
if (!reportArg) throw new Error('Usage: node run-staged-web-check.mjs TARGET HOME PLUGINS REPORT_DIR');
const target = resolve(targetArg), home = resolve(homeArg), plugins = resolve(pluginsArg), report = resolve(reportArg);
const attempt = randomUUID();
const probePath = join(report, `stage-probe-${attempt}.json`);
const overlay = join(home, `probe-${attempt}.patch.yml`);
await writeFile(overlay, `- insert:\n    - id: staged-profile-probe\n      name: ${join(plugins, 'bin/staged-profile-probe.mjs')}\n`, { flag: 'wx', mode: 0o600 });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^DSH_|KEY|TOKEN|SECRET|PASSWORD|^INVOCATION_ID$|^NOTIFY_SOCKET$|^JOURNAL_STREAM$/i.test(key)));
Object.assign(env, { DSH_HOME: home, DSH_UPGRADE_TARGET: target, DSH_UPGRADE_PROBE_OUTPUT: probePath });
const child = spawn(process.execPath, [join(target, 'apps/cli/lib/bin.js'), '--profile', 'web', '--patch', overlay, '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: target, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let log = '', exited = false, exitStatus, browser, page;
const pageErrors = [], consoleErrors = [];
const ready = Promise.withResolvers();
const done = new Promise(resolve => child.once('exit', (code, signal) => { exited = true; exitStatus = { code, signal }; ready.reject(new Error(`Staged Host exited before readiness: ${code}/${signal}`)); resolve(exitStatus); }));
const receive = data => {
  log += data.toString();
  for (const line of log.split('\n').slice(0, -1)) {
    const match = line.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\u001b]+/);
    if (match) { ready.resolve(match[0]); break; }
  }
};
child.stdout.on('data', receive); child.stderr.on('data', receive);
child.once('error', error => ready.reject(error));
const readinessTimeout = setTimeout(() => ready.reject(new Error('Staged Host readiness timeout')), 60000);
const result = { attempt, probePath, status: 'failed' };
try {
  const url = await ready.promise;
  clearTimeout(readinessTimeout);
  const { chromium } = createRequire(join(target, 'apps/web/package.json'))('playwright');
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  assert.equal(response.status(), 200);
  await page.addLocatorHandler(page.getByText('Preview Notice', { exact: true }), async () => { await page.getByRole('button', { name: 'Continue', exact: true }).click(); });
  await openSettings(page);
  const probe = JSON.parse(await readFile(probePath, 'utf8'));
  Object.assign(result, { origin: new URL(url).origin, pageErrors, consoleErrors, probe });
  assert.equal(probe.status, 'passed', probe.message);
  assert.deepEqual(pageErrors, []);
  assert(!/incompatible with dsh|failed to import|entries did not activate/.test(log), 'Staged startup reported missing plugins');
  result.status = 'passed';
} catch (error) {
  result.message = String(error.message).replace(/([?&]token=)[^\s"'&]+/g, '$1[REDACTED]');
  Object.assign(result, { pageErrors, consoleErrors });
  if (page && !page.isClosed()) {
    result.visibleText = (await page.locator('body').innerText()).slice(0, 12000);
    await page.screenshot({ path: join(report, `stage-web-${attempt}.png`), fullPage: true });
  }
  process.exitCode = 1;
} finally {
  clearTimeout(readinessTimeout);
  await browser?.close();
  if (!exited) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    const killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') console.error(error.code); } }, 15000);
    await done; clearTimeout(killTimer);
  }
  result.exitStatus = exitStatus;
  const safeLog = log.replace(/([?&]token=)[^\s"'&]+/g, '$1[REDACTED]');
  await writeFile(join(report, `stage-web-${attempt}.log`), safeLog, { mode: 0o600 });
  await writeFile(join(report, `stage-web-${attempt}.json`), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ attempt, status: result.status, message: result.message, report: join(report, `stage-web-${attempt}.json`) }));
}
