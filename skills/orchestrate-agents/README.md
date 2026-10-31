# Reproducible agent orchestration

An on-demand skill plus a dependency-free flow compiler and optional Jev routing entry. Models formulate tasks; fixed routing rules can select an existing flow from Jev Choice answers. Checked code owns graph expansion, admission, parallelism, conditional edges and termination. It reuses DSH's native `workflow` tool: no server, replacement harness, or background service is installed.

## Use

```sh
node bin/compile.mjs examples/single.json examples/policy.json /ABSOLUTE/PRIVATE/new-run
node --test tests/*.test.mjs
uv run bin/install.py
```

Read [DSH execution and installation](references/run-dsh.md) before submitting the compiled payload. [Task packets](references/task-packet.md) and [policy/graph formats](references/flow-format.md) define the inputs. Installation backs up the old two skills and leaves one discoverable `orchestrate-agents` skill. The [verification record](references/verification.md) separates deterministic tests, native integration evidence and deployment limitations.

[SKILL.md](SKILL.md) is a thin entry: it selects a structure and points to one [flow guide](docs/direct.md) per choice (`direct`, `single`, `executor-advisor`, `comparison`, `lead-workers`, `coordinator-advisor`, `custom`), each read only when that flow is entered. [Shared execution rules](docs/shared-execution.md) holds authority, opt-in, session-topology, routing and runner behavior common to the flows. The references below explain specific mechanisms and are not a required read-first sequence.

For larger tasks, use [progressive decomposition](references/progressive-decomposition.md) to move from the whole goal to independently verifiable worker packets. [Acceptance evidence](references/acceptance-evidence.md) defines the criterion-to-evidence report without changing the runner schema. [Verification entry points](references/verification-map.md) maps this skill's existing checks and their limits.

## Optional Jev routing

Read the [Japanese routing guide](references/jev-routing.ja.md) for the stage/policy fields and private artifacts. `node bin/route.mjs examples/routing-stage.json examples/routing-policy.json /ABSOLUTE/PRIVATE/new-routing` is an offline synthetic shadow example. Real classification requires separate external-send permission: `gateway:typesafe` uses `TYPESAFE_API_KEY`, while `gateway:openrouter` uses `OPENROUTER_API_KEY` and the Decisions API. Endpoints are allowlisted. Choose a pinned model or explicitly opt into OpenRouter's `~typesafe/jev-latest`; returned model identities are recorded and credentials never fall back between gateways. Questions are batched once, with no retry or provider fallback. This is a stage artifact generator, not a global agent hook or an arbitrary-task planner.

Default shadow mode emits no executable script. Selection requires explicit `mode:select`, operator-supplied per-question thresholds for adopted inferred answers, and separately authorized workflow execution. F1 compiles to existing `single`; F3/F4 compile to `lead-workers`, including its planning, integration and review calls. F0 routine and F2 bounded-investigation outputs are handoffs, never shell execution or invented templates. Missing evidence, malformed answers or failures return structured handoff/hold/fallback; they never call a replacement model.

Pass the previous `report.json` as the fourth CLI argument to retain cumulative call/input-byte limits and reuse validated pinned-model classifications. The latest alias never reuses classifications: its target may move, so each needed classification requires fresh external-send permission and budget. Stage/source changes invalidate the cache; permission and compiler-budget checks run again on reuse. Limits apply to the supplied report lineage, not concurrent processes or monetary spend. Keep reports private; never put credentials into task inputs. Mocked tests establish routing and compiler behavior, not classification accuracy or safe threshold calibration.

## Execution model

The compiler takes a request and a separately maintained deployment policy. It emits one complete `{meta, script, args, resultKeys}` tool input. Submit that object unchanged to the native DSH `workflow` tool after the human has requested workflow execution. For ordinary direct work, the skill still permits acting without a workflow or extra agent.

The policy binds logical roles to observed provider/model routes and sets ceilings. Request options select concurrency and repair rounds within those ceilings. Unknown options, unresolved roles, invalid scopes, overlapping parallel unit writers and invalid graphs fail before worker calls. Reasoning effort is not supported by this DSH hook; model names such as `expert-single` are not extra flow types.

