# Issue: generalize LLM provider fallback beyond kimi-coding

- **Status:** fallback generalized (config-driven chains); role agents next
- **Created:** 2026-08-15
- **Related:** `llm-fallback/index.mjs` (host plugin, row in `~/.dsh/cordis.patch.yml`)
- **Final goal:** a dsh plugin like [`pi-subagents`](https://github.com/nicobailon/pi-subagents) (npm `pi-subagents@0.50.0`, docs in its `docs/` tree). The fallback work below is one slice of that goal.

## Memory — what exists today and why

`llm-fallback` intercepts the `llm/stream` waterfall and re-issues any call
whose provider has a configured chain when the call fails with a configured
failure code (default `QUOTA`, `RATE_LIMIT`) **before producing content**.
Routes are tried in order; the first route that completes wins. The caller
sees one uninterrupted stream; no agent or skill change is needed.

Config (row config in `~/.dsh/cordis.patch.yml`):

```yaml
chains:
  kimi-coding:
    - provider: cursor
      model: grok-4.6
      reasoningEffort: xhigh
      strip: [maxTokens, temperature, stop]
fallbackOn: [QUOTA, RATE_LIMIT]   # optional; default shown
```

Design knowledge that must not be re-derived:

- **Why the waterfall:** the LLM seam has no provider-fallback. Retry is
  per-provider and runs at the agent's failed-step extension point
  (`dsh-llm-retry`), so a terminal quota failure reaches the caller as a
  `finish` chunk with `reason.kind === 'error'` and `failure.code`.
- **Re-issue path:** the waterfall listener's `this` is the `LlmRuntime`;
  re-issue via `runtime.stream({ ...options, ...route })`. Guard on the
  source provider to prevent recursion (the fallback call re-enters the
  waterfall; chains compose, cycles are a config error).
- **Event reach:** all contexts share the root `EventsService`, so a
  host-composition row hears `llm/stream` emitted from any service context.
- **Cursor adapter constraints:** rejects `maxTokens`, `temperature`, `stop`
  (`UNSUPPORTED_OPTION`) — the per-route `strip` list drops them. `grok-4.6`
  supports `reasoningEffort: xhigh` (paramId `effort`).
- **Fallback-on codes:** `QUOTA` (terminal) and `RATE_LIMIT` (transient) by
  default, matching pi-subagents' `fallbackModels` behavior. Falling back on
  `RATE_LIMIT` preempts the retry policy and burns fallback-provider credits
  on blips — accepted trade-off, configurable via `fallbackOn`.
- **Content guard:** a fallback only fires before any content chunk was
  delivered; after content, the error propagates (cannot rewind).

## Issue — the fallback is provider-level; pi-subagents is per-agent

The generalized fallback is keyed by **provider** (the only signal the
waterfall sees). pi-subagents keys `fallbackModels` by **agent/role**
(frontmatter + `agentOverrides`), so different roles can route to different
models and fallbacks. Bridging that gap is part of the final goal below.

## Verified live (2026-08-15, dynamic probe + dynamic fallback)

- `deepseek-official`/`deepseek-v4-flash` fails with `QUOTA`
  ("Insufficient Balance") — the DeepSeek account has no usage.
- `ollama-cloud`/`deepseek-v4-flash:0731` works (the default agent model).
- With a fallback chain `deepseek-official → ollama-cloud/deepseek-v4-flash:0731
  → cursor/grok-4.6 (xhigh)`, the same failing call succeeds (`stop`, "pong"):
  the `fallbackOn` `QUOTA` path fires and re-issues automatically.
- Persistent config now carries the `deepseek-official` chain (route 1 strips
  `maxTokens` — the pi-ai adapter passes it through and ollama-cloud caps it
  below the deepseek-official 256000 default; route 2 is the Cursor strip
  list). Effective after the next dsh restart.

## Requested target chain (worker model rate-limit fallback)

Source `ollama-cloud`/`glm-5.3-flash` → one fallback route `openrouter`/
`deepseek/deepseek-v4-flash-0731`, firing on `QUOTA` or `RATE_LIMIT` only and
only before any content chunk. Config for the plugin row:

```yaml
chains:
  ollama-cloud:
    sourceModel: glm-5.3-flash
    routes:
      - provider: openrouter
        model: deepseek/deepseek-v4-flash-0731
fallbackOn: [QUOTA, RATE_LIMIT]
```

`sourceModel` is required per chain: only that model on the provider falls
back, so every other ollama-cloud model keeps its direct path. Routes target
their own provider (`ollama-cloud → ollama-cloud`) is a config error (cycle).

Provider-scoped chain keyed on `ollama-cloud` cannot touch the GPT
planner/reviewer (`openai-codex`/`gpt-6-astra`), which lives on a different
provider. `test.mjs` covers this exact route plus disposal (tests 10–11).

**Activation:** the plugin is packaged as a profile bundle `dsh-llm-fallback`
(see `package.json` / `cordis.patch.yml`) and installed into
`~/.dsh/profiles/web` via `dsh plugin --profile web add`
`/data/softwares/deepseek-harness-plugins/llm-fallback`. The composed config
resolves through `dsh --profile web --dump-config`; the row carries the chain
below plus a `sourceModel: glm-5.3-flash` guard so only that model falls back.
Wired in 2026-09-09.

## Verification

- `llm-fallback/test.mjs` — 11 assertions (source-model filter, cycle guard,
  disposal); run with `node llm-fallback/test.mjs`.
- `llm-fallback/mount.test.mjs` — real-Cordis mount/teardown through
  `ctx.plugin` + `llm/stream` waterfall dispatch (this-bound runtime).
- Composed profile config: `dsh --profile web --dump-config` (see the
  `llm-fallback` row).
- Live end-to-end only after a real quota failure; activation is not asserted
  from config.

---

## Subagent-call fallback (`subagent-fallback`, 2026-08-15)

A second, complementary layer: the delegation **tool** retries a failed
subagent run on the next provider/model route. Rides on the existing
`subagents` registry (same request shape and start path as
`@deepseek-ai/dsh-tool-subagent` — no reimplementation of spawning,
backgrounding, or the provider registry).

- Row in `~/.dsh/cordis.patch.yml` replaces `tool-subagent-frontier`; the
  tool keeps the name `subagent_frontier` so the implement-task skill works
  unchanged, now with fallback.
- Config: `primary` (required) + `fallbackRoutes` (ordered) + `toolName` /
  `provider` (defaults `subagent_frontier` / `spawn`).
- **Retry policy:** only `stopReason: 'error'` (the seam's definition:
  "model or transport failure") retries. `completed` wins; `aborted`,
  `max-tokens`, `refusal` are final (task-level outcomes, matching
  pi-subagents' "ordinary task failures do not trigger fallback").
- **Relationship to `llm-fallback`:** the stream layer transparently covers
  `QUOTA`/`RATE_LIMIT` before content; the run layer catches what the stream
  layer misses (auth, no-adapter, transport, exhausted chains, run-level
  failures) and is explicit about which route served the call.
- Verification: `subagent-fallback/test.mjs` (5 assertions), composition
  checked via `--dump-config`. Live end-to-end after the next dsh restart.

## Final goal — a dsh plugin like `pi-subagents`

Reference: <https://github.com/nicobailon/pi-subagents> (README + `docs/`:
`agents.md`, `models.md`, `workflows.md`, `tool-reference.md`,
`configuration.md`, `observability.md`, `missions.md`, `watchdog.md`,
`extension-api.md`).

### Feature map (from the README and docs)

| Area | Features |
|------|----------|
| Delegation tool | One `subagent` tool with `workflowScript` (plain JS): `runs.run` (one child), `runs.all` (parallel), sequential composition, `resume` of retained children, foreground/background (`async`), `cwd` override, `maxOutput` truncation. |
| Builtin agents | Markdown files with YAML frontmatter: `scout` (recon), `researcher` (web/docs), `worker` (implementation), `reviewer` (review + small fixes), `oracle`/`advisor` (second opinion, no edits), `delegate` (general). Custom agents anywhere (builtin/package/user/project scope, project wins). |
| Agent frontmatter | `tools` (strict child allowlist, `mcp:` entries), `extensions`/`subagentOnlyExtensions`, `model`, `fallbackModels`, `thinking`, `systemPromptMode` (replace/append), `inheritProjectContext`, `inheritSkills`, `skills`/`skillPath`, `defaultContext` (fresh/fork), `output`, `defaultReads`, `defaultProgress`, `async`, `timeoutMs`, `toolTimeoutMs`, `turnBudget`, `acceptance`, `acceptanceRole`, `completionGuard`, `maxSubagentDepth`, `memory` (per-agent persistent `MEMORY.md`, project/user scopes). |
| Models | Precedence: per-run → frontmatter → `agentOverrides.<name>` → `subagents.defaultModel` → parent model. **`fallbackModels`: ordered backup models; automatic fallback on rate-limit, overload, quota, auth, timeout, unavailable-model — NOT on ordinary task failure.** Thinking levels, fuzzy model matching, `modelScope` enforcement (glob allowlist, strict mode), profiles generated from live provider catalogs. |
| Workflows | Prompt shortcuts (`/parallel-review`, `/review-loop`, `/parallel-research`, `/gather-context-and-clarify`, `/parallel-cleanup`, `autofix`), scripted workflows, git worktree isolation per child, missions (durable records, `state.get/set` JSON, delivery receipts), scheduled/timed runs. |
| Child↔parent | `contact_supervisor` (need_decision / interview_request / progress_update) + parent reply path, scoped to the spawning session. |
| Safety | Recursion guard (`maxSubagentDepth`, default 2 levels), spawn budgets (`maxSubagentSpawnsPerRun`/`PerSession`), concurrency limits, child-safety boundaries (children don't get the subagent tool unless allowlisted), watchdog (opt-in adversarial change reviewer, scope monitoring, LSP checks). |
| Observability | FleetView, fleet inspector, status/control actions (`status`, `interrupt`, `steer`, `resume`), transcripts, run artifacts, session sharing. |
| Budgets/gates | `turnBudget` (maxTurns+grace), `toolBudget` (soft/hard, block list), `usageBudget` (tokens/cost soft/hard), acceptance gates (`verified` with host-run commands), `timeoutMs`/`toolTimeoutMs`. |
| Ops | `/subagents-doctor`, `/subagents-guide <topic>`, refinement overlays (evidence-driven project-local prompt patches with rollback), `eject`/`disable`/`enable`/`reset` agent management. |

### What dsh already has (the mapping)

- `subagents` registry + providers (`spawn`, `fork`, `codex`, `claude-code`)
  and `tool-subagent` / `tool-subagent-fork` / `tool-subagent-control` /
  `tool-subagent-report` — the delegation substrate.
- `subagent_frontier` (implement-task) — the first "role" tool, hardcoded to
  kimi-k3.
- Skills system (SKILL.md discovery, per-agent catalogs) — maps to
  `skills`/`inheritSkills`.
- Agent presets (per-session composition) — maps to per-agent tool/prompt
  scoping.
- LLM seam with providers (kimi-coding, cursor, ollama-cloud, deepseek) and
  the `llm/stream` waterfall — the hook for `fallbackModels` (now built:
  `llm-fallback`).
- `workflowEngine` service, `goals`, `jobs` — possible bases for missions,
  schedules, and orchestration.

### The gap (what to build)

1. **Role agents as data** — markdown/frontmatter agent definitions (scout,
   worker, reviewer, oracle, delegate) resolved into dsh subagent launches,
   with per-agent `tools` allowlists and prompt assembly (replace/append,
   inherit project context, skills).
2. **Per-agent model config with `fallbackModels`** — extend `llm-fallback`
   from provider-level chains to per-role chains (the waterfall only sees
   provider/model; the subagent tool must tag calls with the role, or the
   role→provider mapping must be resolved before the call).
3. **Orchestration** — `workflowScript`-style sequential/parallel composition
   over the dsh subagents registry (dsh's `workflow` tool is the closest
   existing shape), plus review-loop/parallel-review patterns.
4. **Budgets and gates** — turn/tool/usage budgets, acceptance gates,
   timeouts, spawn-depth and concurrency caps.
5. **Observability** — fleet/status surface for background children
   (dsh has `jobs` and subagent status primitives to build on).
6. **Child→parent coordination** — a `contact_supervisor`-equivalent over
   dsh's session/message primitives.

### Sequencing

1. ~~Generalize the fallback into config-driven chains~~ — **done**
   (`llm-fallback`, 8/8 checks).
2. Role agents as data (frontmatter → subagent launch).
3. Orchestration + budgets + observability, in that order.

### Open questions

- Should the default agent model (`ollama-cloud`) get a fallback, and to what?
- Should a fired fallback be visible to the user (log/notice)?
- Agent definitions: dsh-native format (YAML frontmatter like pi) or reuse
  dsh's existing preset/skill machinery?
- How should the subagent tool tag calls with the role so `fallbackModels`
  can be per-agent?
