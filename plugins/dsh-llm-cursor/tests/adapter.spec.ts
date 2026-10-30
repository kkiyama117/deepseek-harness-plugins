import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BlockAssembler,
  CallId,
  createAssistantMessage,
  createMessage,
  createUserMessage,
  LlmError,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { RunResult, SDKMessage } from '@cursor/sdk'
import { CursorAdapter, readReplayState, validateReplayState } from '../src/adapter.ts'
import type { CursorConnectionOptions } from '../src/types.ts'

const sdkMocks = vi.hoisted(() => {
  const stores: Array<{ rootDir: string }> = []
  return {
    create: vi.fn(),
    resume: vi.fn(),
    stores,
  }
})

vi.mock('@cursor/sdk', () => ({
  Agent: { create: sdkMocks.create, resume: sdkMocks.resume },
  Cursor: { models: { list: vi.fn() } },
  JsonlLocalAgentStore: class JsonlLocalAgentStore {
    constructor(public readonly rootDir: string) {
      sdkMocks.stores.push(this)
    }
  },
}))

interface RunStubOptions {
  messages?: SDKMessage[]
  waitResult?: RunResult
  /** Loop until cancelled, then throw — the idle-timeout and caller-abort paths. */
  cancelEndsStream?: boolean
  /** End the stream after this many milliseconds without observing cancellation. */
  endAfterMs?: number
}

function makeRun(options: RunStubOptions = {}) {
  let cancelled = false
  const run = {
    id: 'run-1',
    agentId: 'agent-1',
    cancel: vi.fn(async () => {
      cancelled = true
    }),
    wait: vi.fn(async () => options.waitResult ?? { id: 'run-1', status: 'finished' }),
    stream: vi.fn(async function* () {
      for (const item of options.messages ?? []) {
        if (cancelled) throw new Error('stream cancelled by run.cancel()')
        yield item
      }
      if (options.endAfterMs !== undefined) {
        await new Promise(resolve => setTimeout(resolve, options.endAfterMs))
      }
      if (options.cancelEndsStream === true) {
        while (!cancelled) await new Promise(resolve => setTimeout(resolve, 5))
        throw new Error('stream cancelled by run.cancel()')
      }
    }),
  }
  return run
}

function makeAgent(run: ReturnType<typeof makeRun>) {
  return {
    agentId: 'agent-1',
    send: vi.fn(async () => run),
    close: vi.fn(),
  }
}

function connection(overrides: Partial<CursorConnectionOptions> = {}): CursorConnectionOptions {
  return {
    apiKeyEnv: credentialRef('CURSOR_API_KEY'),
    runtime: 'local',
    cwd: '/work',
    stateRoot: '/state',
    mode: 'agent',
    models: [{ id: 'default', name: 'Default', contextWindow: 1000 }],
    defaultContextWindow: 128_000,
    streamIdleTimeoutMs: 300_000,
    retryPolicy: resolveRetryPolicy(undefined, 'test'),
    params: [],
    ...overrides,
  }
}

function makeAdapter(overrides: Partial<CursorConnectionOptions> = {}, loadSdk?: () => Promise<unknown>) {
  const options = connection(overrides)
  const adapter = new CursorAdapter({
    options: () => options,
    resolveApiKey: async () => 'sk-test',
    ...loadSdk === undefined ? {} : { loadSdk: loadSdk as () => Promise<typeof import('@cursor/sdk')> },
  })
  return { adapter, options }
}

function user(text: string): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test' },
  })
}

function assistantWithReplay(agentId: string): Message {
  return createAssistantMessage({
    content: [{ type: 'text', text: 'done' }],
    source: {
      provider: 'cursor',
      model: 'default',
      replayState: { response: { kind: 'cursor', version: 1, agentId } },
    },
  })
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'cursor',
    model: 'default',
    messages: [user('hello')],
    ...overrides,
  }
}

