/**
 * Register a {@link CursorAdapter} for the `cursor` provider route on
 * `ctx.llm`, with connection facts resolved per request instead of frozen at
 * load: the plugin layers its `cordis.yml` entry config under the optional
 * `llm-cursor` user-settings section (`ctx.settings`) and resolves the API
 * key through the optional credential seam (`ctx.credentials`), so a changed
 * runtime, catalog, or key reaches the very next request without restarting
 * anything, while an in-flight stream keeps the facts it started with. The
 * one registration-captured fact — the retry policy — re-registers the route
 * in place when it changes.
 * @module @deepseek-ai/dsh-llm-cursor
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  CursorAdapter,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from './adapter.ts'
import type { CursorCatalogModel, CursorConnectionOptions } from './types.ts'

export {
  CursorAdapter,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from './adapter.ts'
export type { CursorAdapterOptions, CursorCatalogModel, CursorConnectionOptions, CursorReplayState } from './types.ts'
export { buildPrompt, renderMessage } from './prompt.ts'
export { closeBlocks, createTranslateState, mapSdkError, mapUsage, translateMessage } from './translate.ts'
export type { TranslateState } from './translate.ts'

export const name = 'llm-cursor'
export const inject = ['llm']

const NS = settingsNamespace('llm-cursor')
const DEFAULT_API_KEY_ENV = 'CURSOR_API_KEY'
/** The single provider route this plugin owns. */
const PROVIDER = 'cursor'

const DEFAULT_MODELS: CursorCatalogModel[] = [
  { id: 'default', name: 'Default', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'composer-2.5', name: 'Composer 2.5', contextWindow: DEFAULT_CONTEXT_WINDOW },
]

/** One model parameter merged into every `ModelSelection`. */
export interface CursorModelParam {
  /** Parameter id from the Cursor SDK's model-parameter vocabulary (e.g. `thinking`). */
  id: string
  /** Parameter value as the SDK expects it (e.g. `true`). */
  value: string
}

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-cursor` settings-section shape. Every field is optional in yml:
 * a missing API key resolves through {@link Config.apiKeyEnv} at each request
 * (a request without any key fails with `MISSING_CREDENTIAL`, not at plugin
 * load), the local runtime defaults to the launching working directory, and
 * the local agent store defaults to `$DSH_HOME/cursor`.
 */
export interface Config {
  /** Credential reference (environment-variable name) resolved per request; defaults to `CURSOR_API_KEY`. */
  apiKeyEnv?: string
  /** Cursor agent runtime: the local SDK agent loop (default) or the Cursor Cloud agent. */
  runtime?: 'local' | 'cloud'
  /** Working directory for local agents; defaults to the launching working directory. */
  cwd?: string
  /** Root directory of the local agent store; defaults to `$DSH_HOME/cursor`. */
  stateRoot?: string
  /** Conversation mode for every send (default `agent`). */
  mode?: 'agent' | 'plan'
  /** Advisory models shown by discovery consumers; defaults to `default` and `composer-2.5`. */
  models?: CursorCatalogModel[]
  /** Positive context capacity used when the selected model has no exact value (default 128,000). */
  defaultContextWindow?: number
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
  /** Extra model parameters merged into every `ModelSelection` (e.g. `thinking: true`). */
  params?: CursorModelParam[]
}

const catalogModel: z<CursorCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
})

const modelParam: z<CursorModelParam> = z.object({
  id: z.string().required(),
  value: z.string().required(),
})

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  runtime: z.union(['local', 'cloud']).default('local'),
  cwd: z.string(),
  stateRoot: z.string(),
  mode: z.union(['agent', 'plan']).default('agent'),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
  params: z.array(modelParam).default([]),
})

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models: readonly CursorCatalogModel[] | undefined): CursorCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('llm-cursor: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-cursor: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(
        `llm-cursor: catalog model "${model.id}" contextWindow must be a positive integer`,
      )
    }
    if (seen.has(model.id)) throw new Error(`llm-cursor: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
    }
  })
}

/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here — for the composition entry at
 * load (fail loud) and for each settings snapshot at its first use.
 * @param config - raw plugin config or resolved settings snapshot.
 * @returns validated connection facts plus the credential reference.
 */
