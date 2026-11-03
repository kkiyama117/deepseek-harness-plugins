// Read-only: is the isolated web host worth driving? Usage: doctor-web.mjs <web-url> "<package-name>..."
import { openWeb, rpc } from './web.mjs';

const [url, packageNames = ''] = process.argv.slice(2);
const names = packageNames.split(' ').filter(Boolean);

let failed = false;
const say = (ok, text) => { if (!ok) failed = true; console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`); };
const { browser, page, errors } = await openWeb(url);
try {
  say(true, `web UI loaded at ${new URL(url).origin}`);
  const reply = await rpc(page, 'pluginManager/listPlugins');
  say(reply.result?.ok === true, 'plugin inventory answers');
  const rows = reply.result?.value ?? [];
  for (const row of rows.filter(row => row.fiberPhase === 'failed')) say(false, `row ${row.entryId} failed`);
  for (const name of names) {
    const own = rows.filter(row => row.moduleName === name || row.moduleName?.startsWith(`${name}/`));
    say(own.length > 0, `${name} has rows in the web profile`);
    for (const row of own) say(row.fiberPhase === 'active', `${row.entryId} is ${row.fiberPhase}`);
  }
  say(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
