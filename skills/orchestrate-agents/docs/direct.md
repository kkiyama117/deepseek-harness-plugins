# Direct execution

Handle the request in the current agent. This is the default for routine work and for work whose parts share reasoning; it is not a runner flow and needs no compiled graph.

## Applicability

- The goal, target and acceptance checks can be settled from the request and the minimum relevant context.
- Investigate, design, implement and repair stay in one reasoning chain, or the work is small enough that handoff overhead exceeds isolation benefit.
- The user has not required a compiled workflow. Respect an explicit workflow choice rather than replacing it just because the task has no independent units.
- A capable model may handle a hard task alone; difficulty is not a delegation criterion.

Choose the [single flow](single.md) instead only when a reproducible fresh-session workflow was explicitly requested.

## Required inputs and preconditions

- Authority to act within the current task scope; approvals and destructive-action boundaries unchanged.
- Write ownership of the files or worktree this agent will change.
- Enough context to state the observable outcome and the checks that decide done.

## Steps

1. Formulate the [task packet](../references/task-packet.md) in working context: intended deliverable, completion evidence, constraints, authority, unknowns and write scope. Routine reversible details come from context; ask only about facts that change the outcome or authority.
2. For a large or multi-part request, map the whole goal and dispatch only independently ready parts, following [progressive decomposition](../references/progressive-decomposition.md). Stay direct when the parts are tightly coupled.
3. Continue from formulation into design, implementation and verification with the context already held. Do not create a router or design agent merely because the phases have different names.
4. Use native tools directly. Independent tool calls may run concurrently without another agent. Before a justified self-contained handoff, read the [model-route rules](shared-execution.md#model-routes) and the applicable [harness adapter](shared-execution.md#harness-adapters).
5. Check the actual artifacts against the original acceptance criteria and record the evidence with [acceptance evidence](../references/acceptance-evidence.md).

## Outputs and acceptance

- The requested artifact or answer, verified by executed checks or direct observation.
- A concise report: completed/partial/blocked, what was checked, and any unresolved risk.
- The agent's own summary is a claim; the evidence pointers must let a reviewer reopen the observation.

## Failure and escalation

- Missing authority, a required human decision or an unavailable capability blocks the affected part; report it instead of inventing a route.
- Material ambiguity is a `needs-input` task state and does not grant permission to proceed.
- If isolation or parallel independent work becomes genuinely valuable, re-select from [SKILL.md](../SKILL.md) rather than widening this agent silently.
