/**
 * Tests for the dsh-evolve schema and durable state store.
 *
 * Everything here is deterministic: no timers, no LLM, no storage domain. The
 * store is driven through a fake global handle and an injected clock.
 */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'
import {
  Config,
  EvolveError,
  candidateSchema,
  initialState,
  stateSchema,
  testSchema,
} from '../schema.mjs'
import { EvolveStore } from '../state.mjs'

/** A fake storage-domain global handle; `failNextSet` fails exactly one write. */
function createHandle(initial = initialState()) {
  const handle = {
    value: initial,
    failNextSet: null,
    writes: 0,
    get() {
      return handle.value
    },
    async set(next) {
      if (handle.failNextSet !== null) {
        const error = handle.failNextSet
        handle.failNextSet = null
        throw error
      }
      handle.value = next
      handle.writes += 1
    },
  }
  return handle
}

/** Matcher asserting an EvolveError carries the expected stable code. */
function codeIs(code) {
  return (error) => {
    assert.ok(error instanceof EvolveError, `expected EvolveError, got ${error}`)
    assert.equal(error.code, code)
    return true
  }
}

/** Matcher asserting a synchronous throw carries the expected stable code. */
function throwsCode(code) {
  return (error) => {
    assert.ok(error instanceof EvolveError, `expected EvolveError, got ${error}`)
    assert.equal(error.code, code)
    return true
  }
}

function candidate(overrides = {}) {
  return {
    id: 'c1',
    asset: 'evolve-demo',
    description: 'demo candidate',
    content: 'body',
    baseRevision: null,
    digest: 'sha256:aa',
    validationHash: 'sha256:bb',
    status: 'pending',
    createdAt: 1,
    proposalSessionId: 's1',
    validation: null,
    ...overrides,
  }
}

function revision(overrides = {}) {
  return {
    id: 'r1',
    asset: 'evolve-demo',
    description: 'demo revision',
    content: 'body',
    parent: null,
    digest: 'sha256:cc',
    time: 1,
    ...overrides,
  }
}

function historyEntry(overrides = {}) {
  return {
    time: 1,
    kind: 'apply',
    asset: 'evolve-demo',
    from: null,
    to: 'r1',
    candidateId: 'c1',
    commandId: 'cmd1',
    sessionId: 's1',
    ...overrides,
  }
}

function observation(code = 'o1') {
  return { at: 1, sessionId: 's1', tool: 'bash', code, callId: `call-${code}`, detail: 'failed' }
}

function requestLimits() {
  return { maxOutputTokens: 256, maxInputBytes: 4096, maxOutputBytes: 4096, timeoutMs: 30000 }
}

/** A complete, valid propose-mode config. */
function proposeConfig(overrides = {}) {
  return {
    mode: 'propose',
    route: { provider: 'mock', model: 'mock-small' },
    request: requestLimits(),
    dailyRequestLimit: 3,
    assets: [{
      name: 'evolve-demo',
      description: 'Demo asset',
      tests: [{ id: 't1', prompt: 'Say ok', equals: 'ok' }],
    }],
    ...overrides,
  }
}

const fixedNow = () => Date.UTC(2026, 4, 1, 12, 0, 0)

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

