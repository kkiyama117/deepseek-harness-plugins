# `custom` flow

An allowlisted strong designer constructs a finite data-only graph when the fixed templates cannot express the required structure. The runner calls that designer, validates the returned graph, then executes it with the same primitives and limits.

## Applicability

- A workflow was explicitly requested and the needed structure is not one of the templates: for example, enumerated alternative paths, a required final acceptance node combining several results, or explicit finite repetitions.
- The structure can be expressed with `agent` and `map` nodes, dependencies and enumerated status conditions. Arbitrary JavaScript, cycles and unbounded retries are not accepted.
- If a template expresses the work, prefer it: [single](single.md), [executor-advisor](executor-advisor.md), [lead-workers](lead-workers.md) or [coordinator-advisor](coordinator-advisor.md).

## Required inputs and preconditions

- Request with `flow: "custom"`, the ordinary `task` object, at least one declared unit (required by the current input validator, even if the graph uses no map), `batches: []` and `options.repairRounds: 0` (repetitions must be explicit nodes). See [the example](../examples/custom.json).
- Policy with `roles.customDesigner` set to a discovered route that appears exactly in `customDesignerAllowlist`. A user-supplied author label is not proof; Fable or any designer is usable only when its actual route is available and allowlisted.
- Worst-case `maxCalls` must reserve the design call before any proposed node; the remaining budget is passed to the designer.

## Steps

1. Fix the task, units, roles and limits. The designer receives the units, the non-reserved role names, the limits and the remaining call budget.
2. Compile the request and submit it unchanged to native `workflow`. The runner first calls `custom_design`, which returns the graph only, not an author identity.
3. Validation runs before any proposed work: node kinds and roles, the units field rules, scopes inside the task scope, parallel write conflicts, conditions naming direct predecessors, acyclicity, the single final acceptance node, and an acceptance path for every node.
4. On success the frozen graph executes: independent ready nodes dispatch together, while the shared call queue admits at most `concurrency` child calls per wave. Map nodes fan out over their units. See [runner behavior](shared-execution.md#runner-behavior-shared-by-flows).
5. On failure the run returns `blocked` with the rejected proposal and the reason, and zero proposed work starts.

## Graph shape

- `agent` nodes carry `id`, `kind`, `role`, `prompt`, `after`, `match`, `when`, `writeScope`; the `units` field is forbidden.
- `map` nodes add `units` (nonempty) and must have an empty node `writeScope`, because each unit runs under its own scope.
- `when` entries are `{node, status}` over direct predecessors with statuses `done`, `changes_requested`, `needs_advice`, `blocked`. Unspecified dependencies match `done`; `match: any` requires a condition for every dependency.
- Custom graphs require exactly one final agent node in `success`; combine required results with a final `match: all` node.

## Outputs and acceptance

- `completed` needs the declared acceptance node `done` with no blocked node; otherwise `blocked` or `needs-review`.
- Inspect the validation record and the acceptance evidence yourself; a validated graph proves structure, not task correctness. See [acceptance evidence](../references/acceptance-evidence.md).
- Custom graph publication as a reusable template needs separate human acceptance.

## Failure and repair

- An invalid graph is rejected whole. Do not repair it by editing the runner or by executing model-authored code.
- A graph change requires a new design call and a new validated run.
- The designer must include the synthesis instruction in integration and acceptance nodes; the runner supplies that instruction to the designer rather than injecting it.

## Related references

- [Policy, graphs and results](../references/flow-format.md) — full node validation rules.
- [Evidence-aware synthesis](../references/synthesis.md) — what the design instruction requires.
- [Compile and run on DSH](../references/run-dsh.md) — native submission and budget behavior.
