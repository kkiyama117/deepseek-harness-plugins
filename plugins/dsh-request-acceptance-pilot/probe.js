/** Temporary deterministic GUI command, restricted to the two approved synthetic Sessions. */
import assert from 'node:assert/strict';
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';
import { createScope } from '@deepseek-ai/dsh-scope';
import { existsSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const out = '/data/softwares/deepseek-harness-plugins/reports/goal-acceptance-20261016';
const selected = 'session-2b468884-e9fe-46c5-8816-c8620c9e73c3';
const control = 'session-2be5c73f-cea2-4fb9-aa9f-77bf31e78681';
const route = 'request-acceptance-pilot-mock';
const quote = 'SYNTHETIC PILOT: Slack Intake is the intake environment, not the verification target. Verify Bend/GPU, compare 学振審査 with official criteria, and test Codex/Astra operation in an authorized sandbox.';

export function applyProbe(ctx) {
  if (existsSync(`${out}/live-probe-evidence.json`)) return;
  const evidence = {};
  const releases = [];
  const calls = [];
  releases.push(ctx.on('llm/stream', async function* (options, next) {
    const agent = ctx.agents.get(options.sessionId);
    if ([selected, control].includes(options.sessionId) || agent?.session.header.parentSession === selected) {
      if (options.provider !== route) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PILOT_REAL_MODEL_DISABLED', message: 'Only scripted responses are authorized for this pilot.' } } };
        return;
      }
      calls.push({ sessionId: options.sessionId, provider: options.provider, model: options.model, purpose: options.purpose ?? 'task' });
    }
    yield* next();
  }));
  let childContext;
  class PilotAdapter extends LlmAdapter {
    async *stream(options) {
      const child = ctx.agents.get(options.sessionId);
      assert.equal(child?.session.header.parentSession, selected, 'mock adapter accepts only the approved pilot child');
      const texts = child.session.snapshotEvents().filter(event => event.type === 'user/message')
        .flatMap(event => event.data.content.filter(block => block.type === 'text').map(block => block.text)).join('\n');
      assert(texts.includes('<original_request>') && texts.includes(quote));
      for (const theme of ['Bend/GPU', '学振審査', 'Codex/Astra']) assert(texts.includes(theme));
      childContext = { childId: child.id, originalRequestRetained: true, themes: 3 };
      const text = 'SYNTHETIC CHILD: original request and all three acceptance items arrived; this does not certify parent completion.';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  releases.push(ctx.llm.registerAdapter([route], new PilotAdapter()));
  const mount = agent => {
    if (![selected, control].includes(agent.id)) return;
    ctx.effect(() => {
      const scope = createScope(ctx, agent);
      releases.push(() => scope.dispose());
      scope.ctx.tools.register({
        name: 'acceptance_pilot_observation', description: 'Return explicitly synthetic observations for the bounded acceptance pilot.', parameters: {},
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: value.text }] },
        async execute() { return { text: 'SYNTHETIC ONLY: Bend/GPU observed; 学振審査 comparison negative; Codex/Astra operation observed. Not a real article experiment. Process saved, exit 0.' }; },
      });
      releases.push(scope.ctx.commands.register({
        name: 'acceptance-pilot', description: '要求保持の限定合成試験を実行（実providerモデル呼出しなし）',
        async handler({ signal }) {
          assert.equal(agent.status, 'idle');
          assert.equal(ctx.goals.get(agent), undefined, 'pilot command runs once in each new synthetic Session');
          ctx.sessionTitle.rename(agent.session, agent.id === selected ? 'DSH要求保持：限定合成pilot' : 'DSH要求保持：対象外の対照試験');
          const turn = 1;
          agent.session.append('turn/start', { turn });
          agent.session.append('step/start', { turn, step: 1 });
          const human = agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: quote }] }), { surfaceOp: 'append' });
          const goal = ctx.goals.create(agent, { objective: 'SYNTHETIC PILOT: preserve all three material-specific acceptance items', maxGoalRounds: 3 });
          const call = async (name, args) => {
            const id = ToolCallId(randomUUID());
            const source = agent.session.append('tool/call', { turn, step: 1, callId: id, name, arguments: JSON.stringify(args) });
            const batch = await ctx.tools.execute({ agent, signal,
              calls: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }] });
            assert.equal(batch.results.length, 1);
            const result = batch.results[0].result;
            const event = agent.session.append('tool/result', { turn, step: 1, message: {
              role: 'tool', id: createUserMessage({ content: [], source: { kind: 'user' } }).id,
              source: { kind: 'tool', callId: id }, toolCallId: id, content: result.content, isError: result.isError,
            }, ...result.meta === undefined ? {} : { meta: result.meta } }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] });
            return { result, seq: event.seq };
          };
          const denied = () => {
            try { ctx.goals.complete(agent, goal); return false; }
            catch (error) { assert.equal(error.code, 'GOAL_ACCEPTANCE_MISSING'); return true; }
          };
          let checks;
          if (agent.id === control) {
            assert.equal(ctx.tools.get('request_check', agent), undefined);
            const prompt = await ctx.systemPrompt.assemble({ scope: agent });
            assert(!prompt.sections.some(section => section.text?.includes('Use request_check before')));
            assert.equal(ctx.goals.complete(agent, goal).phase, 'complete');
            checks = { excludedSession: true, noCheckpointTool: true, noAcceptanceGuidance: true, completionUnaffected: true };
          } else {
            assert(ctx.tools.get('request_check', agent));
            assert(denied());
            let c = { stage: 'delegate', request: { seq: human.seq, quote }, reviewed_through: human.seq,
              target: { value: '/tmp/reversible-pilot', origin: 'inferred', restricts_scope: false },
              items: ['Bend/GPU', '学振審査', 'Codex/Astra'].map((theme, i) => ({
                id: `theme-${i + 1}`, quote: theme, acceptance: `Return material-specific evidence for ${theme}`, status: 'pending', evidence: [],
              })), lessons: [] };
            const restricted = await call('request_check', { checkpoint: { ...c, target: { ...c.target, restricts_scope: true } } });
            assert.equal(restricted.result.isError, true);
            assert.equal((await call('request_check', { checkpoint: c })).result.isError, false);
            const prompt = await ctx.systemPrompt.assemble({ scope: agent });
            assert(prompt.sections.some(section => section.text?.includes('<original_request>') && section.text.includes(quote)));
            const child = await ctx.subagents.startActivation({ provider: 'spawn', label: 'Synthetic original-request propagation', delivery: 'caller', signal,
              request: { parent: agent, prompt: [{ type: 'text', text: 'Review only the queue implementation.' }], maxDepth: 1,
                agentOptions: { provider: route, model: route } } });
            await child.result;
            assert(childContext?.originalRequestRetained);
            c = { ...c, stage: 'complete', items: c.items.map(item => ({ ...item, status: 'not-applicable' })) };
            assert.equal((await call('request_check', { checkpoint: c })).result.isError, false);
            assert(denied());
            const observation = await call('acceptance_pilot_observation', {});
            assert.equal(observation.result.isError, false);
            c = { ...c, items: c.items.map(item => ({ ...item, status: 'satisfied', evidence: [{ seq: observation.seq, kind: 'mechanical', excerpt: 'Process saved, exit 0.' }] })) };
            assert.equal((await call('request_check', { checkpoint: c })).result.isError, false);
            assert(denied());
            c = { ...c, items: c.items.map((item, i) => ({ ...item, status: i === 1 ? 'negative' : 'satisfied',
              evidence: [{ seq: observation.seq, kind: 'outcome', excerpt: 'SYNTHETIC ONLY: Bend/GPU observed; 学振審査 comparison negative; Codex/Astra operation observed.' }] })) };
            assert.equal((await call('request_check', { checkpoint: c })).result.isError, false);
            assert.equal(ctx.goals.complete(agent, goal).phase, 'complete');
            checks = { missingCompletionDenied: true, inferredRestrictionDenied: true, routineSupplementAccepted: true,
              originalRequestDelegated: childContext, notApplicableDenied: true, mechanicalOnlyDenied: true, negativeOutcomeAccepted: true };
          }
          agent.session.append('step/end', { turn, step: 1 });
          agent.session.append('turn/end', { turn, reason: { kind: 'completed' } });
          await ctx.sessions.flush(agent.session);
          evidence[agent.id] = checks;
          if (evidence[selected] && evidence[control]) {
            writeFileSync(`${out}/live-probe-evidence.json`, JSON.stringify({ synthetic: true, realProviderModelCalls: 0, scriptedCalls: calls, sessions: evidence }, null, 2) + '\n');
            for (const release of releases.splice(0)) await release();
          }
          return { kind: 'success', text: `要求保持の限定合成試験：成功\n実providerモデル呼出し：0\n${JSON.stringify(checks)}` };
        },
      }));
      return agent.ctx.effect(() => () => scope.dispose());
    });
  };
  releases.push(ctx.on('agent/created', ({ agent }) => mount(agent)));
  for (const agent of ctx.agents.list()) mount(agent);
  writeFileSync(`${out}/browser-entry.private`, ctx.connection.authenticatedUrl('http://127.0.0.1:3080'), { mode: 0o600 });
}
