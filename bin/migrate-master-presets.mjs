/** Migrate only removed subagent control declarations in explicit preset files. */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const [target, ...files] = process.argv.slice(2);
if (!target || !files.length) throw new Error('Usage: node migrate-master-presets.mjs TARGET_DSH PATCH...');
const yaml = createRequire(join(resolve(target), 'package.json'))('js-yaml');
const schema = yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: text => ({ expression: text }) }));
const parse = text => yaml.load(text, { schema });
function migrate(value) {
  if (Array.isArray(value)) {
    const removed = value.filter(row => row?.name === '@deepseek-ai/dsh-tool-subagent-control/list-agents');
    if (removed.length) assert(value.some(row => row?.name === '@deepseek-ai/dsh-tool-subagent-control'));
    return value.filter(row => !removed.includes(row)).map(migrate);
  }
  if (!value || typeof value !== 'object') return value;
  const out = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, migrate(child)]));
  if (out.name === '@deepseek-ai/dsh-tool-subagent' && out.config?.modelSelectionSettings === true) {
    delete out.config.modelSelectionSettings;
    out.config.modelSelection = true;
    out.config.modelDiscovery = true;
  }
  return out;
}
for (const file of files) {
  const text = await readFile(file, 'utf8');
  const expected = migrate(parse(text));
  const revised = text.replace(/^\s+- id: tool-subagent-list-agents\r?\n\s+name: '@deepseek-ai\/dsh-tool-subagent-control\/list-agents'\r?\n/gm, '')
    .replace(/^( +)modelSelectionSettings: true$/gm, '$1modelSelection: true\n$1modelDiscovery: true');
  assert.deepEqual(parse(revised), expected, `Unrelated preset change: ${file}`);
  if (text !== revised) await writeFile(file, revised);
  console.log(JSON.stringify({ file, changed: text !== revised, semanticCheck: 'passed' }));
}
