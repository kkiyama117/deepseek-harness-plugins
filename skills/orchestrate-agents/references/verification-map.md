# Verification entry points

Use the existing checks below to verify this skill's authored files, compiler and runner. This index does not replace test assertions or track every test name. Run commands from the skill directory. [Verification record](verification.md) owns observed results and native-integration limits; [acceptance evidence](acceptance-evidence.md) defines how to report them.

## Authored files

Run `uv run bin/check-files.py`. The [checker](../bin/check-files.py) checks UTF-8 text, trailing whitespace and newlines, JSON and Python syntax, and Markdown relative file links and fence counts. Success does not establish prose meaning, heading-anchor validity or agent adherence.

## Offline compilation and execution

Run `node --test tests/*.test.mjs` for this small skill-local suite. These tests create temporary artifacts and own their cleanup; do not delete unrelated run directories.

| Behavior | Owning test | Observable result and limitation |
|---|---|---|
| Request and policy compilation | [compiler tests](../tests/compiler.test.mjs) | Equal input produces equal payload/hash; task strings remain data; unsupported fields fail. |
| Compiled payload execution | [compiler tests](../tests/compiler.test.mjs) | Generated JavaScript executes with the documented fake hook and passes assertions. This is not a native model run. |
| Private output and overwrite refusal | [compiler tests](../tests/compiler.test.mjs) | Saved artifacts match the compiled payload; a second write is rejected; supported hosts check private modes. |
| All four flow structures, advice and bounded repairs | [runtime tests](../tests/runtime.test.mjs) | Synthetic outcomes take expected branches and preserve acceptance ordering. |
| Parallel admission, writer declarations and failures | [runtime tests](../tests/runtime.test.mjs) | Assertions cover fixed-wave limits, ordering, scope conflicts and failed/null/malformed results. Scope declarations are not filesystem isolation. |
| Discovery installation and preservation | [installation test](../tests/install.test.mjs) | A temporary-home test checks backups and repeated installation. This does not authorize installing into the live home. |
| Initial review, re-review and prior findings | [review-context tests](../tests/review-context.test.mjs) | Compiled payload checks pin the transmitted instructions and prior reviewer records across bounded repair rounds. |
| Evidence-aware synthesis and compact handoff | [synthesis tests](../tests/synthesis.test.mjs) | Generated payload requests projection, retains full reports and exposes acceptance/blocker evidence without an extra agent. Synthetic size checks are not cost or quality benchmarks; Host tests own actual storage and rendering. |
| Skill instruction entry | [skill-entry test](../tests/skill-entry.test.mjs) | Owner-local expected output pins the body excluding frontmatter. It does not replay a DSH session or establish model adherence. |

## Native DSH execution

Follow [compile and run](run-dsh.md) only after an explicit human workflow or large-orchestration request. The offline suite cannot prove native model behavior, real overlapping execution, host cancellation or effective backend identity.

Before a native check, define its acceptance criteria, requested roles and call cap, exact writable temporary paths, and expected external artifacts. Compile the packet unchanged through the existing entry point. Keep the native result with its input; independently inspect the artifacts rather than accept the result's `completed` label.

A useful isolated check exercises two independently owned worker artifacts, parent integration, and a read-only review. A repair check must contain an observable seeded defect or missing acceptance artifact; a reviewer must not claim to have found a defect merely to force a branch. A coordinator/advisor check must name the actual question the advisor answers. Record branches actually observed, not those merely enabled by the packet.

Preserve evidence after cleanup. Stop only resources started by the check; do not create another server, change the live GUI, publish branches or reuse a failed run automatically. The absence of a native check is a reported coverage gap, not a passed offline equivalent.
