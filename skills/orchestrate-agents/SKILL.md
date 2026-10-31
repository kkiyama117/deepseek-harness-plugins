---
name: orchestrate-agents
description: Formulate tasks, choose direct or delegated execution, and run validated parameterized single, lead-workers, coordinator-advisor or strong-model-designed custom flows. Use for task routing, AI prompt formulation, model-role selection, reproducible workflows and multi-agent coordination. Does not require delegation or a workflow for routine work.
---

# Task formulation and orchestration

Use the smallest execution structure that completes the human's full request. This skill includes the former `task-router` intake; do not load a second routing policy or create a router agent merely to select a flow.

For issue-based development, first follow [issue-driven-development](https://github.com/kkiyama117/deepseek-harness-plugins/blob/main/skills/issue-driven-development/SKILL.md) or the project's documented equivalent. It owns intake, acceptance, delivery and feedback; this skill owns execution structure and delegation.

## Select and read before acting

Read the full request and minimum relevant context. Identify the outcome, acceptance evidence, authority, unknowns and write ownership; resolve routine details without questioning the user. Use [task formulation](references/task-packet.md) when preparing a handoff or run, and [progressive decomposition](references/progressive-decomposition.md) for large multi-part work. Neither creates an extra planning agent.

Keep sequential work that shares reasoning in one agent. Split by isolated context, not job titles; difficulty or model strength alone does not justify delegation. Prefer on-demand skills and tools over adding specialists just to hold instructions. Explain the chosen structure's benefit over a simpler choice.

**Before entering a flow, read its guide below.** Read only that guide and the references needed for the current action, not every guide or the entire README. On a flow change, read the new guide; do not reread unchanged guidance already in context. If a required guide is unavailable, report the missing resource rather than invent its procedure.

| Choice | Selection criterion | Read on entry |
|---|---|---|
| Direct | Current-agent work; use native delegation only for a justified independent part. No compiled workflow required. | [Direct](docs/direct.md) |
| `single` | An explicitly requested reproducible workflow with one fresh executor and its checks. | [Single](docs/single.md) |
| `executor-advisor` | One executor, at most one scoped consultation, then a fresh continuation if needed. | [Executor–advisor](docs/executor-advisor.md) |
| `comparison` | A requested read-only experiment: Flash alone, Astra alone, Flash with conditional advice; not production task execution. | [Comparison](docs/comparison.md) |
| `lead-workers` | A finite set of independent units with separate write scopes, followed by integration and bounded review/repair. | [Lead–workers](docs/lead-workers.md) |
| `coordinator-advisor` | Stable ordered batches where repeated coordination can be separated from design judgment. | [Coordinator–advisor](docs/coordinator-advisor.md) |
| `custom` | Fixed templates cannot express the structure; an available, allowlisted designer proposes a finite data-only graph. | [Custom](docs/custom.md) |

## Constraints that apply before execution

- Follow higher-priority instructions, user scope and host permissions. Loading this skill grants no recursive delegation, additional data sharing, higher spend, destructive actions, installation, publication or server authority.
- Native `workflow` needs an explicit workflow/large-orchestration request; `ralph` needs a separate explicit Ralph/fresh-agent request. Ordinary work needs neither. Discover routes before binding them; never silently substitute a model.
- One writer per shared file/worktree. Compiled flows use flat, fresh child contexts with no worker-spawned children; owner-continuity guidance does not change that topology. Keep credentials, private run data and unnecessary conversation out of worker packets and skill examples.
- Material ambiguity is `needs-input`, not permission to proceed. Missing capabilities are blockers, not permission to invent routes or launch another application. A changed compiled graph requires a new validated run; do not replay uncertain effects or restart after cancellation without authority.
- A routing packet is not completion of an execution request, and a child's `done` is not proof. Inspect artifacts and [acceptance evidence](references/acceptance-evidence.md) against the original goal. Design-only requests do not authorize executing their example tasks.

## Read when the action requires it

- Before role/budget configuration or delegation: [shared execution rules](docs/shared-execution.md), selecting the relevant model-route and harness-adapter sections. Before a compiled DSH run: [compile and submit](references/run-dsh.md); transmit the exact compiled payload, including supported `resultKeys`, never a rewritten runner.
- Only for explicitly opted-in stage classification: [Jev routing](references/jev-routing.ja.md). It is not compulsory; user-selected flows/models take precedence. External-send permission and workflow execution permission are separate; default shadow output is not executable.
- Before claiming determinism, resumability, isolation or actual model identity: [runtime limits](README.md#limits) and [guarantees](README.md#reproducibility-and-guarantees). Only DSH has a supplied executable adapter.
- When maintaining this skill: [verification entry points](references/verification-map.md). Examples are synthetic, not cost/quality evidence; run `node --test tests/*.test.mjs` from this skill directory for deterministic regression checks.
