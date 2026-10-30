/** Validate the distributable without installing or activating the plugin. */
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const runtime = ['index.mjs', 'schema.mjs', 'state.mjs', 'engine.mjs', 'runner.mjs', 'evaluate.mjs', 'trial-policy.mjs'];
for (const path of runtime) {
  const result = spawnSync(process.execPath, ['--check', path], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
for (const prefix of ['', 'trial-policy/']) {
  for (const locale of ['ja', 'en']) {
    const value = JSON.parse(await readFile(new URL(`../locale/${prefix}${locale}.json`, import.meta.url), 'utf8'));
    assert.ok(value.meta.title.trim() && value.meta.description.trim());
  }
}
for (const path of [...runtime, 'cordis.patch.yml', 'icon.svg', 'LICENSE', 'README.md']) {
  assert.ok((await stat(new URL(`../${path}`, import.meta.url))).isFile());
}
const svg = await readFile(new URL('../icon.svg', import.meta.url), 'utf8');
assert.ok(svg.startsWith('<svg ') && svg.includes('xmlns="http://www.w3.org/2000/svg"'));
assert.doesNotMatch(svg, /<script|(?:href|src)=/i);
assert.ok(Buffer.byteLength(svg) < 256 * 1024);
const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
assert.equal(pack.status, 0, pack.stderr);
const files = JSON.parse(pack.stdout)[0].files.map(file => file.path);
for (const path of [...runtime, 'cordis.patch.yml', 'locale/ja.json', 'locale/en.json', 'locale/trial-policy/ja.json', 'locale/trial-policy/en.json', 'icon.svg', 'LICENSE']) {
  assert.ok(files.includes(path), `Packed bundle misses ${path}`);
}
assert.ok(!files.some(path => path.startsWith('node_modules/') || path.startsWith('tests/')));
assert.equal(manifest.engines.dsh, '=0.2.1-rc.3');
console.log(JSON.stringify({ syntaxChecked: runtime.length, packedFiles: files.length, locales: ['ja', 'en'], activation: 'not-performed' }));
