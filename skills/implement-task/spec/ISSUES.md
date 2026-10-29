# Known issues — Quint toolchain quirks hit while building this model

This file documents, one section per issue, the toolchain quirks encountered
while building and validating `implementTask.qnt` with Quint 0.32.0. Each
entry records the symptom, the cause, the workaround used in this spec, and
where it applies. The general documentation (coverage map, invariants,
witnesses, runbook) lives in [`README.md`](README.md); this file is only for
issues.

## Issue 1 — Rust backend mis-evaluates `false or X` as `false`

- **Symptom**: a guard or expression containing `or` with a possibly-false
  left operand evaluates to `false` even when the right operand is `true`,
  so the action never fires or the invariant is wrongly violated.
- **Cause**: a simulation bug in the Quint 0.32 Rust backend (verified
  empirically; `and` / `implies` / `not` are correct).
- **Workaround**: avoid `or` with a possibly-false left operand. Rewrite
  `A or B` as `if (A) true else B` (guards) or as nested `if`s (value
  computation). Alternatively run with `--backend=typescript`, which
  evaluates `or` correctly.
- **Where**: `plan()` and `workerDone()` use nested `if`s for their
  `phase'` computation; `delegate()` and the `workHappensInWorkers`
  invariant use `if/else` instead of `or`. Keep this in mind when editing.

## Issue 2 — `quint test` `.fail()` does not thread state to the next step

- **Symptom**: after a `.then(act.fail())` step, the next step fails with
  `QNT502: Variable <name> not set` — the state after a blocked action is
  unset, not the pre-action state.
- **Cause**: a state-threading quirk of `.fail()` in the Quint 0.32 test
  runner (a blocked action should leave the state unchanged, but the runner
  does not carry it forward).
- **Workaround**: keep `.fail()` as the **last** step of a test. To assert
  that several actions are blocked, split the scenario into one test per
  blocked action.
- **Where**: `implementTask_test.qnt` — `noImplementBeforeApprovalTest` and
  `noTaskOutsideWorkPhasesTest` are split for this reason; every other
  `.fail()` is the final step of its test.

## Issue 3 — `Option` / `Some` / `None` / `Map.values()` are not in Quint core

- **Symptom**: `QNT404: Type alias 'Option' not found` (and the same for
  `Some`, `None`, `values`) at typecheck.
- **Cause**: these operators live in `basicSpells.qnt`, a standard-library
  file bundled with Quint projects (e.g. the tendermint example ships it at
  `./spells/basicSpells.qnt`), not in the Quint core language.
- **Workaround**: stay dependency-free — use a domain sum type instead of
  `Option` (`Idle | Working({ task })` for the worker state) and iterate
  `Map.keys()` instead of `Map.values()`.
- **Where**: `implementTask.qnt` — the `WorkerState` type and every
  `workers`-map expression.
