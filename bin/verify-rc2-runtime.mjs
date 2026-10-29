/** Verify the canonical rc.2 service and existing browser conversations without model calls. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readlink, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { checkExistingSession, classifyResourceFailures, blockingBrowserErrors } from './check-upgrade-session.mjs';

const root = '/data/softwares/deepseek-harness';
const out = '/data/backups/dsh-rc2-20261019-1232/verification';
await mkdir(out, { recursive: true, mode: 0o700 });
const pid = execFileSync('systemctl', ['--user', 'show', 'dsh-web-managed.service', '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim();
assert.equal(await readlink(`/proc/${pid}/cwd`), root);
const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
assert.equal(argv[1], `${root}/apps/cli/lib/bin.js`);
const version = execFileSync(argv[0], [argv[1], '--version'], { encoding: 'utf8' }).trim();
assert.equal(version, '0.2.1-rc.2');
execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', 'dsh-v0.2.1-rc.2', 'HEAD']);
const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const journal = execFileSync('journalctl', ['--user', '-u', 'dsh-web-managed.service', `_PID=${pid}`, '--no-pager'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
assert(!/entr(?:y|ies) did not activate|incompatible with dsh|failed to import/.test(journal), 'Plugin activation failure; inspect the private service journal');
const token = journal.match(/http:\/\/127\.0\.0\.1:3080\/\?token=([^\s\u001b]+)/)?.[1];
assert(token, 'Missing service authentication URL');
const { chromium } = createRequire(join(root, 'apps/web/package.json'))('playwright');
const browser = await chromium.launch({ headless: true });
const results = [];
let page;
try {
  for (const origin of ['http://127.0.0.1:3080', 'https://boiled.colobus-powan.ts.net']) {
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], responses = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', response => {
      if (response.status() < 400) return;
      const url = new URL(response.url()); url.searchParams.delete('token');
      responses.push({ url: url.href, status: response.status() });
    });
    await page.addLocatorHandler(page.getByText('Preview Notice', { exact: true }), async () => {
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
    });
    const response = await page.goto(`${origin}/?token=${token}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    assert.equal(response.status(), 200);
    await page.getByRole('button', { name: 'Account menu', exact: true }).click({ timeout: 45000 });
    await page.getByRole('menuitem', { name: /^Settings/ }).click();
    await page.getByText('General', { exact: true }).first().waitFor({ timeout: 15000 });
    const session = await checkExistingSession(page);
    const resources = await classifyResourceFailures(responses, '/home/kiyama/.dsh-recovery-20261005', origin);
    results.push({ origin, settingsOpened: true, session, errors: blockingBrowserErrors(errors, resources), resources });
    await page.screenshot({ path: join(out, origin.startsWith('https') ? 'https.png' : 'local.png'), fullPage: true });
    await page.close(); page = undefined;
  }
  await writeFile(join(out, 'result.json'), JSON.stringify({ pid, version, head, results }, null, 2) + '\n', { mode: 0o600 });
  assert(!results.some(result => result.errors.length || result.resources.blocking.length), 'Blocking browser errors; inspect verification/result.json');
  console.log(JSON.stringify({ pid, version, head, existingHistoryAndImage: true, origins: results.map(result => result.origin) }));
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(out, 'failure.png'), fullPage: true });
    await writeFile(join(out, 'failure-body.txt'), await page.locator('body').innerText(), { mode: 0o600 });
  }
  await writeFile(join(out, 'failure.json'), JSON.stringify({ message: error.message, results }, null, 2) + '\n', { mode: 0o600 });
  throw error;
} finally {
  await browser.close();
}
