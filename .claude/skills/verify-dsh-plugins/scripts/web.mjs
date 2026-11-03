// Playwright helpers for the isolated DSH web UI. Playwright comes from the DSH checkout.
import { createRequire } from 'node:module';

const dshRoot = process.env.DSHV_DSH_ROOT;
if (!dshRoot) throw new Error('DSHV_DSH_ROOT is unset; run this through `dshv exec <run> -- node <script>`');
const { chromium } = createRequire(`${dshRoot}/apps/web/package.json`)('playwright');

/** Open the tokenized web URL in English and wait until the sidebar is usable. */
export async function openWeb(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: 'en-US' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addLocatorHandler(page.getByText('Preview Notice', { exact: true }), async () => {
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
  });
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  if (response?.status() !== 200) throw new Error(`web UI answered ${response?.status()}`);
  await page.getByRole('button', { name: 'New session' }).first().waitFor({ timeout: 30_000 });
  return { browser, page, errors };
}

/** Call one host RPC from inside the authenticated page, as the UI does. */
export async function rpc(page, method, args = {}) {
  return page.evaluate(async ({ method, args }) => {
    const response = await fetch('/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
    });
    return response.json();
  }, { method, args });
}
