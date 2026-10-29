# implement-task workflow — Quint formal model

This directory holds an executable [Quint](https://quint-lang.org/) model of the
`implement-task` skill (`../SKILL.md`): its 9-step flow as a phase state
machine, its rules as guarded transitions and invariants, and its documented
paths as reachability witnesses. The point is clarification — the model makes
the skill's semantics precise, checkable, and reproducible.
A visual map of the same flow lives in
[`flow.html`](flow.html) (Mermaid flowchart + spec mapping table) — update it
in the same change as the model and the skill.

## What it covers

The coordinator's workflow as a state machine with **worker subagents**
(`implementTask.qnt`, module `implementTask`): the coordinator runs the phase
machine; IMPLEMENT and VERIFY are **delegated to workers** — the coordinator
never does the work itself. Two actors sit at the top of the flow: the
**USER** (human client — task in, gate decision, report out) and the
**COORDINATOR** (manager / top gate — runs the phase machine; the USER's only
interface into the workers). The USER is external to the state machine: its
choices are the gate actions. The `workers` map (`WorkerId -> Idle | Working({ task })`)
is the shared coordination state: a worker holds a task iff the coordinator
delegated it, and the phase advances / `verified` is set only through a
worker's report (`workerDone`).

| SKILL.md | Model |
|---|---|
| Step 1 SCOPE | action `scopeDone` (Scope → Clarify) |
| Step 2 CLARIFY (coordinator; pi-clarify vagueness check, one ask_user_question round) | actions `clarify(clear)` (clear → Plan; vague → stay, `asked = true`) + `clarifyAnswered` (Clarify+asked → Plan, `clarified = true`) |
| Step 3 PLAN (frontier planner, judgment role) | action `plan(frontierOk)` (Plan → Gate); `frontierOk = false` models the documented fallback route |
| Step 4 GATE (approve / adjust; skip if pre-approved) | USER-owned gate decisions: actions `approve`, `adjust`, `skipGate` (const `PRE_APPROVED`) |
| Step 5 IMPLEMENT (delegated to `subagent_worker`, only after approval) | actions `delegate(w, ImplementTask)` + `workerDone(w, ImplementTask, _)`; implement chunks may run in parallel (const `WORKERS`) |
| Step 6 VERIFY (delegated to `subagent_verify`; deterministic checks only) | actions `delegate(w, VerifyTask)` + `workerDone(w, VerifyTask, ok)`; at most one VerifyTask outstanding; `ok = false` loops back to IMPLEMENT |
| Steps 7–8 REVIEW / ITERATE (oracle verdict, 3-round cap) | action `review(v)`; FAIL → IMPLEMENT while `fixRounds < 3`, else REPORT with open items |
| Step 9 REPORT (final summary; honest about fallback) | action `report` (fires once, sets `reportedFallback = fallbackUsed`); delivered to the USER |

Invariants (each is a rule quoted from SKILL.md, made checkable):

- `fixRoundCap` — at most 3 fix rounds ("Cap at 3 fix rounds").
- `planRequiresClarify` — PLAN only after the clarify step resolved (steps 2 → 3).
- `reviewOnlyAfterVerify` — in the REVIEW phase, verification evidence exists
  ("VERIFY … No model opinion here"; the reviewer prompt: missing evidence = FAIL).
- `reportRequiresReview` — REPORT only after an oracle verdict (steps 7 → 9).
- `noImplementBeforeApproval` — no worker receives an implementation task
  before the gate (or skip) approved the plan (steps 4 → 5).
- `approveRequiresPlan` — the gate presents a validated plan.
- `reportHonesty` — a completed report states the fallback limitation iff one
  was used ("never silently substitute a weaker model in the judgment roles").
- `workHappensInWorkers` — a worker is busy only during the work phases
  (IMPLEMENT / VERIFY). Combined with the structure — `delegate` and
  `workerDone` are the only actions that touch `workers`, and the phase
  leaves IMPLEMENT/VERIFY and `verified` is set only through a worker's
  report — this is the role separation the flow change introduced: the
  coordinator never implements or verifies itself.

Witnesses (documented paths are reachable, not just written): each phase is
reached (`reachedClarify`, `reachedImplement`, `reachedVerify`,
`reachedReview`, `reachedReport`), the vague path where questions were
actually asked (`clarifyUsed`), the fix loop bites (`fixLoopUsed`), the cap
ends in REPORT with open items (`capReachedOpenItems`), the fallback route
exists (`fallbackOccurred`), a task is actually delegated (`delegationUsed`),
and two implement chunks run in parallel (`parallelChunks`).

## What it does NOT cover

- The internal content of artifacts (plan steps/risks, findings, evidence
  text) — modeled only as existence flags.
- Worker internals: how a worker implements or verifies, its tool calls, its
  own sub-delegation. A worker's work+report is fused with the coordinator's
  consumption into one atomic `workerDone` action — the intermediate states
  (worker working, report in flight) are not observable to any invariant here.
- Worker failure / re-delegation: workers always complete their assigned
  task. If the real flow gains a retry-on-worker-failure rule, model it as a
  guarded re-delegate action and add an invariant.
- Implementation internals: todo tracking, revertable steps.
- The SKILL.md "stop and ask" clarification path is no longer uncovered — it IS the CLARIFY phase (actions `clarify` / `clarifyAnswered`); only the ask-round content (question text, user answers) stays unmodeled (existence flags only).
- The frontier model's judgment quality; verdicts are nondeterministic inputs.
- "VERIFY is deterministic" as a property — it is a constraint on the human
  process, not on the state machine.
- Verification-failure loops consume no fix-round (assumption: the 3-round cap
  counts review findings, per step 7).

## How to run

Requires the `quint` CLI (0.32.x used here).

```sh
cd spec

# 1. Types
quint typecheck implementTask.qnt
quint typecheck implementTask_test.qnt

# 2. Simulate: invariants + witnesses, both const instances
#    (--max-steps=40: the delegation steps lengthen traces — the fix-loop
#    cap path needs ~29 steps to reach REPORT with fixRounds == 3)
quint run implementTask.qnt --main=implTaskGate \
  --invariants fixRoundCap planRequiresClarify reviewOnlyAfterVerify \
    reportRequiresReview noImplementBeforeApproval approveRequiresPlan \
    reportHonesty workHappensInWorkers \
  --witnesses reachedClarify clarifyUsed reachedImplement reachedVerify \
    reachedReview reachedReport fixLoopUsed capReachedOpenItems \
    fallbackOccurred delegationUsed parallelChunks --max-steps=40 \
    --max-samples=1000
quint run implementTask.qnt --main=implTaskPreApproved \
  --invariants fixRoundCap planRequiresClarify reviewOnlyAfterVerify \
    reportRequiresReview noImplementBeforeApproval approveRequiresPlan \
    reportHonesty workHappensInWorkers \
  --witnesses reachedClarify clarifyUsed reachedImplement reachedVerify \
    reachedReview reachedReport fixLoopUsed capReachedOpenItems \
    fallbackOccurred delegationUsed parallelChunks --max-steps=40 \
    --max-samples=1000

# 3. Scenario tests (names ending in `Test`; run all three modules)
quint test implementTask_test.qnt --main=implTaskGateTest
quint test implementTask_test.qnt --main=implTaskPreApprovedTest
quint test implementTask_test.qnt --main=implTaskVulnerableTest

# 4. Mizchi-style gate: the deterministic counterexample test reproduces the
#    fixRoundCap violation on the vulnerable variant (BUGGY_FIX_CAP = true),
#    while random simulation on the same variant can miss it.
quint run implementTask.qnt --main=implTaskVulnerable \
  --invariants fixRoundCap --max-steps=30 --max-samples=300
```

Expected: `[ok] No violation found` on both fixed runs (all eleven witnesses
reported > 0 traces), and 14 + 1 + 1 passing tests. The vulnerable
`quint run` (step 4) is the demonstration that random sampling can report "No
violation found" on a model that the deterministic counterexample test
(`fixRoundOverflowCounterexampleTest`) still catches — see the section below.

## Mizchi-style deterministic gate (counterexample → regression test)

This spec doubles as a prototype of the loop mizchi describes in
"[Quintでcelldの二重writerバグを見つけた](https://zenn.dev/mizchi/articles/quint-application-modeling)":
do not trust "the model checker said correct" — take the counterexample it
produces, lock it as a deterministic test, and make *that* the gate.

The loop, applied to the `fixRoundCap` invariant (`fixRounds <= 3`):

1. **Invariant** — `fixRoundCap`: a review FAIL may increment `fixRounds` only
   while `fixRounds < 3`; at the cap a FAIL goes to REPORT without incrementing.
2. **Vulnerable variant** — `implTaskVulnerable` instantiates
   `BUGGY_FIX_CAP = true`, which removes the `< 3` guard from `review`: a FAIL
   always increments `fixRounds`, so a fourth FAIL reaches `fixRounds == 4`.
3. **Counterexample → deterministic test** — `fixRoundOverflowCounterexampleTest`
   (in `implTaskVulnerableTest`) drives the exact four-FAIL trace and asserts
   `.expect(not(fixRoundCap))`. It **passes** on the vulnerable variant: the
   violation is reproduced deterministically, not by chance sampling.
4. **The gate** — `fixRoundCapSentinelTest` (in `implTaskGateTest`) runs the same
   trace on the **fixed** model and asserts `.expect(fixRoundCap)`. It **passes**
   (`fixRounds` held at 3). Run the same trace on the vulnerable variant and the
   `.expect(fixRoundCap)` fails — the gate catches the regression.

The decisive observation (step 4 of the run commands above): `quint run
--main=implTaskVulnerable --invariants=fixRoundCap` reports `[ok] No violation
found` on the vulnerable model at `--max-samples=300`. Random simulation missed
the bug; the deterministic counterexample test did not. That is the whole
argument for changing the gate verdict from "the sampler found nothing"
(probabilistic, can false-negative) to "the locked counterexample trace does not
violate" (deterministic, reproducible).

`BUGGY_FIX_CAP` is an experiment toggle kept only to make the loop runnable end
to end. The two production instances (`implTaskGate`, `implTaskPreApproved`)
pass `BUGGY_FIX_CAP = false` and are unaffected; remove the const and the
`implTaskVulnerable` instance once the pattern is established elsewhere.

> Enforcement layers (do not collapse): proto-1 is a deterministic lock on the
> **model**. Proto-2 (`replay/trace.jsonl`) is **self-reported / experimental**
> — the coordinator appends its own transitions; omitting a line defeats the
> check. Proto-3 (`observed-trace-emitter`) records harness `tools/result`
> events into per-session logs — **experimental telemetry, not a gate**: it
> does not observe internal phases (SCOPE / CLARIFY / PLAN), the REPORT
> action, or `reportHonesty`, and its mapper omits actions it lacks recorded
> evidence for. Live emit requires the home-patch row and a dsh restart.
> See [`replay/README.md`](replay/README.md).

## Baseline CI

The spec's baseline gate is [`verify-baseline.sh`](verify-baseline.sh): it runs
`quint-verify` (every invariant SATISFIED + every witness REACHED, with a
structured report), the scenario tests (`quint test` on all three test
modules, including the proto-1 sentinel and counterexample lock), and the
replay-gate self-tests (regenerate `replayTrace.{good,bad}.qnt` from
`trace.{good,bad}.json` via `replay.mjs`, then assert the good trace passes and
the bad trace fails). It uses `quint` and `node` from PATH.

- **CI**: [`.github/workflows/quint-spec-baseline.yml`](../../../.github/workflows/quint-spec-baseline.yml)
  runs the wrapper (and the `verify-completion-gate` wrapper) on push/PR
  touching either spec or the `quint-verify` skill — installs quint via npm,
  caches the Rust evaluator in `~/.quint`, uploads the reports as artifacts. A
  non-zero exit fails the job.
- **Locally (DSH sandbox)**: run the wrapper inside the quint container, which
  has `quint` + `node` on PATH (a faithful CI simulation):
  ```
  container_exec (podman, localhost/claudecode:latest, entrypoint /bin/sh -c):
    bash /work/skills/implement-task/spec/verify-baseline.sh
  ```
- **Locally (host with quint installed)**: `bash skills/implement-task/spec/verify-baseline.sh`.

Baseline = `quint-verify` verdict pass (8/8 invariants satisfied, 11/11
witnesses reached) + 14 + 1 + 1 scenario tests passing + replay-gate self-tests
(good trace GREEN, bad trace RED).

## Notes

- `PRE_APPROVED` and `WORKERS` are module parameters (consts) — they must be
  instantiated, which is why the two runnable entry modules `implTaskGate` /
  `implTaskPreApproved` exist in `implementTask.qnt` (both use `WORKERS = Set(1, 2)`).
- Toolchain quirks encountered while building this model (the Quint 0.32
  `or` bug, `.fail()` state threading, `basicSpells`-only operators) are
  documented separately in [`ISSUES.md`](ISSUES.md), one section per issue.

## When to update

This model documents `../SKILL.md`. If the skill's flow, rules, or prompts
change, update the model (and its invariants/tests) in the same change — the
spec is the executable statement of what the skill guarantees.