test('stateSchema accepts the empty state exactly and rejects deviations', () => {
  assert.deepEqual(stateSchema.parse(initialState()), initialState())

  assert.equal(stateSchema.safeParse({ ...initialState(), version: 2 }).success, false)
  assert.equal(stateSchema.safeParse({ ...initialState(), extra: true }).success, false)
  assert.equal(stateSchema.safeParse({ ...initialState(), lastError: 5 }).success, false)
  assert.equal(stateSchema.safeParse({ ...initialState(), lastCycleAt: 'yesterday' }).success, false)
  assert.equal(stateSchema.safeParse({ ...initialState(), budget: { day: '2026-05-01', requests: -1 } }).success, false)
  assert.equal(stateSchema.safeParse({ ...initialState(), budget: { day: '2026-05-01', requests: 1, extra: 2 } }).success, false)

  const missing = initialState()
  delete missing.history
  assert.equal(stateSchema.safeParse(missing).success, false)

  const badStatus = structuredClone(initialState())
  badStatus.candidates.c1 = candidate({ status: 'done' })
  assert.equal(stateSchema.safeParse(badStatus).success, false)

  const badKind = structuredClone(initialState())
  badKind.history.push(historyEntry({ kind: 'promote' }))
  assert.equal(stateSchema.safeParse(badKind).success, false)

  const unknownCandidateField = structuredClone(initialState())
  unknownCandidateField.candidates.c1 = { ...candidate(), extra: 1 }
  assert.equal(stateSchema.safeParse(unknownCandidateField).success, false)

  const valid = structuredClone(initialState())
  valid.candidates.c1 = candidate()
  valid.revisions.r1 = revision()
  valid.active['evolve-demo'] = 'r1'
  valid.history.push(historyEntry())
  valid.observations.push(observation())
  valid.budget = { day: '2026-05-01', requests: 2 }
  valid.lastError = 'previous cycle failed'
  assert.deepEqual(stateSchema.parse(valid), valid)
  assert.equal(candidateSchema.safeParse(candidate()).success, true)
})

test('stored pointers and parent chains must refer to real revisions of the same asset', () => {
  const missing = initialState()
  missing.active['evolve-demo'] = 'missing'
  assert.equal(stateSchema.safeParse(missing).success, false)
  const cycle = initialState()
  cycle.revisions.r1 = revision({ parent: 'r1' })
  assert.equal(stateSchema.safeParse(cycle).success, false)
  const wrong = initialState()
  wrong.revisions.r1 = revision()
  wrong.active['evolve-other'] = 'r1'
  assert.equal(stateSchema.safeParse(wrong).success, false)
})

test('candidateSchema keeps the validation verdict shape strict', () => {
  const improved = {
    kind: 'improved',
    cases: [{ id: 't1', baselinePassed: false, trialPassed: true, baselineSessionId: 'b1', trialSessionId: 't1s' }],
    reason: 'baseline failed on t1, trial passed',
  }
  assert.equal(candidateSchema.safeParse(candidate({ validation: improved })).success, true)
  // `reason` defaults to null when omitted.
  const parsed = candidateSchema.parse(candidate({
    validation: { kind: 'improved', cases: [] },
  }))
  assert.equal(parsed.validation.reason, null)
  assert.equal(candidateSchema.safeParse(candidate({ validation: { kind: 'improved', cases: [{ id: 't1' }] } })).success, false)
  assert.equal(candidateSchema.safeParse(candidate({ validation: { kind: 'improved', cases: [], extra: true } })).success, false)
  assert.equal(candidateSchema.safeParse(candidate({ validation: { kind: 'maybe', cases: [] } })).success, false)
})

test('Config applies conservative defaults and rejects unknown fields', () => {
  const parsed = Config.parse({})
  assert.equal(parsed.mode, 'observe')
  assert.equal(parsed.locale, 'ja')
  assert.deepEqual(parsed.assets, [])
  assert.equal(parsed.route, undefined)
  assert.equal(parsed.request, undefined)
  assert.equal(parsed.dailyRequestLimit, undefined)
  assert.deepEqual(parsed.observation, { failureThreshold: 3, windowMs: 300000, cooldownMs: 600000, maxRecords: 100 })
  assert.deepEqual(parsed.storage, { maxCandidates: 20, maxRevisions: 200, maxHistory: 1000, maxStateBytes: 2097152 })

  assert.deepEqual(Config.parse({ locale: 'en' }).locale, 'en')
  assert.equal(Config.safeParse({ mode: 'auto' }).success, false)
  assert.equal(Config.safeParse({ locale: 'fr' }).success, false)
  assert.equal(Config.safeParse({ unknown: 1 }).success, false)
  assert.equal(Config.safeParse({ route: { provider: '', model: 'm' } }).success, false)
  assert.equal(Config.safeParse({ route: { provider: 'p', model: 'm', extra: 1 } }).success, false)

  const partialRequest = { maxOutputTokens: 1, maxInputBytes: 1, maxOutputBytes: 1, timeoutMs: 1 }
  assert.equal(Config.safeParse({ request: partialRequest }).success, true)
  for (const field of ['maxOutputTokens', 'maxInputBytes', 'maxOutputBytes', 'timeoutMs']) {
    assert.equal(Config.safeParse({ request: { ...partialRequest, [field]: 0 } }).success, false, field)
    assert.equal(Config.safeParse({ request: { ...partialRequest, [field]: 1.5 } }).success, false, field)
    const missing = { ...partialRequest }
    delete missing[field]
    assert.equal(Config.safeParse({ request: missing }).success, false, field)
  }
  assert.equal(Config.safeParse({ dailyRequestLimit: 0 }).success, false)
  assert.equal(Config.safeParse({ dailyRequestLimit: 2.5 }).success, false)

  const partialObservation = Config.parse({ observation: { failureThreshold: 5 } })
  assert.equal(partialObservation.observation.failureThreshold, 5)
  assert.equal(partialObservation.observation.maxRecords, 100)
  const partialStorage = Config.parse({ storage: { maxCandidates: 2 } })
  assert.equal(partialStorage.storage.maxCandidates, 2)
  assert.equal(partialStorage.storage.maxStateBytes, 2097152)
})

