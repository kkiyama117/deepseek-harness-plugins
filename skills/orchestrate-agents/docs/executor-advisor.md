# `executor-advisor` flow

One executor attempts the task; once, and only on a specific unresolved question, an advisor answers; a fresh executor then continues from the recorded attempt and advice. There is no mandatory designer, reviewer or repairer.

## Applicability

- A workflow was explicitly requested, and the work is one context that may hit a narrow design or diagnosis question.
- The question can be answered without redoing the task, and the scoped consultation justifies the extra context handoff. Lower cost is not guaranteed.
- For a fixed three-way model experiment with the same shape, use [comparison](comparison.md) instead.

Do not use this flow as a substitute for review or user acceptance. The attempt's `done` determines graph-level completion on the no-advice path; the parent still checks the artifacts and evidence.

## Required inputs and preconditions

- Request with `flow: "executor-advisor"`, the ordinary `task` object, `units: []`, `batches: []` and `options.repairRounds: 0` (the runner rejects units or repair rounds for this flow).
- Policy roles `executor` and `advisor`, each a discovered `{provider, model}` pair. Worst-case budget is three calls: attempt, optional advice, continuation.
- Explicit workflow authorization and a live `workflow` tool supporting `resultKeys`.

## Steps

1. Write the task so a fresh executor can finish from the packet alone; state the acceptance checks and what counts as a material unknown.
2. Compile the request with its policy, then submit the compiled payload unchanged to native `workflow`. See [compile and run on DSH](../references/run-dsh.md).
3. The `attempt` node returns `done` with the full deliverable, `needs_advice` with progress, evidence, failed attempts and the exact question, or `blocked`.
4. The `advice` node runs only on `needs_advice` status. It answers that question using the supplied evidence and does not implement the task.
5. The `finish` node runs as a new context receiving both the attempt and the advice. It completes the deliverable, runs the acceptance checks and returns `done` or `blocked`.

## Outputs and acceptance

- Success entries are `attempt` and `finish`: either may complete the task. `advice` alone is never acceptance.
- A second `needs_advice` is not accepted as completion; the continuation has no further advice channel.
- Verify artifacts and criteria independently; the attempt's own `done` claim is not verification. See [acceptance evidence](../references/acceptance-evidence.md).

## Failure and repair

- `blocked` from the attempt or advice stops the run; per the global rule in [flow-format](../references/flow-format.md), a blocked, null or malformed child result halts admission rather than continuing to a later node.
- Advice is guidance, not permission: it cannot grant authority, expand write scope or authorize a recursive handoff.
- No repair rounds exist here. A needed repair is either done inside the continuation or reported as blocked.

## Related references

- [Policy, graphs and results](../references/flow-format.md) — the three-call shape and budget rule.
- [Compile and run on DSH](../references/run-dsh.md) — required native submission.
