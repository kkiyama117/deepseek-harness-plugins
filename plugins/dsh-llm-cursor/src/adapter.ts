/**
 * `CursorAdapter`: one Cursor agent run per harness model call, backed by
 * `@cursor/sdk`. The Cursor agent loop executes its own tools inside the SDK,
 * so the harness sees reasoning, text, and usage only — the turn ends when
 * the agent finishes. Session continuity rides the seam's replayState: a
 * successful finish stores the agent id, and the next ordinary conversation
 * request resumes that agent with only the new user message.
 *
 * The adapter is transport-only: connection facts arrive through a thunk
 * resolved once per operation and the API key through a per-request
 * resolver, so the registering plugin owns validation, layering, and
 * credential policy.
 *
 * @module dsh-llm-cursor/adapter
 */

import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { AgentOptions, ModelSelection, Run, SDKAgent, SDKMessage } from '@cursor/sdk'
import { buildPrompt } from './prompt.ts'
import { closeBlocks, createTranslateState, mapSdkError, mapUsage, translateMessage } from './translate.ts'
import type { CursorAdapterOptions, CursorConnectionOptions, CursorReplayState } from './types.ts'

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 128_000
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
const REPLAY_STATE_KIND = 'cursor'
const REPLAY_STATE_VERSION = 1

/** Zero usage emitted when the SDK reported none for a successful run. */
const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

/** One model's selectable effort vocabulary, from the Cursor SDK catalog. */
interface CursorModelEfforts {
  /** SDK model-parameter id that carries the effort (e.g. `effort`, `reasoning`). */
  paramId: string
  /** Selectable efforts in display order; ids are the SDK's parameter values. */
  efforts: readonly { id: string; name: string }[]
  /** Effort materialized when the caller omits one; matches the SDK default variant. */
  defaultEffort?: string
}

/** SDK display names for the effort parameter values. */
const EFFORT_NAMES: Readonly<Record<string, string>> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
}

/** Build the display list for one SDK effort parameter, ids as the SDK values. */
function EFFORTS(...ids: readonly string[]): CursorModelEfforts['efforts'] {
  return ids.map(id => ({ id, name: EFFORT_NAMES[id] ?? id }))
}

/**
 * Advisory effort vocabularies keyed by SDK model id, mirroring the model
 * catalog: a static snapshot of the SDK's `parameters`/`variants` so the
 * harness reasoning-effort seam can drive Cursor's model parameters without
 * a per-request catalog fetch. Models without an entry expose no efforts and
 * keep the SDK's own default variant.
 */
const MODEL_EFFORTS: ReadonlyMap<string, CursorModelEfforts> = new Map([
  ['grok-4.6', { paramId: 'effort', efforts: EFFORTS('low', 'medium', 'high', 'xhigh'), defaultEffort: 'high' }],
  ['grok-4.5', { paramId: 'effort', efforts: EFFORTS('low', 'medium', 'high'), defaultEffort: 'high' }],
  ['claude-opus-5', { paramId: 'effort', efforts: EFFORTS('low', 'medium', 'high', 'xhigh', 'max'), defaultEffort: 'high' }],
  ['claude-sonnet-5', { paramId: 'effort', efforts: EFFORTS('low', 'medium', 'high', 'xhigh', 'max'), defaultEffort: 'high' }],
  ['claude-fable-5', { paramId: 'effort', efforts: EFFORTS('low', 'medium', 'high', 'xhigh', 'max'), defaultEffort: 'high' }],
  ['glm-5.2', { paramId: 'reasoning', efforts: EFFORTS('high', 'max'), defaultEffort: 'high' }],
  ['gpt-5.6-sol', { paramId: 'reasoning', efforts: EFFORTS('none', 'low', 'medium', 'high', 'xhigh', 'max'), defaultEffort: 'medium' }],
  ['gpt-5.6-luna', { paramId: 'reasoning', efforts: EFFORTS('none', 'low', 'medium', 'high', 'xhigh', 'max'), defaultEffort: 'medium' }],
])

/**
 * Base model ids whose Cursor SDK catalog exposes a `fast` parameter
 * (`true`/`false`). These models are advertised with `:fast`/`:slow` id
 * variants so the harness can select the fast path per model; models outside
 * this set keep only their plain id and the SDK's default variant.
 */
const FAST_CAPABLE_MODELS: ReadonlySet<string> = new Set([
  'grok-4.6', 'grok-4.5',
  'composer-2.5', 'composer-2',
  'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7',
  'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra',
  'gpt-5.5', 'gpt-5.4', 'gpt-5.2', 'gpt-5.3-codex',
])

const FAST_SUFFIX = ':fast'
const SLOW_SUFFIX = ':slow'

/**
 * Split a model id's `:fast`/`:slow` suffix from its base Cursor model id.
 * A plain id returns no `fast`; a suffixed id returns the boolean the SDK's
 * `fast` parameter expects. The suffix is only meaningful for models in
 * {@link FAST_CAPABLE_MODELS}; callers decide whether to honor it.
 */
