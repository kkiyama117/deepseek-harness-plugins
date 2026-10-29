# Trace replay gate

Proto-2 of the mizchi-style deterministic gate, closed on a **self-reported**
trace. **Experimental — not harness-enforced.** The model
(`../implementTask.qnt`) is the source of truth; the trace is the
implementation under test. Replaying it and asserting every invariant after
every step is the gate for that file, not a proof of live honesty.

## The loop

1. The coordinator instruments its transitions: after each step in the
   `implement-task` flow fires, it appends one JSON object to `trace.jsonl`
   (one per model action — see the format below).
2. At REPORT (or early exit), `trace.jsonl` is the agent's actual execution.
3. `replay.mjs` turns the trace into a Quint `run replayTest` that drives the
   model through the exact transitions and `.expect(allInvariants)` after
   every step.
4. `quint test replayTrace.qnt --main=replayTrace` runs the gate:
   - **GREEN** — every transition the agent attempted was allowed by the
     model's guards, and every invariant held at every state.
   - **RED** — a `.then(step)` failed (the model blocked a transition the agent
     attempted: a deviation) or an `.expect(allInvariants)` failed (an
     invariant broke at a state the agent reached).

## Usage

```sh
# Generate the replay test from a trace:
node replay.mjs trace.jsonl > replayTrace.qnt

# Run the gate (quint runs in the harness container — see quint-cli skill):
quint test replayTrace.qnt --main=replayTrace
```

`replay.mjs` infers `PRE_APPROVED` (true iff the trace uses `skipGate`) and
`WORKERS` (the set of worker ids the trace references) from the trace, and
fixes `BUGGY_FIX_CAP = false` — the gate replays against the real (fixed) model.

## Trace format

A JSON array **or JSONL** (one object per line). Action names and
parameters match `../implementTask.qnt` exactly:

| action | step | params |
|---|---|---|
| `scopeDone` | `{"a":"scopeDone"}` | — |
| `clarify` | `{"a":"clarify","clear":<bool>}` | `clear` |
| `clarifyAnswered` | `{"a":"clarifyAnswered"}` | — |
| `plan` | `{"a":"plan","frontierOk":<bool>}` | `frontierOk` |
| `approve` | `{"a":"approve"}` | — |
| `adjust` | `{"a":"adjust"}` | — |
| `skipGate` | `{"a":"skipGate"}` | sets `PRE_APPROVED = true` |
| `delegate` | `{"a":"delegate","w":<int>,"task":"ImplementTask"\|"VerifyTask"}` | `w`, `task` |
| `workerDone` | `{"a":"workerDone","w":<int>,"task":...,"ok":<bool>}` | `w`, `task`, `ok` |
| `review` | `{"a":"review","v":"Pass"\|"Fail"}` | `v` |
| `report` | `{"a":"report"}` | — |

## Worked examples

`trace.good.json` — the happy path: scope → clarify(true) → plan(true) →
approve → delegate implement → workerDone → delegate verify → workerDone(ok) →
review(Pass) → report. The gate is **GREEN** (`1 passing`): every transition
was allowed and all invariants held at every step.

`trace.bad.json` — the agent **skips the gate**: scope → clarify(true) →
plan(true) → delegate implement (no `approve`). The gate is **RED**:
`Cannot continue to "expect"` at `.then(delegate(1, ImplementTask))` — the
model's guard blocked the transition (`phase == Gate`, `approved = false`),
so the chain stops at the exact deviating step. The agent implemented before
approval; the spec says it must not.

Run them:

```sh
node replay.mjs trace.good.json > replayTrace.good.qnt
node replay.mjs trace.bad.json  > replayTrace.bad.qnt
quint test replayTrace.good.qnt --main=replayTrace   # 1 passing  (GREEN)
quint test replayTrace.bad.qnt  --main=replayTrace   # 1 failed   (RED)
```

## What this proves / what it does not

This closes mizchi's loop on a **self-reported** trace: the counterexample is
"this file does not match the spec." A coordinator that omits a step defeats
proto-2 silently. Proto-3 (below) records **tool calls** the harness already
emitted; it does not observe internal phases or report honesty.

## Harness-observed emitter (proto-3)

> **Proto-3 is experimental telemetry, not a gate.** It records tool calls the
> harness already emitted; it cannot observe internal phases, report honesty,
> or unrecorded verdicts. Its mapper makes documented, conservative inferences
> and OMITS actions it lacks evidence for — ambiguity never manufactures
> success.

