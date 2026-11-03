// Journey: a headless run started in a registered workspace appears under that
// workspace in the web sidebar. Run through `dshv exec <run> -- node <this file>`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openWeb } from './web.mjs';

const run = process.env.DSHV_RUN;
const state = Object.fromEntries(readFileSync(join(run, 'state.env'), 'utf8').trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
const out = join(process.env.DSHV_EVIDENCE, 'workspace-attach');
mkdirSync(out, { recursive: true });
const dshHome = process.env.DSH_HOME;
const hints = join(dshHome, 'workspace-attach-hints');
const workspaceDir = join(process.env.HOME, 'attach-project');
mkdirSync(workspaceDir, { recursive: true });
const result = { feature: 'workspace-attach', entryPoint: 'web Add workspace + DSH_WORKSPACE_ID=cwd headless', steps: [] };
const step = (name, detail) => { result.steps.push({ name, ...detail }); console.log(`ok   ${name}`); };
const storedWorkspace = () => Object.values(JSON.parse(readFileSync(join(dshHome, 'storages/workspace.json'), 'utf8')).tables.workspaces)
  .find(workspace => workspace.path === workspaceDir);

async function waitUntil(label, seconds, check) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${seconds}s waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

const { browser, page, errors } = await openWeb(state.WEB_URL);

/** Session rows listed after attach-project, up to the next group header (headers carry aria-expanded). */
async function sessionRows() {
  const tree = page.getByRole('tree', { name: 'Sessions' });
  const header = tree.getByRole('treeitem', { name: 'attach-project' });
  if ((await header.getAttribute('aria-expanded')) === 'false') await header.click();
  await tree.getByRole('treeitem').nth(1).waitFor({ timeout: 10_000 });
  const items = await tree.getByRole('treeitem').evaluateAll(nodes =>
    nodes.map(node => ({ name: node.textContent.trim(), header: node.hasAttribute('aria-expanded') })));
  const at = items.findIndex(item => item.header && item.name.startsWith('attach-project'));
  const rows = [];
  for (const item of items.slice(at + 1)) {
    if (item.header) break;
    rows.push(item.name);
  }
  return rows;
}
try {
  // 1. The user registers the project directory through the sidebar.
  await page.getByRole('button', { name: 'Add workspace' }).click();
  const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' });
  await dialog.getByRole('button', { name: 'Edit path' }).click();
  await dialog.getByRole('textbox', { name: 'Edit path' }).fill(workspaceDir);
  await dialog.getByRole('textbox', { name: 'Edit path' }).press('Enter');
  await dialog.getByRole('button', { name: 'Open' }).click();
  const sidebar = page.getByRole('tree', { name: 'Sessions' });
  await sidebar.getByRole('treeitem', { name: 'attach-project' }).waitFor({ timeout: 15_000 });
  await page.screenshot({ path: join(out, '1-workspace-added.png') });
  writeFileSync(join(out, '1-sidebar.aria.txt'), await sidebar.ariaSnapshot());
  // Adding a workspace also opens one draft session in it; that is the baseline.
  const baseline = storedWorkspace()?.sessionIds;
  assert(Array.isArray(baseline), 'workspace missing from the store');
  const baselineRows = (await sessionRows()).length;
  step('workspace added from the sidebar', { workspaceDir, baselineSessionIds: baseline, baselineRows });

  // 2. Control: the same run without DSH_WORKSPACE_ID must stay ungrouped.
  const headless = (name, env) => {
    const stdout = execFileSync(join(run, 'bin/dsh'), ['--profile', 'headless', '--json', 'Say hello'], {
      cwd: workspaceDir, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    writeFileSync(join(out, name), stdout);
    assert(stdout.includes('"type":"final"'), `headless run ${name} did not finish`);
    return JSON.parse(stdout.split('\n')[0]).sessionId;
  };
  const controlId = headless('2-control-headless.jsonl', {});
  step('control headless run (no DSH_WORKSPACE_ID) finished', { controlId, hintWritten: existsSync(join(hints, `${controlId}.json`)) });

  // 3. The user runs a headless task from that directory, asking to join it.
  const sessionId = headless('3-headless.jsonl', { DSH_WORKSPACE_ID: 'cwd' });
  assert.match(sessionId, /^session-/);
  step('headless run with DSH_WORKSPACE_ID=cwd finished', { sessionId });

  // 4. Side effect: the web host consumes the hint and records the membership.
  const workspace = await waitUntil('session in workspace store', 60, () => {
    const found = storedWorkspace();
    return found?.sessionIds.includes(sessionId) && found;
  });
  const leftovers = readdirSync(hints).filter(name => name.startsWith(sessionId));
  assert.deepEqual(leftovers, [], `hint not consumed: ${leftovers.join(', ')}`);
  writeFileSync(join(out, '4-workspace-store.json'), JSON.stringify(workspace, null, 2));
  assert(!workspace.sessionIds.includes(controlId), 'control session was grouped without a hint');
  step('web host attached the session, deleted the hint, and left the control ungrouped', { sessionIds: workspace.sessionIds });

  // 5. The user sees the session under the workspace after a reload.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('tree', { name: 'Sessions' }).getByRole('treeitem', { name: 'attach-project' }).waitFor({ timeout: 30_000 });
  const grouped = await sessionRows();
  const tree = await page.getByRole('tree', { name: 'Sessions' }).ariaSnapshot();
  writeFileSync(join(out, '5-sidebar.aria.txt'), tree);
  await page.screenshot({ path: join(out, '5-session-grouped.png') });
  assert.equal(grouped.length, baselineRows + 1, `expected one more session under attach-project, saw:\n${tree}`);
  assert.deepEqual(errors, []);
  step('sidebar shows the headless session under attach-project', { rows: grouped });
  result.verdict = 'pass';
} catch (error) {
  result.verdict = 'fail';
  result.error = String(error?.stack ?? error);
  await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
  console.error(result.error);
} finally {
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
  await browser.close();
}
console.log(`${result.verdict}: evidence in ${out}`);
