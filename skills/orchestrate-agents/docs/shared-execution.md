# Shared execution rules

Read the relevant section before configuring model roles, delegating work, submitting a compiled flow, or accepting its result. This page holds shared rules, not another execution stage; direct work with no delegation need not load runner details. Return to [the entry](../SKILL.md) when choosing a flow.

## Scope of this skill

`issue-driven-development` owns issue intake, acceptance, delivery and feedback. Whenever the work is part of that process, follow it first; this skill owns only execution structure and delegation. If it is deployed separately, use the project's documented equivalent rather than assume the sibling skill is installed.

## Authority and opt-in

- System/developer instructions, user scope, host approval boundaries and project rules take precedence over this skill.
- Loading this skill authorizes nothing by itself: not recursive delegation, extra data sharing, higher spend, destructive actions, software installation, publication, or starting a server.
- Native `workflow` requires an explicit workflow or large-orchestration request. `ralph` separately requires an explicit Ralph/fresh-agent request. Goal tools follow their own rules. Ordinary direct work needs neither.

## Harness adapters

- **DSH, ordinary work:** use native `subagent` for self-contained assignments, or `subagent_fork` when sharing the conversation is appropriate. Start independent work in the background and continue useful parent work; use completion notifications and `send_message` for related continuations. One writer per shared file/worktree; the parent owns integration and acceptance. Independent tool calls need no additional agent.
- **DSH, requested workflows:** read [compile and run](../references/run-dsh.md), compile the request with a separately maintained deployment policy, and submit the exact `meta`, `script`, `args` and `resultKeys` to native `workflow`. If the live tool lacks `resultKeys`, report the required Host update instead of dropping it. Do not rewrite the runner in chat or substitute model-authored JavaScript.
- **pi:** use registered `pi-subagents` and its instructions. If pi-workflows is installed, use its documented adapter/API; these DSH payloads are not pi-workflows definitions. Do not install it or invoke Herdr implicitly.
- **Claude Code and others:** use documented native delegation tools, session controls and project rules. Without an executable adapter, report manual/native execution honestly, not that the deterministic DSH runner was used.

## Session topology

- Ordinary delegation may use native `subagent` (self-contained) or `subagent_fork` (when the conversation must be shared), reuse worker sessions for related repairs, and use separate review contexts for independence.
- The compiled flows are fixed: every runtime-owned worker is flat under the calling agent, workers launch no children, and each workflow call gets fresh child contexts. Persistent advisor/worker sessions from the original proposal are not implemented.
- Owner continuity guidance never overrides a compiled flow's declared fresh-session topology, including a "continue in the same owner" preference. Do not edit a template to imitate session reuse.

## Model routes

- Discover supported routes in the active harness first (`list_subagent_models` in DSH); never guess identifiers.
- Bind roles by task fit, report volume and total input/output cost. No route or model family is designated cheap by name, and example routes are not benchmark claims. A current agent does not become cheaper by renaming itself coordinator: bind the existing lead or coordinator integration role to a lower-cost discovered route when that helps, and reserve expensive judgment for specific unresolved questions.
- Do not add a mandatory synthesizer or have the parent reread all reports after delegation; follow [evidence-aware synthesis](../references/synthesis.md).
- Never silently substitute another model. A missing route, an unavailable allowlisted designer or an unconfigured role is a blocker, not permission to invent a route or launch another application.
- The DSH workflow hook accepts provider/model only; no effort or `reasoning_effort` option is supported. Do not insert unsupported options. Its phases describe progress, while the role bindings in actual `agent` calls determine requested routes. The returned route list records requests, not the backend's effective weights.

## Runner behavior shared by flows

These rules describe the ordinary graph runner. The [comparison wrapper](comparison.md) instead records an arm's ordinary failure and continues the other arms; its final status is `awaiting-evaluation`.

- Every agent returns exactly `{status, summary, evidence}` with nonempty `summary` and an array of unique nonempty evidence strings (the array may be empty; this does not prove acceptance). Map workers must return `done`. A reviewer may return `changes_requested`; a coordinator or the initial executor in `executor-advisor` may return `needs_advice`. These statuses advance only their explicit repair or advice branches.
- Admission uses fixed ordered waves inside the call queue: at most the selected concurrency of runner-owned calls start at once, the next wave starts only after the previous wave settles, and completion order does not change which calls are admitted. Independent ready graph nodes are dispatched together and awaited before the next graph wave, so the concurrency option bounds call admission, not node-level dispatch; the call budget still bounds the total.
- A null, malformed or `blocked` result stops new admission; in-flight calls settle first. Host exceptions and cancellation propagate and are never converted into model-requested repair.
- Nodes whose conditions do not match become `skipped`, not successful empty outputs. Unordered writers with overlapping scopes are rejected at validation.
- The record retains the resolved request, frozen graph, requested routes, call count and ordered results; the compact projection is not the full result.

## Acceptance

- `completed` means the declared acceptance node reported `done` with no blocked node. It is not proof that the human objective is correct.
- A model's `done` is a claim. Inspect artifacts and raw observations, record each criterion with [acceptance evidence](../references/acceptance-evidence.md), and treat a criterion without evidence as uncovered. The convention adds no schema; a brief phrase of prose is sufficient for a small task.
- A routing packet alone does not complete an execution request. Continue through the authorized implementation and verification, but do not execute examples when only a design or prompts were requested.
- Report completed/partial/blocked work, the checks actually run, requested routes and any independently observed runtime identity. Keep those three kinds of statement separate.
- Collect relevant managed jobs and stop irrelevant ones before finishing; do not add a supervisor merely to poll jobs. Deliver requested files through the host mechanism (`present` in DSH).

## Retention and replay

- Keep compiled inputs, their fingerprints, run references and acceptance receipts until acceptance is decided. Preserve accepted artifacts; never delete the evidence a claim depends on.
- Do not replay uncertain side effects automatically. Inspect existing artifacts and current state before a new run.
- Cancellation is host-owned and is not permission to restart.
