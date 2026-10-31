# Progressive decomposition

Use this guide when a human request is large enough that its acceptance cannot be judged as one unit, but the work still needs the smallest structure that completes it. Enumerate first, refine responsibility by responsibility, and dispatch a unit only once a worker with no inherited context can finish and verify it from the packet alone. This is planning guidance for [task formulation](task-packet.md); it adds no runtime behavior.

Do not turn every request into a map. Use direct execution when the inputs, the design decisions, and the checks are already sufficient, including routine or tightly coupled work; one acceptance check and one writer do not make an unresolved design ready.

## 1. Map the whole system first

Before splitting, state the rough whole-system goal and enumerate the candidate pieces. The map stays coarse and visible for the whole task.

- Write the intended end state in one sentence, including the evidence that will prove it.
- List every candidate item you currently see, including items that may later be rejected or deferred.
- Give each candidate an owning responsibility area and a one-line outcome, not an implementation.
- Record adopt, defer, or reject with the reason. A deferred or rejected candidate stays on the map so it is not silently re-added later.
- Keep the whole-system goal as the acceptance anchor even while only some candidates are implemented now.

Do not deepen unrelated future work here. Future candidates may stay one line until their dependencies exist.

## 2. Refine responsibility layers and dependencies

Group adopted candidates into responsibility layers, then order them by true dependencies. A planning layer is not an agent boundary: the same owner may implement and verify several sequential layers. Delegate only when the needed context can be isolated; serial dependencies or a ready packet alone do not justify a handoff.

- A layer produces one kind of result, has one owner, and can be checked without later layers.
- Order by what must exist first, not by convenience, file count, or expected effort.
- An item is unblocked when its required external inputs and its design decisions are settled. Artifacts a predecessor inside the same approved flow will produce need not exist yet.
- Group only tightly coupled logic. Sharing a writer, a mutable artifact, or one reasoning chain does not force one layer or unit forever: serialize independently verifiable dependent units when their ownership can be separated.
- Record a dependency as "needs output X from Y", not as "should run after".

Refine in passes. Promote one layer's worth of detail at a time and leave later layers coarse.

## 3. Planning states: design-needed and ready

Classify each adopted candidate in the plan only. These labels live in the working map; they are not new schema fields or runtime result statuses, though ordinary context or prompt prose may mention them.

- **design-needed**: at least one choice that changes the result, a public surface, or the acceptance is still unresolved. Design judgment owns those choices: the designing model or the parent resolves them before any worker starts. Do not hand an unresolved design to an implementation worker.
- **ready**: required external inputs exist, predecessor outputs have explicit producers and dependencies, output and ownership are exact, and acceptance can be checked independently. A worker with no inherited context can complete the unit from its packet once its dependencies settle.

Implement ready units in dependency order. When implementation reveals a new truth, do not widen the unit silently; return to the map and re-classify. A scope or acceptance change is a planning change. If it alters a compiled graph, it requires a new validated run, never an edit during execution.

## 4. Ready packet contents

A ready unit carries everything its worker needs and nothing inherited from this conversation. Each packet states:

1. **Parent goal** — the whole-system outcome the unit serves, plus the unit's contribution.
2. **Exact inputs** — canonical paths, artifacts, or supplied facts, with the revision or region that matters.
3. **Exclusive scope** — the only files or directories this worker may write, plus its read-only inputs.
4. **Concrete output** — the artifact, file, or answer to produce, specific enough to inspect.
5. **Resolved design decisions** — the choices already made that the worker must not reopen.
6. **Acceptance checks** — executable or directly observable checks that decide done versus not-done.
7. **Exclusions** — what not to touch, change, or redecide, plus approval boundaries and budget.
8. **Failure and escalation reporting** — what to report on failure, and which material unknowns to return to the parent instead of guessing.

Do not prescribe line-by-line code. State the intended behavior, output, and checks; the worker chooses the implementation. Workers report findings rather than negotiate scope: an unknown that changes inputs, ownership, or acceptance goes back to the parent, which re-runs steps 1–3. Workers do not silently expand scope, spawn children, or invent requirements.