async function collect(adapter: CursorAdapter, options: GenerateOptions): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('provider metadata', () => {
  it('describes the route, retry policy, and advisory catalog', async () => {
    const { adapter, options } = makeAdapter()
    expect(adapter.providerInfo('cursor')).toEqual({ id: 'cursor', name: 'Cursor' })
    expect(adapter.providerRetryPolicy('cursor')).toBe(options.retryPolicy)
    await expect(adapter.listModels('cursor')).resolves.toEqual([
      { provider: 'cursor', id: 'default', name: 'Default', inputModalities: ['text'] },
    ])
  })

  it('resolves exact-model context from the catalog entry or the route default', async () => {
    const { adapter } = makeAdapter()
    await expect(adapter.resolveModel('cursor', 'default')).resolves.toMatchObject({
      provider: 'cursor',
      id: 'default',
      name: 'Default',
      context: { contextWindow: 1000 },
    })
    await expect(adapter.resolveModel('cursor', 'unknown-model')).resolves.toMatchObject({
      provider: 'cursor',
      id: 'unknown-model',
      name: 'unknown-model',
      context: { contextWindow: 128_000 },
    })
  })

  it('exposes the SDK effort vocabulary as reasoning efforts for known models', async () => {
    const { adapter } = makeAdapter()
    await expect(adapter.resolveModel('cursor', 'grok-4.6')).resolves.toMatchObject({
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium' },
          { id: 'high', name: 'High' },
          { id: 'xhigh', name: 'Extra High' },
        ],
        defaultEffort: 'high',
      },
    })
    await expect(adapter.resolveModel('cursor', 'glm-5.2')).resolves.toMatchObject({
      reasoning: {
        efforts: [
          { id: 'high', name: 'High' },
          { id: 'max', name: 'Max' },
        ],
        defaultEffort: 'high',
      },
    })
    // A model without a vocabulary keeps the SDK's own default variant.
    await expect(adapter.resolveModel('cursor', 'default')).resolves.not.toHaveProperty('reasoning')
  })

  it('advertises a catalog entry without a name under its id', async () => {
    const { adapter } = makeAdapter({ models: [{ id: 'bare' }] })
    await expect(adapter.listModels('cursor')).resolves.toEqual([
      { provider: 'cursor', id: 'bare', name: 'bare', inputModalities: ['text'] },
    ])
  })

  it('advertises :fast and :slow variants for fast-capable models', async () => {
    const { adapter } = makeAdapter({
      models: [
        { id: 'grok-4.6', name: 'Cursor Grok 4.6', contextWindow: 256_000 },
        { id: 'glm-5.2', name: 'GLM 5.2', contextWindow: 200_000 },
      ],
    })
    await expect(adapter.listModels('cursor')).resolves.toEqual([
      { provider: 'cursor', id: 'grok-4.6', name: 'Cursor Grok 4.6', inputModalities: ['text'] },
      { provider: 'cursor', id: 'grok-4.6:fast', name: 'Cursor Grok 4.6 (fast)', inputModalities: ['text'] },
      { provider: 'cursor', id: 'grok-4.6:slow', name: 'Cursor Grok 4.6 (slow)', inputModalities: ['text'] },
      // A model without a `fast` parameter keeps only its plain id.
      { provider: 'cursor', id: 'glm-5.2', name: 'GLM 5.2', inputModalities: ['text'] },
    ])
  })

  it('resolves a suffixed model id against its base catalog entry', async () => {
    const { adapter } = makeAdapter({
      models: [{ id: 'grok-4.6', name: 'Cursor Grok 4.6', contextWindow: 256_000 }],
    })
    await expect(adapter.resolveModel('cursor', 'grok-4.6:fast')).resolves.toMatchObject({
      provider: 'cursor',
      id: 'grok-4.6:fast',
      name: 'Cursor Grok 4.6',
      context: { contextWindow: 256_000 },
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium' },
          { id: 'high', name: 'High' },
          { id: 'xhigh', name: 'Extra High' },
        ],
        defaultEffort: 'high',
      },
    })
    await expect(adapter.resolveModel('cursor', 'grok-4.6:slow')).resolves.toMatchObject({
      id: 'grok-4.6:slow',
      context: { contextWindow: 256_000 },
    })
  })

  it('carries a catalog description into the advertised model', async () => {
    const { adapter } = makeAdapter({ models: [{ id: 'm1', name: 'M1', description: 'desc' }] })
    await expect(adapter.listModels('cursor')).resolves.toEqual([
      { provider: 'cursor', id: 'm1', name: 'M1', description: 'desc', inputModalities: ['text'] },
    ])
  })
})