Proto-3 replaces the agent's self-reported `trace.jsonl` with a record the
**harness** writes by observing the agent's actual tool calls. DSH exposes a
Cordis event `tools/result` that fires on every tool dispatch (with the tool
name, arguments, transport outcome, and result text head), independent of the
agent. A plugin listens and appends each observed call to a **per-session**
log `trace.observed.<session-id>.jsonl` (append-only writes through one
in-process promise chain, so parallel calls cannot interleave and sessions
never mix); the agent cannot suppress what the harness already emitted.

```
agent tool calls ─▶ [harness: tools/result event] ─▶ observed-trace-emitter plugin
                                                           │ writes (not the agent)
                                                           ▼
                    trace.observed.<sid>.jsonl ──▶ observedToTrace.mjs ──▶ trace.json
                                                                                      │
                                                               replay.mjs ◀────────┘
                                                                      │
                                                               replayTrace.qnt
                                                                      │
                                                           quint test ──▶ GREEN / RED check
```

Pieces:

- [`observed-trace-emitter/`](observed-trace-emitter/) — host plugin
  (`index.js` listens to `tools/result`, writes the per-session log via the
  host `fs` service when present). Local install is a **home-patch**
  `file://` row in `~/.dsh/cordis.patch.yml` (the home-patch plane),
  then a dsh restart. `dsh plugin add` is optional, not required here.
- [`observedToTrace.mjs`](observedToTrace.mjs) — maps the observed tool-call
  log to the model-action trace; every inference is documented in its header.
  The unobservable prefix (scope/clarify/plan) is assumed; an
  `ask_user_question` counts as the gate ONLY when its recorded option labels
  include Approve (a clarification question does not) and it was not denied;
  worker/verify `ok` is forced false on explicit failure evidence in the
  recorded report head; a frontier call maps to a review action only when its
  report head carries an explicit PASS/FAIL token; `report` is never emitted
  (unobservable).
- [`trace.observed.good.jsonl`](trace.observed.good.jsonl),
  [`trace.observed.bad.jsonl`](trace.observed.bad.jsonl),
  [`trace.observed.clarify.jsonl`](trace.observed.clarify.jsonl) —
  representative observed logs in the exact format the emitter writes, to demo
  the bridge without a live run. `node observedToTrace.mjs --self-check`
  asserts all three map exactly as documented.

Worked demo:

```sh
node observedToTrace.mjs trace.observed.good.jsonl > trace.good.json
node replay.mjs          trace.good.json           > replayTrace.good.qnt
quint test replayTrace.good.qnt --main=replayTrace   # 1 passing  (GREEN)
node observedToTrace.mjs trace.observed.bad.jsonl  > trace.bad.json
node replay.mjs          trace.bad.json           > replayTrace.bad.qnt
quint test replayTrace.bad.qnt  --main=replayTrace   # 1 failed   (RED)
```

The bad log has **no gate-shaped question before the first `subagent_worker`**
(the agent delegated implementation without gating); the check goes RED at
`.then(delegate(1, ImplementTask))` — exactly the deviation proto-2's
self-reporting could have hidden. The clarify log shows the other direction:
a clarification question (no Approve option) does NOT become a gate, so
implementing right after it stays RED — the old mapper counted any question
as approval.

### ⚠ Blocker: live activation in this session

`cordis_define` (the dynamic-plugin path) could not be used: this session's
tool-binding layer stringifies object-valued parameters, so `cordis_define`'s
`plugin` oneOf fails (`must match exactly one oneOf branch (matched 0)`); the
same bug breaks `cordis_inspect_query`'s `input`. The emitter is therefore
shipped as an **installable bundle** (install + restart), not a live dynamic
plugin. The `apply(ctx)` body in `index.js` is the exact code that would go
into `cordis_define`'s `code.host` once the binding is fixed.

### What the harness can and cannot observe

The harness observes **tool calls** — the actions the invariants care about
(`noImplementBeforeApproval`, `reviewOnlyAfterVerify`, `fixRoundCap`,
`workHappensInWorkers`). It cannot observe the model's internal phase moves
(SCOPE done, CLARIFY resolved, PLAN ready): those are not tool calls, so the
mapper assumes that prefix. `reportHonesty` (about the report's content) is
also not observable from tool calls and is not enforced by this emitter.