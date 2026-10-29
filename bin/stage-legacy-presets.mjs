/** Preserve legacy preset identities in declarative bundles in the isolated home. */
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
const root = '/data/softwares/deepseek-harness-upgrade-master';
const live = '/home/kiyama/.dsh';
const home = '/home/kiyama/.dsh-upgrade-stage-20261005';
const yaml = createRequire(`${root}/package.json`)('js-yaml');
class Expression { constructor(text) { this.text = text; } }
const schema = yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: text => new Expression(text), instanceOf: Expression, represent: value => value.text,
}));
const load = async file => yaml.load(await readFile(file, 'utf8'), { schema });
const save = async (file, data) => writeFile(file, yaml.dump(data, { schema, lineWidth: -1, noRefs: true }));
for (const id of ['managed-cordis', 'managed-standard', 'ai-reference-store-next', 'ai-reference-store-daily']) {
  const dir = `${home}/.agent-presets/${id}`;
  await mkdir(dir);
  const meta = await load(`${live}/.agent-presets/${id}/preset.yml`);
  const oldRows = await load(`${live}/.agent-presets/${id}/agent.cordis.yml`);
  let rows;
  if (id === 'ai-reference-store-daily') rows = oldRows;
  else {
    const template = id === 'managed-cordis' ? 'cordis' : 'standard';
    rows = (await load(`${root}/packages/bundle/web-app/presets/${template}.patch.yml`))[0].insert[0].config.plugins;
    const oldRalph = oldRows.find(x => x.id === 'delegation').config.find(x => x.id === 'tool-ralph');
    rows.find(x => x.id === 'delegation').config.find(x => x.id === 'tool-ralph').disabled = oldRalph.disabled === true;
    if (id === 'ai-reference-store-next') {
      const task = oldRows.find(x => x.id === 'aistore-native-task');
      rows.push({ ...task, name: '@kkiyama117/dsh-slack-intake/agent' });
    }
  }
  await save(`${dir}/cordis.patch.yml`, [{ insert: [{ id: `preset-${id}`, name: '@deepseek-ai/dsh-agent-preset', config: { id, ...meta, plugins: rows } }] }]);
  await writeFile(`${dir}/package.json`, JSON.stringify({ name: `@local/dsh-${id}-preset`, version: '1.0.0', private: true, type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2) + '\n');
}
// The active daily application and standard headless profile get isolated copies.
for (const profile of ['ai-reference-store-daily', 'headless']) {
  const dir = `${home}/profiles/${profile}`;
  await cp(`${live}/profiles/${profile}`, dir, { recursive: true, filter: path => !path.split('/').includes('node_modules') });
  const manifest = JSON.parse(await readFile(`${dir}/package.json`, 'utf8'));
  delete manifest.dsh.profile.patchReload;
  for (const [name, spec] of Object.entries(manifest.dependencies)) {
    if (name.startsWith('@deepseek-ai/')) manifest.dependencies[name] = spec.replace(/\/data\/softwares\/deepseek-harness(?:-master)?\//, `${root}/`);
  }
  await writeFile(`${dir}/package.json`, JSON.stringify(manifest, null, 2) + '\n');
  const patch = await load(`${dir}/cordis.patch.yml`);
  if (profile === 'ai-reference-store-daily') {
    const registry = patch.flatMap(x => x.insert ?? []).find(x => x.id === 'agent-presets');
    registry.id = 'agent-preset-registry';
    registry.name = '@deepseek-ai/dsh-agent-preset-registry';
    registry.config = { default: 'ai-reference-store-daily' };
  }
  if (profile === 'headless') {
    const web = await load(`${home}/profiles/web/cordis.patch.yml`);
    for (const id of ['llm-pi-ai', 'agent-default-model']) patch.find(row => row.id === id).config = web.find(row => row.id === id).config;
  }
  patch.push({ id: 'hmr', disabled: true });
  await save(`${dir}/cordis.patch.yml`, patch);
}
console.log('Staged four legacy preset declarations plus daily/headless profiles.');