test('asset names, defaults, and test assertions are enforced', () => {
  assert.equal(Config.safeParse({ assets: [{ name: 'demo', description: 'x' }] }).success, false)
  assert.equal(Config.safeParse({ assets: [{ name: 'evolve_', description: 'x' }] }).success, false)
  assert.equal(Config.safeParse({ assets: [{ name: 'evolve-', description: 'x' }] }).success, false)
  assert.equal(Config.safeParse({ assets: [{ name: 'evolve-A', description: 'x' }] }).success, false)
  assert.equal(Config.safeParse({ assets: [{ name: 'evolve-a_', description: 'x' }] }).success, false)
  assert.equal(Config.safeParse({ assets: [{ name: 'evolve-1a', description: 'x' }] }).success, true)
  assert.equal(Config.safeParse({ assets: [{ name: 'evolve-1a', description: '' }] }).success, false)
  assert.equal(Config.safeParse({ assets: [{ name: 'evolve-1a', description: 'x', extra: 1 }] }).success, false)

  const parsed = Config.parse({ assets: [{ name: 'evolve-demo', description: 'x' }] })
  assert.equal(parsed.assets[0].initialContent, '')
  assert.deepEqual(parsed.assets[0].tests, [])

  assert.equal(testSchema.safeParse({ id: 't1', prompt: 'p' }).success, false)
  assert.equal(testSchema.safeParse({ id: 't1', prompt: 'p', contains: [''] }).success, false)
  assert.equal(Config.safeParse({ assets: [{ name: 'evolve-x-', description: 'x' }] }).success, false)
  assert.equal(Config.safeParse({ assets: [{ name: 'evolve-x--y', description: 'x' }] }).success, false)
  assert.equal(testSchema.safeParse({ id: 't1', prompt: 'p', contains: [] }).success, false)
  assert.equal(testSchema.safeParse({ id: 't1', prompt: 'p', notContains: [] }).success, false)
  assert.equal(testSchema.safeParse({ id: 't1', prompt: 'p', equals: '' }).success, true)
  assert.equal(testSchema.safeParse({ id: 't1', prompt: 'p', contains: ['x'] }).success, true)
  assert.equal(testSchema.safeParse({ id: 't1', prompt: 'p', notContains: ['x'] }).success, true)
  assert.equal(testSchema.safeParse({ id: 't1', prompt: 'p', jsonEquals: { a: [1, null, 'x'] } }).success, true)
  assert.equal(testSchema.safeParse({ id: 't1', prompt: 'p', equals: 'x', extra: 1 }).success, false)
  assert.equal(testSchema.safeParse({ id: '', prompt: 'p', equals: 'x' }).success, false)
  assert.equal(testSchema.safeParse({ id: 't1', prompt: '', equals: 'x' }).success, false)
})

