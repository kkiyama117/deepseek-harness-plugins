---
name: quint-verify
description: >
  Verify a Quint spec end-to-end the disciplined way: typecheck, run every
  invariant (safety — expect SATISFIED) and every witness (liveness — expect
  REACHED in >0 traces), interpret results with the witness/invariant judgment
  convention, apply the progressive-increase protocol to 0-trace witnesses, and
  emit a structured verification report. This is quint-llm's /verify flow ported
  to the DSH lightweight-skill path: the runner (verify.mjs) executes inside the
  quint container (node + quint on PATH) via container_exec, one call. Use when
  you need to verify a .qnt spec — confirm a model is safe and its states are
  reachable, or produce a machine-readable verdict for a gate. For Quint syntax
  load quint-lang; for invoking quint in this harness load quint-cli.
whenToUse: >
  You have a .qnt spec with invariants and/or witnesses and want to verify it:
  confirm safety holds and key states are reachable, get a pass/fail verdict,
  or produce a verification-report JSON. Also when a witness reports 0 traces
  (unreachable) and you need the progressive-increase + diagnosis protocol, or
  an invariant is violated and you need the counterexample seed for a detailed
  trace. Do not use for writing/editing a spec (quint-modeling) or implementing
  from one (quint-execute-spec).
---

# quint-verify — verify a Quint spec (quint-llm /verify, ported)

quint-llm's Docker-path `/verify` flow, ported to the DSH lightweight-skill
world. The runner `verify.mjs` executes **inside the quint container** (node v20
+ quint 0.32 are on PATH there), shelling out to `quint` for each check, so the
whole flow is one `container_exec` call.

## The judgment convention (do not get this backwards)

Witnesses and invariants ask **opposite** questions — the direction of
"good" differs. This is the easy mistake; the full reference is in
[`quint-lang/guidelines/simulations.md`](../quint-lang/guidelines/simulations.md)
(not duplicated here):

| | reached / satisfied | 0-traces / violated |
|---|---|---|
| **Witness** (`--witnesses`, liveness) | ✅ reached in >0 traces — reachable | ⚠️ 0 traces — unreachable / over-constrained |
| **Invariant** (`--invariant`, safety) | ✅ "No violation found" — safety holds in sampled traces | ❌ violated — a real bug (one trace disproves it) |

