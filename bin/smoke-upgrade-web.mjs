/** Bounded browser smoke of an isolated upgrade profile, through the official CLI. */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { checkExistingSession, classifyResourceFailures, blockingBrowserErrors } from './check-upgrade-session.mjs';
import { chromium } from '/data/softwares/deepseek-harness-upgrade-master/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const root = process.env.DSH_SMOKE_ROOT ?? '/data/softwares/deepseek-harness-upgrade-master';
const home = process.env.DSH_SMOKE_HOME ?? '/home/kiyama/.dsh-upgrade-stage-20261005';
const presetLabel = process.env.DSH_SMOKE_PRESET_LABEL ?? 'Cordis + Kura';
const child = spawn(process.execPath, [`${root}/apps/cli/lib/bin.js`, 'web', '--port', '0', '--no-open'], {
  cwd: root, env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
let exited = false;
const exit = new Promise(resolve => child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }));
let browser;
let page;
let timer;
try {
  const url = await new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Web startup did not report its URL within 60 seconds')), 60000);
    const onData = data => {
      output += data.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\u001b]+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Web exited before ready: ${code}`)));
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addLocatorHandler(page.getByText('Preview Notice', { exact: true }), async () => {
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
  });
  const errors = [];
  const failedResponses = [];
  page.on('response', response => {
    if (response.status() >= 400) {
      const url = new URL(response.url());
      url.searchParams.delete('token');
      failedResponses.push({ url: url.href, status: response.status() });
    }
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // The application keeps stream requests open, so network-idle is not its readiness signal.
  await page.waitForFunction(() => document.querySelector('button') !== null, null, { timeout: 30000 });
  // The preset selector proves the initial Host roster has reached the page.
  await page.getByText(presetLabel, { exact: true }).first().waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByText('General', { exact: true }).first().waitFor({ timeout: 15000 });
  const session = await checkExistingSession(page);
  const text = await page.locator('body').innerText();
  await page.screenshot({ path: `${home}/browser-smoke.png`, fullPage: true });
  await writeFile(`${home}/browser-smoke.txt`, text, { mode: 0o600 });
  const resources = await classifyResourceFailures(failedResponses, home, new URL(url).origin);
  const blockingErrors = blockingBrowserErrors(errors, resources);
  const summary = { url: new URL(url).origin, title: await page.title(), session, bodyChars: text.length, buttons: await page.locator('button').count(), errors: blockingErrors, failedResponses: resources.blocking, knownResourceFailures: resources.known, rawConsoleErrors: errors };
  await writeFile(`${home}/browser-smoke.json`, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(summary));
  if (blockingErrors.length || resources.blocking.length) throw new Error('Browser reported runtime errors; inspect private browser-smoke files');
} catch (error) {
  if (page) {
    await page.screenshot({ path: `${home}/browser-failure.png`, fullPage: true });
    await writeFile(`${home}/browser-failure.txt`, await page.locator('body').innerText(), { mode: 0o600 });
  }
  throw error;
} finally {
  clearTimeout(timer);
  await browser?.close();
  if (!exited) child.kill('SIGTERM');
  const kill = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 10000);
  await exit;
  clearTimeout(kill);
  await writeFile(`${home}/browser-server.log`, output, { mode: 0o600 });
}
