/** Real shipped-profile Loader test; this fixture is never a supported app entrypoint. */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = process.env.DSH_HOST_ROOT;
assert.ok(root, 'DSH_HOST_ROOT is required');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
assert.equal(version, '0.2.1-rc.3', 'Review a different DSH version before changing this test target');
registerHooks({ resolve(specifier, context, next) {
  for (const name of ['agent-preset', 'agent-preset-registry']) {
    if (specifier === `@deepseek-ai/dsh-${name}/package.json`) {
      return next(join(root, `packages/preset/${name}/package.json`), context);
    }
  }
  return next(specifier, context);
} });
const { bootProductionProfile } = await import(pathToFileURL(join(root, 'packages/test-support/loader-smoke/tests/fixtures/production-profile.ts')));
const pkg = fileURLToPath(new URL('../../', import.meta.url));
const fixture = fileURLToPath(new URL('./composition.patch.yml', import.meta.url));
let ctx;
try {
  ctx = await bootProductionProfile({ binName: 'evolve-composition-test', profile: 'headless',
    overlayPaths: [join(pkg, 'cordis.patch.yml'), fixture] });
  const entry = [...ctx.loader.entries()].find(item => item.options.id === 'local-evolve');
  assert.ok(entry?.fiber, 'Plugin must import through the real Loader');
  await entry.fiber.await();
  assert.equal(entry.fiber.state, 2, 'Plugin must be ACTIVE');
  const agents = ctx.get('agents');
  if (!agents.roots().length) await new Promise(resolve => {
    const off = ctx.on('agent/created', ({ agent }) => { if (agent.id === 'evolve-composition-root') { off(); resolve(); } });
    if (agents.roots().length) { off(); resolve(); }
  });
  const agent = agents.roots().find(item => item.id === 'evolve-composition-root');
  assert.ok(agent);
  const commands = ctx.get('commands');
  const skills = ctx.get('skills');
  const domain = ctx.get('storageDomain').get('local_evolve');
  const before = await skills.get('evolve-fixture');
  assert.equal(before.content, 'EXACT ORIGINAL BODY\n');
  const meter = ctx.get('tokenMeter');
  const schema = ctx.get('tools').schemas(agent).find(item => item.name === 'evolve_inspect');
  assert.ok(schema);
  const envelope = { config: { provider: 'evolve-mock', model: 'fixed' }, tools: [] };
  const beforeTokens = meter.measure(agent.session, envelope).totalTokens;
  const afterTokens = meter.measure(agent.session, { ...envelope, tools: [schema] }).totalTokens;
  assert.ok(afterTokens > beforeTokens);
  process.stdout.write(JSON.stringify({ type: 'tool-schema-estimate', beforeTokens, afterTokens }) + '\n');
  assert.equal(ctx.get('tools').get('evolve_apply'), undefined);
  const denied = await ctx.get('tools').execute({ agent, signal: new AbortController().signal,
    calls: [{ type: 'tool-call', id: 'denied-evolve-apply', name: 'evolve_apply', arguments: '{}' }] });
  assert.match(JSON.stringify(denied), /UNKNOWN_TOOL/);
  assert.equal((await skills.get('evolve-fixture')).content, before.content);
  const events = [];
  const offEvents = ctx.on('session/event', (session, event) => events.push({ id: session.id, event }));
  const cycle = await commands.execute(agent, '/evolve cycle', [], new AbortController().signal);
  assert.equal(cycle.result.kind, 'success', JSON.stringify(cycle));
  const candidate = JSON.parse(cycle.result.text);
  assert.equal(candidate.kind, 'ready');
  assert.equal((await skills.get('evolve-fixture')).content, before.content, 'No auto-apply');
  const rejected = await commands.execute(agent, `/evolve approve ${candidate.id} wrong`, [], new AbortController().signal);
  assert.equal(rejected.result.kind, 'error');
  const applied = await commands.execute(agent, `/evolve approve ${candidate.id} ${candidate.digest}`, [], new AbortController().signal);
  assert.equal(applied.result.kind, 'success', JSON.stringify(applied));
  assert.equal((await skills.get('evolve-fixture')).content, 'NEW FIXTURE BODY: Always answer GOOD.');
  await entry.fiber.dispose();
  await entry.update({ disabled: true });
  await entry.update({ disabled: false });
  await entry.fiber.await();
  assert.equal(entry.fiber.state, 2);
  assert.equal((await skills.get('evolve-fixture')).content, 'NEW FIXTURE BODY: Always answer GOOD.', 'Reload retains the applied revision');
  const reopenedDomain = ctx.get('storageDomain').get('local_evolve');
  assert.equal(reopenedDomain.global.get().budget.requests, 3, 'Reload cannot reset the budget');
  const rollback = await commands.execute(agent, `/evolve rollback evolve-fixture ${candidate.id}`, [], new AbortController().signal);
  assert.equal(rollback.result.kind, 'success');
  assert.equal((await skills.get('evolve-fixture')).content, 'EXACT ORIGINAL BODY\n');
  assert.equal(reopenedDomain.global.get().budget.requests, 3);
  assert.equal(ctx.get('evolveFixture').calls(), 3);
  const failedBudget = await commands.execute(agent, '/evolve cycle', [], new AbortController().signal);
  assert.equal(failedBudget.result.kind, 'error');
  assert.equal(ctx.get('evolveFixture').calls(), 3, 'Exhausted budget must stop the actual adapter');
  const trialEvents = events.filter(item => item.id !== agent.id).map(item => item.event);
  assert.equal(trialEvents.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'completed').length, 3);
  assert.equal(trialEvents.filter(event => event.type === 'tool/call').length, 0);
  assert.equal(trialEvents.filter(event => event.type === 'agent-preset/selected'
    && event.data.agentPreset === 'evolve-trial').length, 4, 'Every attempted run mounts and logs its evaluation preset');
  for (const header of trialEvents.filter(event => event.type === 'request/header')) {
    assert.equal(header.data.header.config.provider, 'evolve-mock');
    assert.equal(header.data.header.config.model, 'fixed');
  }
  await ctx.get('sessions').flush(agent.session);
  offEvents();
  await entry.fiber.dispose();
  assert.equal(ctx.get('tools').get('evolve_inspect'), undefined);
  assert.equal(commands.find(agent, 'evolve'), undefined);
  assert.equal(await skills.get('evolve-fixture'), undefined);
  process.stdout.write(JSON.stringify({ loader: true, pairedTrials: 1, noAutoApply: true,
    humanCommand: true, exactRollback: true, requestBudget: 3, disposal: true }) + '\n');
} finally {
  await ctx?.fiber.dispose();
}
