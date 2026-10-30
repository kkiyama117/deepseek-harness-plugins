/** Read-only assertions over a real copied preset mounted by the dsh CLI. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { replacements, skillName } from '../index.mjs';

export const name = 'compact-preset-probe';
export const inject = ['agentPresets', 'systemPrompt', 'skills'];

export async function apply(ctx, config) {
  const scope = await ctx.agentPresets.standingKeyFor(config.preset);
  const assembly = await ctx.systemPrompt.assemble({ scope });
  const section = assembly.sections.find(item => item.name === 'tool:cordis');
  assert.equal(section?.text, replacements['tool:cordis'].text);
  const skill = await ctx.skills.get(skillName, { scope });
  assert.ok(skill?.content.includes('## Match the requested outcome'));
  assert.ok(assembly.tools.some(tool => tool.name === 'cordis_define'));
  assert.ok(assembly.tools.some(tool => tool.name === 'cordis_run' && tool.description.includes('awaiting-approval')));
  await writeFile(config.output, JSON.stringify({
    preset: config.preset,
    compactCordis: true,
    skill: skill.name,
    toolCount: assembly.tools.length,
    cordisBytes: Buffer.byteLength(section.text),
  }) + '\n');
}
