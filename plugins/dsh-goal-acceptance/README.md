---
description: "Opt-in original-request retention, lesson decision records, and evidence checks for Goal completion and initial delegation prompts."
kind: "package-bundle"
---

# @kkiyama117/dsh-goal-acceptance

English | [中文](README.zh.md)

## Summary

Keep human quotations separate from inferred targets, examples, execution environments, and retrieved material. Record acceptance conditions before design, delegation, failure repair, and completion. The plugin rejects missing citations, removal of retained acceptance conditions, unsupported target promotion, and Goal completion without outcome observations. It carries the retained request into initial child prompts without an evaluation model. These checks enforce record consistency, not semantic truth.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install this opt-in bundle through Plugin Manager. Its patch disables the official `goal` and `subagent` rows and inserts `acceptance-goal-provider` and `acceptance-subagent-provider`. The upstream service classes remain unchanged. The policy requires these providers, tools, system prompt, Session projection, and asynchronous Session query services. The following patch configures the installed policy row.

```yaml
- id: goal-acceptance
  config:
    maxRecordBytes: 16384
    sessionIds: [session-example]
```

| Field | Default | Meaning |
|---|---|---|
| `maxRecordBytes` | `16384` | Maximum UTF-8 bytes of the complete accepted checkpoint, including its Goal identity; excess fails without truncation |
| `sessionIds` | `all` | Exact participating Session ids; an empty list selects none. Use an explicit list for a shared-Host pilot |

Copy any non-default Goal/subagent configuration to the replacement row ids; configuration on disabled rows is not inherited. The deployed pilot wrapper retains `maxDepth: 2` and its exact Session id list. Do not also select this standalone all-session policy when using that wrapper. A Loader patch cannot rename a row by setting `name`.

Call `request_check` without a checkpoint to read the retained request, latest human event sequence, missing items, and staleness. Supply a checkpoint to record human quotations, acceptance items, target origin, observations, and lesson decisions. Source citations resolve against the owning Session, not external files or another Session. A successful `kura_read` citation links the record to a logged invocation; it does not certify the returned memory's existence or completeness. The model records which decision changed or why the lesson was not applied. Memory bodies are not injected.

A scope-restricting target requires a cited direct human message containing its value. A value already recorded as non-human requires later human confirmation before promotion. Routine reversible supplementation and non-restricting inferred targets need no confirmation. This validation cannot decide whether a human mention actually designates a target.

For a retained Goal, checkpoints cannot replace the original request or remove or rewrite existing acceptance items. Add new items rather than narrow the old ones. Each item keeps its human source sequence, including intermediate messages. A direct human message, Goal objective edit, or failed tool result makes the checkpoint stale. A fresh checkpoint acknowledges the latest human sequence; interpreting new instructions remains the model's responsibility. Routine status reads do not clear staleness.

Completion requires a current `complete` checkpoint bound to the exact Goal id and objective. Every item must be `satisfied` or `negative` and cite an `outcome` observation in an existing successful tool result. `not-applicable`, `missing`, pending work, and mechanical evidence alone remain incomplete. Negative observations can satisfy acceptance; shell exit zero and child-reported completion are not independently certified outcomes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Accepted checkpoints live in existing native `tool/result` metadata or nested `tool/ptc-dispatch` result content. The projection accepts only a matching checkpoint-write call, argument digest, and latest reviewed human sequence. A design checkpoint without a Goal survives subsequent Goal creation; completion, clear, or replacement of an existing Goal starts a new acceptance record. A completed no-Goal checkpoint can also start a new record after a later human request. Citation validation reads exact events asynchronously, not the full log. The host-only Session projection folds committed records incrementally, independently of the active model-history surface. Restore, fork, and surface compaction therefore retain checkpoints without a shared process-wide readiness flag. The external Goal provider checks completion before invoking the upstream mutation, including direct and Remote callers. The external subagent provider appends a bounded original-request capsule to initial one-shot and continuable prompts; child settlement does not update parent acceptance.

Activation awaits the retained projection handle before publishing tools or policies. Projection initialization failure leaves those operations unpublished; state reads use the retained handle.