function splitFastSuffix(modelId: string): { baseId: string; fast?: boolean } {
  if (modelId.endsWith(FAST_SUFFIX)) {
    return { baseId: modelId.slice(0, -FAST_SUFFIX.length), fast: true }
  }
  if (modelId.endsWith(SLOW_SUFFIX)) {
    return { baseId: modelId.slice(0, -SLOW_SUFFIX.length), fast: false }
  }
  return { baseId: modelId }
}

function modelInfo(provider: string, model: CursorConnectionOptions['models'][number]): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: ['text'],
  }
}

/**
 * Reject request fields the Cursor SDK cannot honor. The SDK `send` takes a
 * prompt, a model selection, and a mode; sampling knobs and stop sequences
 * have no wire equivalent. Reasoning effort is honored: it maps to the
 * model's effort parameter (see {@link MODEL_EFFORTS}). The agent loop sends
 * none of these by default, so the rejection only fires for explicit
 * configuration.
 * @param options - the fully assembled harness request.
 */
function rejectUnsupported(options: GenerateOptions): void {
  if (options.stop !== undefined) {
    throw new LlmError('Cursor SDK does not support stop sequences', 'UNSUPPORTED_OPTION')
  }
  if (options.temperature !== undefined) {
    throw new LlmError('Cursor SDK does not expose temperature', 'UNSUPPORTED_OPTION')
  }
  if (options.maxTokens !== undefined) {
    throw new LlmError('Cursor SDK does not expose an output-token cap', 'UNSUPPORTED_OPTION')
  }
}

/**
 * Validate adapter-private replay state carried on an assistant message.
 * Durable data crosses a process boundary, so the shape is re-judged here
 * even though only this adapter ever writes it.
 * @param value - the stored replay state.
 * @returns the validated state.
 */
export function validateReplayState(value: unknown): CursorReplayState {
  const invalid = (): LlmError =>
    new LlmError('Cursor replay state is malformed', 'INVALID_REPLAY_STATE')
  if (typeof value !== 'object' || value === null) throw invalid()
  // rc7 wraps adapter-private state in a ReplayEnvelope; the cursor state
  // lives in its `response` field (no per-block metadata, so `blocks` is
  // omitted and the envelope passes through assembly unchanged).
  const envelope = value as Record<string, unknown>
  const candidate = envelope.response as Record<string, unknown> | undefined
  if (typeof candidate !== 'object' || candidate === null) throw invalid()
  if (candidate.kind !== REPLAY_STATE_KIND || candidate.version !== REPLAY_STATE_VERSION) throw invalid()
  if (typeof candidate.agentId !== 'string' || candidate.agentId.length === 0) throw invalid()
  return { kind: REPLAY_STATE_KIND, version: REPLAY_STATE_VERSION, agentId: candidate.agentId }
}

/**
 * Read the replay state of the latest model-produced assistant message, if
 * any. `LlmRuntime` already restricts replay state to messages this adapter
 * instance produced, so presence means a resumable Cursor agent.
 * @param options - the fully assembled harness request.
 * @returns the validated replay state, or `undefined` when absent.
 */
export function readReplayState(options: GenerateOptions): CursorReplayState | undefined {
  for (let index = options.messages.length - 1; index >= 0; index--) {
    const message = options.messages[index]
    if (message === undefined || message.role !== 'assistant') continue
    const source = message.source
    if (source.kind !== 'model' || source.replayState === undefined) continue
    return validateReplayState(source.replayState)
  }
  return undefined
}

/**
 * The first Cursor SDK-backed `LlmAdapter`. One instance serves every model
 * id it was registered under; the harness model id IS the Cursor model id.
 */
