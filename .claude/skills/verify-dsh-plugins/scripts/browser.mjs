// One headless Chromium per run, kept alive between commands and reached over CDP,
// so each `dshv web` command continues on the page the previous one left.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { DshvError } from './config.mjs';
import { isolatedEnv, ownsPid, saveState } from './run.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const chromiumOf = state => createRequire(join(state.dshRoot, 'apps/web/package.json'))('playwright').chromium;

async function startBrowser(state, settings) {
  const chromium = chromiumOf(state);
  const profile = join(state.run, 'browser');
  mkdirSync(profile, { recursive: true });
  const child = spawn(chromium.executablePath(), [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--lang=en-US', '--accept-lang=en-US',
    '--no-first-run', '--no-default-browser-check', '--window-size=1400,900', 'about:blank',
  ], { env: isolatedEnv(state, settings), detached: true, stdio: ['ignore', 'ignore', openSync(join(state.run, 'browser.err'), 'a')] });
  child.unref();
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) throw new DshvError('the browser did not start', `read ${join(state.run, 'browser.err')}`);
  state.browser = { pid: child.pid, port: Number(readFileSync(portFile, 'utf8').split('\n')[0]) };
  saveState(state);
}

/**
 * Connect to the run's browser (starting it on first use) and return the page on the web UI.
 * Always `await session.close()`: it disconnects and leaves the browser and page running.
 */
export async function connect(state, settings) {
  if (!state.browser || !ownsPid(state, state.browser.pid)) await startBrowser(state, settings);
  const browser = await chromiumOf(state).connectOverCDP(`http://127.0.0.1:${state.browser.port}`);
  const context = browser.contexts()[0];
  let page = context.pages().find(candidate => candidate.url().startsWith(state.webOrigin)) ?? context.pages()[0] ?? await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addLocatorHandler(page.getByText('Preview Notice', { exact: true }), async () => {
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
  });
  if (!page.url().startsWith(state.webOrigin)) await open(page, state);
  return { page, errors, close: () => browser.close() };
}

/** Load the tokenized web URL and wait until the sidebar is usable. */
export async function open(page, state) {
  const response = await page.goto(state.webUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  if (response?.status() !== 200) throw new DshvError(`web UI answered ${response?.status()}`, 'run `dshv doctor <run>`');
  await page.getByRole('button', { name: 'New session' }).first().waitFor({ timeout: 30_000 });
}

/** Resolve a target from --role/--name, optionally inside --in "<role>=<name>". */
export function target(page, { role, name, in: within, exact }) {
  if (!role) throw new DshvError('missing --role', 'e.g. --role button --name "Add workspace"; run `dshv web <run> snapshot` to see roles and names');
  let scope = page;
  if (within) {
    const [scopeRole, ...rest] = within.split('=');
    scope = page.getByRole(scopeRole, rest.length ? { name: rest.join('=') } : {});
  }
  return scope.getByRole(role, name === undefined ? {} : { name, exact: Boolean(exact) }).first();
}

/** Accessibility snapshot of the page or of one element. */
export async function snapshot(page, options) {
  const scope = options.role ? target(page, options) : page.locator('body');
  return { url: page.url(), aria: await scope.ariaSnapshot({ timeout: 10_000 }) };
}

/** Save a screenshot; a relative path lands under the run's evidence directory. */
export async function screenshot(page, state, path) {
  if (!path) throw new DshvError('missing <file>', 'e.g. `dshv web <run> screenshot workspace-attach/after.png`');
  const file = isAbsolute(path) ? path : join(state.evidence, path);
  mkdirSync(dirname(file), { recursive: true });
  await page.screenshot({ path: file });
  return { screenshot: file };
}
