/** Read-only manifest checks with the selected DSH version's own compatibility implementation. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [targetArg, inventory, output] = process.argv.slice(2);
if (!targetArg || !inventory || !output) throw new Error('Usage: tsx weekly-compatibility.mjs TARGET INVENTORY NEW_OUTPUT');
const target = resolve(targetArg);
const { evaluatePluginCompatibility } = await import(pathToFileURL(join(target, 'packages/boot/app-boot/src/plugin-compatibility.ts')).href);
const { version } = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
const rows = JSON.parse(await readFile(inventory, 'utf8'));
const results = [];
for (const row of rows) {
  if (row.missing) {
    results.push({ name: row.name, profile: row.profile, status: 'missing' });
    continue;
  }
  const manifest = JSON.parse(await readFile(join(row.directory, 'package.json'), 'utf8'));
  const issue = evaluatePluginCompatibility(manifest, {}, version);
  results.push({ name: row.name, profile: row.profile, version: row.version, runtimeVersion: version,
    status: issue ? 'incompatible' : 'requirements-accepted', ...(issue ? { issue } : {}) });
}
await writeFile(output, JSON.stringify(results, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ count: results.length, issues: results.filter(row => row.status !== 'requirements-accepted') }, null, 2));
