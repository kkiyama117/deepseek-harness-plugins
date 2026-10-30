# @kkiyama117/dsh-llm-cursor

English | [中文](README.zh.md)

Cursor SDK agent adapter for the DeepSeek Harness LLM seam: one Cursor agent run per harness model call, backed by [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk) (pinned to `1.0.23`, the version the reference Pi extension was built against). The Cursor agent loop executes its own tools inside the SDK, so the harness sees reasoning, text, and usage only — the turn ends when the agent finishes. Session continuity rides the seam's replayState: a successful finish stores the Cursor agent id, and the next ordinary conversation request resumes that agent with only the new user message, so the Cursor agent's own conversation survives across harness turns and process restarts (the local store persists under `stateRoot`).

The package root exposes the Cordis plugin contract and `CursorAdapter`; prompt flattening, SDK message translation, and error mapping are separate modules.

## Install

From the harness checkout:

```sh
pnpm dsh plugin --profile web add /path/to/deepseek-harness-plugins/plugins/dsh-llm-cursor
```

The bundle's patch layer inserts the `llm-cursor` row, which registers the `cursor` provider route on the harness LLM seam. Restart the harness, store a Cursor SDK API key through the credentials service (the web Models page writes it) or export `CURSOR_API_KEY`, and select a `cursor/*` model.

## Config

```yaml
- id: llm-cursor
  name: '@kkiyama117/dsh-llm-cursor'
  config:
    apiKeyEnv: CURSOR_API_KEY  # default; resolved per request via ctx.credentials, then the environment
    runtime: local            # optional; local (default) or cloud
    cwd: /path/to/workspace   # optional; local agents run their tools here (default: process.cwd())
    stateRoot: ~/.dsh/cursor  # optional; local agent store root (default: $DSH_HOME/cursor)
    mode: agent               # optional; agent (default) or plan
    models:                   # optional; advisory catalog, defaults to `default` and `composer-2.5`
      - id: default
        name: Default
        contextWindow: 128000
    defaultContextWindow: 128000 # optional positive-integer fallback; this is the default
    streamIdleTimeoutMs: 300000  # optional; positive finite Node timer delay; five-minute default
    retryPolicy:             # optional; omission uses bounded normal defaults
      mode: normal
      maxRetries: 3
    params:                  # optional; extra model parameters merged into every ModelSelection
      - id: thinking
        value: 'true'
```

The plugin registers the single provider route `cursor`. A request selects it with `provider: cursor`; its `model` is passed through as the Cursor model id, so changing Cursor models does not require lifecycle-time registration. Omitting `models` advertises `default` and `composer-2.5`, each with the route's `defaultContextWindow`; an explicit list replaces those defaults, while `models: []` advertises none. Catalog entries are exposed through `ctx.llm.listModels('cursor')` for clients such as ACP editors and the Web selector, but remain advisory: unlisted model ids still pass through unchanged.

Models whose Cursor SDK catalog exposes a `fast` parameter (Grok, Composer, Opus 5/4.8/4.7, and the GPT-5.x family) are additionally advertised as `:fast` and `:slow` id variants — e.g. `grok-4.6`, `grok-4.6:fast`, `grok-4.6:slow` — so the model selector can pick the fast path per model. The adapter strips the suffix before calling the SDK and injects the `fast` parameter (`true` for `:fast`, `false` for `:slow`), which wins over a configured `params` entry with the same id; a suffix on a model without the `fast` parameter is ignored. The plain id keeps the SDK's default variant.

