/** Read one named existing GUI conversation without sending, stopping, or changing its model. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const title = process.argv[2];
if (!title) throw new Error('Usage: node inspect-concurrent-session.mjs EXACT_TITLE');
const root = '/data/softwares/deepseek-harness';
const pid = execFileSync('systemctl', ['--user', 'show', 'dsh-web-managed.service', '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim();
const journal = execFileSync('journalctl', ['--user', '-u', 'dsh-web-managed.service', `_PID=${pid}`, '--no-pager'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const token = journal.match(/http:\/\/127\.0\.0\.1:3080\/\?token=([^\s\u001b]+)/)?.[1];
assert(token, 'No current browser authentication URL');
const { chromium } = createRequire(`${root}/apps/web/package.json`)('playwright');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:3080/?token=${token}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.getByRole('button', { name: 'Search sessions', exact: true }).click({ timeout: 30000 });
  await page.getByPlaceholder('Search session names', { exact: true }).fill(title);
  await page.getByText(title, { exact: true }).first().click({ timeout: 15000 });
  await page.locator('[data-chat-flow]').first().waitFor({ timeout: 30000 });
  await page.waitForFunction(() => {
    const text = document.querySelector('[data-chat-flow]')?.innerText.trim();
    return text && !text.startsWith('Loading history');
  }, undefined, { timeout: 30000 });
  const text = await page.locator('[data-chat-flow]').first().innerText();
  console.log(JSON.stringify({ title, url: page.url().replace(/([?&]token=)[^&]+/g, '$1[REDACTED]'), visibleTail: text.slice(-18000) }, null, 2));
} catch (error) {
  console.error(String(error.message).replace(/([?&]token=)[^\s"'&]+/g, '$1[REDACTED]'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
