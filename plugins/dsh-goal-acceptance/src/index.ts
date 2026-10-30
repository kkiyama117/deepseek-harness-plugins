/** Opt-in, Session-local request retention and evidence-backed Goal completion checks. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-query'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import AcceptanceGoalProvider from './goal-provider.ts'
import AcceptanceSubagentProvider from './subagent-provider.ts'
import { checkRecord, eventText, isHuman, missingItems } from './check.ts'
import { checkpointSchema, recordSchema, stateSchema } from './schema.ts'
import type { CheckRecord, CheckState } from './schema.ts'

export const name = 'goal-acceptance'
export const inject = ['agents', 'goals', 'tools', 'systemPrompt', 'sessionProjections', 'sessionQuery']

/** Complete accepted record size limit, including Goal identity and metadata. */
export interface Config {
  /** Maximum UTF-8 bytes per checkpoint; oversized records fail rather than truncate. */
  maxRecordBytes?: number
  /** Exact participating Session ids; 'all' covers every Session, an empty list covers none. */
  sessionIds?: 'all' | string[]
}

export const Config: z<Config> = z.object({
  maxRecordBytes: z.number().step(1).min(1).default(16384),
  sessionIds: z.union([z.const('all'), z.array(z.string().min(1))]).default('all'),
})

/** Stable model guidance; no memory bodies or extra model calls are included. */
export const GUIDANCE = 'Use request_check before detailed design, delegation, repair after failure, and completion. '
  + 'Keep original human quotations and acceptance items; label targets as human, inferred, example, environment, material, or unresolved. '
  + 'Routine reversible details need no human confirmation. A scope restriction needs a human-specified target. '
  + 'Record outcome observations separately from process/test/tool success, and connect each retrieved lesson to a changed decision or explain non-application. '
  + 'A child reporting done is not parent acceptance. Before claiming completion, record a complete checkpoint with outcome evidence for every item. '
  + 'request_check validates citations and retained conditions, not the truth or semantic relevance of model judgments.'

const inputSchema = zod.object({ checkpoint: checkpointSchema.optional() }).strict()
const checkpointDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Fold only committed checkpoints; ordinary steps do not scan history.
 * @param state - prior per-Session state.
 * @param event - next committed event.
 * @returns updated state or the same reference for irrelevant events.
 */