A witness **reached** is good; a witness **unreachable** is a concern (the
state can't happen — over-constrained model or a dead action). An invariant
**satisfied** is good; an invariant **violated** is a bug. Note the asymmetry: a
single trace settles a witness (reached) or refutes an invariant (violated), but
an invariant with *no* counterexample only reflects the traces sampled this run
— not a proof.

## Run it

The runner lives at `skills/quint-verify/verify.mjs` and runs in the container.
Invoke through `container_exec` (podman) — see the `quint-cli` skill for the
canonical container flags. The repo is mounted at `/work`; the runner is at
`/work/skills/quint-verify/verify.mjs`; `-v quint-eval-cache:/root/.quint`
caches the Rust evaluator so it downloads once.

```
container_exec (podman, localhost/claudecode:latest, entrypoint /bin/sh -c):
  node /work/skills/quint-verify/verify.mjs <spec.qnt> <main> \
    --invariants <i1> <i2> ... \
    --witnesses <w1> <w2> ... \
    [--max-steps N] [--max-samples M] [--out report.json]
```

It runs typecheck, then each invariant (`quint run --invariant <name>`,
classified satisfied vs violated) and all witnesses together (`quint run
--witnesses ...`, per-witness trace counts), prints a verdict table, writes the
report JSON if `--out`, and exits 0 (pass) / 1 (fail) / 2 (typecheck or usage
error).

### Sidecar (auto-extract)

Instead of listing `--invariants`/`--witnesses` on every call, drop a
`<spec>.verify.json` next to the spec:

```json
{ "invariants": ["..."], "witnesses": ["..."], "maxSteps": 40, "maxSamples": 1000 }
```

When present it supplies the defaults, so `node verify.mjs <spec.qnt> <main>`
suffices; an explicit CLI flag overrides the sidecar.
`skills/implement-task/spec/implementTask.verify.json` is the reference example.

### Worked example — the implement-task model

```
node /work/skills/quint-verify/verify.mjs \
  skills/implement-task/spec/implementTask.qnt implTaskGate \
  --invariants fixRoundCap planRequiresClarify reviewOnlyAfterVerify \
    reportRequiresReview noImplementBeforeApproval approveRequiresPlan \
    reportHonesty workHappensInWorkers \
  --witnesses reachedClarify clarifyUsed reachedImplement reachedVerify \
    reachedReview reachedReport fixLoopUsed capReachedOpenItems \
    fallbackOccurred delegationUsed parallelChunks \
  --out skills/quint-verify/.report.example.json
```

Expected: `verdict: ✅ pass` (8/8 invariants satisfied, 11/11 witnesses
reached). The witness `capReachedOpenItems` reaches only ~18/1000 traces — the
4-fail cap path is rare, which is exactly why random simulation can miss a
fixRoundCap overflow (see the proto-1 sentinel test for the deterministic gate).

## Verdict and report

`verdict = pass` iff every invariant is satisfied AND every witness is reached
(>0 traces). Any invariant violated → fail (bug). Any witness unreachable →
fail (over-constrained). The report JSON
([`verification-report.schema.json`](verification-report.schema.json), ported
from quint-llm) is machine-readable — a gate can consume it:

```json
{ "configuration": {"module": "..."}, "invariants": {"total": N, "satisfied": N, "violated": 0, "details": [{"name": "...", "result": "satisfied"}]},
  "witnesses": {"total": M, "violated": M, "satisfied": 0, "details": [{"name": "...", "result": "violated", "traces": N, "explored": M}]},
  "verdict": "pass" }
```

Note the schema's (confusing but faithful) terms: a witness `result: "violated"`
means **reached = good**; `"satisfied"` means **unreachable = concern**.

## When a witness is unreachable (0 traces) — progressive increase

Do not declare a witness dead from one run. Re-run with increasing `--max-steps`
(e.g. 100 → 200 → 500), then if still 0 traces, run with `--verbosity=3` and read
the trace: which actions executed? is the protocol stuck at init? is the same
action looping? are key actions reachable? Root causes: `protocol_stuck_at_init`
(fix `init`/precondition), `liveness_bug_infinite_loop`, `witness_too_strong`
(weaken the witness), or `need_more_steps`. See
`quint-lang/guidelines/simulations.md` for the diagnosis table.

## When an invariant is violated — capture the counterexample

A violated invariant is a bug. The runner captures the `--seed=0x...` from the
violating run. Reproduce the exact trace:

```
quint run <spec> --main=<main> --invariant <name> --seed=0x... --verbosity=3
```

Read the state trace to the step where the invariant became false and the action
that caused it. This is the counterexample mizchi's loop turns into a
deterministic regression test (see the implement-task `fixRoundCapSentinelTest` /
`replay/` gate): a violated invariant's trace becomes a locked `.expect(not(inv))`
scenario test, and after the fix the sentinel asserts the trace no longer
violates.

## What this ports from quint-llm, and what it does not

Ported: the `/verify` procedure (typecheck → invariants → witnesses → interpret
→ progressive increase → counterexample), the structured verification report
schema, and the runner adapted to the DSH quint-cli container path. The
witness/invariant judgment convention itself already lives in
`quint-lang/guidelines/simulations.md`.

Not ported (quint-llm Docker-path assets that don't map to this context): the
Choreo-specific `test_generation` scripts (`gen_listener_witnesses.py`,
`gen_type_witnesses.py` — they discover `witness_*` vals and listeners for
distributed-protocol specs, which our workflow specs are not), the
`mbt-validator` (Rust-quint-connect model-based testing, heavy), and the
slash-command framework (`/spec:* /code:* /refactor:*`, Docker-only).