`runtime: cloud` runs the Cursor Cloud agent instead of the local SDK loop; the local store and `cwd` are then unused. `params` entries are merged into every `ModelSelection` (the SDK's model-parameter vocabulary, e.g. `thinking: true`), which is also where Cursor's reasoning controls live — the harness exposes no reasoning efforts for this provider because Cursor reasoning is a model parameter, not a wire effort.

`streamIdleTimeoutMs` bounds each outstanding provider read without counting time the consumer spends between chunks. The adapter makes exactly one Cursor agent run per `stream()` call; it registers the configured policy as provider metadata, and `dsh-llm-retry` separately executes it at durable agent-step boundaries.

## Dynamic configuration (settings + credentials)

Connection facts are not frozen at load. `resolveAdapterOptions` is the one explicit resolve step from raw config to validated facts, and the adapter re-reads them through a thunk **once per operation**: runtime, cwd, state root, catalog, and idle budget all take effect on the next request, while an in-flight stream keeps the facts it started with. Two optional seams feed that thunk:

- **`ctx.settings`** — the plugin registers the `llm-cursor` namespace with this same `Config` schema and its `cordis.yml` entry as the composition `base`, so a `llm-cursor:` section in the user settings document overrides any field without a restart. Without a mounted settings service the entry config alone drives the adapter, unchanged. A live settings snapshot that passes the schema but fails a beyond-schema bound (an empty state root, a duplicate catalog id) keeps the last good facts and logs the failure; the entry config itself still fails plugin load.
- **`ctx.credentials`** — the API key resolves per stream call, from the *same* resolved snapshot that supplies the connection facts. Configuration carries only `apiKeyEnv`, never a literal key: the reference resolves through the credential seam, and without a mounted seam through the trusted environment layers. Every resolved key is format-checked before use, so a value no HTTP header can carry is refused with `LlmError('INVALID_CREDENTIAL')` naming the failing entry point — never any part of the key. A request with no key anywhere fails with `MISSING_CREDENTIAL` naming every configuration entry point, while the route stays registered and the catalog stays browsable.

The one registration-captured fact is the retry policy: when its resolved value changes, the plugin re-registers the route in place (same adapter instance, one synchronous section), so `ctx.llm.providerRetryPolicy('cursor')` always reports the current policy.

The plugin also declares its route in the configurable-provider directory (`ctx.llm.listConfigurableProviders()`): provider `cursor`, settings namespace `llm-cursor`, empty settings path — the whole section is the profile.

## Model discovery

The plugin offers `ctx.llm.registerModelDiscovery('llm-cursor', …)`, which answers "which models can this provider serve?" for a route a configuration surface is editing or drafting. A draft naming the `cursor` route is answered from the **live Cursor SDK catalog** (`Cursor.models.list()`, the pi-cursor-sdk `/cursor-refresh-models` equivalent) whenever a credential is available — the key typed in the draft, else the route's stored key. The reply is candidates the surface offers for adoption, never a stored catalog. Without any credential the draft is answered from the configured catalog, with no network call. Every other draft — a base URL, a foreign route — is refused with `DISCOVERY_UNSUPPORTED`, because Cursor models come from the Cursor SDK, never from an endpoint this adapter can interrogate.

## Provider/model routing and replay

Each resolution produces one **immutable** snapshot of the connection facts, captured before the first `await` of the operation. A configuration change therefore reaches the next request, never the one in flight.

A successful finish emits `finish.replayState` carrying the Cursor agent id inside the seam's `ReplayEnvelope` (`{ response: { kind: 'cursor', version: 1, agentId } }`; no per-block metadata, so `blocks` is omitted and the envelope passes through assembly unchanged). On the next request, the adapter reads the replay state of the latest model-produced assistant message, validates it, and — for ordinary conversation requests only — resumes that agent (`Agent.resume`) and sends only the latest user message, because the agent already holds the conversation. Auxiliary calls (`purpose: compaction` or `session-title`) always run on a fresh agent with the flattened history, so a summarization or title call can never pollute the conversation of a resumed agent. Malformed replay state fails with `LlmError('INVALID_REPLAY_STATE')` before any SDK interaction; a resumed agent that no longer exists (a cleared store) fails loud as `INVALID_REQUEST` rather than silently starting over.

## Vocabulary differences

- The Cursor agent loop executes its own tools inside the SDK, so `tool_call` messages and assistant `tool_use` blocks are **not** replayed as harness tool-call blocks: the harness would execute them a second time. The harness sees reasoning, text, and usage; the agent's internal tool activity is opaque, exactly like a subagent's.
- A fresh agent receives the flattened harness conversation as one prompt: the system prompt, then each message rendered as `User:`/`Assistant:` text with tool calls and results as a transcript. Reasoning blocks are model-internal and never rendered.
- `GenerateOptions.stop`, `temperature`, and `maxTokens` are rejected with `UNSUPPORTED_OPTION`: the Cursor SDK `send` takes a prompt, a model selection, and a mode, and has no wire equivalent for sampling knobs or stop sequences. The agent loop sends none of these by default, so the rejection only fires for explicit configuration.
- `reasoningEffort` maps to the model's effort parameter: the adapter exposes the SDK catalog's effort vocabulary (`effort` for Grok/Claude models, `reasoning` for GLM/GPT models) as harness reasoning efforts, so the model selector offers effort levels per model. The selected effort becomes the model parameter (e.g. `effort: high`), replacing a configured `params` entry with the same id; models without a vocabulary keep the SDK's default variant.
- The `fast`/`slow` choice is a model id suffix, not a mode: the SDK's `mode` is only `agent`/`plan`, and `fast` is a model parameter (`true`/`false`). Select `grok-4.6:fast` or `grok-4.6:slow` to pin it per model; the suffix is stripped before the SDK call and the `fast` param is injected into the `ModelSelection`.
- SDK error classes map to stable harness codes: `AuthenticationError` → `AUTH`, `RateLimitError` → `RATE_LIMIT`, `NetworkError` → `SERVER`, `AgentBusyError`/`UnknownAgentError`/`ConfigurationError` → `INVALID_REQUEST`, generic retryable SDK errors → `SERVER`, everything else → `TRANSPORT`. A failed run ends the stream with an error finish carrying the run's own error code and message.
- Caller cancellation cancels the SDK run and throws `ABORTED`; the configured stream-idle budget cancels the run and throws `TIMEOUT`.

## App attribution

Every provider HTTP request must carry the shared attribution header from dsh-llm's `attributionHeaders()`. `@cursor/sdk` 1.0.23 exposes no header hook (`CursorRequestOptions` carries only the API key), so this adapter cannot inject the harness attribution header into the SDK's transport; the SDK sends its own User-Agent. This is a documented deviation from the adapter contract, tracked under Known Limitations.

## Dependency weight

`@cursor/sdk` is pinned exactly (not ranged) because the SDK ships platform-specific optional binaries; the pin matches the version the reference Pi extension was built and tested against. The SDK is loaded through a dynamic `import()` per stream call, so its dependency weight stays out of plugin startup. The local runtime uses the SDK's `JsonlLocalAgentStore` (JSONL files under `stateRoot`), which needs no native `sqlite3` module.

## Model Experience

### Cursor agent request

#### What the model sees

The Cursor agent receives the flattened harness conversation as one user message (system prompt plus history for a fresh agent, the latest user message for a resumed one). This package adds no prompt prose beyond the `System instructions:` / `User:` / `Assistant:` framing of the flattened history.

#### Token effect

Provider tokenization governs exact input. Flattening adds the role framing lines; reasoning blocks are dropped rather than re-sent. A resumed agent sends only the new user message, so its input is minimal.

#### KV Cache effect

The Cursor agent's own conversation is the cache domain: a resumed agent reuses its stored context, while a fresh agent starts from the flattened history. Changing the agent (a cleared store, a new `stateRoot`) starts a new domain.

### Cursor agent response

#### What the model sees

SDK thinking messages become harness reasoning blocks, assistant text becomes text blocks, and usage messages become usage chunks. Tool activity inside the agent loop is not surfaced.

#### Token effect

Generated content affects later inputs only after the loop records it. The SDK's per-turn usage is reported when available; a run that reports none yields zero usage.

#### KV Cache effect

Recorded response content appends to the next request through the resumed agent's own conversation and does not invalidate its earlier reusable prefix. Unrecorded transport metadata and usage accounting do not affect cache identity.

## Known Limitations and Deferred Work

- **Attribution headers are not injectable** — `@cursor/sdk` 1.0.23 exposes no header hook, so the mandatory harness attribution header cannot reach the SDK's transport; the SDK sends its own User-Agent. A future SDK header hook or a transport-level fork would close this.
- **The harness never executes tools during a Cursor turn** — the Cursor agent loop runs its own tools inside the SDK, and the harness's tool schemas are not sent. Bridging harness tools into the Cursor agent (the Pi extension's MCP-bridge pattern) is deferred.
- **A resumed agent's conversation can diverge from the harness history** — compaction and session-title calls run on fresh agents, but a compacted harness history is not replayed into a resumed agent; the agent keeps its own (longer) context.
- **A cleared store breaks session continuity loudly** — a resumed agent that no longer exists fails with `INVALID_REQUEST` instead of silently starting over; there is no fallback to a fresh agent.
- **Effort vocabularies are a static snapshot** — the reasoning efforts the selector offers come from a built-in table mirroring the SDK catalog (`effort` for Grok/Claude models, `reasoning` for GLM/GPT models), not a live fetch; a model the table does not know exposes no efforts and keeps the SDK's default variant.
- **`GenerateOptions.stop`, `temperature`, and `maxTokens` are unsupported** — the Cursor SDK has no wire equivalent; explicit configuration fails with `UNSUPPORTED_OPTION`.
- **Discovery offers, it does not store** — the live catalog is fetched on demand for the Models page, but nothing writes the fetched list into `settings.yaml`; adopting candidates is the configuration surface's job, and the advisory catalog remains whatever the settings document says.
- **Cloud runs are untested against the harness** — the `runtime: cloud` path is implemented against the SDK's option shape but has no real-API coverage in this package's e2e suite.