export class CursorAdapter extends LlmAdapter {
  constructor(private readonly config: CursorAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Cursor' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const advertised: LlmModelInfo[] = []
    for (const model of this.config.options().models) {
      advertised.push(modelInfo(provider, model))
      if (FAST_CAPABLE_MODELS.has(model.id)) {
        const base = modelInfo(provider, model)
        advertised.push({ ...base, id: `${model.id}${FAST_SUFFIX}`, name: `${model.name ?? model.id} (fast)` })
        advertised.push({ ...base, id: `${model.id}${SLOW_SUFFIX}`, name: `${model.name ?? model.id} (slow)` })
      }
    }
    return Promise.resolve(advertised)
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const { baseId } = splitFastSuffix(model)
    const configured = connection.models.find(entry => entry.id === baseId)
    const efforts = MODEL_EFFORTS.get(baseId)
    return Promise.resolve({
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : { ...modelInfo(provider, configured), id: model },
      context: {
        contextWindow: configured?.contextWindow ?? connection.defaultContextWindow,
      },
      ...efforts === undefined
        ? {}
        : {
          reasoning: {
            efforts: efforts.efforts.map(effort => ({ id: ReasoningEffortId(effort.id), name: effort.name })),
            ...efforts.defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(efforts.defaultEffort) },
          },
        },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts and the credential
    // freeze here and hold for this whole request, so an in-flight stream
    // never observes a configuration change and the next call re-resolves.
    const connection = this.config.options()
    const apiKey = await this.config.resolveApiKey(connection)
    rejectUnsupported(options)
    const replay = readReplayState(options)
    // Auxiliary calls (compaction, session-title) must not pollute the
    // conversation of a resumed agent, so they always run on a fresh agent
    // with the flattened history.
    const resumed = replay !== undefined && options.purpose === undefined
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    let agent: SDKAgent | undefined
    let run: Run | undefined
    let onAbort: (() => void) | undefined
    let iterator: AsyncIterator<SDKMessage> | undefined
    let exhausted = false
    try {
      const loadSdk = this.config.loadSdk
        ?? ((): Promise<typeof import('@cursor/sdk')> => import('@cursor/sdk'))
      const sdk = await loadSdk()
      const { baseId, fast } = splitFastSuffix(options.model)
      const params = [...connection.params]
      if (fast !== undefined && FAST_CAPABLE_MODELS.has(baseId)) {
        // A `:fast`/`:slow` model id wins over a configured `fast` param.
        const entry = { id: 'fast', value: fast ? 'true' : 'false' }
        const at = params.findIndex(param => param.id === 'fast')
        if (at >= 0) params[at] = entry
        else params.push(entry)
      }
      const efforts = MODEL_EFFORTS.get(baseId)
      if (options.reasoningEffort !== undefined && efforts !== undefined) {
        // The harness effort id is the SDK parameter value; a per-request
        // effort wins over a configured param carrying the same id.
        const entry = { id: efforts.paramId, value: options.reasoningEffort }
        const at = params.findIndex(param => param.id === entry.id)
        if (at >= 0) params[at] = entry
        else params.push(entry)
      }
      const selection: ModelSelection = {
        id: baseId,
        ...params.length > 0 ? { params } : {},
      }
      agent = await this.acquireAgent(sdk, connection, apiKey, selection, resumed, replay)
      const prompt = buildPrompt(options, resumed)
      run = await agent.send(prompt, { mode: connection.mode, model: selection })
      onAbort = (): void => {
        run?.cancel().catch(() => {
          // Cancellation is best-effort; the stream loop settles the outcome.
        })
      }
      watchdog.signal.addEventListener('abort', onAbort, { once: true })
      const state = createTranslateState()
      let usage: TokenUsage | undefined
      iterator = run.stream()[Symbol.asyncIterator]()
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          break
        }
        const message = result.value
        if (message.type === 'status') {
          if (message.status === 'FINISHED' || message.status === 'ERROR' || message.status === 'CANCELLED') {
            break
          }
          continue
        }
        if (message.type === 'usage') usage = mapUsage(message.usage)
        yield* translateMessage(message, state)
      }
      if (options.signal?.aborted) {
        throw new LlmError('Cursor request aborted by caller', 'ABORTED')
      }
      // The SDK streams one message per delta, so the open text and reasoning
      // blocks are finalized here, before the usage and finish chunks.
      yield* closeBlocks(state)
      const result = await run.wait()
      if (result.status === 'error') {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              code: result.error?.code ?? 'INVALID_REQUEST',
              message: result.error?.message ?? 'Cursor run failed',
            },
          },
        }
        return
      }
      if (result.status === 'cancelled') {
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Cursor run cancelled' } },
        }
        return
      }
      yield { type: 'usage', usage: usage ?? (result.usage === undefined ? EMPTY_USAGE : mapUsage(result.usage)) }
      yield {
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: { response: { kind: REPLAY_STATE_KIND, version: REPLAY_STATE_VERSION, agentId: agent.agentId } },
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `Cursor stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('Cursor request aborted by caller', 'ABORTED', { cause: error })
      }
      throw mapSdkError(error)
    } finally {
      if (onAbort !== undefined) watchdog.signal.removeEventListener('abort', onAbort)
      consumer.abort('Cursor stream consumer stopped')
      if (!exhausted && iterator !== undefined && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time
          // abort cannot add a second outcome.
        }
      }
      agent?.close()
    }
  }

  /**
   * Create or resume the Cursor agent for one call. A resumed agent keeps its
   * conversation; a fresh one starts from the flattened harness history.
   * @param sdk - the loaded Cursor SDK module.
   * @param connection - the frozen connection facts.
   * @param apiKey - the resolved API key.
   * @param selection - the model selection for this call.
   * @param resumed - whether to resume the agent named by {@link replay}.
   * @param replay - validated replay state, when present.
   * @returns the acquired agent.
   */
  private async acquireAgent(
    sdk: typeof import('@cursor/sdk'),
    connection: CursorConnectionOptions,
    apiKey: string,
    selection: ModelSelection,
    resumed: boolean,
    replay: CursorReplayState | undefined,
  ): Promise<SDKAgent> {
    const store = new sdk.JsonlLocalAgentStore(connection.stateRoot)
    const options: AgentOptions = { model: selection, apiKey, mode: connection.mode }
    if (connection.runtime === 'local') {
      options.local = { cwd: connection.cwd, store }
    } else {
      options.cloud = {}
    }
    if (resumed && replay !== undefined) {
      // The replay state is validated before this call, so the agent id is a
      // non-empty string; a missing agent fails loud as INVALID_REQUEST.
      return sdk.Agent.resume(replay.agentId, options)
    }
    return sdk.Agent.create(options)
  }
}