| Flow | Structure |
|---|---|
| `single` | One executor performs the task and its verification. Use direct execution outside the runner when a reproducible workflow was not requested. |
| `executor-advisor` | Executor attempts → optional one-shot advisor → fresh executor continuation. No mandatory planning or review. |
| `comparison` | Sequential read-only Flash / Astra / Flash-with-advice experiment; same task, separate answers, independent evaluation pending. See [protocol and limits](references/comparison.md). |
| `lead-workers` | Lead plan → workers over explicit units → lead integration → reviewer → bounded integrator repair and re-review. |
| `coordinator-advisor` | Designer → sequential batches: coordinator decision → optional advisor → unit workers → coordinator integration → reviewer/repair → designer acceptance. |
| `custom` | Allowlisted strong designer proposes a data-only graph → validation → frozen graph execution using the same primitives and limits. |

Preset [review rounds](references/review-evidence.md) distinguish initial review from re-review and carry prior findings alongside the latest repair result.

Units, prompts, scope and acceptance criteria are formulated before dispatch. Worker count is the explicit unit count; concurrency is a separate option. Model-produced planning output can guide work, but cannot silently add units, roles, permissions or calls. A custom designer can combine `agent` and `map` nodes, dependencies and enumerated status conditions. Arbitrary JavaScript and graph cycles are not accepted; bounded repetitions are explicit finite nodes. The host still owns cancellation.

## Reproducibility and guarantees

For the same validated input and accepted node outputs, transitions and ordered result aggregation are deterministic. Model replies, wall-clock completion order and external effects are not deterministic. The complete result includes the resolved request, frozen graph, selected routes, call count and ordered node outputs. The compiler requests a Host-saved result with only status, call count and the acceptance/attention summary returned inline; retain its retrieval reference with the compiled input. Neither a filename nor model-written provenance proves actual runtime identity. [Evidence-aware synthesis](references/synthesis.md) defines judgment and selective retrieval.

The `custom` path calls the designer itself on a deployment-allowlisted route. It does not accept a user-authored `author.model` label as proof and does not load a submitted executable script. Validation happens before any proposed work runs. Effective model routing remains host-owned: inspect native DSH records for provider fallback or alias changes before claiming the actual model identity. Custom graph publication as a reusable template requires separate human acceptance.

The output `completed` means the declared acceptance node reported `done` with no observed blocked node. It is not independent proof that the underlying user task is correct. The parent must inspect artifacts and actual verification evidence before claiming the human objective is complete.

## Limits

- Native DSH workflow calls block the parent. This adapter has no durable resume, checkpoint, retry of uncertain side effects, child-session reuse, or per-node effort override. Cancellation is handled by DSH, not by rerunning a saved script.
- Child prompts prohibit recursive delegation and specify write scopes, but the workflow hook cannot enforce per-child tool/filesystem permissions. The policy checks planned ownership, not sandbox isolation or symlink aliases. Use host permissions/worktrees for enforcement.
- Ceilings count calls admitted by this runner, not tokens, money, or hidden calls a misbehaving child could make. Host caps can be tighter. Compact handoff requires a live `workflow` tool supporting `resultKeys` and a session-owned spill store; it does not cap child context/output or guarantee synthesis quality. The Host caps the rendered projection and retains the complete result for retrieval.
- Runtime/tool failures are not automatically retried. Only an explicit reviewer `changes_requested` result enters the bounded repair path. `blocked`, malformed output and null child results stop new admission; in-flight work is collected.
- The existing DSH tool requires the full compiled script in each call; it has no script-file/template-name parameter. This is a compiler/runner adapter, not a newly registered tool that accepts only a flow name and options. The caller must transmit the compiled payload unchanged; the host does not enforce this skill's template registry. This adds prompt/transmission overhead even though flow execution is code-owned.
- Only the DSH executable adapter is supplied. Other harnesses may use the skill's selection and formulation guidance, but do not treat this JavaScript tool input as a pi-workflows or Claude Code API.

## Sources

The separation of model choice from explicit transitions follows [pi-workflows](https://github.com/osolmaz/pi-workflows) and its [branch example](https://github.com/osolmaz/pi-workflows/blob/main/examples/workflows/branch.workflow.ts). Its APIs are not imported or assumed compatible. Role patterns also draw on [Rahul's post](https://x.com/sairahul1/status/2099101032529957226) and [Mathias's proposal](https://x.com/pegastud/status/2099354226635796585); those posts provide no validated cost/quality guarantee.
