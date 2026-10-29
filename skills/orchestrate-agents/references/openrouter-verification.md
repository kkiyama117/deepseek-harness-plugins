# OpenRouter Jev verification

## Scope

The live smoke submits only a synthetic translation-stage description to the Decisions API. It never sends the development conversation or project source and never executes a workflow. This is one-case connectivity and response-validation evidence, not a task-routing accuracy benchmark.

## Observations

Two live requests were made while adding this transport. The first ended with a generic routing fallback; no normalized response or cost was retained. It was not reported as successful. The generic diagnostic did not establish its exact cause. The [public endpoint information](https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints) identifies the dated version behind the requested model slug; the implementation now checks that exact mapping and reports specific response-validation failures.

The second request passed:

| Observation | Value |
|---|---|
| Endpoint | `https://openrouter.ai/api/alpha/decisions` |
| Requested model | `typesafe/jev-1.13` |
| Returned model | `typesafe/jev-1.13-20260917` |
| Returned provider | `TypeSafe` |
| Request ID | `gen-dec-1789726960-0bpl8AQYPDZQtMrSVqol` |
| Routing result | `shadow`, F1, R8 |
| Readiness | `ready`; probability 1, confidence 1 |
| Usage | 637 input tokens, 50 output tokens |
| Reported cost for the successful request | USD 0.000026754 |
| Smoke elapsed time | 561 ms, including local recording and cache verification |
| Cache reuse with external sending disabled | Passed; no second network call |
| Executable workflow / submitted | false / false |

The cost above is not the total for both attempts; the first attempt's cost is unknown. Probability 1 on this simple case is not a general accuracy guarantee.

Private receipts from this check are in `/home/kiyama/.local/state/orchestrate-agents/openrouter-checks/verified-model-pin/`: `request.json`, `api-receipt.json`, `report.json`, `cached-report.json`, and `summary.json`. They contain synthetic data only and are not source-controlled. The preceding failed report is under `7f2f1d959a6848daaba51b19353c068b/` in the same parent directory. These local paths are evidence locations for this execution, not portable prerequisites.

## Latest-alias check

A subsequent one-request smoke used the documented [latest alias](https://openrouter.ai/api/v1/models/~typesafe/jev-latest/endpoints) against the same synthetic input:

| Observation | Value |
|---|---|
| Requested model | `~typesafe/jev-latest` |
| Returned model / provider | `typesafe/jev-1.13-20260917` / `TypeSafe` |
| Request ID | `gen-dec-1789727627-ZP4qRxIlbbJWmhjZFG7H` |
| Result | `shadow`, F1, readiness=`ready`, probability/confidence 1 |
| Usage / reported cost | 637 input, 50 output tokens / USD 0.000026754 |
| Smoke elapsed | 904 ms, including local recording and cache-policy verification |
| Cache policy | `no-reuse-for-latest` |
| With external sending disabled | Refused to reuse the old result; no additional network request |
| Workflow execution | None |

Receipts are in `/home/kiyama/.local/state/orchestrate-agents/openrouter-checks/verified-latest-alias/`. This establishes that the alias worked for this request, not that its future targets will behave identically. Mock tests cover a change to another dated Jev version, continued usage accounting, and rejection of unresolved aliases or other providers in responses.

## Repeat the check

Follow the [Japanese routing guide](jev-routing.ja.md). `bin/smoke-openrouter.mjs --live` makes at most one new network call per invocation and performs its cache check without network. Each invocation requires a new private output directory. Its sanitized gateway receipt helps diagnose model/answer validation failures without exposing the credential. Do not repeat a failed request blindly.

The optional Python launcher reads only a literal OpenRouter-key assignment from an explicitly supplied owner-only file; it does not execute shell configuration. Neither launcher discovers other credential stores.

## Limits

The transport is alpha. The versioned model selection retains its exact canonical mapping. Explicit latest selection instead requires a resolved dated Jev model from TypeSafe and does not reuse classifications. Missing probabilities or confidence remain a fallback even though the gateway schema makes those fields optional. Latest selection does not require editing a day-specific model mapping, but also does not preserve a calibrated model version. No calibration thresholds, multilingual accuracy, large-input behavior, latency distribution, or monetary saving were established by this smoke. TypeSafe direct-endpoint live behavior remains untested here.
