/** Mechanical evidence checks; semantic relevance remains a model or human judgment. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import type { CheckRecord, CheckState } from './schema.ts'

/** Recognize direct human input, not a child report, continuation, or injected notice.
 * @param event - committed Session event.
 * @returns whether it is a direct human message.
 */
export function isHuman(event: SessionEvent): event is SessionEvent<'user/message'> {
  return event.type === 'user/message' && event.data.source.kind === 'user'
}

/** Extract plain text without copying tool arguments or provider replay data.
 * @param event - cited Session event.
 * @returns text available as evidence, or an empty string for other event types.
 */
export function eventText(event: SessionEvent | undefined): string {
  const content = event?.type === 'user/message' ? event.data.content
    : event?.type === 'tool/result' ? event.data.message.content
      : event?.type === 'tool/ptc-dispatch' ? event.data.content : []
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/** List unsatisfied acceptance items without interpreting prose.
 * @param record - accepted checkpoint.
 * @returns item ids lacking a completed positive or negative outcome observation.
 */
export function missingItems(record: CheckRecord): string[] {
  return record.checkpoint.items.filter(item =>
    !['satisfied', 'negative'].includes(item.status)
    || !item.evidence.some(evidence => evidence.kind === 'outcome'),
  ).map(item => item.id)
}

/** Exact async event reader; callers cache only this checkpoint's cited positions. */
export type ReadEvidenceEvent = (seq: number) => Promise<SessionEvent | undefined>

function successfulResult(event: SessionEvent | undefined): event is SessionEvent<'tool/result' | 'tool/ptc-dispatch'> {
  return event?.type === 'tool/result' ? !event.data.message.isError
    : event?.type === 'tool/ptc-dispatch' && !event.data.isError
}

async function sourceCall(read: ReadEvidenceEvent, source: SessionEvent<'tool/result' | 'tool/ptc-dispatch'>) {
  if (source.type === 'tool/ptc-dispatch') return { name: source.data.name, arguments: JSON.stringify(source.data.arguments) }
  for (const seq of source.sourceEventSeqs ?? []) {
    const event = await read(seq)
    if (event?.type === 'tool/call' && event.data.callId === source.data.message.toolCallId) return event.data
    if (event?.type === 'assistant/message') {
      const block = event.data.message.content.find(block => block.type === 'tool-call'
        && block.id === source.data.message.toolCallId)
      if (block?.type === 'tool-call') return { name: block.name, arguments: block.arguments }
    }
  }
  return undefined
}

/** Reject unsupported origin claims, scope narrowing, and evidence citations.
 * @param read - bounded asynchronous access to exact cited events.
 * @param state - prior accepted checkpoint and latest human input.
 * @param record - bounded proposed checkpoint.
 * @returns rejection reason, or undefined when mechanical checks pass.
 */
export async function checkRecord(read: ReadEvidenceEvent, state: CheckState, record: CheckRecord): Promise<string | undefined> {
  const c = record.checkpoint
  const request = await read(c.request.seq)
  if (request === undefined || !isHuman(request) || !eventText(request).includes(c.request.quote)) {
    return 'request must quote a direct human user/message in this Session'
  }
  if (c.reviewed_through !== state.latestHumanSeq) return 'reviewed_through must name the latest direct human message'
  const prior = state.current
  const finishedWithoutGoal = prior !== null && prior.goal === null
    && prior.checkpoint.stage === 'complete' && missingItems(prior).length === 0
    && c.request.seq > prior.checkpoint.reviewed_through
  if (prior !== null && !finishedWithoutGoal && (prior.goal === null || prior.goal.id === record.goal?.id)) {
    if (prior.checkpoint.request.seq !== c.request.seq || prior.checkpoint.request.quote !== c.request.quote) {
      return 'the original request cannot be replaced for the same goal'
    }
    for (const item of prior.checkpoint.items) {
      const next = c.items.find(candidate => candidate.id === item.id)
      if (next === undefined || next.quote !== item.quote || next.acceptance !== item.acceptance
        || (next.source_seq ?? c.request.seq) !== (item.source_seq ?? prior.checkpoint.request.seq)) {
        return `acceptance item ${item.id} was removed or changed; retain it and report missing work`
      }
    }
  }
  if (new Set(c.items.map(item => item.id)).size !== c.items.length) return 'acceptance item ids must be unique'
  const target = c.target
  if (target.restricts_scope && target.origin !== 'human') {
    return 'scope restriction requires a human-specified target; cwd, examples, materials and inference are not authorization'
  }
  if (target.origin === 'human') {
    const source = target.source_seq === undefined ? undefined : await read(target.source_seq)
    if (!target.value.trim() || source === undefined || !isHuman(source) || !eventText(source).includes(target.value)) {
      return 'human target requires a direct human source containing its value'
    }
    if (prior !== null && prior.checkpoint.target.origin !== 'human'
      && target.value === prior.checkpoint.target.value
      && target.source_seq !== undefined && target.source_seq <= prior.checkpoint.reviewed_through) {
      return 'a recorded non-human target needs a later human confirmation before promotion'
    }
  }
  for (const item of c.items) {
    const sourceSeq = item.source_seq ?? c.request.seq
    const humanSource = await read(sourceSeq)
    if (sourceSeq < c.request.seq || sourceSeq > c.reviewed_through
      || humanSource === undefined || !isHuman(humanSource) || !eventText(humanSource).includes(item.quote)) {
      return `item ${item.id} must retain a direct human quotation and its source sequence`
    }
    for (const evidence of item.evidence) {
      const source = await read(evidence.seq)
      if (!successfulResult(source)
        || !eventText(source).includes(evidence.excerpt)) return `item ${item.id} cites unavailable or failed tool evidence`
      const call = await sourceCall(read, source)
      if (call === undefined || call.name === 'request_check') return 'a checkpoint cannot certify itself or cite an unlinked result'
    }
  }
  for (const lesson of c.lessons) {
    const source = await read(lesson.read_seq)
    if (!successfulResult(source)) return `lesson ${lesson.slug} lacks a successful read`
    const call = await sourceCall(read, source)
    if (call === undefined || call.name !== 'kura_read') return `lesson ${lesson.slug} must cite kura_read`
    let args: unknown
    try { args = JSON.parse(call.arguments) } catch { return 'lesson read arguments are invalid JSON' }
    if (typeof args !== 'object' || args === null || !('slug' in args) || args.slug !== lesson.slug) {
      return `lesson ${lesson.slug} does not match the recorded read`
    }
  }
  return undefined
}
