---
name: implement-task
description: "Implement a feature or task end-to-end with a frontier-model planner and reviewer (superpowers-style flow: scope → clarify → plan → gate → implement → verify → review → iterate). Use when the user asks to implement something non-trivial, wants a plan before code, or mentions planning/review with a frontier model (kimi, cursor, claude, glm). Do not use for trivial one-liner edits or pure reads — do those directly."
whenToUse: Use when the user asks to implement a feature/task, wants a plan first, or invokes the superpowers-style flow. Don't use for a one-off trivial edit, a single obvious change, or pure research.
metadata:
  frontierProvider: kimi-coding
  frontierModel: kimi-k3
  frontierFallback: cursor/grok-4.6
  workerProvider: ollama-cloud
  workerModel: deepseek-v4-flash:0731
  workerFallback: cursor/composer-2.5
  verifyProvider: ollama-cloud
  verifyModel: deepseek-v4-flash:0731
---

# implement-task — superpowers-style implementation flow

Orchestrate ONE implementation task end-to-end. Roles (like `pi`):

| Role | Tool | Model route | Does |
|---|---|---|---|
| **USER** (human) | — | — | The client person. Hands the task to the coordinator, owns the gate decision (approve / adjust / pre-approve), receives the final report. |
| **COORDINATOR** (YOU) | — | session default (`deepseek-v4-flash` or user pick) | Manager / top gate of this flow, and the USER's single interface into the subagents. Orchestrate only — scope, delegate, land, report. Never implement or verify yourself. |
| **FRONTIER** | `subagent_frontier` | `kimi-coding`/`kimi-k3` → `cursor`/`grok-4.6` → plain `subagent` | Planner + oracle reviewer ONLY. Judgment roles — never a lone implementer. The planner may use ITS OWN subagents for repository research, but must produce the plan itself. |
| **WORKER** | `subagent_worker` | `ollama-cloud`/`deepseek-v4-flash:0731` → `cursor`/`composer-2.5` | Implementation and fix iterations. Self-contained flattened prompts. **Do not use plain `subagent` here** — it inherits the session default route with no fallback chain. Repeat-call loops are broken by the built-in `repeat-tool-reminder` nudge (thresholds 3/5/8); transport errors fall back to composer-2.5. |
| **VERIFY** | `subagent_verify` | `ollama-cloud`/`deepseek-v4-flash:0731` | Run the plan's deterministic checks (tests, `bash -n`, `git diff --check`, grep evidence) and report actual command output. No model opinion — that is what REVIEW is for. Flash is fine here; the task is command-running, not multi-step coding. |

Two actors sit at the top of this flow: the **USER** (human, client person —
owns the task, the gate decision, and receives the report) and the
**COORDINATOR** (manager — runs the flow, delegates to subagents, never does
the work itself). The coordinator is the USER's only interface into the
subagent pool; the USER never talks to FRONTIER / WORKER / VERIFY directly.

Routes come from home `cordis.patch.yml` rows on `subagent-fallback`
(`subagent_frontier`, `subagent_worker`, `subagent_verify`). Effective after
the next dsh restart.

## The flow

1. **SCOPE** — Read the task (from the USER) and the code it touches; trace
   the real flow. State the completion condition.
2. **CLARIFY** — Check the scoped task for vagueness along the pi-clarify
   dimensions — ambiguous referents, unclear outcomes, undefined scope,
   missing constraints, or any material ambiguity inspection cannot answer.
   If vague, ask the USER one concise round of clarifying questions via
   `ask_user_question`; the answers feed PLAN. If the task is already clear,
   ask nothing and proceed.
3. **PLAN** — Call the FRONTIER planner (see "Calling the frontier model"
   below) with `references/planner-prompt.md` + the task + repo facts.
   It returns a validated plan: goal, file-level steps with acceptance
   criteria, verification list, risks.
4. **GATE** — Present the plan (condensed) to the USER and ask them to
   approve or adjust (`ask_user_question`, options: Approve / Adjust). The
   USER owns this decision; the coordinator only presents. If the USER
   already said "go ahead", skip the gate and proceed.