## 5. Map the plan to the existing packet

Use existing accepted fields only. [task-packet.md](task-packet.md) owns the full request contract, and [lead-workers.json](../examples/lead-workers.json) shows a synthetic shape.

| Plan element | Existing field |
|---|---|
| Preserved human request | `task.originalRequest` |
| Whole-system goal and this unit's contribution | `task.goal` |
| Facts, assumptions, material unknowns, selection reason | `task.context` |
| Overall acceptance and unit-level checks | `task.acceptance` |
| Exclusions, authority, budget | `task.constraints` |
| Ownership boundary | `task.writeScope` |
| Ready packet for one worker | `units[].prompt` |
| That worker's exclusive write paths | `units[].writeScope` |
| Ordered grouping of units (coordinator-advisor) | `batches` |

Rules that follow from the existing formats:

- The `units` count is the worker count. Keep design-needed items out of `units`; dispatch only ready units.
- Presets dispatch every declared unit. `lead-workers` units must therefore be independent of each other; `coordinator-advisor` runs its batches in order, so a later batch may rely on accepted outputs of earlier batches when those batch instructions were fixed before dispatch. Required external inputs and design must be settled, but planned predecessor artifacts need not exist before the whole workflow begins. Do not add dependency fields, and do not force every dependency into a separate run; custom graph dependencies belong to [the existing graph format](flow-format.md) and are authored by the allowlisted designer, not invented here.
- No new flow, option, or template is introduced. `ready` and `design-needed` are not new schema fields or runtime status values; ordinary prose in `task.context` or a unit prompt may mention them.

## 6. Conditional pilot

Pilot a repeated task only when its procedure is unproven: the steps are new, the project has no known entry point, or the same coordination keeps recurring without evidence. Do not require a pilot for cheap, known, one-off procedures, and do not add ceremony to trivial work.

- Reuse ordinary direct execution or an approved existing flow; the pilot introduces no new runner.
- Keep the pilot to one real, isolated representative unit (a synthetic unit is also acceptable); compare its observed result against that unit's acceptance and whether the procedure can scale, not against whole-system completion.
- The runtime graph is frozen at admission; there is no runtime mutation and no mid-run unit injection.
- An altered graph requires a new validated run with its own admission. Preserve the previous run and inspect it before running again.
- A workflow still requires an explicit human workflow or large-orchestration request; this guide does not authorize one.

## Synthetic example

This example is invented for illustration and is not taken from any real run. Request: "Add a row-count summary to the synthetic `csvtool` sample." Whole-system goal: running the sample tool over a sample file prints the number of data rows. Candidates: count function, CLI flag, documentation, packaging.

| Candidate | Layer | State | Note |
|---|---|---|---|
| `count_rows(path)` | parsing | ready | input, output, and checks fixed below |
| `--rows` flag | CLI | design-needed | flag name and printed format are undecided |
| README section | docs | design-needed | waits for the CLI decision |
| packaging | release | deferred | unrelated to this request's acceptance |

Ready packet for `count_rows`:

- Parent goal: the sample tool prints a correct row count for a supplied sample file.
- Inputs: `samples/tiny.csv`, whose exact content is the three lines `name,count`, `alpha,1`, `beta,2`, and the existing `src/count.py`.
- Exclusive scope: `src/count.py` only.
- Output: a `count_rows(path)` function returning the number of data rows.
- Resolved decisions: a data row is a non-empty line after the first header line; a header-only file counts `0`; blank lines are ignored; a missing path raises `FileNotFoundError`.
- Acceptance: the synthetic project check `uv run bin/check.py samples/tiny.csv` prints `2`; a header-only sample prints `0`; a missing path raises `FileNotFoundError`.
- Exclusions: no CLI, packaging, or README change; no new dependency.
- Escalation: if a sample uses a delimiter other than `,`, report it and stop instead of guessing.

Only this unit is dispatched. The `--rows` and README candidates stay design-needed until the flag decision is made and their own packets are ready.