test('duplicate asset names and duplicate test ids are rejected', () => {
  assert.equal(Config.safeParse({
    assets: [
      { name: 'evolve-a', description: 'a' },
      { name: 'evolve-a', description: 'b' },
    ],
  }).success, false)

  assert.equal(Config.safeParse({
    assets: [{
      name: 'evolve-a',
      description: 'a',
      tests: [
        { id: 't', prompt: 'p', equals: 'x' },
        { id: 't', prompt: 'q', equals: 'y' },
      ],
    }],
  }).success, false)

  assert.equal(Config.safeParse({
    assets: [
      { name: 'evolve-a', description: 'a', tests: [{ id: 't1', prompt: 'p', equals: 'x' }] },
      { name: 'evolve-b', description: 'b' },
    ],
  }).success, true)
})

test('propose mode requires route, request, dailyRequestLimit, and tested assets', () => {
  assert.equal(Config.safeParse(proposeConfig()).success, true)

  for (const key of ['route', 'request', 'dailyRequestLimit']) {
    const missing = proposeConfig()
    delete missing[key]
    assert.equal(Config.safeParse(missing).success, false, `propose without ${key}`)
  }
  assert.equal(Config.safeParse(proposeConfig({ assets: [] })).success, false)
  assert.equal(Config.safeParse(proposeConfig({
    assets: [{ name: 'evolve-a', description: 'a', tests: [] }],
  })).success, false)
  // observe mode needs neither a route nor assets.
  assert.equal(Config.safeParse({ mode: 'observe', assets: [] }).success, true)
})

// ---------------------------------------------------------------------------
// Store: construction and snapshots
// ---------------------------------------------------------------------------

test('constructor validates the handle, config, and stored state', () => {
  assert.throws(() => new EvolveStore(null, {}), throwsCode('HANDLE_INVALID'))
  assert.throws(() => new EvolveStore({ get() {}, set: 1 }, {}), throwsCode('HANDLE_INVALID'))
  assert.throws(() => new EvolveStore(createHandle(), { mode: 'auto' }), throwsCode('CONFIG_INVALID'))
  assert.throws(() => new EvolveStore(createHandle(), undefined), throwsCode('CONFIG_INVALID'))
  assert.throws(() => new EvolveStore(createHandle({ version: 2 }), {}), throwsCode('INVALID_STATE'))
  assert.throws(() => new EvolveStore(createHandle(), {}, { clock: 'now' }), throwsCode('CONFIG_INVALID'))

  const failingRead = {
    get() {
      throw new Error('backend down')
    },
    async set() {},
  }
  assert.throws(() => new EvolveStore(failingRead, {}), throwsCode('STORAGE_FAILED'))

  const store = new EvolveStore(createHandle(), {})
  assert.deepEqual(store.read(), initialState())
  assert.equal(store.failure, null)
  assert.equal(store.config.mode, 'observe')
  assert.ok(Object.isFrozen(store.config))
})

test('read returns an immutable snapshot that later writes never change', async () => {
  const store = new EvolveStore(createHandle(), {})
  const first = store.read()
  assert.ok(Object.isFrozen(first))
  assert.ok(Object.isFrozen(first.budget))
  assert.notEqual(store.read(), first)
  assert.deepEqual(store.read(), first)

  assert.throws(() => {
    first.budget.requests = 5
  }, TypeError)
  assert.throws(() => {
    first.observations.push(observation())
  }, TypeError)

  await store.update((state) => {
    state.budget.requests = 7
  })
  assert.equal(store.read().budget.requests, 7)
  assert.equal(first.budget.requests, 0)

  // A transform that mutates the clone and then throws commits nothing.
  await assert.rejects(store.update((state) => {
    state.lastError = 'partial'
    throw new Error('transform boom')
  }), /transform boom/)
  assert.equal(store.read().lastError, null)
})

test('update accepts both a mutating transform and a replacement state', async () => {
  const store = new EvolveStore(createHandle(), {})
  await store.update((state) => {
    state.lastError = 'mutated'
  })
  assert.equal(store.read().lastError, 'mutated')

  const snapshot = store.read()
  await store.update(() => ({
    ...snapshot,
    lastError: 'replaced',
    budget: { ...snapshot.budget, requests: 2 },
  }))
  assert.equal(store.read().lastError, 'replaced')
  assert.equal(store.read().budget.requests, 2)

  await assert.rejects(store.update(() => 42), codeIs('STATE_INVALID'))
  await assert.rejects(store.update(undefined), codeIs('INVALID_ARGUMENT'))
})

