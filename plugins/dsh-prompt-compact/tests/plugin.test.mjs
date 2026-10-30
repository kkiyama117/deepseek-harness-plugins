import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import * as plugin from '../index.mjs';

const root = process.env.DSH_UPSTREAM_ROOT;
if (!root) throw new Error('Set DSH_UPSTREAM_ROOT to the built upstream checkout under test.');
const load = path => import(pathToFileURL(resolve(root, path)).href);
const { Context } = await load('vendor/cordis/lib/index.js');
const { default: SystemPrompt } = await load('packages/core/system-prompt/lib/index.js');
const { createScope } = await load('packages/core/scope/lib/index.js');
const snapshot = (await Promise.all([
  'snapshots/web/cordis-tool-round/system-prompt.expected.md',
  'snapshots/session/ralph-loop/system-prompt.1.expected.md',
].map(path => readFile(resolve(root, path), 'utf8')))).join('\n\n');
const originals = Object.keys(plugin.replacements).map(name => ({
  name,
  text: snapshot.split('\n\n').find(text => text.startsWith(`Use the ${name.slice(5)} tool`)),
}));

async function setup(t) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt, {});
  for (const [index, section] of originals.entries()) {
    assert.equal(typeof section.text, 'string', section.name);
    ctx.systemPrompt.section({ ...section, order: 100 + index });
  }
  ctx.systemPrompt.context({ name: 'permissions', order: 1, text: 'Approval is required.' });
  ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'unchanged_tool', description: 'Keep this contract.', parameters: { type: 'object', properties: {} } }] }));
  return ctx;
}

test('compacts reviewed upstream sections only in the opted-in scope and reverses on disposal', async t => {
  const ctx = await setup(t);
  const selected = {};
  const sibling = {};
  const scope = createScope(ctx, selected);
  const before = await ctx.systemPrompt.assemble({ scope: selected });
  const fiber = await scope.ctx.plugin(plugin);
  const after = await ctx.systemPrompt.assemble({ scope: selected });
  for (const section of after.sections) {
    const replacement = plugin.replacements[section.name];
    if (replacement) assert.equal(section.text, replacement.text, section.name);
  }
  assert.deepEqual(after.tools, before.tools);
  assert.deepEqual(after.contexts, before.contexts);
  assert.deepEqual(after.variables, before.variables);
  assert.deepEqual(after.sections.map(x => x.name), before.sections.map(x => x.name));
  assert.deepEqual(await ctx.systemPrompt.assemble({ scope: sibling }), before);
  await fiber.dispose();
  assert.deepEqual(await ctx.systemPrompt.assemble({ scope: selected }), before);
});

test('retains customized, hidden and unrelated sections; applying twice is idempotent', () => {
  const sections = [
    { name: 'tool:workflow', text: 'Custom safety requirements.' },
    { name: 'tool:subagent', text: '' },
    { name: 'other', text: 'Do not change.' },
    { name: 'tool:ralph', text: plugin.replacements['tool:ralph'].text },
  ];
  const before = structuredClone(sections);
  const mismatches = [];
  plugin.compactSections(sections, name => mismatches.push(name));
  assert.deepEqual(sections, before);
  assert.deepEqual(mismatches, ['tool:workflow']);
});

test('respects a complete-prompt override and composes with other waterfall listeners', async t => {
  const ctx = await setup(t);
  const selected = {};
  const scope = createScope(ctx, selected);
  await scope.ctx.plugin(plugin);
  scope.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next();
    assembly.variables.marker = 'downstream';
    return assembly;
  });
  scope.ctx.get('systemPrompt').section({ name: 'complete', order: 999, complete: true, text: 'Explicit complete prompt.' });
  const assembly = await ctx.systemPrompt.assemble({ scope: selected });
  assert.equal(assembly.variables.marker, 'downstream');
  assert.deepEqual(assembly.sections, [{ name: 'complete', text: 'Explicit complete prompt.' }]);
});
