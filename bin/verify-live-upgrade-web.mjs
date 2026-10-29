/** Verify the existing deployed GUI without starting a replacement server or a model turn. */
import { execFileSync } from 'node:child_process';
import { readFile, readlink, writeFile } from 'node:fs/promises';
import { checkExistingSession, classifyResourceFailures, blockingBrowserErrors } from './check-upgrade-session.mjs';
import { chromium } from '/data/softwares/deepseek-harness-upgrade-master/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const out = process.env.DSH_VERIFY_OUTPUT ?? '/home/kiyama/.dsh/backups/master-upgrade-20261005/cutover';
const dataHome = process.env.DSH_VERIFY_DATA_HOME ?? '/home/kiyama/.dsh';
const origins = JSON.parse(process.env.DSH_VERIFY_ORIGINS ?? '["http://127.0.0.1:3080","https://boiled.colobus-powan.ts.net"]');
const pid = process.env.DSH_VERIFY_PID ?? execFileSync('systemctl', ['--user', 'show', 'dsh-web-managed.service', '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim();
const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
const expectedRoot = '/data/softwares/deepseek-harness-upgrade-master';
if (argv[1] !== `${expectedRoot}/apps/cli/lib/bin.js` || await readlink(`/proc/${pid}/cwd`) !== expectedRoot) throw new Error('Unexpected running DSH checkout');
const version = execFileSync(argv[0], [argv[1], '--version'], { encoding: 'utf8' }).trim();
if (version !== '0.2.1-alpha.1') throw new Error(`Unexpected running CLI version: ${version}`);
const journal = process.env.DSH_VERIFY_AUTH_URL ?? execFileSync('journalctl', ['--user', '-u', 'dsh-web-managed.service', `_PID=${pid}`, '--no-pager'], { encoding: 'utf8' });
const match = journal.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=([^\s\u001b]+)/);
if (!match) throw new Error('Current service did not publish its authentication URL');
const browser = await chromium.launch({ headless: true });
const results = [];
let activePage;
try {
  for (const origin of origins) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    activePage = page;
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
    await page.goto(`${origin}/?token=${match[1]}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ timeout: 30000 });
    await page.getByText('Cordis + Kura', { exact: true }).first().waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByText('General', { exact: true }).first().waitFor({ timeout: 15000 });
    const session = await checkExistingSession(page);
    const key = origin.startsWith('https') ? 'https' : 'local';
    await page.screenshot({ path: `${out}/web-${key}.png`, fullPage: true });
    const resources = await classifyResourceFailures(failedResponses, dataHome, origin);
    results.push({ origin, title: await page.title(), settingsOpened: true, session, errors: blockingBrowserErrors(errors, resources), failedResponses: resources.blocking, knownResourceFailures: resources.known, rawConsoleErrors: errors });
    await page.close();
  }
  await writeFile(`${out}/web-verification.json`, JSON.stringify({ pid, version, runningCli: argv[1], results }, null, 2) + '\n', { mode: 0o600 });
  if (results.some(result => result.errors.length || result.failedResponses.length)) throw new Error('GUI runtime errors; inspect private verification JSON');
  console.log(JSON.stringify({ pid, origins: results.map(x => x.origin), settingsOpened: true, persistedSessionAndImage: true, blockingErrors: 0, knownMissingResources: results.reduce((sum, result) => sum + result.knownResourceFailures.length, 0) }));
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: `${out}/web-failure.png`, fullPage: true });
    await writeFile(`${out}/web-failure.txt`, await activePage.locator('body').innerText(), { mode: 0o600 });
  }
  throw error;
} finally {
  await browser.close();
}