test('observations keep only the newest maxRecords entries', async () => {
  const store = new EvolveStore(createHandle(), { observation: { maxRecords: 2 } })
  await store.update((state) => {
    state.observations.push(observation('o1'), observation('o2'), observation('o3'))
  })
  assert.deepEqual(store.read().observations.map((entry) => entry.code), ['o2', 'o3'])

  await store.update((state) => {
    state.observations.push(observation('o4'))
  })
  assert.deepEqual(store.read().observations.map((entry) => entry.code), ['o3', 'o4'])
})

// ---------------------------------------------------------------------------
// Store: bounds
// ---------------------------------------------------------------------------

test('validation and record-bound failures leave the state and health intact', async () => {
  const store = new EvolveStore(createHandle(), {
    storage: { maxCandidates: 1, maxRevisions: 1, maxHistory: 1 },
  })
  await store.update((state) => {
    state.candidates.c1 = candidate()
  })

  await assert.rejects(store.update((state) => {
    state.candidates.c2 = candidate({ id: 'c2' })
  }), codeIs('STATE_LIMIT'))
  assert.equal(store.failure, null)
  assert.deepEqual(Object.keys(store.read().candidates), ['c1'])

  await assert.rejects(store.update((state) => {
    state.revisions.r1 = revision()
    state.revisions.r2 = revision({ id: 'r2' })
  }), codeIs('STATE_LIMIT'))
  assert.equal(Object.keys(store.read().revisions).length, 0)

  await assert.rejects(store.update((state) => {
    state.history.push(historyEntry(), historyEntry({ commandId: 'cmd2' }))
  }), codeIs('STATE_LIMIT'))
  assert.equal(store.read().history.length, 0)

  await assert.rejects(store.update((state) => {
    state.version = 2
  }), codeIs('STATE_INVALID'))
  assert.equal(store.failure, null)

  // The store still admits writes after those refusals.
  await store.update((state) => {
    state.lastCycleAt = 3
  })
  assert.equal(store.read().lastCycleAt, 3)
})

test('serialized bounds count UTF-8 bytes, not characters', async () => {
  const measure = async (content) => {
    const handle = createHandle()
    const store = new EvolveStore(handle, {})
    await store.update((state) => {
      state.lastError = content
    })
    return Buffer.byteLength(JSON.stringify(handle.value), 'utf8')
  }
  const asciiSize = await measure('a')
  const multibyteSize = await measure('あ')
  // 'a' is 1 byte, 'あ' is 3 bytes; a character count would see no difference.
  assert.equal(multibyteSize - asciiSize, 2)

  // Exactly at the limit passes.
  const atLimit = new EvolveStore(createHandle(), { storage: { maxStateBytes: asciiSize } })
  await atLimit.update((state) => {
    state.lastError = 'a'
  })
  assert.equal(atLimit.read().lastError, 'a')

  // One byte over the limit is refused, and nothing is written.
  const oneByteShort = new EvolveStore(createHandle(), { storage: { maxStateBytes: asciiSize - 1 } })
  await assert.rejects(oneByteShort.update((state) => {
    state.lastError = 'a'
  }), codeIs('STATE_LIMIT'))
  assert.equal(oneByteShort.read().lastError, null)
  assert.equal(oneByteShort.failure, null)

  // The same byte budget that fits 'a' cannot fit the multibyte 'あ'.
  const multibyteLimit = new EvolveStore(createHandle(), { storage: { maxStateBytes: asciiSize } })
  await assert.rejects(multibyteLimit.update((state) => {
    state.lastError = 'あ'
  }), codeIs('STATE_LIMIT'))
})

// ---------------------------------------------------------------------------
// Store: daily request budget
// ---------------------------------------------------------------------------

