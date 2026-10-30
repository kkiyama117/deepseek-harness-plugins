import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-app-boot'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '../src/goal-provider.ts'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SubagentRuntime from '../src/subagent-provider.ts'
import { mountWorkingDirectoryFixture } from '@test-target/packages/subagent/subagent/tests/working-directory-fixture.ts'
import { liveConfig } from '@test-target/packages/settings/settings/tests/live-config.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as acceptance from '../src/index.ts'
import { TestSessionQuery } from '@test-target/packages/subagent/subagent/tests/test-session-query.ts'
import { checkRecord } from '../src/check.ts'
import type { Checkpoint, CheckRecord } from '../src/schema.ts'
import { stateSchema } from '../src/schema.ts'

function readState(ctx: Context, agent: Agent) {
  return stateSchema.parse(ctx.sessionProjections.stateOf(agent.session, 'requestAcceptance'))
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function own<T extends { dispose(): unknown }>(fiber: T): T {
  cleanups.push(async () => { await fiber.dispose() })
  return fiber
}

async function harness(enabled = true, config: acceptance.Config = {}) {
  const ctx = new Context()
  own(await ctx.plugin(SessionStore))
  own(await ctx.plugin(SessionProjectionRegistry))
  own(await ctx.plugin(AgentRegistry))
  own(await ctx.plugin(SystemPrompt))
  own(await ctx.plugin(ToolRuntime))
  own(await ctx.plugin(NativeToolExecutor))
  const goalFiber = own(await ctx.plugin(GoalService))
  own(await ctx.plugin(TestSessionQuery))
  const fiber = enabled ? own(await ctx.plugin(acceptance, config)) : undefined
  const makeAgent = async (session: Session = ctx.sessions.create(SessionId(randomUUID()))) => {
    const agent: Agent = {
      id: session.id, session, ctx, options: {}, model: unsupportedModel(), status: 'idle', inbox: createInboxStub(),
      send() {}, followup() {}, inject() {}, cancel() {},
      steer: () => ({ outcome: Promise.resolve({ status: 'rejected' }) }),
      runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
    }
    await ctx.agents.register(agent)
    return agent
  }
  const agent = await makeAgent()
  agent.session.append('turn/start', { turn: 1 })
  const user = agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{
    type: 'text', text: 'Slack Intake is the intake environment, not the verification target. Verify Bend/GPU with a small reproduction; compare 学振審査 with official criteria; test Codex/Astra operation in an authorized sandbox.',
  }] }), { surfaceOp: 'append' })
  const goal = ctx.goals.create(agent, { objective: 'Return material-specific verification and evidence for all three themes' })
  const checkpoint: Checkpoint = {
    stage: 'design', request: { seq: user.seq, quote: 'Slack Intake is the intake environment, not the verification target.' }, reviewed_through: user.seq,
    target: { value: '/workspace/slack-intake', origin: 'environment', restricts_scope: false },
    items: [
      { id: 'bend', quote: 'Bend/GPU', acceptance: 'Reproduce the material’s claim and report GPU limitations', status: 'pending', evidence: [] },
      { id: 'jsps', quote: '学振審査', acceptance: 'Compare official criteria and distinguish interpretation', status: 'pending', evidence: [] },
      { id: 'agents', quote: 'Codex/Astra', acceptance: 'Test an authorized operation and report product differences', status: 'pending', evidence: [] },
    ], lessons: [],
  }
  return { ctx, fiber, goalFiber, agent, goal, checkpoint, makeAgent }
}

async function call(ctx: Context, agent: Agent, checkpoint?: Checkpoint) {
  const id = ToolCallId(randomUUID())
  const args = checkpoint === undefined ? {} : { checkpoint }
  agent.session.append('tool/call', { turn: 1, step: 1, callId: id, name: 'request_check', arguments: JSON.stringify(args) })
  const result = await executeToolFixture(ctx, { agent, name: 'request_check', callId: id, arguments: args, signal: new AbortController().signal })
  agent.session.append('tool/result', { turn: 1, step: 1, message: { role: 'tool', id: createUserMessage({ content: [], source: { kind: 'user' } }).id,
    source: { kind: 'tool', callId: id }, toolCallId: id, content: result.content, isError: result.isError }, ...result.meta === undefined ? {} : { meta: result.meta } }, { surfaceOp: 'append' })
  return result
}

