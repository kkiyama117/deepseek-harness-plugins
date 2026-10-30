/** Synthetic model input drives the real tool pipeline and Goal service without an API call. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-gateway'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-agent'
import type { Checkpoint } from '../../src/schema.ts'

class AcceptanceAdapter extends LlmAdapter {
  private readonly ctx: Context
  constructor(ctx: Context) { super(); this.ctx = ctx }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const agent = options.sessionId === undefined ? undefined : this.ctx.agents.get(options.sessionId)
    if (agent === undefined) throw new Error('fixture requires a live Agent')
    const events = agent.session.snapshotEvents()
    const steps = events.filter(event => event.type === 'assistant/message').length
    if (steps >= 2) {
      const text = 'NOT_COMPLETE: all three material-specific outcomes remain missing.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    let name = 'completion_probe'
    let args = '{}'
    if (steps === 0) {
      const user = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
      if (user === undefined) throw new Error('fixture requires direct human source')
      const checkpoint: Checkpoint = {
        stage: 'complete', request: { seq: user.seq, quote: 'Slack Intake is an intake environment, not the target.' }, reviewed_through: user.seq,
        target: { value: '/workspace/slack-intake', origin: 'environment', restricts_scope: false },
        items: ['Bend/GPU', '学振審査', 'Codex/Astra'].map((theme, index) => ({
          id: `theme-${index + 1}`, quote: theme, acceptance: `Return material-specific work and findings for ${theme}`,
          status: 'not-applicable', evidence: [],
        })), lessons: [],
      }
      name = 'request_check'
      args = JSON.stringify({ checkpoint })
    }
    const id = ToolCallId(`acceptance-${steps + 1}`)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

export const name = 'acceptance-fixture'
export const inject = ['llm', 'agents', 'goals', 'subagents', 'tools', 'typertGateway']
export function apply(ctx: Context): void {
  assert.deepEqual(remoteMethods(ctx.goals).map(row => row.exportName ?? row.method).sort(), ['clear', 'complete', 'create', 'edit', 'get', 'pause', 'resume'])
  assert.equal(ctx.subagents.resolveMaxDepth(), 2)
  ctx.llm.registerAdapter(['acceptance-mock'], new AcceptanceAdapter(ctx))
  ctx.on('agent/pre-step', ({ agent }, next) => {
    if (ctx.goals.get(agent) === undefined) ctx.goals.create(agent, { objective: 'Return useful material-specific work for Bend/GPU, 学振審査, and Codex/Astra', maxGoalRounds: 3 })
    return next()
  })
  ctx.tools.register(defineTool({
    name: 'completion_probe', description: 'Attempt direct Goal completion for the synthetic fixture.', parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { phase: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.phase }] },
    async execute(_args, exec) {
      if (exec.agent === undefined) throw new Error('fixture requires an Agent')
      const goal = ctx.goals.get(exec.agent)
      if (goal === undefined) throw new Error('fixture requires a Goal')
      const before = exec.agent.session.seq
      const peer = new Peer(ctx, { principal: { kind: 'owner' } })
      try {
        await assert.rejects(ctx.typertGateway.invoke({ peer, namespace: 'goals', method: 'complete',
          args: { agentId: exec.agent.id, ref: { id: goal.id, revision: goal.revision } } }), /Goal acceptance is unmet/)
        assert.equal(exec.agent.session.seq, before)
        assert.equal(ctx.goals.get(exec.agent)?.phase, 'active')
        console.log('GATEWAY_POLICY_REJECTED_WITHOUT_MUTATION')
      } finally { await peer.dispose() }
      return { phase: ctx.goals.complete(exec.agent, goal).phase }
    },
  }))
}
