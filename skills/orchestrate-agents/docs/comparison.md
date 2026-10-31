# `comparison` flow

A fixed three-arm read-only experiment: Flash alone, Astra alone, and Flash with conditional Astra advice, on the same fixture and the same task text. The graph is code-owned; the quality judgement is not.

## Applicability

- You want a reproducible comparison of single-model versus conditional-advice operation, not a benchmark claim.
- The task can be answered read-only from a fixed fixture. Writable implementation tasks are rejected in this version.
- Ordinary work with no comparison request belongs to [direct](direct.md) or [single](single.md).

This compares operating modes as well as models: each arm receives role prompts appropriate to its mode, so a difference is not attributable to the model alone.

## Required inputs and preconditions

- Request fields `version: 1`, `flow: "comparison"`, `task`, `fixtureId`, `order`. `order` must be a permutation of `flash`, `astra`, `flash-advisor`; `task.writeScope` must be `[]`; `fixtureId` identifies the fixture revision and does not itself verify fixture identity. See [the example](../examples/comparison.json).
- Policy roles exactly `flash` and `astra` as discovered `{provider, model}` pairs, with limits covering the five-call worst case (three arms, plus advice and continuation). See [the example policy](../examples/comparison-policy.json).
- A fixture frozen before the run. Do not let arms read volatile sources such as live Slack or web pages; equalize tools, visible profile data and retrieval availability across arms.

## Steps

1. Freeze the fixture material and record how its identity is established.
2. Compile: `node bin/compile.mjs examples/comparison.json examples/comparison-policy.json /ABSOLUTE/PRIVATE/new-comparison`. Compilation calls no model.
3. Submit the compiled payload unchanged to native `workflow` after an explicit workflow request; the arms run in the declared order and no arm's answer is given to another arm.
4. Record the complete result: per-arm records, advice content and call counts. Keep the retrieval reference for the saved result.
5. Evaluate separately with a fixed rubric or deterministic tests, then join observed timing, token and cost data if the host provides it.

## Outputs and acceptance

- The runner status is `awaiting-evaluation`. It is not a pass/fail verdict, and a child `done` is not a quality result.
- Each arm's `measurements` start as `null` (unknown, not zero) with `independentAcceptance: "pending"`. Fill them only from actual observations, joined to run and child-session identity.
- Do not exclude failed arms or runs where advice never triggered. Re-run with shuffled `order` to check order effects; automatic repetition is out of scope for this version.

## Failure and repair

- A host exception or cancellation aborts the experiment. A normal `blocked`, null or malformed arm result is that arm's failure and the other arms still run.
- A blocked advice result stops that arm's continuation; it never silently falls back to another route.
- There is no repair loop and no model judge. Choosing a winner is a human decision made from the evaluation record.

## Limits

- The runner guarantees branch structure, arm order, the single-advice limit, prompt separation and the pre-validated call maximum; see [README runtime limits](../README.md).
- It does not enforce child tool-call counts, money, time, recursive-delegation refusal, filesystem permissions or effective model identity. Read-only scopes are instructions, not sandbox isolation.
- Shared files remain readable across arms even though no arm's answer is passed into another arm's prompt; prompt separation is not filesystem isolation.
- Do not describe this as unattended, cost-capped operation until the relevant host controls are confirmed.

## Related references

- [Comparison protocol](../references/comparison.md) — the original protocol note, including evaluation-recording detail.
- [Compile and run on DSH](../references/run-dsh.md) — submission and artifact handling.