| File | Role |
|---|---|
| [src/index.ts](src/index.ts) | Tool, projection, completion policy, and initial delegation context |
| [src/check.ts](src/check.ts) | Quotation, origin, retained-item, and evidence checks |
| [src/schema.ts](src/schema.ts) | Bounded checkpoint and replay validation |
| [src/goal-provider.ts](src/goal-provider.ts) | Upstream Goal subclass and completion policy registration |
| [src/subagent-provider.ts](src/subagent-provider.ts) | Upstream subagent subclass and initial context registration |
| [bin/audit-session.py](bin/audit-session.py) | Read-only route and bounded incident extraction; excludes provider replay data and raw exports |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Goal subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/goal.md) — Goal operations and lifecycle.
- [Goal provider](src/goal-provider.ts) — external completion policy registration.
- [Subagent provider](src/subagent-provider.ts) — initial prompt context and child lifecycle.
- [Session projection service](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-projection/README.md) — incremental replay and checkpoint ownership.

-----

<a id="model-experience"></a>
## Model Experience

### Checkpoint tool schema

#### What the model sees

The [request_check declaration](src/index.ts) and JSON results containing the retained record, missing item ids, staleness, and a bounded latest-human excerpt.

#### Token effect

Opt-in mounting adds one stable tool schema; checkpoint calls append bounded results. Reading status also returns the current record without changing acceptance.

#### KV Cache effect

The schema remains unchanged between ordinary steps. Mounting or unmounting changes the available tool set; result history follows normal append and compaction behavior.

### Checkpoint guidance and retained request

#### What the model sees

The following guidance plus, after an accepted checkpoint, a capsule containing the original quotation, item ids, human quotations, model-authored acceptance text, and target classifications.

##### Verbatim guidance

```markdown
Use request_check before detailed design, delegation, repair after failure, and completion. Keep original human quotations and acceptance items; label targets as human, inferred, example, environment, material, or unresolved. Routine reversible details need no human confirmation. A scope restriction needs a human-specified target. Record outcome observations separately from process/test/tool success, and connect each retrieved lesson to a changed decision or explain non-application. A child reporting done is not parent acceptance. Before claiming completion, record a complete checkpoint with outcome evidence for every item. request_check validates citations and retained conditions, not the truth or semantic relevance of model judgments.
```

#### Token effect

Opt-in mounting adds the fixed guidance. Accepted checkpoints and their bounded capsules add data-dependent tokens. Unchanged ordinary steps do not append reminders or memory bodies. The plugin makes no model calls; required checkpoints or rejected premature completion can require additional task steps.

#### KV Cache effect

Unchanged guidance and capsules preserve their text. Checkpoint updates change the system contribution and may affect prefix reuse according to the selected provider's prompt capabilities. Tool results remain append-only history until normal compaction.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These checks limit recorded inconsistencies, not model judgment.

- The model chooses the first acceptance items and classifies origins and evidence. Exact quotations and retained ids do not establish completeness, authority, factual truth, or semantic relevance. A misleading `outcome` annotation can pass.
- Design and repair checkpoints are guidance, not interception of every file edit. Goal completion and initial delegation are enforced; arbitrary final prose without Goal completion is not rewritten or withheld.
- A persona with `complete: true` intentionally suppresses other system-prompt sections, including this guidance and the parent capsule. Completion checks, tool registration, and initial delegation validation still run. Use a normally composed prompt when the guidance is required.
- With `sessionIds: all`, Host mounting applies this policy to every Goal in that composition, including existing Sessions. An explicit id list confines completion checks, delegation context, guidance, and tool visibility to those Sessions; children and forks are not automatically selected. An empty list is inert. Unload removes scoped tools. Existing Goal history is not migrated. Opt-in completion of an old Goal needs a new checkpoint quoting its retained direct human source.
- Initial child prompts receive the parent capsule; later child messages and recursive children without a checkpoint do not automatically receive updated parent acceptance. External providers must honor their logged prompt-delivery obligation.
- The plugin does not select models, retry, meter cost, expand budgets, or certify provider-internal routing. Harness request headers and assistant sources are observable records, not provider-internal guarantees.
- A trusted plugin can forge tool-result metadata. Unloading this opt-in policy removes completion checks; it is not a security sandbox.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
