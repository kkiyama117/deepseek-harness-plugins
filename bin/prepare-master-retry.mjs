/** Rehearse the upgraded profiles with the latest, never-overwritten recovery data. */
import { readFile, writeFile, cp, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = '/data/softwares/deepseek-harness-upgrade-master';
const active = '/home/kiyama/.dsh-recovery-20261005';
const installed = '/home/kiyama/.dsh';
const stage = '/home/kiyama/.dsh-upgrade-retry-20261005';
const yaml = createRequire(`${root}/package.json`)('js-yaml');
class Expression { constructor(text) { this.text = text; } }
const schema = yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: text => new Expression(text), instanceOf: Expression, represent: value => value.text,
}));
const load = async path => yaml.load(await readFile(path, 'utf8'), { schema });
const save = (path, value) => writeFile(path, yaml.dump(value, { schema, lineWidth: -1, noRefs: true }), { mode: 0o600 });
function merge(base, top) {
  if (!base || !top || Array.isArray(base) || Array.isArray(top) || typeof base !== 'object' || typeof top !== 'object') return top;
  const result = { ...base };
  for (const [key, value] of Object.entries(top)) result[key] = merge(base[key], value);
  return result;
}
await exec('/home/kiyama/.local/share/uv/tools/distill-kura/bin/python', ['-B', '-c',
  `from pathlib import Path; from upgrade_recovery import copy_recovery_home; copy_recovery_home(Path(${JSON.stringify(active)}), Path(${JSON.stringify(stage)}))`],
  { env: { ...process.env, PYTHONPATH: '/data/softwares/deepseek-harness-plugins/bin' } });
const observed = await readFile(`${active}/settings.yaml`, 'utf8');
const settings = yaml.load(observed);
const renames = { 'agent-presets': 'agent-preset-registry', 'ui-onboarding': 'ui-settings-general', 'ui-developer-tools': 'ui-settings', catppuccin: 'dsh-catppuccin', 'dsh-better-sidebar': 'better-sidebar', 'subagent-model-selection': 'subagent-model-selection-settings' };
for (const profile of ['web', 'headless', 'ai-reference-store-daily']) {
  const target = `${stage}/profiles/${profile}`;
  await rename(target, `${target}.legacy`);
  await cp(`${installed}/profiles/${profile}`, target, { recursive: true, verbatimSymlinks: true });
  for (const file of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
    const path = `${target}/${file}`;
    await writeFile(path, (await readFile(path, 'utf8')).replaceAll(`${installed}/`, `${stage}/`));
  }
  const old = await load(`${active}/profiles/${profile}/cordis.patch.yml`);
  const patch = await load(`${target}/cordis.patch.yml`);
  for (const id of ['llm-pi-ai', 'agent-default-model']) patch.find(row => row.id === id).config = merge(old.find(row => row.id === id).config, settings[id]);
  if (profile === 'web') {
    for (const [oldId, value] of Object.entries(settings)) {
      if (['llm-pi-ai', 'agent-default-model'].includes(oldId)) continue;
      const id = renames[oldId] ?? oldId;
      const row = patch.find(row => row.id === id);
      if (row) row.config = merge(row.config ?? {}, value);
      else patch.push({ id, config: value });
    }
  }
  await save(`${target}/cordis.patch.yml`, patch);
}
await cp(`${installed}/.agent-presets`, `${stage}/.agent-presets`, { recursive: true, verbatimSymlinks: true });
await writeFile(`${stage}/cordis.patch.yml`, (await readFile(`${installed}/cordis.patch.yml`, 'utf8')).replaceAll(`${installed}/`, `${stage}/`));
await rename(`${stage}/settings.yaml`, `${stage}/settings.legacy.yaml`);
await writeFile(`${stage}/settings-observed.yaml`, observed, { mode: 0o600 });
await writeFile(`${stage}/expected-model.json`, JSON.stringify(settings['agent-default-model']) + '\n', { mode: 0o600 });
console.log(`Prepared ${stage} from the currently active recovery home.`);
