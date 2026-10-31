# `coordinator-advisor` flow

A designer defines outcomes and accepts each batch; a coordinator runs stable batches and may ask an advisor through the explicit `needs_advice` branch; workers implement each batch's units; a reviewer and bounded repairs close the batch before the designer accepts it.

## Applicability

- A workflow was explicitly requested and the work divides into ordered batches of units whose specifications can be fixed before dispatch.
- Repeated coordination can be separated from design judgement, so an integration role may be bound to a lower-cost route.
- A single unbranched set of independent units is simpler as [lead-workers](lead-workers.md).

## Required inputs and preconditions

- Request with `flow: "coordinator-advisor"`, the ordinary `task` object, units, and `batches`: a nonempty array of nonempty unit-ID arrays that partitions all units exactly once. Other flows must send `batches: []`. See [the example](../examples/coordinator-advisor.json).
- Policy roles `designer`, `coordinator`, `advisor`, `worker` and `reviewer` as discovered routes, and limits covering the worst-case call count including advice and repair branches.
- Later batches may rely on accepted outputs of earlier batches, but the batch instructions must be fixed before dispatch; predecessor artifacts need not exist when the workflow starts.

## Steps

1. Fix unit prompts and batch grouping before compilation. Write each batch instruction so it can consume earlier accepted outputs without renegotiating scope.
2. Compile and submit unchanged to native `workflow`. See [compile and run on DSH](../references/run-dsh.md).
3. `design` — the designer defines batch outcomes and acceptance guidance for the supplied task and fixed units; it does not implement.
4. Per batch `N`, in order: `batchN_coordinate` → optional `batchN_advice` (only on `needs_advice`) → `batchN_workers` (an `any` join over the coordinator's `done` or the advisor's `done`) → `batchN_integrate` → `batchN_review0..M` with bounded `batchN_repairN` → `batchN_accept`.
5. The designer's `batchN_accept` runs only after a passing review of that batch; the next batch starts after that acceptance.

## Outputs and acceptance

- Success is the final batch's acceptance node. `completed` requires it to report `done` with no blocked node; exhausted repairs yield `needs-review`.
- The compact summary returns every batch acceptance report, so an earlier batch's caveats survive even if a later report omits them.
- Designer acceptance is graph-level evidence. The parent still verifies the user objective against artifacts.

## Failure and repair

- A worker status other than `done` blocks the map; a blocked or malformed result stops admission and later batches do not start.
- Advice is available only through the explicit branch and only for a specific design or diagnostic question; the advisor does not implement or approve.
- Only reviewer `changes_requested` triggers repair. `needs_advice` on the coordinator is not a repair signal.
- Re-grouping units requires editing the request and a new validated run; the frozen graph cannot be mutated mid-run.

## Related references

- [Policy, graphs and results](../references/flow-format.md) — batch partition rule, joins and statuses.
- [Review rounds and evidence](../references/review-evidence.md) — what each review round receives.
- [Evidence-aware synthesis](../references/synthesis.md) — coordinator integration duties.
