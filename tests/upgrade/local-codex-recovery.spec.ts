import { it, expect, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as retry from '@deepseek-ai/dsh-llm-retry'
import { MockAdapter, textResponse } from '@test-target/packages/core/agent-loop/tests/mock-adapter.ts'
import * as recovery from '../../plugins/dsh-codex-transport-recovery/index.mjs'

const failed = (code: number): StreamChunk[] => [{ type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message: `WebSocket closed ${code}` } } }]
class Adapter extends MockAdapter {
  override providerRetryPolicy(): ResolvedRetryPolicy {
    return { mode: 'normal', maxRetries: 2, retryableCodes: ['TRANSPORT'], initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }
  }
}
async function run(enabled: boolean, responses: StreamChunk[][]) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(retry)
  if (enabled) await ctx.plugin(recovery)
  const adapter = new Adapter(responses)
  ctx.llm.registerAdapter(['openai-codex'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(`transport-${crypto.randomUUID()}`), { provider: 'openai-codex', model: 'fixture' })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'recover' }] }))
  await agent.whenIdle()
  return { adapter, events: agent.session.snapshotEvents() }
}
it.each([1000, 1012])('reproduces terminal close %i without correction and no retry', async (code) => {
  const { adapter, events } = await run(false, [failed(code)])
  expect(adapter.requests).toHaveLength(1)
  expect(events.filter(e => e.type === 'llm/retry')).toHaveLength(0)
  expect(events.at(-1)?.data).toMatchObject({ reason: { kind: 'error', error: { code: 'PI_AI_ERROR' } } })
})
it.each([1000, 1012])('recovers from close %i through the official retry executor without changing the route', async (code) => {
  const { adapter, events } = await run(true, [failed(code), textResponse('recovered')])
  expect(adapter.requests).toHaveLength(2)
  expect(adapter.requests.map(r => [r.provider, r.model])).toEqual([['openai-codex', 'fixture'], ['openai-codex', 'fixture']])
  expect(events.filter(e => e.type === 'llm/retry')).toHaveLength(1)
  expect(events.at(-1)?.data).toMatchObject({ reason: { kind: 'completed' } })
})
it.each([1000, 1012])('stops after the configured finite retry budget when close %i persists', async (code) => {
  const { adapter, events } = await run(true, [failed(code), failed(code), failed(code)])
  expect(adapter.requests).toHaveLength(3)
  expect(events.filter(e => e.type === 'llm/retry')).toHaveLength(2)
  expect(events.at(-1)?.data).toMatchObject({ reason: { kind: 'error', error: { code: 'TRANSPORT' } } })
})