export function resolveAdapterOptions(config: Config): CursorConnectionOptions {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-cursor: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('llm-cursor: defaultContextWindow must be a positive integer')
  }
  const runtime = config.runtime ?? 'local'
  const cwd = config.cwd ?? process.cwd()
  if (runtime === 'local' && cwd.length === 0) {
    throw new Error('llm-cursor: cwd must be a non-empty path for the local runtime')
  }
  const stateRoot = config.stateRoot ?? dshHomePath('cursor')
  if (stateRoot.length === 0) throw new Error('llm-cursor: stateRoot must be a non-empty path')
  const params = (config.params ?? []).map((param) => {
    if (param.id.length === 0 || param.value.length === 0) {
      throw new Error('llm-cursor: model params must have non-empty id and value')
    }
    return { id: param.id, value: param.value }
  })
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    runtime,
    cwd,
    stateRoot,
    mode: config.mode ?? 'agent',
    models: resolveModels(config.models),
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-cursor: retryPolicy'),
    params,
  }
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: CursorConnectionOptions | undefined
  const options = (): CursorConnectionOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-cursor: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveApiKey = async (connection: CursorConnectionOptions): Promise<string> => {
    // Every credential fact comes from the caller's snapshot, so a rejected
    // settings generation cannot leak its key onto the previous endpoint.
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-cursor', ref)
    } else {
      // Without the seam there is no managed store to rank against, so the
      // environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'llm-cursor', ref)
      }
    }
    throw new LlmError(
      `llm-cursor: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
      + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  const loadSdk = (): Promise<typeof import('@cursor/sdk')> => import('@cursor/sdk')
  const adapter = new CursorAdapter({ options, resolveApiKey, loadSdk })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Cursor', settingsNs: NS, settingsPath: [] },
  ])
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below.
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    // The registry captures the retry policy at registration, so it is the one
    // fact per-request resolution cannot refresh. `replace` re-reads it in one
    // synchronous registry section: disposing and re-registering instead would
    // publish an empty route set between the two, and an observer that reacted
    // to it would see this provider disappear and come back.
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  ctx.llm.registerModelDiscovery(NS, async (request: LlmModelDiscoveryRequest): Promise<LlmDiscoveredModel[]> => {
    // A draft editing this adapter's own route is answered from the live
    // Cursor SDK catalog whenever a credential is available — the key typed
    // in the draft, else the route's stored key (the pi-cursor-sdk
    // `/cursor-refresh-models` equivalent). The reply is candidates the
    // surface offers for adoption, never a stored catalog. Without any
    // credential the draft is answered from the configured catalog, with no
    // network call.
    if (request.provider === PROVIDER) {
      let apiKey: string | undefined
      if (request.apiKey !== undefined) {
        apiKey = assertUsableApiKey(request.apiKey, 'llm-cursor', 'discovery')
      } else {
        try {
          apiKey = await resolveApiKey(options())
        } catch (error) {
          // No stored key either: answer from the configured catalog. Only
          // MISSING_CREDENTIAL can land here — the typed-key path above
          // already format-checked, and resolveApiKey throws nothing else.
          if (!(error instanceof LlmError) || error.code !== 'MISSING_CREDENTIAL') throw error
        }
      }
      if (apiKey !== undefined) {
        try {
          const models = await (await loadSdk()).Cursor.models.list({ apiKey })
          return models.map(model => ({
            id: model.id,
            ...model.displayName === undefined ? {} : { name: model.displayName },
          }))
        } catch (error) {
          throw new LlmError(
            `Cursor model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
            'DISCOVERY_FAILED',
            { cause: error },
          )
        }
      }
      return options().models.map(model => ({
        id: model.id,
        ...model.name === undefined ? {} : { name: model.name },
        ...model.description === undefined ? {} : { description: model.description },
      }))
    }
    // Cursor models come from the Cursor SDK, never from a base URL or a
    // route this adapter does not own, so no other draft is interrogatable.
    return Promise.reject(new LlmError(
      'Cursor models come from the Cursor SDK, not a base URL or a foreign route',
      'DISCOVERY_UNSUPPORTED',
    ))
  })

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: ensureRegistrationFacts,
  })
}