test('concurrent reservations never overshoot the daily cap', async () => {
  const handle = createHandle()
  const store = new EvolveStore(handle, proposeConfig({ dailyRequestLimit: 3 }), { clock: fixedNow })
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => store.reserveRequest()))

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 3)
  const rejected = results.filter((result) => result.status === 'rejected')
  assert.deepEqual(rejected.map((result) => result.reason.code), ['BUDGET_EXHAUSTED', 'BUDGET_EXHAUSTED'])
  assert.equal(store.read().budget.requests, 3)
  assert.equal(store.read().budget.day, '2026-05-01')
  assert.equal(handle.value.budget.requests, 3)
  assert.equal(handle.writes, 3)
})

test('reopening the same handle keeps the persisted daily allowance', async () => {
  const handle = createHandle()
  const config = proposeConfig({ dailyRequestLimit: 2 })
  const first = new EvolveStore(handle, config, { clock: fixedNow })
  assert.deepEqual(await first.reserveRequest(), { day: '2026-05-01', requests: 1, limit: 2 })
  await first.reserveRequest()

  const second = new EvolveStore(handle, config, { clock: fixedNow })
  await assert.rejects(second.reserveRequest(), codeIs('BUDGET_EXHAUSTED'))
  assert.equal(second.read().budget.requests, 2)

  await first.close()
  await second.close()
})

test('a UTC day rollover resets the count before the cap check', async () => {
  let now = Date.UTC(2026, 4, 1, 23, 30, 0)
  const store = new EvolveStore(createHandle(), proposeConfig({ dailyRequestLimit: 1 }), { clock: () => now })
  assert.deepEqual(await store.reserveRequest(), { day: '2026-05-01', requests: 1, limit: 1 })
  await assert.rejects(store.reserveRequest(), codeIs('BUDGET_EXHAUSTED'))
  assert.equal(store.read().budget.day, '2026-05-01')

  now = Date.UTC(2026, 4, 2, 0, 0, 1)
  assert.deepEqual(await store.reserveRequest(), { day: '2026-05-02', requests: 1, limit: 1 })
  assert.equal(store.read().budget.day, '2026-05-02')
  assert.equal(store.read().budget.requests, 1)
})

test('an unconfigured daily limit refuses reservations', async () => {
  const store = new EvolveStore(createHandle(), {})
  await assert.rejects(store.reserveRequest(), codeIs('CONFIG_INVALID'))
  assert.equal(store.read().budget.requests, 0)
})

// ---------------------------------------------------------------------------
// Store: write failures, closing
// ---------------------------------------------------------------------------

test('a failed set preserves the committed state and quarantines later writes', async () => {
  const handle = createHandle()
  const store = new EvolveStore(handle, proposeConfig({ dailyRequestLimit: 2 }), { clock: fixedNow })
  await store.reserveRequest()
  const committed = store.read()
  assert.equal(committed.budget.requests, 1)
  assert.equal(handle.writes, 1)

  const failure = new Error('disk full')
  handle.failNextSet = failure
  await assert.rejects(store.update((state) => {
    state.lastError = 'boom'
  }), (error) => {
    assert.ok(error instanceof EvolveError)
    assert.equal(error.code, 'STORAGE_FAILED')
    assert.equal(error.cause, failure)
    return true
  })

  assert.deepEqual(store.read(), committed)
  assert.equal(store.failure, failure)
  assert.equal(handle.writes, 1)
  assert.equal(handle.value.budget.requests, 1)

  await assert.rejects(store.reserveRequest(), codeIs('STORAGE_FAILED'))
  await assert.rejects(store.update((state) => {
    state.lastCycleAt = 9
  }), codeIs('STORAGE_FAILED'))
  assert.equal(handle.writes, 1)
  assert.equal(store.read().lastCycleAt, 0)
})

test('close refuses new writes and waits for already admitted ones', async () => {
  const handle = createHandle()
  const store = new EvolveStore(handle, {})
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const pending = store.update(async (state) => {
    await gate
    state.lastCycleAt = 7
  })
  const closing = store.close()

  await assert.rejects(store.update((state) => {
    state.lastCycleAt = 1
  }), codeIs('CLOSED'))

  release()
  const persisted = await pending
  await closing
  assert.equal(persisted.lastCycleAt, 7)
  assert.equal(store.read().lastCycleAt, 7)
  assert.equal(handle.value.lastCycleAt, 7)

  // Closing again is harmless.
  await store.close()
})
