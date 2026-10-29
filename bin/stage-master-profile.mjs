/** Build isolated profile fixtures; no live profile or persistent application data is modified. */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const [targetArg, pluginsArg, homeArg, releasesArg] = process.argv.slice(2);
if (!targetArg || !pluginsArg || !homeArg || !releasesArg) throw new Error('Usage: node stage-master-profile.mjs TARGET_DSH PLUGINS NEW_HOME RELEASE_MANIFEST');
const target = resolve(targetArg), plugins = resolve(pluginsArg), home = resolve(homeArg);
const live = '/home/kiyama/.dsh';
const yaml = createRequire(join(target, 'package.json'))('js-yaml');
class Expression { constructor(text) { this.text = text; } }
const schema = yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: text => new Expression(text), instanceOf: Expression, represent: value => value.text }));
const load = async path => yaml.load(await readFile(path, 'utf8'), { schema });
const save = (path, value) => writeFile(path, yaml.dump(value, { schema, lineWidth: -1, noRefs: true }), { mode: 0o600 });
const packageDirs = new Map();
for (const group of await readdir(join(target, 'packages'))) {
  let entries; try { entries = await readdir(join(target, 'packages', group), { withFileTypes: true }); } catch (error) { if (error.code === 'ENOTDIR') continue; throw error; }
  for (const entry of entries.filter(entry => entry.isDirectory())) {
    const dir = join(target, 'packages', group, entry.name);
    try { const p = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')); packageDirs.set(p.name, dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
const releases = new Map(JSON.parse(await readFile(releasesArg, 'utf8')).map(row => [row.name, row.artifact]));
await mkdir(home, { mode: 0o700 });
for (const profile of ['web', 'headless', 'ai-reference-store-daily']) {
  const dir = join(home, 'profiles', profile); await mkdir(dir, { recursive: true, mode: 0o700 });
  const manifest = JSON.parse(await readFile(join(live, 'profiles', profile, 'package.json'), 'utf8'));
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (releases.has(name)) manifest.dependencies[name] = `file:${releases.get(name)}`;
    else if (name.startsWith('@deepseek-ai/') && packageDirs.has(name)) manifest.dependencies[name] = `link:${packageDirs.get(name)}`;
  }
  for (const name of manifest.dsh.profile.bundles) {
    if (name.startsWith('@deepseek-ai/') && !['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless'].includes(name)) {
      assert(packageDirs.has(name), name); manifest.dependencies[name] = `link:${packageDirs.get(name)}`;
    }
  }
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(dir, 'cordis.yml'), '[]\n', { mode: 0o600 });
  const policy = await readFile(join(live, 'profiles', profile, 'pnpm-workspace.yaml'), 'utf8');
  await writeFile(join(dir, 'pnpm-workspace.yaml'), policy.replaceAll('/data/softwares/deepseek-harness/', target + '/'), { mode: 0o600 });
  const patch = await load(join(live, 'profiles', profile, 'cordis.patch.yml'));
  // Synthetic credentials preserve field types but cannot authenticate provider requests.
  function redact(value) {
    if (!value || typeof value !== 'object' || value instanceof Expression) return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(apiKey|token|password|secret)$/i.test(key) && typeof child === 'string') value[key] = 'STAGING_NOT_A_CREDENTIAL';
      else redact(child);
    }
  }
  redact(patch);
  const override = (id, fields) => { const row = patch.find(row => row.id === id); if (row) Object.assign(row, fields); else patch.push({ id, ...fields }); };
  for (const id of ['session-title-llm', 'slack-intake-worker', 'aistore-daily', 'aistore-adapter', 'aistore-credentials']) override(id, { disabled: true });
  if (profile === 'web') override('experimental-inspector', { config: { port: 0, captureFetch: true, clientOrigins: [] } });
  if (profile === 'headless') {
    override('headless-startup', { disabled: true }); override('headless-runner', { disabled: true });
    override('sandbox-policy', { inject: [], config: { mode: 'workspace-write', workspaceRoot: target } });
  }
  await save(join(dir, 'cordis.patch.yml'), patch);
}
// Preserve Kura composition, but never reuse the production persistence redirects.
const homePatch = await load(join(live, 'cordis.patch.yml'));
assert(homePatch.every(row => row.insert || ['session-persistence-jsonl', 'storage-json', 'attachment-local'].includes(row.id)), 'Review new home patch rows before isolating persistence');
const memory = homePatch.flatMap(row => row.insert ?? []).find(row => row.id === 'memory-kura');
if (memory) {
  memory.name = join(home, 'profiles/web/node_modules/dsh-distill-kura/lib/index.js');
  memory.config = { ...memory.config, readonly: true };
}
await save(join(home, 'cordis.patch.yml'), memory ? [{ insert: [memory] }] : []);
console.log(JSON.stringify({ home, target, fixturesOnly: true, productionPersistenceCopied: false, liveConfigurationChanged: false }));
