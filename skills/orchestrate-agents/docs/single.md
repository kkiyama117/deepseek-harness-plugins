# `single` flow

One fresh executor performs the task and its checks, under a validated runner graph. Use it when reproducibility matters: the same request and policy must compile to the same tool input.

## Applicability

- A reproducible workflow was explicitly requested (workflow/large-orchestration opt-in), and the task fits one isolated context.
- The owner does not need to be this conversation; a self-contained packet plus the acceptance checks is sufficient.
- Model choice is a role binding under the deployment policy, not a separate flow. There is no `expert-single` flow.

Use [direct](direct.md) when no workflow was requested; the runner adds compile/submit overhead without demonstrated benefit for routine work.

## Required inputs and preconditions

- Request with `flow: "single"`, an ordinary `task` object (`originalRequest`, `goal`, `context`, `acceptance`, `constraints`, `writeScope`), `units: []`, `batches: []`, and `options: {concurrency, repairRounds: 0}`. See [policy and graph formats](../references/flow-format.md) and [the example](../examples/single.json).
- Deployment policy with a `roles.executor` provider/model route discovered in the active harness, plus limits covering the single call.
- An explicit human workflow request and, when submission matters, a live `workflow` tool that accepts `resultKeys`.

## Steps

1. Discover routes (`list_subagent_models` in DSH) and write the policy separately from the task.
2. Compile with the offline generator into a new private directory: `node bin/compile.mjs REQUEST.json POLICY.json /ABSOLUTE/PRIVATE/new-run`. See [compile and run on DSH](../references/run-dsh.md).
3. Submit the compiled object's exact `meta`, `script`, `args` and `resultKeys` to native `workflow`. Do not rewrite the runner, interpolate task text into script, or drop `resultKeys`.
4. Read the compact result (`status`, `callsStarted`, `summary`) and retain the Host's full-record reference. Retrieve full-record details only when acceptance needs them; inspect the actual artifacts rather than trusting the label.

## Outputs and acceptance

- Graph result `completed` requires the `execute` node's `done` and no blocked node. `blocked` or `needs-review` otherwise.
- `completed` is graph-level evidence, not proof the human objective is correct. Re-check each criterion yourself with [acceptance evidence](../references/acceptance-evidence.md).
- Report requested routes separately from any independently observed runtime identity.

## Failure and repair

- `single` has no repair rounds; `repairRounds` must be `0`. A `blocked` or malformed child result stops the run.
- A null result, invalid output or runtime failure is not a partial success. Inspect the artifacts before any new run; do not replay uncertain effects.
- A changed task or scope needs a new validated run with a new compiled directory; the compiler refuses to overwrite.

## Related references

- [Policy, graphs and results](../references/flow-format.md) — field contract, limits and outcomes.
- [Compile and run on DSH](../references/run-dsh.md) — artifact generation, submission fields, limits.
- [README runtime limits](../README.md) — what this adapter does and does not guarantee.
