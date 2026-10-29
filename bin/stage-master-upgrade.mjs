/** Prepare an isolated upgrade home; never overwrite a previous staging run. */
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
const upstream = '/data/softwares/deepseek-harness-upgrade-master';
const home = '/home/kiyama/.dsh-upgrade-stage-20261005';
const live = '/home/kiyama/.dsh';
const require = createRequire(`${upstream}/package.json`);
const yaml = require('js-yaml');
class Expression { constructor(text) { this.text = text; } }
const schema = yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: text => new Expression(text), instanceOf: Expression,
  represent: value => value.text,
}));
const parse = text => yaml.load(text, { schema });
const dump = data => yaml.dump(data, { schema, lineWidth: -1, noRefs: true });
const load = async path => parse(await readFile(path, 'utf8'));
await mkdir(home, { mode: 0o700 });
await mkdir(`${home}/profiles/web`, { recursive: true });
await mkdir(`${home}/.agent-presets/cordis-kura`, { recursive: true });
for (const file of ['AGENTS.md', '.credentials.yaml']) await cp(`${live}/${file}`, `${home}/${file}`);
await cp(`${live}/skills`, `${home}/skills`, { recursive: true, verbatimSymlinks: true });
const manifest = JSON.parse(await readFile(`${live}/profiles/web/package.json`, 'utf8'));
// Third-party upgrades are installed by the supported CLI after its build finishes.
manifest.dependencies['@deepseek-ai/dsh-web-search-exa'] = `link:${upstream}/packages/web/web-search-exa`;
delete manifest.dsh.profile.patchReload;
await writeFile(`${home}/profiles/web/package.json`, JSON.stringify(manifest, null, 2) + '\n');
await writeFile(`${home}/profiles/web/cordis.yml`, '[]\n');
const settings = await load(`${live}/settings.yaml`);
const patch = await load(`${live}/profiles/web/cordis.patch.yml`);
// Preserve effective provider settings: dictionary keys merge; arrays replace, as before.
function merge(base, top) {
  if (!base || !top || Array.isArray(base) || Array.isArray(top) || typeof base !== 'object' || typeof top !== 'object') return top;
  const result = { ...base };
  for (const [key, value] of Object.entries(top)) result[key] = merge(base[key], value);
  return result;
}
const rename = { 'agent-presets': 'agent-preset-registry', 'ui-onboarding': 'ui-settings-general', 'ui-developer-tools': 'ui-settings', 'catppuccin': 'dsh-catppuccin', 'dsh-better-sidebar': 'better-sidebar', 'subagent-model-selection': 'subagent-model-selection-settings' };
for (const [oldId, config] of Object.entries(settings)) {
  const id = rename[oldId] ?? oldId;
  const row = patch.find(row => row.id === id);
  if (row) row.config = merge(row.config ?? {}, config);
  else patch.push({ id, config });
}
await writeFile(`${home}/profiles/web/cordis.patch.yml`, dump(patch));
const memory = await load(`${live}/cordis.patch.yml`);
memory[0].insert[0].name = `${home}/profiles/web/node_modules/dsh-distill-kura/lib/index.js`;
await writeFile(`${home}/cordis.patch.yml`, dump(memory));
const preset = await load(`${upstream}/packages/bundle/web-app/presets/cordis.patch.yml`);
const declaration = preset[0].insert[0];
declaration.id = 'preset-cordis-kura';
declaration.config.id = 'cordis-kura';
declaration.config.name = 'Cordis + Kura';
declaration.config.description = 'Cordis coding tools with shared Kura memory and compact workflow guidance.';
declaration.config.order = 5;
// Preserve the prior explicit-request Ralph tool and the local compact policy.
declaration.config.plugins.find(row => row.id === 'delegation').config.find(row => row.id === 'tool-ralph').disabled = false;
declaration.config.plugins.push({ id: 'prompt-compact', name: '@kkiyama117/dsh-prompt-compact' });
await writeFile(`${home}/.agent-presets/cordis-kura/cordis.patch.yml`, dump(preset));
await writeFile(`${home}/.agent-presets/cordis-kura/package.json`, JSON.stringify({ name: '@local/dsh-cordis-kura-preset', version: '1.0.0', private: true, type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2) + '\n');
console.log(`Prepared ${home}; credentials copied privately, no live settings changed.`);
