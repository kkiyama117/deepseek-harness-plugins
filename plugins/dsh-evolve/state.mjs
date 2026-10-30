/**
 * The durable state store for dsh-evolve: one global storage record updated
 * through a single serialized write chain.
 *
 * Invariants (see DESIGN.md):
 *
 * - `update` is a compare-and-swap-free but serialized read/modify/write: it
 *   clones the committed state, applies one transform, validates the result
 *   with {@link stateSchema}, enforces the configured record and serialized-byte
 *   bounds, and only then awaits `globalHandle.set`. Nothing is written when
 *   validation or a bound fails.
 * - A failed `set` is the one failure that taints the store: the committed
 *   state is left untouched, `failure` records the error, and every later write
 *   is refused with `STORAGE_FAILED`. Validation and bound errors never taint it.
 * - `reserveRequest` persists its daily allowance increment before the LLM
 *   request starts, resets the count on a UTC day rollover before checking the
 *   cap, and never refunds a failed or interrupted reservation.
 * - `close` stops new admissions, drains already admitted writes, and leaves the
 *   storage domain itself open.
 */
import { Buffer } from 'node:buffer'
import { Config, EvolveError, initialState, stateSchema } from './schema.mjs'

/** Structured clone; the durable state is always JSON-safe plain data. */
function clone(value) {
  return structuredClone(value)
}

/**
 * Deep-freeze a value in place. `read`/`update` hand out frozen snapshots so a
 * caller cannot mutate committed state by accident.
 * @template T
 * @param {T} value - Value to freeze.
 * @returns {T} The same value.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return value
}

/**
 * The UTC calendar day of an epoch-millisecond timestamp.
 * @param {number} ms - Epoch milliseconds.
 * @returns {string} `YYYY-MM-DD`.
 */
function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Best-effort message for an unknown thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Render Zod issues as one line, naming the failing paths.
 * @param {{ issues: Array<{ path: PropertyKey[], message: string }> }} error - Zod error.
 * @returns {string} Joined issue descriptions.
 */
function formatIssues(error) {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ')
}

/**
 * The dsh-evolve state store over one storage-domain global record.
 *
 * The constructor reads the authoritative value synchronously (`globalHandle.get`)
 * and validates it; the store then keeps a private committed copy and never
 * reads the handle again, so `read` is synchronous.
 */
export class EvolveStore {
  /** @type {{ get(): unknown, set(value: unknown): Promise<void> }} */
  #handle
  /** Validated configuration with defaults applied; frozen. */
  #config
  /** Epoch-millisecond clock. */
  #clock
  /** Last durably committed state; never handed out directly. */
  #state
  /** Tail of the serialized write chain; never rejects. */
  #tail = Promise.resolve()
  /** The first failed `set`, or null. */
  #failure = null
  /** Whether new admissions are closed. */
  #closed = false

  /**
   * @param {{ get(): unknown, set(value: unknown): Promise<void> }} globalHandle -
   *   The storage domain's single global record handle.
   * @param {unknown} config - Raw plugin configuration; validated here, so the
   *   store always works with defaults applied.
   * @param {{ clock?: () => number }} [options] - Injected clock for deterministic
   *   tests; defaults to `Date.now`.
   * @throws {EvolveError} `HANDLE_INVALID`, `CONFIG_INVALID`, `STORAGE_FAILED`
   *   (read failed), or `INVALID_STATE` (stored value fails the schema).
   */
  constructor(globalHandle, config, { clock = Date.now } = {}) {
    if (globalHandle === null
      || typeof globalHandle !== 'object'
      || typeof globalHandle.get !== 'function'
      || typeof globalHandle.set !== 'function') {
      throw new EvolveError('HANDLE_INVALID', 'EvolveStore needs a global handle with get() and set()')
    }
    if (typeof clock !== 'function') {
      throw new EvolveError('CONFIG_INVALID', 'clock must be a function returning epoch milliseconds')
    }
    const parsedConfig = Config.safeParse(config)
    if (!parsedConfig.success) {
      throw new EvolveError('CONFIG_INVALID', `invalid dsh-evolve config: ${formatIssues(parsedConfig.error)}`)
    }
    let raw
    try {
      raw = globalHandle.get()
    } catch (error) {
      throw new EvolveError('STORAGE_FAILED', `failed to read evolve state: ${messageOf(error)}`, { cause: error })
    }
    const parsedState = stateSchema.safeParse(raw === undefined ? initialState() : raw)
    if (!parsedState.success) {
      throw new EvolveError('INVALID_STATE', `stored evolve state is invalid: ${formatIssues(parsedState.error)}`)
    }
    this.#handle = globalHandle
    this.#config = deepFreeze(parsedConfig.data)
    this.#clock = clock
    this.#state = parsedState.data
  }

  /** Validated configuration, with defaults applied and frozen. */
  get config() {
    return this.#config
  }

  /**
   * The first failed durable write, or null. Non-null means quarantined: the
   * committed state is stale/unknown and every later write is refused.
   */
  get failure() {
    return this.#failure
  }