5. **IMPLEMENT** — Track with `todo_write`. Delegate implementation to
   **`subagent_worker`** with self-contained prompts (no conversation access,
   so include every fact and file path). Do not implement yourself: the
   coordinator delegates, tracks, and lands. Keep design/naming decisions
   and the land decision yourself.
6. **VERIFY** — Delegate verification to **`subagent_verify`**: it runs the
   plan's verification list + deterministic checks (tests, `bash -n`,
   `git diff --check`, grep evidence) and reports actual command output,
   failures included, never embellished. No model opinion here — that is
   what REVIEW is for.
7. **REVIEW** — Call the FRONTIER oracle (same mechanism) with
   `references/reviewer-prompt.md` + the diff + verification results.
   It returns a verdict (PASS/FAIL) with severity-graded findings.
   No implementation requests in this step.
8. **ITERATE** — Send findings back to **`subagent_worker`**, fix,
   re-verify with **`subagent_verify`**, re-review. Cap at 3 fix rounds; after
   that report remaining findings as open items.
9. **REPORT** — Final summary delivered to the USER: what changed (files),
   evidence (commands + outputs), review verdict, open items.

## Formal model (Quint)

The flow above is formalized as an executable Quint state machine in
[`spec/implementTask.qnt`](spec/implementTask.qnt): the 9 steps as phases,
the rules as guarded transitions and invariants (review only after verify,
no implementation before approval, 3-round fix cap, honest fallback
reporting), and each documented path as a reachability witness. IMPLEMENT
and VERIFY are delegated to worker subagents: the coordinator only
delegates tasks and consumes worker reports (`delegate` / `workerDone`),
and the invariant `workHappensInWorkers` makes the role separation
checkable — the coordinator never does the work itself. Scenario tests
live in [`spec/implementTask_test.qnt`](spec/implementTask_test.qnt);
[`spec/README.md`](spec/README.md) is the coverage map (requirement → model)
and runbook.

```sh
quint typecheck spec/implementTask.qnt spec/implementTask_test.qnt
quint run spec/implementTask.qnt --main=implTaskGate \
  --invariants fixRoundCap planRequiresClarify reviewOnlyAfterVerify \
    reportRequiresReview noImplementBeforeApproval approveRequiresPlan \
    reportHonesty workHappensInWorkers \
  --witnesses reachedClarify clarifyUsed reachedImplement reachedVerify \
    reachedReview reachedReport fixLoopUsed capReachedOpenItems \
    fallbackOccurred delegationUsed parallelChunks --max-steps=40 \
    --max-samples=1000
quint test spec/implementTask_test.qnt --main=implTaskGateTest
```

Keep the model in sync with this skill: if the flow, rules, or prompts
change, update the spec (and its invariants/tests) in the same change.

## Trace replay gate (deterministic, mizchi-style)

**What is enforced vs self-reported** (do not collapse these):

| Layer | Strength |
|---|---|
| Quint model + scenario tests + proto-1 counterexample lock | Specification / deterministic tests on the **model** |
| Proto-2 `trace.jsonl` written by the coordinator | **Self-reported / experimental.** A omitted line is invisible. Does **not** enforce honesty, internal reasoning, or unobservable phases. |
| Proto-3 `observed-trace-emitter` on host `tools/result` | **Experimental telemetry — NOT a gate.** Tool-call observation only (gate question shape, worker/verify/frontier reports). Cannot see SCOPE/CLARIFY/PLAN or `reportHonesty`; its mapper omits actions it lacks evidence for and never invents success or a verdict. Per-session logs (`trace.observed.<sid>.jsonl`), append-only writes. Needs the home-patch row and a **dsh restart**; live emit is unverified until then. |

