# verification-before-completion — Quint formal model

This directory holds an executable [Quint](https://quint-lang.org/) model of the
`verification-before-completion` skill (`~/.dsh/.../aegis/skills/verification-before-completion/SKILL.md`):
its closeout flow as a phase state machine, its rules as guarded transitions
and invariants, and its documented paths as reachability witnesses. The point
is clarification — the model makes the skill's semantics precise, checkable,
and reproducible.

## What it covers

The skill's closeout flow as a state machine
(`verifyCompletion.qnt`, module `verifyCompletion`): before any success claim,
the agent runs a **fresh falsifying check**, reads its complete result/scope,
**grades confidence** (A | B | C), **chooses a receipt level** (L0 | L1 | L2),
then selects a **stop state** (done | blocked | needs-verification |
scope-exceeded). The skill's rules constrain which stop state is reachable
given the evidence — the `claim` action's guards encode those rules, and the
invariants check them.

| SKILL.md | Model |
|---|---|
| "Before any success claim, ... run a fresh falsifying check" | action `runCheck(ok, narrow)` (Working → Check); sets `checkRan`, records `scope`; `ok=false` sets the downgrade flag |
| "grade confidence: A \| B \| C" | action `grade(conf, rcp)` (Check → Graded); `A`/`B`/`C` are the `Confidence` enum; receipt L0/L1/L2 chosen here |
| "never claim complete first and verify later" | invariant `checkBeforeComplete` (done ⇒ checkRan); also structural — `claim` is only enabled in Graded, which only follows Check |
| "confidence C (partial evidence only) ⇒ do not claim full completion" | invariant `confidenceCNotDone`; `claim` guard routes a confidence-C done to `NeedsVerification` |
| "Claim only what fresh evidence covers; slice evidence cannot close the whole task" | invariant `claimWithinCoverage`; `claim` guard routes a narrower-scope done to `ScopeExceeded` |
| "Complexity Closure: exceeded-unresolved blocks completion" | invariant `complexityBlocksDone`; `claim` guard routes a complexity-exceeded done to `Blocked` |
| "Destructive or irreversible work needs scoped permission; warnings or broad assent do not grant it" | invariant `destructiveNeedsScopedPermission`; `claim` guard routes a destructive-without-permission done to `Blocked`; `grantScopedPermission` unblocks |
| Stop Signals: "evidence is uncertain, stale, agent-only, or narrower than the claim" | `downgraded` flag; `runCheck(ok=false)` and the `claim` guards set it |
| Goal Closure stop states: `done \| blocked \| needs-verification \| scope-exceeded` | `Stop` enum; each has a reachability witness |
| Receipt levels L0/L1/L2 | `Receipt` enum; each has a reachability witness at the Graded phase |
| Confidence grades A/B/C | `Confidence` enum; each has a reachability witness at the Graded phase |

Invariants (each is a rule quoted from SKILL.md, made checkable):

- `checkBeforeComplete` — a claimed done implies a fresh falsifying check ran
  ("never claim complete first and verify later").
- `confidenceCNotDone` — a claimed done implies confidence was A or B
  ("confidence C (partial evidence only) ⇒ do not claim full completion").
- `claimWithinCoverage` — a claimed done implies the evidence covered the whole
  claim ("claim only what fresh evidence covers; slice evidence cannot close
  the whole task").
- `complexityBlocksDone` — a claimed done implies complexity closure is NOT
  exceeded-unresolved ("Complexity Closure: exceeded-unresolved blocks
  completion").
- `destructiveNeedsScopedPermission` — a claimed done under destructive work
  implies scoped permission was granted ("destructive work needs scoped
  permission; warnings or broad assent do not grant it").
- `claimOnlyAfterGraded` — a claim implies the phase advanced to Stopped, i.e.
  the claim action fired only after the Check/Graded phases.

Witnesses (documented paths are reachable, not just written): each phase is
reached (`reachedCheck`, `reachedGraded`, `reachedStopped`), a check ran
(`checkRanWitness`), each confidence grade at the Graded phase
(`confidenceAReached`, `confidenceBReached`, `confidenceCReached`), each
receipt level at the Graded phase (`receiptL0Reached`, `receiptL1Reached`,
`receiptL2Reached`), each stop state reached (`stopDoneReached`,
`stopBlockedReached`, `stopNeedsVerificationReached`, `stopScopeExceededReached`),
a downgrade happened (`downgradeHappened`), and complexity-blocked happened
(`complexityBlockedHappened`).

## What it does NOT cover

- The internal content of evidence (check output text, receipt field labels,
  the L1 receipt's nine slots, output hygiene prose) — modeled only as
  existence flags and enums. The receipt level is an output shape, not
  completion authority ("Evidence is not completion authority").
- The L2 expanded triggers table (10 trigger → expanded-owner rows) —
  modeled only as the `L2` receipt enum being reachable; the routing to
  expanded-closeout.md is out of scope.
- Task Git Closeout (branch, commit SHA, hook failure, task-clean vs
  repo-clean) — a separate concern from the verification gate; the model
  captures only "destructive needs scoped permission" and "complexity blocks
  completion," not the git receipt mechanics.
- Aegis Visibility / Single Closeout (one completion surface, no parallel
  reports) — a process constraint, not a state-machine rule; not modeled.
- The Completion Boundary hierarchy (plan/spec → TaskIntentDraft → Slice Card
  → direct request) — modeled as a single `claim` action with a `chosen`
  parameter; the boundary hierarchy is out of scope.
- "Execution Readiness View is input, not verification evidence" — a
  documentation note, not a checkable state rule; not modeled.
- Stale/agent-only evidence as distinct downgrade signals — folded into the
  single `downgraded` flag (the skill treats them as one stop-signal class).
- The frontier model's judgment quality; the check result and confidence
  grade are nondeterministic inputs.
- The "fresh" qualifier on the check — modeled as `checkRan` (a check ran);
  "freshness" (not reusing stale evidence) is a human-process constraint, not
  a state-machine property. The model assumes the check recorded is the fresh
  one.

## How to run

Requires the `quint` CLI (0.32.x used here). In this harness, `quint` runs
inside the `localhost/claudecode:latest` container (Quint 0.32.0 at
`/usr/bin/quint`), not on the sandbox bash PATH. See the `quint-cli` skill for
the canonical `container_exec` invocation.

```sh
cd spec

# 1. Types
quint typecheck verifyCompletion.qnt
quint typecheck verifyCompletion_test.qnt

# 2. Simulate: invariants + witnesses, both fixed instances
quint run verifyCompletion.qnt --main=verifyCompletionGate \
  --invariants checkBeforeComplete confidenceCNotDone claimWithinCoverage \
    complexityBlocksDone destructiveNeedsScopedPermission claimOnlyAfterGraded \
  --witnesses reachedCheck reachedGraded reachedStopped checkRanWitness \
    confidenceAReached confidenceBReached confidenceCReached \
    receiptL0Reached receiptL1Reached receiptL2Reached \
    stopDoneReached stopBlockedReached stopNeedsVerificationReached \
    stopScopeExceededReached downgradeHappened complexityBlockedHappened \
  --max-steps=40 --max-samples=1000
quint run verifyCompletion.qnt --main=verifyCompletionDestructive \
  --invariants checkBeforeComplete confidenceCNotDone claimWithinCoverage \
    complexityBlocksDone destructiveNeedsScopedPermission claimOnlyAfterGraded \
  --witnesses reachedCheck reachedGraded reachedStopped checkRanWitness \
    confidenceAReached confidenceBReached confidenceCReached \
    receiptL0Reached receiptL1Reached receiptL2Reached \
    stopDoneReached stopBlockedReached stopNeedsVerificationReached \
    stopScopeExceededReached downgradeHappened complexityBlockedHappened \
  --max-steps=40 --max-samples=1000

# 3. Scenario tests (names ending in `Test`; run all three modules)
quint test verifyCompletion_test.qnt --main=verifyCompletionGateTest
quint test verifyCompletion_test.qnt --main=verifyCompletionDestructiveTest
quint test verifyCompletion_test.qnt --main=verifyCompletionVulnerableTest

# 4. quint-verify runner (structured report; runs inside the container with
#    node+quint on PATH):
node ../quint-verify/verify.mjs verifyCompletion.qnt verifyCompletionGate \
  --invariants checkBeforeComplete confidenceCNotDone claimWithinCoverage \
    complexityBlocksDone destructiveNeedsScopedPermission claimOnlyAfterGraded \
  --witnesses reachedCheck reachedGraded reachedStopped checkRanWitness \
    confidenceAReached confidenceBReached confidenceCReached \
    receiptL0Reached receiptL1Reached receiptL2Reached \
    stopDoneReached stopBlockedReached stopNeedsVerificationReached \
    stopScopeExceededReached downgradeHappened complexityBlockedHappened \
  --max-steps 40 --max-samples 1000
```

Expected: `[ok] No violation found` on both fixed runs (all sixteen witnesses
reported > 0 traces), and 18 + 2 + 1 passing tests. The `quint-verify` runner
verdict is `pass` (6/6 invariants satisfied, 16/16 witnesses reached).

## Mizchi-style deterministic gate (counterexample → regression test)

This spec doubles as a prototype of the loop mizchi describes in
"[Quintでcelldの二重writerバグを見つけた](https://zenn.dev/mizchi/articles/quint-application-modeling)":
do not trust "the model checker said correct" — take the counterexample it
produces, lock it as a deterministic test, and make *that* the gate.

The loop, applied to the `confidenceCNotDone` invariant
(`(stop == Done and claimed) implies confidence != C`):

1. **Invariant** — `confidenceCNotDone`: a claimed done requires confidence A
   or B; confidence C (partial evidence only) is routed to
   `NeedsVerification`, never `Done`.
2. **Vulnerable variant** — `verifyCompletionVulnerable` instantiates
   `BUGGY_CONF_C = true`, which removes the confidence-C guard from `claim`:
   a confidence-C `claim(Done)` honors `Done` instead of routing to
   `NeedsVerification`, so `stop == Done` at confidence C is reachable.
3. **Counterexample → deterministic test** — `confidenceCCounterexampleTest`
   (in `verifyCompletionVulnerableTest`) drives the exact trace (fresh covering
   check → grade C → claim done) and asserts `.expect(not(confidenceCNotDone))`.
   It **passes** on the vulnerable variant: the violation is reproduced
   deterministically, not by chance sampling.
4. **The gate** — `confidenceCSentinelTest` (in `verifyCompletionGateTest`)
   runs the same trace on the **fixed** model and asserts
   `.expect(confidenceCNotDone)`. It **passes** (the guard routed the
   confidence-C done to `NeedsVerification`). Run the same trace on the
   vulnerable variant and the `.expect(confidenceCNotDone)` fails — the gate
   catches the regression.

The decisive observation: random simulation on the vulnerable model *can*
report `[ok] No violation found` at modest sample counts (the confidence-C
done path requires a specific `chosen = Done` pick among four stops, the
narrower-scope guard must not fire, and complexity must not be marked — a
narrow slice of the state space). The deterministic counterexample test does
not rely on sampling: it drives the exact trace and reproduces the violation
every time. That is the whole argument for changing the gate verdict from
"the sampler found nothing" (probabilistic, can false-negative) to "the locked
counterexample trace does not violate" (deterministic, reproducible).

`BUGGY_CONF_C` is an experiment toggle kept only to make the loop runnable end
to end. The two production instances (`verifyCompletionGate`,
`verifyCompletionDestructive`) pass `BUGGY_CONF_C = false` and are unaffected;
remove the const and the `verifyCompletionVulnerable` instance once the pattern
is established elsewhere.

> What this proto does NOT cover (the gap to mizchi's full loop): mizchi's
> termination condition is "port the counterexample into a *real implementation*
> regression test that goes Red on the buggy code, Green after the fix." Here
> the "implementation" being gated is the model itself — there is no separate
> codebase whose behavior the model abstracts. The gap is closed for the
> `implement-task` workflow by the trace replay gate in
> `skills/implement-task/spec/replay/`; an analogous replay gate for this
> skill's closeout flow is a later prototype.

## Baseline CI

The spec's baseline gate is [`verify-baseline.sh`](verify-baseline.sh): it runs
`quint-verify` (every invariant SATISFIED + every witness REACHED, with a
structured report) and the scenario tests (`quint test` on all three test
modules, including the proto-1 sentinel and the counterexample lock on the
vulnerable variant). It uses `quint` and `node` from PATH.

- **CI**: [`.github/workflows/quint-spec-baseline.yml`](../../../.github/workflows/quint-spec-baseline.yml)
  runs this wrapper and the `implement-task` wrapper on push/PR touching either
  spec or the `quint-verify` skill — installs quint via npm, caches the Rust
  evaluator in `~/.quint`, uploads the reports as artifacts. A non-zero exit
  fails the job.
- **Locally (DSH sandbox)**: run the wrapper inside the quint container, which
  has `quint` + `node` on PATH (a faithful CI simulation):
  ```
  container_exec (podman, localhost/claudecode:latest, entrypoint /bin/sh -c):
    bash /work/skills/verify-completion-gate/spec/verify-baseline.sh
  ```
- **Locally (host with quint installed)**:
  `bash skills/verify-completion-gate/spec/verify-baseline.sh`.

Baseline = `quint-verify` verdict pass (6/6 invariants satisfied, 16/16 witnesses
reached) + 18 + 2 + 1 scenario tests passing.

## Notes

- `DESTRUCTIVE_NEEDED` and `BUGGY_CONF_C` are module parameters (consts) — they
  must be instantiated, which is why the three runnable entry modules
  `verifyCompletionGate` / `verifyCompletionDestructive` /
  `verifyCompletionVulnerable` exist in `verifyCompletion.qnt`.
- Toolchain quirks encountered while building this model (the Quint 0.32 `or`
  bug, `.fail()` state threading, `basicSpells`-only operators) are documented
  in `skills/implement-task/spec/ISSUES.md` — the same quirks apply; this spec
  follows the same workarounds (nested `if` instead of `or` with a
  possibly-false left operand; `.fail()` only as the last step of a test; no
  `Option`/`Some`/`None`, only sum types).

## When to update

This model documents the `verification-before-completion` skill. If the
skill's flow, rules, or stop signals change, update the model (and its
invariants/tests) in the same change — the spec is the executable statement of
what the skill guarantees.