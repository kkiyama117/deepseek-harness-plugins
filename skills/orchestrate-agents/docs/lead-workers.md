# `lead-workers` flow

A capable lead plans and integrates; independent workers own explicit units; a reviewer checks the integrated result; bounded repair rounds follow only an explicit `changes_requested`.

## Applicability

- A workflow was explicitly requested and the task splits into a finite set of independent units with separate write scopes.
- One integration point can judge the combined result, and an independent review adds value.
- Tightly coupled work, or work with a single owner, stays [direct](direct.md) or [single](single.md).

Lead-workers dispatches every declared unit in one map. Units must therefore be independent of one another.

## Required inputs and preconditions

- Request with `flow: "lead-workers"`, the ordinary `task` object, at least one unit (unique `id`, self-contained `prompt`, `writeScope` inside the task scope), `batches: []`, and `options.concurrency` / `options.repairRounds` within policy limits. See [the example](../examples/lead-workers.json) and [progressive decomposition](../references/progressive-decomposition.md).
- Policy roles `lead`, `worker` and `reviewer`, each a discovered route, and limits whose worst-case call count (including repair branches) fits `maxCalls`.
- Units that can be completed by a worker with no inherited context; design-needed items stay out of `units`.

## Steps

1. Formulate units as ready packets: parent goal, exact inputs, exclusive scope, concrete output, resolved decisions, acceptance checks, exclusions, escalation rules.
2. Compile and submit unchanged to native `workflow`. See [compile and run on DSH](../references/run-dsh.md).
3. `plan` — the lead plans the supplied units and acceptance checks without changing their count or write ownership.
4. `workers` — one call per unit; each worker executes only its assigned unit within its own scope and verifies it.
5. `integrate` — the lead integrates completed units and verifies the full task, applying [evidence-aware synthesis](../references/synthesis.md).
6. `final_review0` — the initial review inspects the current artifacts against the acceptance criteria and returns `done`, `changes_requested` or `blocked`.
7. With `repairRounds` above zero, `final_repairN` runs only after `changes_requested`; `final_reviewN` then re-reviews the repaired artifact with every prior review in the chain as direct dependencies. See [review rounds and evidence](../references/review-evidence.md).

## Outputs and acceptance

- Success entries are the review-chain nodes, but a `final_reviewN` result counts only when it reports `done`: `completed` needs at least one review `done` and no blocked node; exhausted repair rounds yield `needs-review`.
- The compact projection returns acceptance reports, non-done reports, skipped-node count and failure reason; read the saved full record only for decision-relevant evidence.
- Review passing is not user acceptance. Re-check criteria and artifacts yourself per [acceptance evidence](../references/acceptance-evidence.md).
- When the work is part of issue intake, issue-based development or feedback into shared procedures, `issue-driven-development` keeps ownership of that process; this flow owns only execution structure and delegation.

## Failure and repair

- When a reviewer has not yet passed the chain, `completed` is not reachable; only the review chain decides acceptance.
- A worker returning anything other than `done` blocks the map and stops further admission; in-flight calls settle before the run ends.
- A `blocked` result, a null child result or malformed output is not a partial batch; downstream nodes become `skipped`.
- Only an explicit reviewer `changes_requested` enters the repair path. Runtime failures are not retried automatically.
- Adding units, roles or scopes mid-run is impossible: the graph is frozen. A changed graph requires a new validated run.

## Related references

- [Policy, graphs and results](../references/flow-format.md) — presets, admission, write-scope conflicts.
- [Evidence-aware synthesis](../references/synthesis.md) — integration judgement and compact handoff.
- [Compile and run on DSH](../references/run-dsh.md) — native submission and retention.
