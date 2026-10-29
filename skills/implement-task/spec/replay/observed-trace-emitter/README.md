# observed-trace-emitter

Harness-observed emitter for the implement-task Quint replay gate (mizchi-style,
proto-3). Closes proto-2's gap: proto-2 relied on the coordinator honestly
appending its own phase transitions to `trace.jsonl` — it could omit a step.
This plugin records what the agent **actually did**.

> **Proto-3 is experimental telemetry, not a gate.** It observes tool calls
> only — it cannot see internal phases or report honesty, and its mapper makes
> documented, conservative inferences. See "What the harness can and cannot
> observe" below before treating a GREEN replay as proof of anything stronger.

## How it works

DSH exposes a Cordis **event** `tools/result` (mode: `emit`) that the **harness**
fires on every tool dispatch, with the frozen `exec` (`name`, `arguments`,
`callId`, ...) and the `result` (`isError`, first text block). The agent cannot
suppress an event the harness already emitted. This plugin appends each
observed tool call as one JSON line to a **per-session** log:

```
<LOG_DIR>/trace.observed.<session-id>.jsonl
```

Writes are append-only through a single module-level promise chain (a correct
FIFO mutex inside the one harness process), so parallel tool calls cannot
interleave read-modify-write pairs and different sessions never share a file.
Each record carries `sid` (the session id). If host `fs` is missing, `apply`
returns without writing (silent no-op).

Then [`../observedToTrace.mjs`](../observedToTrace.mjs) maps that observed log
to the model-action trace, [`../replay.mjs`](../replay.mjs) turns it into the
Quint replay test, and `quint test` is the check. See [`../README.md`](../README.md).

## Observed record format

One JSON object per line (only scalar leaf fields are read from the frozen live
`exec`/`result`; the live objects are never `JSON.stringify`d):

```json
{"seq":0,"sid":"session-x","name":"ask_user_question","ok":true,"qHead":"Plan is ready...","optsHead":"Approve|Adjust","outHead":"Approve"}
{"seq":1,"sid":"session-x","name":"subagent_worker","ok":true,"desc":"implement chunk","promptHead":"implement per the plan...","outHead":"Implemented chunk 1..."}
{"seq":2,"sid":"session-x","name":"subagent_verify","ok":true,"desc":"verify","promptHead":"run the checks...","outHead":"pnpm test green"}
{"seq":3,"sid":"session-x","name":"subagent_frontier","ok":true,"desc":"review","promptHead":"reviewer: judge the diff...","outHead":"Verdict: PASS"}
```

- `ok` is the **transport outcome only** (the harness's `isError`). It says
  nothing about whether the reported work succeeded — the mapper refines it
  from `outHead` evidence (see the mapper header).
- `outHead` is the head of the result's first text block: the user's gate
  answer, or the worker/verify/frontier report's opening text. It is the
  evidence the mapper keys on; without it those actions are omitted rather
  than guessed.

Other tool calls (bash, read, container_exec, ...) are recorded too but are
ignored by the gate mapping.

## Install

This machine uses a **home-patch** host row (do not `dsh plugin add` unless
you want a profile bundle as well):

```yaml
# in ~/.dsh/cordis.patch.yml — effective after the next dsh restart
- insert:
    - id: observed-trace-emitter
      name: 'file:///data/softwares/deepseek-harness-plugins/skills/implement-task/spec/replay/observed-trace-emitter/index.js'
```

Optional bundle path: `dsh plugin --profile <name> add ./skills/implement-task/spec/replay/observed-trace-emitter`.

The `LOG_DIR` in `index.js` points at the implement-task replay dir. Live emit
is unverified until the process that loaded the row is the running harness.
`node selfcheck.mjs` smoke-tests the write path offline (per-session files,
FIFO append order under parallel events, gate evidence capture).

## ⚠ Known blocker (why this is a bundle, not a live dynamic plugin)

The natural lightweight path would be `cordis_define` (a dynamic plugin
activated in-session). In the session this was built, the harness tool-binding
layer stringifies object-valued parameters, so `cordis_define`'s `plugin`
object (a oneOf) fails validation with *"must match exactly one oneOf branch
(matched 0)"* — the same bug breaks `cordis_inspect_query`'s `input` object.
So the plugin could not be activated live here. It is shipped as an installable
bundle instead: install it and restart to get the live harness-observed emitter.
The source is plain JS (`index.js`); when the tool binding is fixed, the
same `apply(ctx)` body can be passed to `cordis_define` as `code.host`.

## What the harness can and cannot observe

The harness observes **tool calls** (delegations, the gate question, frontier
calls) — some of the actions the invariants care about. It **cannot** observe:

- internal phase moves (SCOPE done, CLARIFY resolved, PLAN ready): the mapper
  ASSUMES that prefix is valid;
- the REPORT action and `reportHonesty`: reporting is an assistant message,
  not a tool call, so the mapper emits no `report` at all;
- worker/verify success beyond transport status plus explicit failure markers
  in the recorded report head — absence of failure evidence is not proof of
  success;
- the reviewer's verdict unless the recorded report head carries an explicit
  PASS/FAIL token.

Everything inferred is documented in the [`../observedToTrace.mjs`](../observedToTrace.mjs)
header, and `node observedToTrace.mjs --self-check` pins the fixtures to the
documented mappings. That is the honest ceiling of proto-3: **telemetry about
observable tool calls, not a production guarantee.**
