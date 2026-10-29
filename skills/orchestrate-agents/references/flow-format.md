# Policy, graphs and results

## Deployment policy

Policy is trusted deployment input, separate from the model's task request. The operator/coordinator selects it under the human's authority; a graph designer cannot increase it through its response. This is not a security boundary against someone who can rewrite the policy or runner.

`version: 1`, `roles`, `limits` and `customDesignerAllowlist` are required. Each role is exactly `{provider, model}` using observed harness routes. Limits are positive safe integers: `maxConcurrency`, `maxCalls`, `maxNodes`, `maxWorkers`, `maxBatches`; `maxRepairRounds` may be zero. The requested concurrency and repair count must fit the policy. All other options are rejected, including unsupported effort.

The compiler conservatively counts every possible node/worker call, including repair branches and optional advice. That worst-case count must fit `maxCalls`; custom graphs reserve one call for design. Skipped branches cost no calls at execution. Limits measure runner-owned calls only, not token cost or enforceable child permission sets.

For `custom`, the policy's `customDesigner` provider/model pair must appear exactly in `customDesignerAllowlist`. The runtime itself dispatches the design call on that pair. Self-reported author/provider fields are not in the accepted graph format. Execution roles exclude the reserved `customDesigner` role. Fable is not preconfigured without a discovered route.

## Executor-advisor and comparison

`executor-advisor` uses the ordinary request format with empty units/batches, zero repair rounds, and policy roles `executor` and `advisor`. An executor may return done immediately or needs_advice once; the advisor is read-only, and a fresh executor receives both the attempt and advice. The worst-case budget is three calls. A second needs_advice result is not accepted as completion.

`comparison` has its own request fields: version:1, flow:"comparison", task, fixtureId and order. order is a permutation of flash/astra/flash-advisor; task is the ordinary task object with empty writeScope. Policy roles are exactly flash and astra, each a provider/model pair. Ordinary policy limits still apply, and maxCalls must cover the total five-call worst case. See [comparison protocol](comparison.md) for output, evaluation and isolation limits.

## Data-only custom graph

The strong designer receives the native structured-output schema exported by `createFlowRuntime().graphSchema`. The same runtime validates semantic constraints after schema decoding. No generic JSON Schema dependency or arbitrary code evaluator is used; these are small closed data formats plus graph-specific checks.

A graph has `nodes` and `success`. Custom `success` must name exactly one final agent node, and every node must be on a dependency path to that acceptance node. To combine multiple required results, add a final agent with `match: all`; use `any` only for an intentional alternative path. Presets may have multiple success entries for mutually exclusive review-round acceptance.

Every agent node contains exactly the following fields. A map node additionally requires `units`. The native structured-output schema distinguishes these alternatives with `oneOf` and a constant `kind`:

```json
{
  "id": "accept",
  "kind": "agent",
  "role": "reviewer",
  "prompt": "Check all task acceptance criteria against the predecessor evidence; return done or blocked.",
  "after": ["work"],
  "match": "all",
  "when": [],
  "writeScope": []
}
```

- `id`: unique identifier. `role`: a configured non-reserved role.
- `kind: agent`: one model call; the `units` field is forbidden. Select its work in `prompt`; `writeScope` must fit the task.
- `kind: map`: one call per named unit, all using the node's role and instructions plus that unit's packet. `units` must be nonempty, and node `writeScope` must be empty because unit scopes apply.
- `after`: all predecessors must settle before this node is evaluated. Forward references are allowed; cycles and unknown references are rejected. Topological order preserves declaration order among ready nodes.
- `match: all`: each predecessor must match its explicit `when` condition or, when unspecified, have status `done`.
- `match: any`: all predecessors still settle, but one matching condition suffices. It requires one explicit condition for every predecessor.
- `when`: unique `{node, status}` entries referring to direct predecessors. Allowed statuses are `done`, `changes_requested`, `needs_advice`, `blocked`. Global blocked/invalid/null results halt admission; a condition cannot override that stop.

Nodes whose conditions do not match become `skipped`, not successful empty outputs. Unordered nodes with overlapping write scopes are rejected, as are overlapping workers in one map. Ancestry—not model completion timing—determines whether writer scopes can be reused. Symlink aliases and undeclared writes remain host/worker concerns.

## Preset review evidence

In `lead-workers` and `coordinator-advisor`, re-review receives the latest repair and every prior review in the same chain as direct dependencies. Repair must be `done`, and the prior reviews must be `changes_requested`. Initial review and numbered re-review have distinct instructions; [review rounds and evidence](review-evidence.md) explains their duties and the distinction between historical findings and current artifacts. The custom graph format and call limits are unchanged.

## Runtime outcomes

An ordinary agent returns exactly `{status, summary, evidence}`. `summary` is nonempty; `evidence` is an array of strings describing actual checks, artifact paths or observations. A map worker must return `done`; any other status blocks the map and further admission. A reviewer may return `changes_requested`; only the explicit repair branch handles it. A coordinator may return `needs_advice`; only its explicit advisor path handles it.

Admission uses fixed ordered waves of at most the selected concurrency. The next wave waits for all admitted calls to settle, so changing completion order does not change which queued calls start after a failure. This trades some throughput for reproducible admission. Outputs retain declaration/unit order, not wall-clock completion order.

A null result or malformed node result blocks the run. Host exceptions/cancellation propagate as failures after in-flight runner calls settle; they are never transformed into model-requested repair. There is no automatic retry after an uncertain side effect.

The complete record contains `status`, `callsStarted`, `selectedRoutes`, the resolved `request`, frozen `graph`, ordered `results`, and `summary`. The summary contains attempted acceptance-node reports, non-done node/worker reports (including historical advice/repair requests), the skipped-node count and any graph failure reason. The compiler requests only `status`, `callsStarted` and `summary` inline through Host `resultKeys`; the full record remains in the Host's saved artifact. For invalid custom graphs, it includes the rejected proposal and a reason, and no proposed work is started. `completed` requires a declared acceptance result of `done` and no blocked node; otherwise the result is `blocked` or `needs-review`. This is graph-level evidence, not an independent task-correctness guarantee.
