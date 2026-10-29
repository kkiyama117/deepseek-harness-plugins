# Review rounds and evidence

A first review judges the initial artifact. A re-review judges the repaired artifact against the task criteria and earlier findings. A prior observation of a defect is evidence of the earlier state, not a requirement to reproduce that state after repair. [Acceptance evidence](acceptance-evidence.md) owns final criterion reporting.

## Preset review inputs

The `lead-workers` and `coordinator-advisor` presets distinguish initial review from numbered re-review in their instructions. An initial review receives its integration result. A re-review receives the latest repair result and all earlier review results in that review chain as direct dependencies. The latest repair must report `done`; each earlier review must have requested changes. These conditions use the existing graph fields and preserve the configured call and repair limits.

The reviewer inspects the current artifact for current behavior and uses the supplied earlier review records for historical findings. A repairer's summary does not replace the original reviewer record. An early passing review skips remaining repair branches; a blocked or malformed result still stops admission. This does not give models a new result status, an unbounded transcript history, or permission to repeat external actions.

## Design choice and limits

Native repair testing exposed a re-review that interpreted itself as the first review after the seed defect had already been repaired. Identical review instructions and a dependency containing only the repairer's output left the original finding indirect. Explicit review duties and ordinary graph dependencies keep the stage and its evidence together without a history database or a second execution mechanism.

Only review-chain records are added, not every ancestor's transcript. Their size is bounded by the configured number of repair rounds and the returned summaries. A custom graph remains responsible for declaring its own dependencies. More context does not guarantee correct model judgment; keyless expected-output checks verify the transmitted instructions and records, while native checks separately test model behavior. [Verification record](verification.md) owns measured results and remaining gaps.
