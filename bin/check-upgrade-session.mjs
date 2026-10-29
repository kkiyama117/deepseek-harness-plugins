/** Read one migrated conversation and its persisted image through the ordinary UI. */
import { readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const fixture = JSON.parse(await readFile(process.env.DSH_ACCEPTANCE_FIXTURE ?? '/home/kiyama/.dsh-upgrade-stage-20261005/session-acceptance.json', 'utf8'));
export async function checkExistingSession(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('Workspaces', { exact: true }).hover();
  await page.getByRole('button', { name: 'Search sessions', exact: true }).click();
  await page.getByPlaceholder('Search session names', { exact: true }).fill(fixture.title);
  await page.getByText(fixture.title, { exact: true }).first().click({ timeout: 30000 });
  await page.getByText(fixture.tailText, { exact: false }).first().waitFor({ timeout: 30000 });
  for (let batch = 0; batch < 20; batch++) {
    const earlier = page.getByRole('button', { name: 'Load earlier', exact: true });
    if (!await earlier.isVisible()) break;
    const before = await page.locator('[data-chat-flow]').first().innerText();
    await earlier.click();
    await page.waitForFunction(length => {
      const flow = document.querySelector('[data-chat-flow]');
      const button = [...flow.querySelectorAll('button')].find(x => x.textContent === 'Loading...');
      return flow.innerText.length > length && !button;
    }, before.length, { timeout: 30000 });
  }
  await page.getByText(fixture.text, { exact: false }).first().waitFor({ timeout: 30000 });
  const turn = page.locator(`button[data-turn-process="${fixture.imageTurn}"][aria-expanded="false"]`);
  if (await turn.isVisible()) await turn.click();
  const groups = page.locator(`[data-step-process][data-chat-turn="${fixture.imageTurn}"] > div:first-child button[aria-expanded="false"]:visible`);
  const groupCount = await groups.count();
  for (let index = 0; index < groupCount; index++) await groups.first().click();
  await page.locator('[data-tool="read_image"]').filter({ hasText: fixture.image.attachment.name }).first().getByText('Read image', { exact: true }).click();
  const image = page.getByRole('img', { name: fixture.image.attachment.name, exact: true }).first();
  await image.waitFor({ timeout: 15000 });
  await page.waitForFunction(name => [...document.images].some(img => img.alt === name && img.complete && img.naturalWidth > 0), fixture.image.attachment.name, { timeout: 15000 });
  return { sessionId: fixture.id, persistedTextVisible: true, persistedImageLoaded: true };
}

/** Distinguish missing historical workspace files from a broken application route. */
export async function classifyResourceFailures(failures, home, origin) {
  const known = [];
  const blocking = [];
  let rows;
  for (const failure of failures) {
    const url = new URL(failure.url);
    if (url.origin !== origin) { blocking.push(failure); continue; }
    // This deployment leaves the family settings bridge physically local; do not weaken it for QA.
    if (failure.status === 403 && url.hostname === 'boiled.colobus-powan.ts.net' && url.pathname === '/api/dsh-web-ui-settings/describe') {
      known.push({ ...failure, reason: 'family settings control plane intentionally refuses remote access' });
      continue;
    }
    if (failure.status !== 404) { blocking.push(failure); continue; }
    if (url.pathname === '/open-in-app/icon/filemanager') {
      known.push({ ...failure, reason: 'optional Linux file-manager icon is unavailable' });
      continue;
    }
    if (url.pathname !== '/api/present.open' || url.searchParams.get('sessionId') !== fixture.id) {
      blocking.push(failure); continue;
    }
    rows ??= execFileSync('zstd', ['-dc', join(home, fixture.journalRelative)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .trim().split('\n').map(line => JSON.parse(line));
    const row = rows.find(row => row.seq === Number(url.searchParams.get('seq')));
    const file = row?.type === 'deliverables/presented' ? row.data.files[Number(url.searchParams.get('index'))] : undefined;
    if (!file) { blocking.push(failure); continue; }
    try {
      await stat(file.path);
      blocking.push(failure);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      known.push({ ...failure, reason: 'historical presented workspace file is absent', path: file.path });
    }
  }
  return { known, blocking };
}

/** Keep JS failures and every unclassified HTTP failure fatal. */
export function blockingBrowserErrors(errors, resourceFailures) {
  const statusOf = error => /^Failed to load resource: the server responded with a status of (403|404) \([^)]*\)$/.exec(error)?.[1];
  if (resourceFailures.blocking.length) return errors;
  for (const status of ['403', '404']) {
    if (errors.filter(error => statusOf(error) === status).length > resourceFailures.known.filter(item => String(item.status) === status).length) return errors;
  }
  return errors.filter(error => statusOf(error) === undefined);
}
