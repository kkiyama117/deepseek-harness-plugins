/**
 * Zod schemas, the durable state shape, and the error type for dsh-evolve.
 *
 * Two schema families live here (see DESIGN.md):
 *
 * - `Config` validates the human-owned configuration: which assets are managed,
 *   which output tests decide pass/fail, the model route, request limits, and
 *   persistence bounds. `propose` mode is only valid with an explicit route,
 *   explicit request limits, a daily request limit, and at least one asset whose
 *   every test carries at least one deterministic assertion.
 * - `stateSchema` validates the one global storage record: observations,
 *   candidates, revisions, the active-revision pointers, operation history, the
 *   persisted daily budget, and the last cycle timestamp. Objects are strict and
 *   exact, so a stored record that does not match this shape is rejected instead
 *   of being silently coerced.
 *
 * `EvolveError` carries a stable machine-readable `code`; codes are part of the
 * public contract and must not be renamed.
 */
import { z } from 'zod'

/**
 * Stable error codes.
 *
 * - `STORAGE_FAILED`: a durable read or write failed; after a failed write the
 *   store is quarantined and later writes are refused.
 * - `STATE_LIMIT`: the next state would exceed a configured record or byte
 *   bound; nothing is written and the previous state stays current.
 * - `CLOSED`: the store no longer admits new writes.
 * - `BUDGET_EXHAUSTED`: the persisted daily LLM request allowance is used up.
 * - `CONFIG_INVALID`, `HANDLE_INVALID`, `INVALID_STATE`, `INVALID_ARGUMENT`,
 *   `STATE_INVALID`, `CLOCK_INVALID`: caller or stored-data errors.
 */
export class EvolveError extends Error {
  /**
   * @param {string} code - Stable machine-readable code (see the class docs).
   * @param {string} message - Human-readable explanation.
   * @param {{ cause?: unknown }} [options] - Optional underlying error.
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'EvolveError'
    this.code = code
  }
}

/** A positive integer, used for byte counts, durations, limits, and counts. */
const positiveInt = z.number().int().positive()

/** A non-empty identifier string. */
const id = z.string().min(1)

/**
 * A JSON value: the result of `jsonEquals` assertions and the only data the
 * durable state may contain. `z.lazy` keeps the recursion finite per value.
 */
const jsonValue = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValue),
  z.record(z.string(), jsonValue),
]))

/**
 * One output test: a prompt plus at least one deterministic assertion. The
 * human owns these; a proposal model can never widen the passing condition.
 * `equals: ''` counts as an assertion (the expected output is empty), but an
 * empty `contains`/`notContains` list does not.
 */
export const testSchema = z.object({
  id,
  prompt: z.string().min(1),
  equals: z.string().optional(),
  contains: z.array(z.string().min(1)).optional(),
  notContains: z.array(z.string().min(1)).optional(),
  jsonEquals: jsonValue.optional(),
}).strict().superRefine((test, ctx) => {
  const asserted = test.equals !== undefined
    || (test.contains !== undefined && test.contains.length > 0)
    || (test.notContains !== undefined && test.notContains.length > 0)
    || test.jsonEquals !== undefined
  if (!asserted) {
    ctx.addIssue({
      code: 'custom',
      message: 'test needs at least one assertion (equals, contains, notContains, or jsonEquals)',
      path: [],
    })
  }
})

/**
 * One managed asset: an `evolve-`-prefixed skill whose body and description may
 * be proposed. `initialContent` is the baseline body when the asset has no
 * revision yet; `tests` are the only pass/fail authority.
 */
const assetSchema = z.object({
  name: z.string().regex(/^evolve-[a-z0-9]+(?:-[a-z0-9]+)*$/, 'asset name must use nonempty lowercase alphanumeric segments after evolve-'),
  description: z.string().min(1),
  initialContent: z.string().default(''),
  tests: z.array(testSchema).default(() => []),
}).strict().superRefine((asset, ctx) => {
  const seen = new Set()
  asset.tests.forEach((test, index) => {
    if (seen.has(test.id)) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate test id '${test.id}'`,
        path: ['tests', index, 'id'],
      })
    }
    seen.add(test.id)
  })
})

/** The explicit model route; never inferred at call time. */
const routeSchema = z.object({
  provider: id,
  model: id,
}).strict()

/** Per-request limits, independent of the daily request count. */
const requestSchema = z.object({
  maxOutputTokens: positiveInt,
  maxInputBytes: positiveInt,
  maxOutputBytes: positiveInt,
  timeoutMs: positiveInt,
}).strict()

/** Observation window and retention, all values owned by the human. */
const observationSchema = z.object({
  failureThreshold: positiveInt.default(3),
  windowMs: positiveInt.default(300000),
  cooldownMs: positiveInt.default(600000),
  maxRecords: positiveInt.default(100),
}).strict().prefault({})

/** Durable state bounds; exceeding them stops the write instead of truncating. */
const storageSchema = z.object({
  maxCandidates: positiveInt.default(20),
  maxRevisions: positiveInt.default(200),
  maxHistory: positiveInt.default(1000),
  maxStateBytes: positiveInt.default(2097152),
}).strict().prefault({})

/**
 * Plugin configuration. `mode` and `locale` default to the conservative pair
 * (`observe`, `ja`); `propose` requires the full explicit model/limit setup.
 */
export const Config = z.object({
  mode: z.enum(['observe', 'propose']).default('observe'),
  locale: z.enum(['ja', 'en']).default('ja'),
  route: routeSchema.optional(),
  request: requestSchema.optional(),
  dailyRequestLimit: positiveInt.optional(),
  inspectionMaxBytes: positiveInt.default(16384),
  observation: observationSchema,
  storage: storageSchema,
  assets: z.array(assetSchema).default(() => []),
}).strict().superRefine((config, ctx) => {
  const seen = new Set()
  config.assets.forEach((asset, index) => {
    if (seen.has(asset.name)) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate asset name '${asset.name}'`,
        path: ['assets', index, 'name'],
      })
    }
    seen.add(asset.name)
  })
  if (config.mode !== 'propose') return
  if (config.route === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: "propose mode requires 'route' with an explicit provider and model",
      path: ['route'],
    })
  }
  if (config.request === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: "propose mode requires 'request' limits",
      path: ['request'],
    })
  }
  if (config.dailyRequestLimit === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: "propose mode requires 'dailyRequestLimit'",
      path: ['dailyRequestLimit'],
    })
  }
  if (config.assets.length === 0) {
    ctx.addIssue({
      code: 'custom',
      message: 'propose mode requires at least one asset',
      path: ['assets'],
    })
  }
  config.assets.forEach((asset, index) => {
    if (asset.tests.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: `propose mode requires at least one output test for asset '${asset.name}'`,
        path: ['assets', index, 'tests'],
      })
    }
  })
})