After each step in "The flow" fires, append one line to `spec/replay/trace.jsonl`
in the canonical step format (documented in
[`spec/replay/replay.mjs`](spec/replay/replay.mjs)): one JSON object per model
action — `{"a":"scopeDone"}`, `{"a":"clarify","clear":true}`,
`{"a":"approve"}` or `{"a":"skipGate"}`,
`{"a":"delegate","w":1,"task":"ImplementTask"}`,
`{"a":"workerDone","w":1,"task":"ImplementTask","ok":true}`,
`{"a":"review","v":"Pass"}`, `{"a":"report"}`, etc. Use the exact action names
and parameters of `spec/implementTask.qnt`. `replay.mjs` accepts a JSON array
or JSONL.

At REPORT (or on early exit), replay the self-reported trace through the model:

```sh
node spec/replay/replay.mjs spec/replay/trace.jsonl > spec/replay/replayTrace.qnt
quint test spec/replay/replayTrace.qnt --main=replayTrace
```

A `.then(step)` failure means the model's guard blocked a transition the agent
claimed; an `.expect` failure means an invariant broke. Either is proto-2 RED
for that **self-reported** trace — not proof the live session was honest.
See [`spec/replay/README.md`](spec/replay/README.md).

## Calling the frontier model

Preferred: the **`subagent_frontier`** tool (provider `kimi-coding`, model
`kimi-k3`, configured by the home `cordis.patch.yml` row
`subagent-fallback`) when it is present in this session.

Otherwise use the **`workflow`** tool with a ONE-agent script that pins the
frontier route (this works in any session):

```js
// meta: { name: 'frontier-call', description: 'One frontier agent for implement-task' }
return await agent(prompt, {
  provider: 'kimi-coding',
  model: 'kimi-k3',
  schema: <schema>,   // inline the schema from the reference file
  label: '<planner|reviewer>',
});
```

- `prompt` = the reference prompt (planner/reviewer) with the task, repo
  facts, and diff inlined.
- `<schema>` = read and inline `references/planner-schema.json` for PLAN,
  `references/reviewer-schema.json` for REVIEW.
- **Fallback order**: `kimi-coding`/`kimi-k3` → `cursor`/`grok-4.6` → plain
  `subagent` (deepseek) with the same prompt. If the frontier route fails,
  proceed with deepseek in the judgment role and REPORT the limitation;
  never silently substitute a weaker model in the judgment roles.
- `run_in_background: false` — the gate/review decision depends on the result.

## Calling worker subagents

Preferred: **`subagent_worker`** (IMPLEMENT / fix iterations) and
**`subagent_verify`** (VERIFY) when present in this session (home
`cordis.patch.yml` rows `subagent-fallback-worker` /
`subagent-fallback-verify`).

Otherwise pin the route with the **`workflow`** tool (same pattern as
frontier):

```js
// meta: { name: 'worker-call', description: 'One worker agent for implement-task' }
return await agent(prompt, {
  provider: 'ollama-cloud',
  model: 'deepseek-v4-flash:0731',
  label: '<implement|verify>',
});
```

- IMPLEMENT / fix prompts: full plan step, file paths, acceptance criteria,
  patterns to follow.
- VERIFY prompts: the plan's verification list only; require raw command output.
- **Fallback order (worker)**: `ollama-cloud`/`deepseek-v4-flash:0731` →
  `cursor`/`composer-2.5`. If both fail, REPORT the limitation; do not silently
  fall back to plain `subagent` for implementation.
- VERIFY may fall back to plain `subagent` (flash inherits) when
  `subagent_verify` is unavailable — command-running tolerates flash.
- Parallel implement chunks: multiple **`subagent_worker`** calls in one
  message; `run_in_background: true` by default unless your next step depends
  on the result.

## Rules

- Fix the completion condition first: "can completion still be proven if this
  is omitted?" If yes, omit it.
- No unrelated refactors, drive-by formatting, or scope creep.
- Stop and ask when correctness cannot be derived from code/spec/task — never
  guess on public APIs, schemas, auth, or data.
- Prefer existing patterns and the standard library; shortest working diff.
- Non-trivial logic leaves ONE runnable check behind.