function evidence(agent: Agent, text: string, name = 'synthetic_observation', args = {}) {
  const id = ToolCallId(randomUUID())
  const call = agent.session.append('tool/call', { turn: 1, step: 1, callId: id, name, arguments: JSON.stringify(args) })
  return agent.session.append('tool/result', { turn: 1, step: 1, message: {
    role: 'tool', id: createUserMessage({ content: [], source: { kind: 'user' } }).id, source: { kind: 'tool', callId: id }, toolCallId: id,
    content: [{ type: 'text', text }], isError: false,
  } }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] }).seq
}

function completed(agent: Agent, checkpoint: Checkpoint): Checkpoint {
  const observations = ['Bend result: CPU reproduction passed; GPU unavailable', 'Official criteria comparison: interpretation not confirmed', 'Agent operation: authorized sandbox round trip verified']
  return { ...checkpoint, stage: 'complete', items: checkpoint.items.map((item, index) => ({
    ...item, status: index === 1 ? 'negative' : 'satisfied',
    evidence: [{ seq: evidence(agent, observations[index]!), kind: 'outcome', excerpt: observations[index]! }],
  })) }
}

describe('original request acceptance', () => {
  it('limits checks, guidance, tools and delegation context to exact configured Sessions', async () => {
    const h = await harness(false)
    const other = await h.makeAgent()
    const otherGoal = h.ctx.goals.create(other, { objective: 'Existing unrelated Goal' })
    const before = await h.ctx.systemPrompt.assemble({ scope: other })
    const futureId = SessionId(randomUUID())
    const fiber = own(await h.ctx.plugin(acceptance, { sessionIds: [h.agent.id, futureId] }))
    expect(h.ctx.tools.schemas(h.agent).some(tool => tool.name === 'request_check')).toBe(true)
    expect(h.ctx.tools.get('request_check', other)).toBeUndefined()
    expect((await h.ctx.systemPrompt.assemble({ scope: other })).sections.map(section => section.text).filter(Boolean))
      .toEqual(before.sections.map(section => section.text).filter(Boolean))
    expect((await call(h.ctx, other)).isError).toBe(true)
    expect(h.ctx.goals.complete(other, otherGoal).phase).toBe('complete')
    expect(() => h.ctx.goals.complete(h.agent, h.goal)).toThrow(/acceptance is missing/)

    await mountWorkingDirectoryFixture(h.ctx)
    await liveConfig(h.ctx, SubagentRuntime)
    const prompts: ContentBlock[][] = []
    h.ctx.subagents.registerProvider({
      name: 'capture', inheritsParentContext: false,
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, agentPreset: false },
      async start(request) {
        prompts.push(request.prompt)
        return { id: SessionId(randomUUID()), result: Promise.resolve({ output: [], stopReason: 'completed' }), async dispose() {} }
      },
    })
    const start = (parent: Agent) => h.ctx.subagents.startActivation({
      provider: 'capture', label: 'bounded review', delivery: 'caller',
      request: { parent, prompt: [{ type: 'text', text: 'Review the queue' }] }, signal: new AbortController().signal,
    })
    const unrelated = await start(other)
    await unrelated.result
    expect(JSON.stringify(prompts.at(-1))).not.toContain('<original_request>')
    await expect(start(h.agent)).rejects.toThrow(/checkpoint before delegation/)
    await call(h.ctx, h.agent, h.checkpoint)
    const selected = await start(h.agent)
    await selected.result
    expect(JSON.stringify(prompts.at(-1))).toContain('Bend/GPU')

    const future = await h.makeAgent(h.ctx.sessions.create(futureId))
    expect(h.ctx.tools.get('request_check', future)).toBeDefined()
    await fiber.dispose()
    expect(h.ctx.tools.get('request_check', h.agent)).toBeUndefined()
    expect(h.ctx.tools.get('request_check', future)).toBeUndefined()
    expect(h.ctx.goals.complete(h.agent, h.goal).phase).toBe('complete')
  })

  it('keeps an explicit empty Session list inert', async () => {
    const h = await harness(true, { sessionIds: [] })
    expect(h.ctx.tools.get('request_check', h.agent)).toBeUndefined()
    expect((await h.ctx.systemPrompt.assemble({ scope: h.agent })).sections.find(section => section.name === 'goal-acceptance')?.text ?? '').toBe('')
    expect(h.ctx.goals.complete(h.agent, h.goal).phase).toBe('complete')
  })

  it('keeps completion checks when a complete persona suppresses the guidance', async () => {
    const h = await harness()
    h.ctx.systemPrompt.section({ name: 'test-complete-persona', order: 0, complete: true, text: 'Explicit complete persona' })
    expect((await call(h.ctx, h.agent, h.checkpoint)).isError).toBe(false)
    const prompt = await h.ctx.systemPrompt.assemble({ scope: h.agent })
    expect(prompt.sections.map(section => section.text)).toEqual(['Explicit complete persona'])
    expect(h.ctx.tools.get('request_check', h.agent)).toBeDefined()
    expect(() => h.ctx.goals.complete(h.agent, h.goal)).toThrow(/acceptance is missing/)
    expect((await call(h.ctx, h.agent, completed(h.agent, h.checkpoint))).isError).toBe(false)
    expect(h.ctx.goals.complete(h.agent, h.goal).phase).toBe('complete')
  })

  it('demonstrates the old completion without outcome evidence, and rejects it with the plugin', async () => {
    const old = await harness(false)
    expect(old.ctx.goals.complete(old.agent, old.goal).phase).toBe('complete')
    const h = await harness()
    expect(() => h.ctx.goals.complete(h.agent, h.goal)).toThrow(/acceptance is missing/)
    expect(h.ctx.goals.get(h.agent)?.phase).toBe('active')
  })

  it('keeps all three not-applicable results incomplete despite tool success', async () => {
    const h = await harness()
    expect(h.ctx.tools.schemas(h.agent).some(tool => tool.name === 'request_check')).toBe(true)
    expect((await call(h.ctx, h.agent, h.checkpoint)).isError).toBe(false)
    const seq = evidence(h.agent, 'process exited 0; saved and notified')
    const narrowed: Checkpoint = { ...h.checkpoint, stage: 'complete', items: h.checkpoint.items.map(item => ({
      ...item, status: 'not-applicable', evidence: [{ seq, kind: 'mechanical', excerpt: 'process exited 0' }],
    })) }
    expect((await call(h.ctx, h.agent, narrowed)).isError).toBe(false)
    expect(() => h.ctx.goals.complete(h.agent, h.goal)).toThrow(/bend, jsps, agents/)
    const mechanicalOnly = { ...narrowed, items: narrowed.items.map(item => ({ ...item, status: 'satisfied' as const })) }
    expect((await call(h.ctx, h.agent, mechanicalOnly)).isError).toBe(false)
    expect(() => h.ctx.goals.complete(h.agent, h.goal)).toThrow(/bend, jsps, agents/)
    expect(h.ctx.goals.get(h.agent)?.phase).toBe('active')
  })

  it('rejects cwd, example and inferred restrictions but permits routine supplementation', async () => {
    const h = await harness()
    for (const origin of ['environment', 'example', 'inferred', 'material', 'unresolved'] as const) {
      const result = await call(h.ctx, h.agent, { ...h.checkpoint, target: { ...h.checkpoint.target, origin, restricts_scope: true } })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('scope restriction')
    }
    expect((await call(h.ctx, h.agent, { ...h.checkpoint, target: { value: '/tmp/reversible-experiment', origin: 'inferred', restricts_scope: false } })).isError).toBe(false)
  })

  it('rejects promotion from an environmental human mention without later confirmation', async () => {
    const h = await harness()
    h.checkpoint.target.value = 'Slack Intake'
    expect((await call(h.ctx, h.agent, h.checkpoint)).isError).toBe(false)
    const promoted: Checkpoint = { ...h.checkpoint,
      target: { value: 'Slack Intake', origin: 'human', restricts_scope: true, source_seq: h.checkpoint.request.seq } }
    expect((await call(h.ctx, h.agent, promoted)).isError).toBe(true)
    const confirmation = h.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'For this new applicability check, use Slack Intake as the target.' }] }), { surfaceOp: 'append' })
    expect((await call(h.ctx, h.agent, { ...promoted, reviewed_through: confirmation.seq,
      target: { ...promoted.target, source_seq: confirmation.seq } })).isError).toBe(false)
  })

  it('rejects dropped acceptance and replacement of the original request during repair', async () => {
    const h = await harness()
    await call(h.ctx, h.agent, h.checkpoint)
    const result = await call(h.ctx, h.agent, { ...h.checkpoint, stage: 'repair', items: h.checkpoint.items.slice(0, 1) })
    expect(JSON.stringify(result.content)).toContain('removed or changed')
    const changed = structuredClone(h.checkpoint)
    changed.items[0]!.acceptance = 'Check only repository relevance'
    expect((await call(h.ctx, h.agent, changed)).isError).toBe(true)
    const source = evidence(h.agent, 'Bend/GPU')
    expect((await call(h.ctx, h.agent, { ...h.checkpoint, request: { seq: source, quote: 'Bend/GPU' } })).isError).toBe(true)
  })

  it('accepts different substantive observations including a completed negative comparison', async () => {
    const h = await harness()
    await call(h.ctx, h.agent, h.checkpoint)
    expect((await call(h.ctx, h.agent, completed(h.agent, h.checkpoint))).isError).toBe(false)
    expect(h.ctx.goals.complete(h.agent, h.goal).phase).toBe('complete')
  })

  it('does not let a status read clear staleness after human input', async () => {
    const h = await harness()
    await call(h.ctx, h.agent, completed(h.agent, h.checkpoint))
    h.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Also preserve the result history.' }] }), { surfaceOp: 'append' })
    expect((await call(h.ctx, h.agent)).isError).toBe(false)
    expect(() => h.ctx.goals.complete(h.agent, h.goal)).toThrow(/stale/)
  })

  it('tracks a lesson read and the decision affected, without treating read as application', async () => {
    const h = await harness()
    const slug = 'deterministic-intake-enforced-execution'
    const seq = evidence(h.agent, 'programs, not supervision', 'kura_read', { slug })
    const c = { ...h.checkpoint, lessons: [{ slug, read_seq: seq, applied: false, decision: 'No supervision model is added; this checkpoint records that budgeting is not implemented here.' }] }
    expect((await call(h.ctx, h.agent, c)).isError).toBe(false)
    expect(readState(h.ctx, h.agent)?.current?.checkpoint.lessons[0]?.applied).toBe(false)
    expect((await call(h.ctx, h.agent, { ...c, lessons: [{ ...c.lessons[0]!, slug: 'other' }] })).isError).toBe(true)
  })

  it('retains accepted records across restoration and surface replacement, and isolates Sessions', async () => {
    const h = await harness()
    await call(h.ctx, h.agent, completed(h.agent, h.checkpoint))
    const seed = h.agent.session.snapshotEvents()
    const fork = await h.makeAgent(h.ctx.sessions.create(SessionId(randomUUID()), { seed }))
    expect(h.ctx.goals.complete(fork, h.goal).phase).toBe('complete')
    const other = await h.makeAgent()
    const goal = h.ctx.goals.create(other, { objective: 'independent request' })
    expect(() => h.ctx.goals.complete(other, goal)).toThrow(/missing/)
    expect(h.ctx.goals.get(h.agent)?.phase).toBe('active')
    h.agent.session.append('developer/message', { turn: 1, step: 1, message: { role: 'developer', source: { kind: 'system-prompt' }, id: createUserMessage({ content: [], source: { kind: 'user' } }).id, content: [{ type: 'text', text: 'Compacted surface summary' }] } },
      { surfaceOp: { op: 'replace', startSeq: h.agent.session.surface.nodes[0]!, endSeq: h.agent.session.surface.nodes.at(-1)! }, sourceEventSeqs: [...h.agent.session.surface.nodes] })
    expect(h.ctx.goals.complete(h.agent, h.goal).phase).toBe('complete')
  })

  it('accepts an independent Session while the first Session has a stale checkpoint', async () => {
    const h = await harness()
    await call(h.ctx, h.agent, h.checkpoint)
    const other = await h.makeAgent()
    other.session.append('turn/start', { turn: 1 })
    const human = other.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
      text: h.checkpoint.request.quote + ' Bend/GPU 学振審査 Codex/Astra' }] }), { surfaceOp: 'append' })
    const goal = h.ctx.goals.create(other, { objective: 'Independent result' })
    const c = { ...h.checkpoint, request: { ...h.checkpoint.request, seq: human.seq }, reviewed_through: human.seq }
    await call(h.ctx, other, completed(other, c))
    h.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'New first-session input' }] }),
      { surfaceOp: 'append' })
    expect(() => h.ctx.goals.complete(h.agent, h.goal)).toThrow(/stale/)
    expect(h.ctx.goals.complete(other, goal).phase).toBe('complete')
  })

  it('replays the recorded scope rejection without changing its tool declaration', async () => {
    const h = await harness()
    const raw = await readFile(new URL('./fixtures/recorded-policy/session.v4.jsonl', import.meta.url), 'utf8')
    const rows = raw.trimEnd().split('\n').map(line => JSON.parse(line))
    const events = rows.slice(1).map((row, index) => ({ ...row, seq: SessionSeq(index), time: rows[0].createdAt + index }) as SessionEvent)
    const restored = h.ctx.sessions.create(SessionId(randomUUID()), { seed: events })
    const agent = await h.makeAgent(restored)
    expect(h.ctx.goals.get(agent)).toBeUndefined()
    expect(readState(h.ctx, agent).current).toBeNull()
    const recordedCall = events.find(event => event.type === 'tool/call')!
    const recordedResult = events.find(event => event.type === 'tool/result')!
    if (recordedCall.type !== 'tool/call' || recordedResult.type !== 'tool/result') throw new Error('Expected recorded policy call/result')
    const response = await call(h.ctx, agent, JSON.parse(recordedCall.data.arguments).checkpoint)
    expect(response.isError).toBe(true)
    expect(response.content).toEqual(recordedResult.data.message.content)
    const schemas = JSON.parse(await readFile(new URL('./fixtures/recorded-policy/tool-schemas.expected.json', import.meta.url), 'utf8'))
    expect(h.ctx.tools.schemas(agent).find(tool => tool.name === 'request_check')).toEqual(schemas.initial.find((tool: { name: string }) => tool.name === 'request_check'))
  })

  it('restores the policy and retained checkpoint when its Goal provider reloads', async () => {
    const h = await harness()
    expect((await call(h.ctx, h.agent, h.checkpoint)).isError).toBe(false)
    const resumed = Promise.withResolvers<void>()
    const stop = h.ctx.on('internal/status', fiber => {
      if (fiber === h.fiber && fiber.state === FiberState.ACTIVE) resumed.resolve()
    })
    try {
      await h.goalFiber.dispose()
      expect(h.ctx.get('goals')).toBeUndefined()
      own(await h.ctx.plugin(GoalService))
      await resumed.promise
      expect(() => h.ctx.goals.complete(h.agent, h.goal)).toThrow(/acceptance/)
      expect((await call(h.ctx, h.agent, completed(h.agent, h.checkpoint))).isError).toBe(false)
      expect(h.ctx.goals.complete(h.agent, h.goal).phase).toBe('complete')
    } finally { stop() }
  })

  it('fails bounded records loudly and removes policies and schemas on unload', async () => {
    const h = await harness(true, { maxRecordBytes: 32 })
    expect((await call(h.ctx, h.agent, h.checkpoint)).isError).toBe(true)
    await h.fiber!.dispose()
    expect(h.ctx.tools.get('request_check')).toBeUndefined()
    expect(h.ctx.goals.complete(h.agent, h.goal).phase).toBe('complete')
  })

  it('retains a requirement added by an earlier human message after a later routine followup', async () => {
    const h = await harness()
    await call(h.ctx, h.agent, h.checkpoint)
    const addition = h.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Also preserve history.' }] }), { surfaceOp: 'append' })
    const extended: Checkpoint = { ...h.checkpoint, reviewed_through: addition.seq, items: [...h.checkpoint.items,
      { id: 'history', quote: 'preserve history', source_seq: addition.seq, acceptance: 'Keep prior history unchanged', status: 'pending', evidence: [] },
    ] }
    expect((await call(h.ctx, h.agent, extended)).isError).toBe(false)
    const routine = h.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue.' }] }), { surfaceOp: 'append' })
    expect((await call(h.ctx, h.agent, { ...extended, reviewed_through: routine.seq })).isError).toBe(false)
  })

  it('ignores unrelated and duplicate checkpoint metadata and rejects late stale results', async () => {
    const h = await harness()
    const c = completed(h.agent, h.checkpoint)
    await call(h.ctx, h.agent, c)
    const state = readState(h.ctx, h.agent)!
    const id = ToolCallId(randomUUID())
    h.agent.session.append('tool/call', { turn: 1, step: 1, callId: id, name: 'unrelated', arguments: '{}' })
    h.agent.session.append('tool/result', { turn: 1, step: 1, message: { role: 'tool', id: createUserMessage({ content: [], source: { kind: 'user' } }).id, source: { kind: 'tool', callId: id }, toolCallId: id, content: [], isError: false }, meta: JSON.parse(JSON.stringify({ ...state.current!, checkpoint: { ...c, reviewed_through: 99999 } })) as NonNullable<ToolExecutionResult['meta']> }, { surfaceOp: 'append' })
    expect(readState(h.ctx, h.agent)?.current).toEqual(state.current)
    const writeId = ToolCallId(randomUUID())
    h.agent.session.append('tool/call', { turn: 1, step: 1, callId: writeId, name: 'request_check', arguments: JSON.stringify({ checkpoint: c }) })
    h.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'New requirement.' }] }), { surfaceOp: 'append' })
    h.agent.session.append('tool/result', { turn: 1, step: 1, message: { role: 'tool', id: createUserMessage({ content: [], source: { kind: 'user' } }).id, source: { kind: 'tool', callId: writeId }, toolCallId: writeId, content: [], isError: false }, meta: JSON.parse(JSON.stringify(state.current)) as NonNullable<ToolExecutionResult['meta']> }, { surfaceOp: 'append' })
    expect(() => h.ctx.goals.complete(h.agent, h.goal)).toThrow(/stale/)
  })

  it('carries the original request to a narrow child and does not constrain a later routine task after Goal completion', async () => {
    const h = await harness()
    await mountWorkingDirectoryFixture(h.ctx)
    await liveConfig(h.ctx, SubagentRuntime)
    const prompts: ContentBlock[][] = []
    h.ctx.subagents.registerProvider({
      name: 'capture', inheritsParentContext: false,
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, agentPreset: false },
      async start(request) {
        prompts.push(request.prompt)
        return { id: SessionId(randomUUID()), localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' }), async dispose() {} }
      },
    })
    const request = { provider: 'capture', label: 'narrow review', delivery: 'caller' as const,
      request: { prompt: [{ type: 'text' as const, text: 'Review only the queue implementation' }], parent: h.agent },
      signal: new AbortController().signal }
    await expect(h.ctx.subagents.startActivation(request)).rejects.toThrow(/checkpoint before delegation/)
    expect(prompts).toHaveLength(0)
    await call(h.ctx, h.agent, h.checkpoint)
    const run = await h.ctx.subagents.startActivation(request)
    await run.dispose()
    const childText = JSON.stringify(prompts[0])
    expect(childText).toContain('intake environment, not the verification target')
    for (const theme of ['Bend/GPU', '学振審査', 'Codex/Astra']) expect(childText).toContain(theme)
    const edited = h.ctx.goals.edit(h.agent, h.goal, { objective: 'Authorized objective edit' })
    await expect(h.ctx.subagents.startActivation(request)).rejects.toThrow(/checkpoint before delegation/)
    await call(h.ctx, h.agent, completed(h.agent, h.checkpoint))
    h.ctx.goals.complete(h.agent, edited)
    const later = await h.ctx.subagents.startActivation(request)
    await later.dispose()
    expect(prompts.at(-1)).toEqual(request.request.prompt)
  })

  it('retains a nested PTC checkpoint and its negative outcome evidence', async () => {
    const h = await harness()
    const rootCallId = ToolCallId('root-ptc')
    const evidenceId = ToolCallId('root-ptc:ptc:1')
    h.agent.session.append('tool/ptc-dispatch-start', { rootCallId, parentCallId: rootCallId, subCallId: evidenceId,
      name: 'synthetic_observation', arguments: {} })
    const observation = h.agent.session.append('tool/ptc-dispatch', { rootCallId, parentCallId: rootCallId, subCallId: evidenceId,
      name: 'synthetic_observation', arguments: {}, isError: false, content: [{ type: 'text', text: 'comparison did not confirm the claim' }] })
    const c: Checkpoint = { ...h.checkpoint, stage: 'complete', items: h.checkpoint.items.map(item => ({ ...item, status: 'negative',
      evidence: [{ seq: observation.seq, kind: 'outcome', excerpt: 'comparison did not confirm the claim' }] })) }
    const id = ToolCallId('root-ptc:ptc:2')
    const args = { checkpoint: c }
    h.agent.session.append('tool/ptc-dispatch-start', { rootCallId, parentCallId: rootCallId, subCallId: id,
      name: 'request_check', arguments: args })
    const result = await executeToolFixture(h.ctx, { agent: h.agent, name: 'request_check', callId: id, arguments: args,
      signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    h.agent.session.append('tool/ptc-dispatch', { rootCallId, parentCallId: rootCallId, subCallId: id,
      name: 'request_check', arguments: args, isError: result.isError, content: result.content })
    expect(h.ctx.goals.complete(h.agent, h.goal).phase).toBe('complete')
  })

  it('preserves pre-Goal design requirements when a Goal is created, and invalidates objective edits', async () => {
    const h = await harness()
    h.ctx.goals.clear(h.agent, h.goal)
    await call(h.ctx, h.agent, h.checkpoint)
    const goal = h.ctx.goals.create(h.agent, { objective: 'Bind the existing design' })
    expect((await call(h.ctx, h.agent, { ...h.checkpoint, items: h.checkpoint.items.slice(0, 1) })).isError).toBe(true)
    await call(h.ctx, h.agent, h.checkpoint)
    h.ctx.goals.edit(h.agent, goal, { objective: 'Different authorized objective' })
    expect(readState(h.ctx, h.agent)?.invalidated).toBe(true)
  })

  it('rejects self-certification and missing or duplicate citations', async () => {
    const h = await harness()
    await call(h.ctx, h.agent, h.checkpoint)
    const selfSeq = h.agent.session.snapshotEvents().findLast(event => event.type === 'tool/result')!.seq
    const c = completed(h.agent, h.checkpoint)
    c.items[0]!.evidence = [{ seq: selfSeq, kind: 'outcome', excerpt: 'request-check' }]
    expect((await call(h.ctx, h.agent, c)).isError).toBe(true)
    c.items[0]!.evidence[0]!.seq = 99999
    expect((await call(h.ctx, h.agent, c)).isError).toBe(true)
    c.items[0]!.evidence = []
    c.items[1]!.id = 'bend'
    expect((await call(h.ctx, h.agent, c)).isError).toBe(true)
    const record: CheckRecord = { kind: 'request-check', version: 1, goal: { id: h.goal.id, objective: h.goal.objective }, checkpoint: h.checkpoint }
    const read = (seq: number) => Promise.resolve(h.agent.session.eventAt(SessionSeq(seq)))
    expect(await checkRecord(read, { current: null, invalidated: false, latestHumanSeq: -1,
      pendingWriteCallId: null, pendingCheckpointDigest: null }, record)).toContain('reviewed_through')
  })
})