/** One failure observation; `at` is epoch milliseconds. */
const observationRecordSchema = z.object({
  at: z.number(),
  sessionId: id,
  tool: id,
  code: id,
  callId: id,
  detail: z.string(),
}).strict()

/** One comparison case: the same test run against baseline and trial. */
const validationCaseSchema = z.object({
  id,
  baselinePassed: z.boolean(),
  trialPassed: z.boolean(),
  baselineSessionId: z.string(),
  trialSessionId: z.string(),
}).strict()

/**
 * The complete validation verdict: every case must pass, and at least one
 * baseline failure must have been improved, before a candidate is `ready`.
 * `reason` explains a rejection or a failed trial (null when self-evident).
 */
const validationSchema = z.object({
  kind: z.enum(['improved', 'not-improved', 'failed']),
  cases: z.array(validationCaseSchema),
  reason: z.string().nullable().default(null),
}).strict()

/**
 * One proposed revision awaiting (or having received) a human decision.
 * `baseRevision` is the revision the proposal was validated against, so an
 * apply is refused when the active pointer moved on.
 */
export const candidateSchema = z.object({
  id,
  asset: id,
  description: z.string(),
  content: z.string(),
  baseRevision: z.string().min(1).nullable(),
  digest: id,
  validationHash: id,
  status: z.enum(['pending', 'ready', 'rejected', 'applied']),
  createdAt: z.number(),
  proposalSessionId: id,
  validation: validationSchema.nullable(),
}).strict()

/** One stored skill version; `parent` is the revision it was derived from. */
const revisionSchema = z.object({
  id,
  asset: id,
  description: z.string(),
  content: z.string(),
  parent: z.string().min(1).nullable(),
  digest: id,
  time: z.number(),
}).strict()

/** One human apply/rollback/reject command, recorded for auditability. */
const historyEntrySchema = z.object({
  time: z.number(),
  kind: z.enum(['apply', 'rollback', 'reject']),
  asset: id,
  from: z.string().min(1).nullable(),
  to: z.string().min(1).nullable(),
  candidateId: z.string().min(1).nullable(),
  commandId: id,
  sessionId: id,
}).strict()

/**
 * The one global storage record. Exact and strict: every field is required, no
 * extra field is accepted, and the record is validated again after every
 * transformation before it is committed.
 *
 * `candidates` and `revisions` are keyed by their own id; `active` maps an asset
 * name to the revision id it currently serves; `budget.day` is a UTC
 * `YYYY-MM-DD` day (`''` before the first reservation).
 */
export const stateSchema = z.object({
  version: z.literal(1),
  observations: z.array(observationRecordSchema),
  candidates: z.record(id, candidateSchema),
  revisions: z.record(id, revisionSchema),
  active: z.record(id, id),
  history: z.array(historyEntrySchema),
  budget: z.object({
    day: z.string(),
    requests: z.number().int().nonnegative(),
  }).strict(),
  lastCycleAt: z.number(),
  lastError: z.string().nullable(),
}).strict().superRefine((state, ctx) => {
  const invalid = (path, message) => ctx.addIssue({ code: 'custom', path, message })
  for (const [key, revision] of Object.entries(state.revisions)) {
    if (key !== revision.id) invalid(['revisions', key], 'revision id does not match its key')
    const seen = new Set([key])
    let parent = revision.parent
    while (parent !== null) {
      const saved = state.revisions[parent]
      if (!saved || saved.asset !== revision.asset || seen.has(parent)) {
        invalid(['revisions', key, 'parent'], 'parent must be an existing, acyclic revision of the same asset')
        break
      }
      seen.add(parent)
      parent = saved.parent
    }
  }
  for (const [asset, revision] of Object.entries(state.active)) {
    if (state.revisions[revision]?.asset !== asset) invalid(['active', asset], 'active revision is missing or belongs to another asset')
  }
  for (const [key, candidate] of Object.entries(state.candidates)) {
    if (key !== candidate.id) invalid(['candidates', key], 'candidate id does not match its key')
    if (candidate.baseRevision !== null && state.revisions[candidate.baseRevision]?.asset !== candidate.asset) {
      invalid(['candidates', key, 'baseRevision'], 'candidate parent is missing or belongs to another asset')
    }
  }
})

/**
 * The empty durable state. Fresh, unfrozen, and schema-valid; the storage
 * domain's global `initial` value should be this object.
 * @returns {object} A new empty state.
 */
export function initialState() {
  return {
    version: 1,
    observations: [],
    candidates: {},
    revisions: {},
    active: {},
    history: [],
    budget: { day: '', requests: 0 },
    lastCycleAt: 0,
    lastError: null,
  }
}
