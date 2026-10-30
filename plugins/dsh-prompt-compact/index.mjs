/** Opt-in, scope-local alternatives to reviewed upstream tool prompt sections. */
import { createHash } from 'node:crypto';

export const name = 'prompt-compact';
export const inject = ['systemPrompt'];

export const replacements = Object.freeze({
  'tool:workflow': {
    hash: '4e6240cecbf5ca92749fa3fe008d8e14aa6ef2d0da79e18c99fd44a79c31f277',
    text: 'Use the workflow tool only when the user explicitly asks for a workflow or large multi-agent orchestration. For one or two delegations, prefer plain subagent calls.',
  },
  'tool:ralph': {
    hash: 'b9e63bed0a547ebc29999625753fcfe42f98595ce3906856c310b9cc59774bd6',
    text: 'Use the ralph tool only when the direct human explicitly asks for a Ralph loop or fresh-agent iterative execution. Completion and blockers are worker reports, not independent evaluation. Use same-session goal tools for ordinary long-running objectives, and plain subagents or workflows for bounded delegation and fan-out.',
  },
});

/** Replace reviewed originals only; retain unknown or customized instructions. */
export function compactSections(sections, mismatch = () => {}) {
  for (const section of sections) {
    const replacement = replacements[section.name];
    if (!replacement || !section.text || section.text === replacement.text) continue;
    const hash = createHash('sha256').update(section.text).digest('hex');
    if (hash !== replacement.hash) {
      mismatch(section.name, hash);
      continue;
    }
    section.text = replacement.text;
  }
}

/** Mount in an agent preset; disposal restores upstream assembly. */
export function apply(ctx) {
  const warned = new Set();
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next();
    compactSections(assembly.sections, (section, hash) => {
      const key = `${section}:${hash}`;
      if (warned.has(key)) return;
      warned.add(key);
      ctx.logger.warn(`prompt-compact: retained unrecognized ${section}; review upstream wording before updating its fingerprint`);
    });
    return assembly;
  });
}