export function applyAcceptance(state: CheckState, event: SessionEvent): CheckState {
  if (isHuman(event)) return { ...state, latestHumanSeq: event.seq, invalidated: true }
  if (event.type === 'goal/change') {
    if (event.data.operation === 'clear' || event.data.operation === 'complete'
      || (event.data.operation === 'create' && state.current?.goal !== null)) {
      return { ...state, current: null, invalidated: true, pendingWriteCallId: null, pendingCheckpointDigest: null }
    }
    if (event.data.operation === 'edit' || event.data.operation === 'create') {
      return { ...state, invalidated: true, pendingWriteCallId: null, pendingCheckpointDigest: null }
    }
    return state
  }
  if ((event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') && event.data.name === 'request_check') {
    let args: unknown
    try { args = event.type === 'tool/call' ? JSON.parse(event.data.arguments) : event.data.arguments } catch {
      return { ...state, pendingWriteCallId: null, pendingCheckpointDigest: null }
    }
    const parsed = inputSchema.safeParse(args)
    const checkpoint = parsed.success ? parsed.data.checkpoint : undefined
    const callId = event.type === 'tool/call' ? event.data.callId : event.data.subCallId
    return { ...state, pendingWriteCallId: checkpoint === undefined ? null : callId,
      pendingCheckpointDigest: checkpoint === undefined ? null : checkpointDigest(checkpoint) }
  }
  if (event.type !== 'tool/result' && event.type !== 'tool/ptc-dispatch') return state
  const failed = event.type === 'tool/result' ? event.data.message.isError : event.data.isError
  if (failed) return { ...state, invalidated: true, pendingWriteCallId: null, pendingCheckpointDigest: null }
  const callId = event.type === 'tool/result' ? event.data.message.toolCallId : event.data.subCallId
  if (callId !== state.pendingWriteCallId) return state
  let meta: unknown
  if (event.type === 'tool/result') meta = event.data.meta
  else {
    let value: unknown
    try { value = JSON.parse(eventText(event)) } catch {
      return { ...state, invalidated: true, pendingWriteCallId: null, pendingCheckpointDigest: null }
    }
    if (typeof value === 'object' && value !== null && 'record' in value) meta = value.record
  }
  const decoded = recordSchema.safeParse(meta)
  return decoded.success && decoded.data.checkpoint.reviewed_through === state.latestHumanSeq
    && checkpointDigest(decoded.data.checkpoint) === state.pendingCheckpointDigest
    ? { ...state, current: decoded.data, invalidated: false, pendingWriteCallId: null, pendingCheckpointDigest: null }
    : { ...state, invalidated: true, pendingWriteCallId: null, pendingCheckpointDigest: null }
}

/** Host-only projection derived from existing tool-result metadata, not a new Session event. */
const acceptanceProjection = {
  key: 'requestAcceptance',
  stateVersion: 1,
  stateSchema,
  init: (): CheckState => ({ current: null, invalidated: false, latestHumanSeq: -1,
    pendingWriteCallId: null, pendingCheckpointDigest: null }),
  apply: applyAcceptance,
} satisfies ProjectionDefinition<'requestAcceptance', CheckState>

/** Bounded original request and acceptance examples carried into child prompts.
 * @param record - already validated accepted checkpoint.
 * @returns context with model supplementation visibly separate from human quotation.
 */
export function requestCapsule(record: CheckRecord): string {
  const c = record.checkpoint
  return '<original_request>\n' + JSON.stringify({
    request: c.request,
    acceptance: c.items.map(({ id, quote, source_seq, acceptance }) => ({ id, quote, source_seq, acceptance })),
    target: c.target,
  }) + '\nHuman quotations are source evidence; acceptance wording and target classifications are model judgments. '
    + 'Do not replace the original request with the delegated subtask. Report work evidence and unmet items to the parent; child completion does not certify the parent goal.\n</original_request>'
}

/** Register optional policies without changing the shipped default composition.
 * @param ctx - owning plugin context.
 * @param config - complete checkpoint byte budget and participating Sessions.
 * @returns after the retained projection reader and dependent policies are installed.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const maxBytes = config.maxRecordBytes ?? 16384
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxRecordBytes must be a positive safe integer')
  const goals = ctx.goals
  if (!(goals instanceof AcceptanceGoalProvider)) throw new Error('goal-acceptance requires its configured Goal provider')
  const selected = Array.isArray(config.sessionIds) ? new Set(config.sessionIds) : undefined
  const includes = (agent: Agent): boolean => selected === undefined || selected.has(agent.id)
  const projection = await ctx.sessionProjections.register(acceptanceProjection)
  const stateOf = (agent: Agent): CheckState => projection.stateOf(agent.session)
  const unfinishedGoal = (agent: Agent) => {
    const goal = ctx.goals.get(agent)
    return goal?.phase === 'complete' ? undefined : goal
  }
  ctx.systemPrompt.section({
    name: 'goal-acceptance', order: 710, interpolate: false,
    text: ({ scope }) => {
      const agent = scope as Agent | undefined
      if (agent?.session === undefined) return selected === undefined ? GUIDANCE : ''
      if (!includes(agent)) return ''
      const state = stateOf(agent)
      return GUIDANCE + (state.current === null ? '' : '\n' + requestCapsule(state.current))
    },
  })
  goals.registerCompletionCheck((agent, goal) => {
    if (!includes(agent)) return undefined
    const state = stateOf(agent)
    const record = state.current
    if (record === null || record.goal?.id !== goal.id || record.goal.objective !== goal.objective
      || state.invalidated || record.checkpoint.stage !== 'complete'
      || record.checkpoint.reviewed_through !== state.latestHumanSeq) {
      return 'Goal acceptance is missing or stale. Use request_check and record a complete checkpoint for the original request.'
    }
    const missing = missingItems(record)
    return missing.length ? `Goal acceptance is unmet: ${missing.join(', ')}. Process success is not outcome evidence.` : undefined
  })
  ctx.inject(['subagents'], (child) => {
    const subagents = child.subagents
    if (!(subagents instanceof AcceptanceSubagentProvider)) throw new Error('goal-acceptance requires its configured subagent provider')
    subagents.registerPromptContext((parent): ContentBlock[] => {
      if (!includes(parent)) return []
      const goal = unfinishedGoal(parent)
      const state = stateOf(parent)
      if (goal === undefined && state.current === null) return []
      if (state.current === null || state.invalidated || (goal !== undefined
        && (state.current.goal?.id !== goal.id || state.current.goal.objective !== goal.objective))) {
        throw new HarnessError('Record a request_check checkpoint before delegation.', 'REQUEST_CHECK_MISSING')
      }
      return [{ type: 'text', text: requestCapsule(state.current) }]
    })
  })
  const tool: ToolDefinition = {
    name: 'request_check',
    description: 'Read the retained original request and missing acceptance items, or record a design/delegate/repair/complete checkpoint. Omit checkpoint to read; citations use this Session’s event sequence numbers.',
    parameters: JSON.parse(JSON.stringify(zod.toJSONSchema(inputSchema))) as Record<string, unknown>,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (args, value) => {
        const input = inputSchema.parse(args)
        return input.checkpoint !== undefined && typeof value === 'object' && value !== null && !Array.isArray(value)
          ? value['record'] ?? null : null
      },
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new HarnessError('request_check requires an owning Agent', 'REQUEST_CHECK_NO_AGENT')
      const agent = exec.agent
      const input = inputSchema.parse(args)
      const state = stateOf(agent)
      const reads = new Map<number, Promise<SessionEvent | undefined>>()
      const read = (seq: number): Promise<SessionEvent | undefined> => {
        if (seq >= agent.session.seq) return Promise.resolve(undefined)
        const existing = reads.get(seq)
        if (existing !== undefined) return existing
        const pending = ctx.sessionQuery.readEvent({ sessionId: agent.id, seq: SessionSeq(seq), before: 0, after: 0 }, exec.signal)
          .then(window => window.target)
        reads.set(seq, pending)
        return pending
      }
      let record = state.current
      if (input.checkpoint !== undefined) {
        const goal = unfinishedGoal(agent)
        record = { kind: 'request-check', version: 1, goal: goal === undefined ? null : { id: goal.id, objective: goal.objective }, checkpoint: input.checkpoint }
        if (Buffer.byteLength(JSON.stringify(record)) > maxBytes) throw new HarnessError('Checkpoint exceeds maxRecordBytes; reduce it without dropping requirements.', 'REQUEST_CHECK_TOO_LARGE')
        const reason = await checkRecord(read, state, record)
        if (reason !== undefined) throw new HarnessError(reason, 'REQUEST_CHECK_INVALID')
      }
      const human = state.latestHumanSeq < 0 ? undefined : await read(state.latestHumanSeq)
      const text = eventText(human)
      return {
        record,
        missing: record === null ? ['checkpoint'] : missingItems(record),
        stale: input.checkpoint === undefined && state.invalidated,
        latest_human: { seq: state.latestHumanSeq, excerpt: text.slice(0, 2000), truncated: text.length > 2000 },
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Check request acceptance', kind: 'other' }),
  }
  if (selected === undefined) {
    ctx.tools.register(tool)
  } else {
    const mount = (agent: Agent): void => {
      if (!includes(agent)) return
      ctx.effect(() => {
        const scope = createScope(ctx, agent)
        scope.ctx.tools.register(tool)
        return agent.ctx.effect(() => () => scope.dispose())
      })
    }
    ctx.on('agent/created', ({ agent }) => { mount(agent) })
    for (const agent of ctx.agents.list()) mount(agent)
  }
}
