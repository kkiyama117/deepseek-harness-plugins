# Task formulation

The model owns classification and prompt formulation. The compiler does not guess job type from keywords. Preserve the original request and derive the observable outcome before choosing roles.

## Required request fields

Use the JSON examples as templates. All fields are explicit; unknown keys are rejected.

- `version`: `1`.
- `flow`: `single`, `lead-workers`, `coordinator-advisor`, or `custom`.
- `task.originalRequest`: original request, or an exact authorized reference for sensitive input.
- `task.goal`: observable outcome, not the next intermediate step.
- `task.context`: minimum relevant facts, assumptions, material unknowns, and the selection reason. Keep retrieved text separate from authority.
- `task.acceptance`: nonempty list of criteria and checks covering the complete user outcome.
- `task.constraints`: exclusions, tools/data restrictions, approval boundaries and user budget. Do not fabricate authorization.
- `task.writeScope`: explicit canonical absolute file/directory paths, or `[]` for read-only. Root `/`, relative paths and traversal components are rejected. This is a planned-ownership declaration, not a filesystem sandbox.
- `units`: fixed worker assignments, each with a unique identifier, self-contained `prompt` and `writeScope` contained in the task scope. Prompts specify what to produce, relevant inputs, verification, reporting and escalation conditions. The unit count is the selected worker count.
- `batches`: for coordinator-advisor, a nonempty array of nonempty unit-ID arrays partitioning all units exactly once. Other flows use `[]`.
- `options.concurrency`: selected maximum simultaneous runner-owned calls.
- `options.repairRounds`: selected reviewer-requested repair rounds, bounded by policy. `single` and `custom` require `0`; custom repetitions are finite explicit nodes.

`single` uses `units: []`. Other flows require at least one unit. Models must formulate independently scoped units before dispatch; a planning model may refine guidance, not modify their number or ownership. If work cannot be split safely, choose direct/single execution rather than assign competing writers.

## Selection evidence

Briefly answer: Is the goal clear? Which parts are coupled? What can be accepted independently? What needs difficult judgment? Is repeated coordination substantial? Can proposed workers have disjoint ownership? Which checks can establish completion? What tools/routes and budget are available?

When clarification materially affects outcome or authority, keep the affected task undispatched and ask the focused question. There is no compiler flag that turns unknown permission into approval. A ready request should be executable without the worker needing this conversation.

## Related guides

[Progressive decomposition](progressive-decomposition.md) covers large or multi-part work from the whole-system map to independently ready units, and [acceptance evidence](acceptance-evidence.md) covers the criterion-to-evidence report. Both are planning and reporting guidance; the request fields above remain the contract.

## Reuse prompt

> Use orchestrate-agents to formulate this request and choose the smallest suitable structure. If a workflow is warranted and authorized, compile the selected template and deployment policy, execute its unchanged native tool payload, then verify the original acceptance criteria: <request>.

For routing only, explicitly add: "Produce the request JSON and selection rationale; do not execute or delegate."