describe('validateReplayState', () => {
  it('accepts a well-formed state', () => {
    expect(validateReplayState({ response: { kind: 'cursor', version: 1, agentId: 'a-1' } }))
      .toEqual({ kind: 'cursor', version: 1, agentId: 'a-1' })
  })

  it('rejects non-objects, foreign kinds, wrong versions, and empty agent ids', () => {
    for (const value of [
      null,
      'cursor',
      {},
      { response: null },
      { response: 'cursor' },
      { response: { kind: 'pi-ai', version: 1, agentId: 'a' } },
      { response: { kind: 'cursor', version: 2, agentId: 'a' } },
      { response: { kind: 'cursor', version: 1, agentId: 7 } },
      { response: { kind: 'cursor', version: 1, agentId: '' } },
    ]) {
      expect(() => validateReplayState(value)).toThrow(
        expect.objectContaining({ code: 'INVALID_REPLAY_STATE' }),
      )
    }
  })
})

describe('readReplayState', () => {
  it('returns undefined without any model-produced assistant message', () => {
    expect(readReplayState(request({ messages: [user('hi')] }))).toBeUndefined()
    expect(readReplayState(request({ messages: [user('hi'), assistantWithReplay('a-1')] })))
      .toEqual({ kind: 'cursor', version: 1, agentId: 'a-1' })
  })

  it('skips assistant messages without model provenance or replay state', () => {
    const toolSource = createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'x' }],
      source: { kind: 'tool', callId: CallId('c1') },
    })
    const noReplay = createAssistantMessage({
      content: [{ type: 'text', text: 'x' }],
      source: { provider: 'cursor', model: 'default' },
    })
    expect(readReplayState(request({ messages: [user('hi'), toolSource, noReplay] }))).toBeUndefined()
  })

  it('reads the latest replay state and validates it', () => {
    const sparse: Message[] = []
    sparse.length = 1
    expect(readReplayState(request({ messages: sparse }))).toBeUndefined()
    const badReplay = createAssistantMessage({
      content: [{ type: 'text', text: 'x' }],
      source: {
        provider: 'cursor',
        model: 'default',
        replayState: { response: { kind: 'cursor', version: 9 } },
      },
    })
    expect(() => readReplayState(request({
      messages: [user('hi'), assistantWithReplay('a-1'), badReplay],
    }))).toThrow(expect.objectContaining({ code: 'INVALID_REPLAY_STATE' }))
  })
})

