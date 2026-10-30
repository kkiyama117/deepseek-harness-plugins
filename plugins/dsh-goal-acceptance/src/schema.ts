/** Validated, bounded checkpoint records stored in existing tool-result metadata. */
import { z } from 'zod'

const text = z.string().trim().min(1).max(2000)
const seq = z.number().int().nonnegative()

/** Model-authored observations retain their classification separately from source evidence. */
export const checkpointSchema = z.object({
  stage: z.enum(['design', 'delegate', 'repair', 'complete']),
  request: z.object({ seq, quote: text }).strict(),
  reviewed_through: seq.describe('Latest direct human event sequence returned by request_check; acknowledges review, not automatic semantic validation.'),
  target: z.object({
    value: z.string().max(2000),
    origin: z.enum(['human', 'inferred', 'example', 'environment', 'material', 'unresolved']),
    restricts_scope: z.boolean().describe('True when this target excludes otherwise requested work; only a human-specified target can restrict scope.'),
    source_seq: seq.optional(),
  }).strict(),
  items: z.array(z.object({
    id: z.string().min(1).max(80),
    quote: text,
    source_seq: seq.optional().describe('Human event supplying this item’s quote; omission uses the original request event.'),
    acceptance: text,
    status: z.enum(['pending', 'satisfied', 'negative', 'not-applicable', 'missing']),
    evidence: z.array(z.object({
      seq,
      kind: z.enum(['outcome', 'mechanical']).describe('outcome records what the requested experiment or comparison established; mechanical records process, test, or delivery status alone.'),
      excerpt: text,
    }).strict()).max(8),
  }).strict()).min(1).max(24),
  lessons: z.array(z.object({
    slug: z.string().min(1).max(160),
    read_seq: seq,
    applied: z.boolean(),
    decision: text,
  }).strict()).max(8),
}).strict()

/** One checkpoint supplied by the model, before the service binds its Goal identity. */
export type Checkpoint = z.infer<typeof checkpointSchema>

/** Authoritative tool-result record, not an independently certified judgment. */
export const recordSchema = z.object({
  kind: z.literal('request-check'),
  version: z.literal(1),
  goal: z.object({ id: z.string(), objective: z.string() }).strict().nullable(),
  checkpoint: checkpointSchema,
}).strict()

/** Replayable accepted checkpoint. */
export type CheckRecord = z.infer<typeof recordSchema>

/** Incremental per-Session state; compaction does not erase committed checkpoints. */
export const stateSchema = z.object({
  current: recordSchema.nullable(),
  invalidated: z.boolean(),
  latestHumanSeq: z.number().int().min(-1),
  pendingWriteCallId: z.string().nullable(),
  pendingCheckpointDigest: z.string().nullable(),
}).strict()

/** Host projection state. */
export type CheckState = z.infer<typeof stateSchema>
