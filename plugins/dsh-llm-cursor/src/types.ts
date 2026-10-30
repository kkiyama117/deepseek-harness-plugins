/**
 * Cursor adapter vocabulary: catalog entries, durable replay state, and the
 * validated connection facts one operation resolves. Types only.
 *
 * @module dsh-llm-cursor/types
 */

import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ModelParameterValue } from '@cursor/sdk'

/** One optional model entry advertised by the Cursor adapter. */
export interface CursorCatalogModel {
  /** Model id accepted by the Cursor SDK (`Cursor.models.list()` ids). */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for similar model variants. */
  description?: string
  /** Known combined request/response context capacity; omitted when unknown. */
  contextWindow?: number
}

/**
 * Durable adapter-private replay state carried on a successful finish. The
 * Cursor agent id is the native session handle: the next ordinary
 * conversation request resumes that agent with only the new user message, so
 * the Cursor agent's own conversation continuity survives across harness
 * turns and process restarts (the local store persists under `stateRoot`).
 */
export interface CursorReplayState {
  /** Adapter discriminator; only this adapter's state is accepted. */
  kind: 'cursor'
  /** State shape version; bumped on any incompatible change. */
  version: 1
  /** Cursor agent id to resume on the next ordinary conversation request. */
  agentId: string
}

/** Validated connection facts for one operation. */
export interface CursorConnectionOptions {
  /** Credential reference resolved per request; never a literal key. */
  apiKeyEnv: CredentialRef
  /** Cursor agent runtime: the local SDK agent loop or the Cursor Cloud agent. */
  runtime: 'local' | 'cloud'
  /** Working directory for local agents; the agent's tools run here. */
  cwd: string
  /** Root directory of the local agent store (JSONL backend). */
  stateRoot: string
  /** Conversation mode for every send. */
  mode: 'agent' | 'plan'
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly CursorCatalogModel[]
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
  /** Extra model parameters merged into every `ModelSelection` (e.g. thinking). */
  params: readonly ModelParameterValue[]
}

/** Constructor options for the adapter: the operation-local hooks the plugin owns. */
export interface CursorAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => CursorConnectionOptions
  /**
   * Resolve the Cursor SDK API key for one request. Throws `LlmError`
   * `MISSING_CREDENTIAL` when no key is available anywhere.
   */
  resolveApiKey: (connection: CursorConnectionOptions) => Promise<string>
  /**
   * Load the Cursor SDK module. Defaults to a dynamic `import('@cursor/sdk')`
   * so the SDK's dependency weight stays out of plugin startup; tests inject
   * a stub.
   */
  loadSdk?: () => Promise<typeof import('@cursor/sdk')>
}
