# Acceptance evidence

How the parent decides whether a user task is actually complete. This is a reporting convention, not a runtime format: a runner model result stays exactly `{status, summary, evidence}` with the statuses in [flow-format.md](flow-format.md). `pass`, `fail`, `not-run` and `blocked` below are check-level labels used in prose, tables or a receipt; they are not new runtime statuses and add no schema field.

## Required record per criterion

Cover every criterion in `task.acceptance` ([task-packet.md](task-packet.md)). A small task can use a concise sentence; use a table or receipt when it makes coverage easier to inspect. Each record identifies:

1. **Criterion** — the required condition, quoted or restated exactly.
2. **Target identity** — the artifact, source revision or environment the criterion applies to.
3. **Check** — the concrete command, inspection or measurement performed.
4. **Observation** — what was actually seen, not what was expected.
5. **Result** — `pass`, `fail`, `not-run` or `blocked`.
6. **Evidence pointer** — where the raw observation is preserved.

A criterion without recorded evidence is uncovered, not passed.

## Target identity

Record only the facts the check depends on; do not pad every row with a revision.

- Source change: the identity needed to locate what was checked. A clean committed tree can use the commit SHA; a dirty tree should reference the relevant patch or content identity for the paths in scope (a diff/patch hash, or a content hash of the changed files), because a SHA alone does not identify uncommitted changes and a clean/dirty label does not identify their contents. Provide a comparable revision identity only when the criterion depends on comparing revisions.
- Built artifact: the artifact path, plus a content hash only when it is needed to distinguish which artifact the check used. A test that consumes bytes does not by itself require hashing every file it reads.
- Running service or process: how to identify the instance actually serving (image, version or hash), not only what was built or requested.
- Read-only research: name the sources used and their date or version when the answer is time-sensitive. No git SHA or build is required for read-only work.
- Environment: OS, runtime or tool versions only when the check's outcome depends on them.

Requested model routes are not observed backend identity ([run-dsh.md](run-dsh.md)); do not present a requested route as an observed one.

## Re-evaluation after a change

When a target changes, re-run only the checks that change can affect. Unrelated checks that already passed keep their earlier observation and evidence pointer; they are not automatically invalidated and need not be repeated. State which criteria were re-evaluated and which carried over. A carried-over check references the target identity it was run against, not the new one.

## Independence

The parent inspects the actual artifacts and raw evidence: open the file, read the receipt, re-run the check or observe the running artifact. A model-written table, a `done` summary or a runner-level `completed` is a claim, not independent proof ([../README.md](../README.md)).

Distinguish a worker's narrative from raw tool and artifact observations. A summary or self-assessment stays a claim; captured command output, an exit status, a log, a diff or an artifact the parent can open is inspectable evidence regardless of which agent produced it. The parent need not rerun every check or add a verifier agent, and a check is not downgraded merely because a worker ran it.

## Evidence pointers and retention

Describe evidence through the existing `evidence: string[]` result field: name a receipt, log or artifact path, or state the observation directly. The compiler only transports these strings; it does not parse, validate or enforce their content, and a listed path is not proof by itself.

- Keep pointers concrete enough to reopen, and keep the underlying files until acceptance is decided. Preserve evidence through cleanup; do not delete the receipt, log or artifact a claim depends on.
- Never place credentials, tokens or raw private messages in evidence. Reference a redacted receipt instead.

## Blockers and acceptance

- Any required criterion recorded as `fail`, `not-run` or `blocked` prevents user-task acceptance. Report the task as partial or blocked with the specific criterion, not as done.
- A missing essential check — no way to establish a required criterion — is itself a blocker.
- Do not automatically replay a failed run or uncertain side effects. Inspect the current state before deciding what may safely run again. Performing a missing authorized check is not replaying the whole workflow.
- Acceptance means every required criterion passed against an identified target and the parent independently inspected the artifacts. Nothing here adds runtime statuses, services, mandatory repeat-all checks or extra agents.

## Synthetic example

Explicitly synthetic: the task, paths and outputs below are invented to show the record format. No execution is claimed.

| Criterion | Target identity | Check | Observation | Result | Evidence pointer |
|---|---|---|---|---|---|
| New flag rejects an unknown combination | `bin/tool.py` at synthetic patch `sha256:1111…` | `uv run pytest tests/test_flags.py` | 1 passed | pass | `receipt.md` in the run dir |
| Help text lists the new flag | built `--help` output | `tool --help` inspected | flag absent from output | fail | captured `help.txt` |
| Install path still works | packaged artifact | end-to-end install run | not executed | not-run | none |

The `not-run` row is not a pass: it has no observation and no evidence pointer, so acceptance stays open. The `fail` row likewise blocks acceptance until the help text is fixed and re-checked; the passing flag test does not cover it.