describe('stream', () => {
  it('runs one fresh local agent turn and emits reasoning, text, usage, and replay state', async () => {
    const run = makeRun({
      messages: [
        { type: 'thinking', agent_id: 'a', run_id: 'r', text: 'ponder' },
        { type: 'assistant', agent_id: 'a', run_id: 'r', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
        { type: 'usage', agent_id: 'a', run_id: 'r', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3 } },
        { type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' },
      ],
    })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter()

    const chunks = await collect(adapter, request())

    expect(sdkMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      model: { id: 'default' },
      apiKey: 'sk-test',
      mode: 'agent',
    }))
    expect(sdkMocks.create.mock.calls[0]?.[0]).toMatchObject({ local: { cwd: '/work' } })
    expect(sdkMocks.stores.at(-1)?.rootDir).toBe('/state')
    expect(sdkMocks.resume).not.toHaveBeenCalled()
    expect(agent.send).toHaveBeenCalledWith('User:\nhello', { mode: 'agent', model: { id: 'default' } })
    expect(agent.close).toHaveBeenCalled()
    expect(run.cancel).not.toHaveBeenCalled()

    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk as never)
    expect(assembler.message({ kind: 'model', provider: 'cursor', model: 'default' }).content).toEqual([
      { type: 'reasoning', text: 'ponder' },
      { type: 'text', text: 'hello' },
    ])
    expect(assembler.usage).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(assembler.replayState).toEqual({ response: { kind: 'cursor', version: 1, agentId: 'agent-1' } })
  })

  it('resumes the agent from replay state and sends only the latest user message', async () => {
    const run = makeRun({
      messages: [
        { type: 'assistant', agent_id: 'a', run_id: 'r', message: { role: 'assistant', content: [{ type: 'text', text: 'again' }] } },
        { type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' },
      ],
    })
    const agent = makeAgent(run)
    sdkMocks.resume.mockResolvedValue(agent)
    const { adapter } = makeAdapter()

    const chunks = await collect(adapter, request({
      messages: [user('first'), assistantWithReplay('a-1'), user('second')],
    }))

    expect(sdkMocks.resume).toHaveBeenCalledWith('a-1', expect.objectContaining({
      model: { id: 'default' },
      apiKey: 'sk-test',
      mode: 'agent',
    }))
    expect(sdkMocks.resume.mock.calls[0]?.[1]).toMatchObject({ local: { cwd: '/work' } })
    expect(sdkMocks.stores.at(-1)?.rootDir).toBe('/state')
    expect(sdkMocks.create).not.toHaveBeenCalled()
    expect(agent.send).toHaveBeenCalledWith('second', { mode: 'agent', model: { id: 'default' } })
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: { response: { kind: 'cursor', version: 1, agentId: 'agent-1' } },
    })
  })

  it('runs auxiliary calls on a fresh agent even when replay state is present', async () => {
    const run = makeRun({ messages: [{ type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' }] })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter()

    await collect(adapter, request({
      purpose: 'compaction',
      messages: [user('summarize'), assistantWithReplay('a-1')],
    }))

    expect(sdkMocks.create).toHaveBeenCalled()
    expect(sdkMocks.resume).not.toHaveBeenCalled()
  })

  it('runs cloud agents without local options', async () => {
    const run = makeRun({ messages: [{ type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' }] })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter({ runtime: 'cloud' })

    await collect(adapter, request())

    expect(sdkMocks.create).toHaveBeenCalledWith({
      model: { id: 'default' },
      apiKey: 'sk-test',
      mode: 'agent',
      cloud: {},
    })
  })

  it('merges configured model params into the selection', async () => {
    const run = makeRun({ messages: [{ type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' }] })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter({ params: [{ id: 'thinking', value: 'true' }] })

    await collect(adapter, request())

    expect(sdkMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      model: { id: 'default', params: [{ id: 'thinking', value: 'true' }] },
    }))
  })

  it('uses the run result usage when the stream reported none', async () => {
    const run = makeRun({
      messages: [{ type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' }],
      waitResult: {
        id: 'run-1',
        status: 'finished',
        usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 11 },
      },
    })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter()

    const chunks = await collect(adapter, request())

    expect(chunks).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
  })

  it('emits zero usage when neither the stream nor the result reported any', async () => {
    const run = makeRun({ messages: [{ type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' }] })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter()

    const chunks = await collect(adapter, request())

    expect(chunks).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
  })

  it('ends with an error finish when the run failed', async () => {
    const run = makeRun({
      messages: [{ type: 'status', agent_id: 'a', run_id: 'r', status: 'ERROR' }],
      waitResult: { id: 'run-1', status: 'error', error: { message: 'boom', code: 'rate_limit' } },
    })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter()

    const chunks = await collect(adapter, request())

    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'rate_limit', message: 'boom' } },
    })
  })

  it('falls back to stable codes and messages for a bare run error', async () => {
    const run = makeRun({
      messages: [{ type: 'status', agent_id: 'a', run_id: 'r', status: 'ERROR' }],
      waitResult: { id: 'run-1', status: 'error' },
    })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter()

    const chunks = await collect(adapter, request())

    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'INVALID_REQUEST', message: 'Cursor run failed' } },
    })
  })

  it('ends with an aborted finish when the run was cancelled', async () => {
    const run = makeRun({
      messages: [{ type: 'status', agent_id: 'a', run_id: 'r', status: 'CANCELLED' }],
      waitResult: { id: 'run-1', status: 'cancelled' },
    })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter()

    const chunks = await collect(adapter, request())

    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Cursor run cancelled' } },
    })
  })

  it('ignores non-terminal status messages', async () => {
    const run = makeRun({
      messages: [
        { type: 'status', agent_id: 'a', run_id: 'r', status: 'CREATING' },
        { type: 'status', agent_id: 'a', run_id: 'r', status: 'RUNNING' },
        { type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' },
      ],
    })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter()

    const chunks = await collect(adapter, request())

    expect(chunks.at(-1)).toEqual(expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }))
  })

  it('throws ABORTED when the caller cancels mid-stream', async () => {
    const run = makeRun({
      messages: [{ type: 'thinking', agent_id: 'a', run_id: 'r', text: 'x' }],
      cancelEndsStream: true,
    })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter()
    const controller = new AbortController()

    const stream = adapter.stream(request({ signal: controller.signal }))[Symbol.asyncIterator]()
    const first = await stream.next()
    expect(first.done).toBe(false)
    controller.abort()
    // The already-received thinking message still drains its two chunks; the
    // next demand after that observes the cancelled run and rejects.
    await expect(stream.next()).resolves.toEqual(expect.objectContaining({ done: false }))
    await expect(stream.next()).rejects.toMatchObject({ code: 'ABORTED' })
    expect(run.cancel).toHaveBeenCalled()
  })

  it('throws ABORTED when the caller aborts after the stream ended', async () => {
    const run = makeRun({
      messages: [
        { type: 'thinking', agent_id: 'a', run_id: 'r', text: 'x' },
      ],
      endAfterMs: 50,
    })
    // Cancellation itself failing is swallowed: the stream loop settles the outcome.
    run.cancel.mockRejectedValue(new Error('cancel failed'))
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter()
    const controller = new AbortController()

    const stream = adapter.stream(request({ signal: controller.signal }))[Symbol.asyncIterator]()
    const first = await stream.next()
    expect(first.done).toBe(false)
    // Drain the in-flight chunks, then abort while the generator sleeps
    // before ending; the post-loop check then sees the aborted signal.
    await expect(stream.next()).resolves.toEqual(expect.objectContaining({ done: false }))
    controller.abort()
    await expect(stream.next()).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('throws TIMEOUT when the stream idles past the configured budget', async () => {
    const run = makeRun({ cancelEndsStream: true })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter({ streamIdleTimeoutMs: 20 })

    await expect(collect(adapter, request())).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(run.cancel).toHaveBeenCalled()
  })

  it('maps SDK send failures to stable harness codes', async () => {
    sdkMocks.create.mockRejectedValue(Object.assign(new Error('bad key'), { name: 'AuthenticationError' }))
    const { adapter } = makeAdapter()

    await expect(collect(adapter, request())).rejects.toMatchObject({ code: 'AUTH' })
  })

  it('propagates a missing credential before touching the SDK', async () => {
    const { adapter } = makeAdapter()
    const keyless = new CursorAdapter({
      options: () => connection(),
      resolveApiKey: async () => {
        throw new LlmError('no key', 'MISSING_CREDENTIAL')
      },
    })

    await expect(collect(keyless, request())).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(sdkMocks.create).not.toHaveBeenCalled()
    void adapter
  })

  it('rejects unsupported request fields', async () => {
    const { adapter } = makeAdapter()
    const cases: Array<Partial<GenerateOptions>> = [
      { stop: ['x'] },
      { temperature: 0.5 },
      { maxTokens: 100 },
    ]
    for (const extra of cases) {
      await expect(collect(adapter, request(extra))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    }
    expect(sdkMocks.create).not.toHaveBeenCalled()
  })

  it('maps a reasoning effort into the model effort parameter', async () => {
    const run = makeRun({ messages: [{ type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' }] })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter({
      models: [{ id: 'grok-4.6', name: 'Cursor Grok 4.6', contextWindow: 256_000 }],
    })

    await collect(adapter, request({ model: 'grok-4.6', reasoningEffort: 'low' as never }))

    expect(sdkMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      model: { id: 'grok-4.6', params: [{ id: 'effort', value: 'low' }] },
    }))
  })

  it('lets a per-request effort replace a configured param with the same id', async () => {
    const run = makeRun({ messages: [{ type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' }] })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter({
      models: [{ id: 'grok-4.6', name: 'Cursor Grok 4.6', contextWindow: 256_000 }],
      params: [{ id: 'effort', value: 'high' }],
    })

    await collect(adapter, request({ model: 'grok-4.6', reasoningEffort: 'xhigh' as never }))

    expect(sdkMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      model: { id: 'grok-4.6', params: [{ id: 'effort', value: 'xhigh' }] },
    }))
  })

  it('keeps the SDK default variant when the model has no effort vocabulary', async () => {
    const run = makeRun({ messages: [{ type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' }] })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter()

    await collect(adapter, request({ reasoningEffort: 'high' as never }))

    expect(sdkMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      model: { id: 'default' },
    }))
  })

  it('maps a :fast model id to the fast parameter and strips the suffix', async () => {
    const run = makeRun({ messages: [{ type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' }] })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter({
      models: [{ id: 'grok-4.6', name: 'Cursor Grok 4.6', contextWindow: 256_000 }],
    })

    await collect(adapter, request({ model: 'grok-4.6:fast' }))

    expect(sdkMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      model: { id: 'grok-4.6', params: [{ id: 'fast', value: 'true' }] },
    }))
  })

  it('maps a :slow model id to fast false', async () => {
    const run = makeRun({ messages: [{ type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' }] })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter({
      models: [{ id: 'grok-4.6', name: 'Cursor Grok 4.6', contextWindow: 256_000 }],
    })

    await collect(adapter, request({ model: 'grok-4.6:slow' }))

    expect(sdkMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      model: { id: 'grok-4.6', params: [{ id: 'fast', value: 'false' }] },
    }))
  })

  it('lets a suffixed model id replace a configured fast param', async () => {
    const run = makeRun({ messages: [{ type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' }] })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter({
      models: [{ id: 'grok-4.6', name: 'Cursor Grok 4.6', contextWindow: 256_000 }],
      params: [{ id: 'fast', value: 'false' }],
    })

    await collect(adapter, request({ model: 'grok-4.6:fast' }))

    expect(sdkMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      model: { id: 'grok-4.6', params: [{ id: 'fast', value: 'true' }] },
    }))
  })

  it('combines a suffixed model id with a reasoning effort', async () => {
    const run = makeRun({ messages: [{ type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' }] })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter({
      models: [{ id: 'grok-4.6', name: 'Cursor Grok 4.6', contextWindow: 256_000 }],
    })

    await collect(adapter, request({ model: 'grok-4.6:fast', reasoningEffort: 'xhigh' as never }))

    expect(sdkMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      model: { id: 'grok-4.6', params: [{ id: 'fast', value: 'true' }, { id: 'effort', value: 'xhigh' }] },
    }))
  })

  it('ignores a fast suffix on a model without the fast parameter', async () => {
    const run = makeRun({ messages: [{ type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' }] })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { adapter } = makeAdapter({
      models: [{ id: 'glm-5.2', name: 'GLM 5.2', contextWindow: 200_000 }],
    })

    await collect(adapter, request({ model: 'glm-5.2:fast' }))

    expect(sdkMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      model: { id: 'glm-5.2' },
    }))
  })

  it('rejects malformed replay state before touching the SDK', async () => {
    const { adapter } = makeAdapter()
    const bad = createAssistantMessage({
      content: [{ type: 'text', text: 'x' }],
      source: {
        provider: 'cursor',
        model: 'default',
        replayState: { response: { kind: 'cursor', version: 1, agentId: 7 } },
      },
    })

    await expect(collect(adapter, request({ messages: [user('hi'), bad] })))
      .rejects.toMatchObject({ code: 'INVALID_REPLAY_STATE' })
    expect(sdkMocks.create).not.toHaveBeenCalled()
  })

  it('loads the SDK through the default dynamic import when no loader is injected', async () => {
    const run = makeRun({ messages: [{ type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' }] })
    const agent = makeAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const adapter = new CursorAdapter({
      options: () => connection(),
      resolveApiKey: async () => 'sk-test',
    })

    const chunks = await collect(adapter, request())

    expect(chunks.at(-1)).toEqual(expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }))
  })
})
