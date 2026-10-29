/** Preserve former home-level model settings in every staged non-Web Agent profile. */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const yaml = createRequire('/data/softwares/deepseek-harness-upgrade-master/package.json')('js-yaml');
const live = '/home/kiyama/.dsh';
const base = '/home/kiyama/.dsh-upgrade-stage-20261005/profiles';
const observed = await readFile(`${live}/settings.yaml`, 'utf8');
const settings = yaml.load(observed);
function merge(base, top) {
  if (!base || !top || Array.isArray(base) || Array.isArray(top) || typeof base !== 'object' || typeof top !== 'object') return top;
  const result = { ...base };
  for (const [key, value] of Object.entries(top)) result[key] = merge(base[key], value);
  return result;
}
const webPath = `${base}/web/cordis.patch.yml`;
const web = yaml.load(await readFile(webPath, 'utf8'));
web.find(row => row.id === 'agent-default-model').config = settings['agent-default-model'];
await writeFile(webPath, yaml.dump(web, { lineWidth: -1, noRefs: true }));
for (const profile of ['headless', 'ai-reference-store-daily']) {
  const original = yaml.load(await readFile(`${live}/profiles/${profile}/cordis.patch.yml`, 'utf8'));
  const path = `${base}/${profile}/cordis.patch.yml`;
  const patch = yaml.load(await readFile(path, 'utf8'));
  for (const id of ['llm-pi-ai', 'agent-default-model']) {
    patch.find(row => row.id === id).config = merge(original.find(row => row.id === id).config, settings[id]);
  }
  await writeFile(path, yaml.dump(patch, { lineWidth: -1, noRefs: true }));
  console.log(`${profile}: preserved configured providers ${Object.keys(patch.find(row => row.id === 'llm-pi-ai').config.providers).join(', ')}`);
}
await writeFile(`${base}/../settings-observed.yaml`, observed, { mode: 0o600 });
await writeFile(`${base}/../expected-model.json`, JSON.stringify(settings['agent-default-model']) + '\n', { mode: 0o600 });
