// Journey: a headless run started in a registered workspace appears under that
// workspace in the web sidebar, and a control run without DSH_WORKSPACE_ID does not.
// Usage: node journey-workspace-attach.mjs <run|latest>   (exit 0 = pass; result.json always written)
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, open, screenshot, target } from './browser.mjs';
import { loadSettings } from './config.mjs';
import { headless, loadState, store } from './run.mjs';

const settings = loadSettings();
const state = loadState(process.argv[2] ?? process.env.DSHV_RUN, settings);
const out = join(state.evidence, 'workspace-attach');
mkdirSync(out, { recursive: true });
const hints = join(state.run, 'home/.dsh/workspace-attach-hints');
const workspaceDir = join(state.run, 'home/attach-project');
mkdirSync(workspaceDir, { recursive: true });
const result = { feature: 'workspace-attach', entryPoint: 'sidebar Add workspace + DSH_WORKSPACE_ID=cwd headless', steps: [] };
const step = (name, detail) => { result.steps.push({ name, ...detail }); console.log(`ok   ${name}`); };
const storedWorkspace = () => Object.values(store(state, 'workspace').tables.workspaces).find(workspace => workspace.path === workspaceDir);
const sleep = ms => new Promise(done => setTimeout(done, ms));

/** Session rows listed after the attach-project header, up to the next header (headers carry aria-expanded). */
async function sessionRows(page) {
  const header = target(page, { in: 'tree=Sessions', role: 'treeitem', name: 'attach-project' });
  if ((await header.getAttribute('aria-expanded')) === 'false') await header.click();
  const items = await page.getByRole('tree', { name: 'Sessions' }).getByRole('treeitem').evaluateAll(nodes =>
    nodes.map(node => ({ name: node.textContent.trim(), header: node.hasAttribute('aria-expanded') })));
  const at = items.findIndex(item => item.header && item.name.startsWith('attach-project'));
  const rows = [];
  for (const item of items.slice(at + 1)) {
    if (item.header) break;
    rows.push(item.name);
  }
  return rows;
}

const session = await connect(state, settings);
const { page, errors } = session;
try {
  // 1. The user registers the project directory through the sidebar.
  const dialog = 'dialog=Select Workspace Directory';
  await target(page, { role: 'button', name: 'Add workspace' }).click();
  await target(page, { in: dialog, role: 'button', name: 'Edit path' }).click();
  await target(page, { in: dialog, role: 'textbox', name: 'Edit path' }).fill(workspaceDir);
  await target(page, { in: dialog, role: 'textbox', name: 'Edit path' }).press('Enter');
  await target(page, { in: dialog, role: 'button', name: 'Open', exact: true }).click();
  await target(page, { in: 'tree=Sessions', role: 'treeitem', name: 'attach-project' }).waitFor({ timeout: 15_000 });
  await screenshot(page, state, 'workspace-attach/1-workspace-added.png');
  writeFileSync(join(out, '1-sidebar.aria.txt'), await page.getByRole('tree', { name: 'Sessions' }).ariaSnapshot());
  // Adding a workspace also opens one draft session in it; that is the baseline.
  const baseline = storedWorkspace()?.sessionIds;
  assert(Array.isArray(baseline), 'workspace missing from the store');
  const baselineRows = (await sessionRows(page)).length;
  step('workspace added from the sidebar', { workspaceDir, baselineSessionIds: baseline, baselineRows });

  // 2. Control: the same run without DSH_WORKSPACE_ID must stay ungrouped.
  const control = headless(state, settings, 'Say hello', { cwd: workspaceDir, name: 'workspace-attach-control' });
  assert(control.finished, `control run did not finish: ${control.transcript}`);
  step('control headless run (no DSH_WORKSPACE_ID) finished', {
    controlId: control.sessionId, hintWritten: existsSync(join(hints, `${control.sessionId}.json`)), transcript: control.transcript,
  });

  // 3. The user runs a headless task from that directory, asking to join it.
  const attached = headless(state, settings, 'Say hello', { cwd: workspaceDir, env: { DSH_WORKSPACE_ID: 'cwd' }, name: 'workspace-attach-cwd' });
  assert(attached.finished, `attach run did not finish: ${attached.transcript}`);
  step('headless run with DSH_WORKSPACE_ID=cwd finished', { sessionId: attached.sessionId, transcript: attached.transcript });

  // 4. Side effect: the web host consumes the hint and records the membership.
  const deadline = Date.now() + 60_000;
  while (!storedWorkspace()?.sessionIds.includes(attached.sessionId)) {
    assert(Date.now() < deadline, 'timed out after 60s waiting for the session in the workspace store');
    await sleep(500);
  }
  const workspace = storedWorkspace();
  const leftovers = existsSync(hints) ? readdirSync(hints).filter(name => name.startsWith(attached.sessionId)) : [];
  assert.deepEqual(leftovers, [], `hint not consumed: ${leftovers.join(', ')}`);
  assert(!workspace.sessionIds.includes(control.sessionId), 'control session was grouped without a hint');
  writeFileSync(join(out, '4-workspace-store.json'), JSON.stringify(workspace, null, 2));
  step('web host attached the session, deleted the hint, and left the control ungrouped', { sessionIds: workspace.sessionIds });

  // 5. The user sees the session under the workspace after a reload.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await target(page, { in: 'tree=Sessions', role: 'treeitem', name: 'attach-project' }).waitFor({ timeout: 30_000 });
  // Rows render after the header; give the list up to 10s to show the new session.
  let grouped = await sessionRows(page);
  for (let tries = 0; grouped.length < baselineRows + 1 && tries < 20; tries++) {
    await sleep(500);
    grouped = await sessionRows(page);
  }
  const tree = await page.getByRole('tree', { name: 'Sessions' }).ariaSnapshot();
  writeFileSync(join(out, '5-sidebar.aria.txt'), tree);
  await screenshot(page, state, 'workspace-attach/5-session-grouped.png');
  assert.equal(grouped.length, baselineRows + 1, `expected one more session under attach-project, saw:\n${tree}`);
  assert.deepEqual(errors, []);
  step('sidebar shows the headless session under attach-project', { rows: grouped });
  result.verdict = 'pass';
} catch (error) {
  result.verdict = 'fail';
  result.error = String(error?.stack ?? error);
  await screenshot(page, state, 'workspace-attach/failure.png').catch(() => {});
  process.exitCode = 1;
  console.error(result.error);
} finally {
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
  // Leave the page on the UI's start so the next command starts from a known state.
  await open(page, state).catch(() => {});
  await session.close();
}
console.log(`${result.verdict}: evidence in ${out}`);