  /**
   * An immutable, deep-frozen snapshot of the last durably committed state.
   * A snapshot, not a live view: later writes never change it. During
   * quarantine it returns the last known committed state; check {@link failure}
   * before treating it as authoritative.
   * @returns {object} Frozen state snapshot.
   */
  read() {
    return deepFreeze(clone(this.#state))
  }

  /**
   * Atomically read, transform, validate, bound-check, and persist the state.
   *
   * Calls are serialized. The transform receives a mutable clone: it may mutate
   * it and return undefined, or return a replacement state. The result is
   * validated with {@link stateSchema}, observations are trimmed to the newest
   * `observation.maxRecords`, counts and serialized UTF-8 bytes are checked, and
   * only then is the state written. Validation, bound, budget, and transform
   * failures leave the committed state untouched and do not quarantine the
   * store; a `set` failure does.
   * @param {(state: object) => object | undefined | Promise<object | undefined>} transform -
   *   Mutation or replacement of the cloned state.
   * @returns {Promise<object>} Frozen snapshot of the newly committed state.
   * @throws {EvolveError} `CLOSED`, `STORAGE_FAILED`, `STATE_INVALID`,
   *   `STATE_LIMIT`, or any error thrown by the transform.
   */
  async update(transform) {
    if (typeof transform !== 'function') {
      throw new EvolveError('INVALID_ARGUMENT', 'update() needs a transform function')
    }
    return this.#enqueue(async () => {
      if (this.#failure !== null) {
        throw new EvolveError(
          'STORAGE_FAILED',
          `evolve store is quarantined after a failed write: ${messageOf(this.#failure)}`,
          { cause: this.#failure },
        )
      }
      const draft = clone(this.#state)
      const returned = await transform(draft)
      let next = returned === undefined ? draft : returned
      const maxRecords = this.#config.observation.maxRecords
      if (next !== null && typeof next === 'object'
        && Array.isArray(next.observations) && next.observations.length > maxRecords) {
        next = { ...next, observations: next.observations.slice(-maxRecords) }
      }
      const parsed = stateSchema.safeParse(next)
      if (!parsed.success) {
        throw new EvolveError('STATE_INVALID', `transform produced an invalid state: ${formatIssues(parsed.error)}`)
      }
      this.#assertRecordBounds(parsed.data)
      const bytes = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8')
      if (bytes > this.#config.storage.maxStateBytes) {
        throw new EvolveError(
          'STATE_LIMIT',
          `serialized state is ${bytes} bytes, over maxStateBytes ${this.#config.storage.maxStateBytes}`,
        )
      }
      try {
        await this.#handle.set(parsed.data)
      } catch (error) {
        this.#failure = error instanceof Error ? error : new Error(messageOf(error), { cause: error })
        throw new EvolveError('STORAGE_FAILED', `failed to persist evolve state: ${messageOf(error)}`, { cause: error })
      }
      this.#state = parsed.data
      return deepFreeze(clone(parsed.data))
    })
  }

  /**
   * Reserve one LLM request against the persisted daily allowance. The
   * increment is committed before the caller starts the request, so a restart
   * or failure cannot refund it. A UTC day rollover resets the count before the
   * cap is checked.
   * @returns {Promise<{ day: string, requests: number, limit: number }>} The
   *   reservation that was persisted.
   * @throws {EvolveError} `CONFIG_INVALID` (no `dailyRequestLimit`),
   *   `CLOCK_INVALID`, `BUDGET_EXHAUSTED`, `CLOSED`, `STORAGE_FAILED`.
   */
  async reserveRequest() {
    const limit = this.#config.dailyRequestLimit
    if (limit === undefined) {
      throw new EvolveError('CONFIG_INVALID', 'dailyRequestLimit must be configured to reserve LLM requests')
    }
    let reservation
    await this.update((state) => {
      const now = this.#clock()
      if (typeof now !== 'number' || !Number.isFinite(now)) {
        throw new EvolveError('CLOCK_INVALID', 'clock must return epoch milliseconds as a finite number')
      }
      const day = utcDay(now)
      if (state.budget.day !== day) {
        state.budget.day = day
        state.budget.requests = 0
      }
      if (state.budget.requests >= limit) {
        throw new EvolveError('BUDGET_EXHAUSTED', `daily request limit ${limit} already used for ${day}`)
      }
      state.budget.requests += 1
      reservation = { day, requests: state.budget.requests, limit }
    })
    return reservation
  }

  /**
   * Stop admitting new writes and wait for already admitted ones to finish.
   * Idempotent; the storage domain and its record stay open for reads.
   * @returns {Promise<void>} Resolution after the write chain drains.
   */
  async close() {
    this.#closed = true
    await this.#tail
  }

  /**
   * Queue one job behind the current tail, refusing admission after close.
   * @param {() => Promise<unknown>} job - Serialized work.
   * @returns {Promise<unknown>} The job's result.
   */
  #enqueue(job) {
    if (this.#closed) {
      return Promise.reject(new EvolveError('CLOSED', 'evolve store is closed and no longer accepts writes'))
    }
    const run = this.#tail.then(job)
    this.#tail = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Refuse a state that exceeds the record-count bounds. The state is not
   * truncated; the write simply does not happen.
   * @param {object} state - Parsed candidate state.
   * @throws {EvolveError} `STATE_LIMIT` for the first bound that is exceeded.
   */
  #assertRecordBounds(state) {
    const { storage } = this.#config
    const candidates = Object.keys(state.candidates).length
    if (candidates > storage.maxCandidates) {
      throw new EvolveError('STATE_LIMIT', `candidates ${candidates} exceed maxCandidates ${storage.maxCandidates}`)
    }
    const revisions = Object.keys(state.revisions).length
    if (revisions > storage.maxRevisions) {
      throw new EvolveError('STATE_LIMIT', `revisions ${revisions} exceed maxRevisions ${storage.maxRevisions}`)
    }
    if (state.history.length > storage.maxHistory) {
      throw new EvolveError('STATE_LIMIT', `history ${state.history.length} exceed maxHistory ${storage.maxHistory}`)
    }
  }
}
