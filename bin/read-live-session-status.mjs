/** Observe the GUI's own read-only session/list response; never resume or send to a Session. */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
const root = '/data/softwares/deepseek-harness';
const pid = execFileSync('systemctl', ['--user', 'show', 'dsh-web-managed.service', '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim();
const journal = execFileSync('journalctl', ['--user', '-u', 'dsh-web-managed.service', `_PID=${pid}`, '--no-pager'], { encoding: 'utf8', maxBuffer: 32*1024*1024 });
const token = journal.match(/http:\/\/127\.0\.0\.1:3080\/\?token=([^\s\u001b]+)/)?.[1];
if (!token) throw new Error('No browser auth URL');
const { chromium } = createRequire(root + '/apps/web/package.json')('playwright');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/session/list', { timeout: 30000 });
  await page.goto(`http://127.0.0.1:3080/?token=${token}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const result = await response;
  const payload = await result.json();
  const value = payload.result?.value;
  const rows = Array.isArray(value) ? value : value?.sessions ?? value?.items ?? [];
  const brief = row => ({ sessionId: row.sessionId, running: row.running, title: row.projections?.values?.title, cwd: row.cwd });
  const pluginReply = await page.evaluate(async () => {
    const method = 'pluginManager/listPlugins';
    const response = await fetch('/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: {} } }) });
    return response.json();
  });
  const plugins = pluginReply.result?.value ?? [];
  const report = { pid, ok: payload.result?.ok, pluginsOk: pluginReply.result?.ok, pluginCount: plugins.length,
    unavailablePlugins: plugins.filter(row => ['pending', 'failed'].includes(row.fiberPhase)).map(row => ({ id: row.entryId, phase: row.fiberPhase })), rowCount: rows.length,
    active: rows.filter(row => row.running || row.status === 'running').map(brief),
    named: rows.filter(row => row.projections?.values?.title === '[GOING]: DSH bug fix').map(brief) };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(String(error.message).replace(/([?&]token=)[^\s"'&]+/g, '$1[REDACTED]')); process.exitCode = 1;
} finally { await browser.close(); }
