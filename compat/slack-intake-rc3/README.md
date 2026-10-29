---
description: "Connect a DSH profile to the Go aistore CLI and execute one claimed reader or reviewer task through a fixed native Agent route."
kind: "package-bundle"
---

# @kkiyama117/dsh-slack-intake

## Summary

This package provides two separate DSH entries for the Go `aistore` CLI. The bundle patch mounts a standalone command adapter with local `OPENROUTER_API_KEY` credential access. The `./agent` entry registers `aistore_native_task` in an Agent scope and runs one claimed reader or reviewer task through an explicitly selected native subagent provider. Both entries require absolute paths to the `aistore` executable and store; legacy Python and `skillRoot` configuration is rejected.

This local.3 package requires the native executor, batch tool execution, and AgentModel APIs of the master commit recorded in `UPGRADE.json`; the older rc.3 release tag has the same version string but not those APIs. Verification Sessions select their configured route before admission and reject route changes. The configured step/command limits, startup readiness, durable claims, and unknown-outcome handling remain unchanged.

## Table of Contents

- [Use the standalone adapter](#use-the-standalone-adapter)
- [Mount the native Agent entry](#mount-the-native-agent-entry)
- [Security and lifecycle](#security-and-lifecycle)
- [Verification](#verification)
- [Known limitations](#known-limitations)

-----

## Use the standalone adapter

The package declares `cordis.patch.yml` as its DSH bundle patch. The patch inserts `@deepseek-ai/dsh-credentials-local` and the standalone package entry. Set both non-secret variables to trusted absolute paths before launching the profile:

```sh
export DSH_AISTORE_EXECUTABLE=/absolute/path/aistore
export DSH_AISTORE_STORE_ROOT=/absolute/path/store
```

The deployment owner may instead override the two fields in a later profile patch:

```yaml
- id: aistore-adapter
  config:
    aistoreExecutable: /absolute/path/aistore
    storeRoot: /absolute/path/store
```

The standalone entry accepts these adapter-owned credential commands:

```sh
dsh --profile <standalone-profile> credential status
dsh --profile <standalone-profile> credential import --file /absolute/private/key
```

Every other argument sequence is passed after the fixed global arguments `--store STORE --json`. These examples match the current Go grammar:

```sh
dsh --profile <standalone-profile> verify
dsh --profile <standalone-profile> intake resume --run run:20260923-01
dsh --profile <standalone-profile> intake resume --run run:20260923-01 --allow-network
```

Only the exact `intake resume ... --allow-network` operation resolves `OPENROUTER_API_KEY`. Exit code `0` means completion, and exit code `3` preserves a Go handoff. Other exits become fixed adapter diagnostics. This package does not expose a package binary; profile installation and activation remain deployment-owner operations and were not run during offline verification.

-----

## Mount the native Agent entry

Mount `@kkiyama117/dsh-slack-intake/agent` in an authored Agent preset that already consumes the host `tools`, `subagents`, and `sessionQuery` services. Do not mount it in the standalone authentication profile: that profile has no calling Agent. A preset row has this configuration:

```yaml
- id: aistore-native-task
  name: '@kkiyama117/dsh-slack-intake/agent'
  config:
    aistoreExecutable: /absolute/path/aistore
    storeRoot: /absolute/path/store
    subagentProvider: spawn
```

The configured provider must support `agentOptions`, `outputSchema`, and `agentPreset`; the in-process `spawn` provider supports all three. Install `@local/dsh-aistore-native-preset` in every calling profile. The adapter selects its `aistore-native` preset, which excludes global tools and provides no task tools; the runtime adds only `structured_output`. A missing preset rejects creation instead of inheriting parent tools. The tool must be invoked by the DSH Agent loop so `exec.agent` identifies the real parent Agent.

The tool accepts only `taskId` and `inputHash` from an aistore handoff. It performs this sequence once:

1. `task claim --id TASK --input HASH`
2. save the private claim in an owner-only temporary file
3. `task in-flight --receipt CLAIM`
4. `intake native packet --task TASK`
5. run one native child with the packet's fixed provider, model, reasoning effort, token limit, and deadline
6. verify the recorded request route, model source, session, completed turn, and exact structured-output bytes
7. `intake native accept --task TASK --attempt N --receipt RECEIPT`

A Reader result must contain each packet identity exactly once. Its status is either `ready`, with stored-source references and verbatim anchors, or `insufficient`, with a reason. The adapter validates this structured output before receipt creation; it does not translate unknown statuses such as `verified`.

A failure after the in-flight transition calls bounded `task unknown` once. The adapter does not claim or execute the task again, and it never selects another model or provider.

-----

## Security and lifecycle

The standalone subprocess receives a new environment containing only `LANG=C.UTF-8` and the credential needed for its operation: `SLACK_BOT_TOKEN` for `intake slack collect`, or `OPENROUTER_API_KEY` for an allowed network resume. The value is absent from argv, configuration, returned JSON, and diagnostics. Credential import accepts only an absolute owner-only regular file in an owner-only real parent directory and verifies the stored value without printing it.

Every aistore subprocess uses an argv array with no shell, ignored stdin, an 8,000,000-byte stdout limit, and a 1,024-byte stderr inspection limit. For Slack collection failures, only an exact allowlisted condition becomes an `AISTORE_SLACK_*` diagnostic; raw stderr, unknown conditions, oversized diagnostics and credential-bearing text are never exposed. Successful output must be one protocol-version-1 JSON envelope. The native claim and authority data stay outside the child prompt and tool output. Only the Go-produced native packet becomes model-visible.

The native entry uses `startActivation` with caller delivery, enforces the packet deadline, and awaits the result and `dispose()` before returning. The admission signal covers startup; after publication, cancellation disposes that exact activation. It reads the settled child's durable Session through `sessionQuery.readSession`, verifies the child id, and builds its receipt from recorded request and assistant events rather than a model's route claim. `reported_cost` is `null` because the current DSH session events do not expose a monetary cost for this run.

-----

## Verification

Run the package's offline suite against the built host named explicitly by `DSH_HOST_ROOT`. Supplying both Go binaries also enables the disposable-store integration smoke:

```sh
out=$(mktemp -d)
CGO_ENABLED=0 go -C /absolute/path/to/ai-store-go build -trimpath -o "$out/aistore" ./cmd/aistore
CGO_ENABLED=0 go -C /absolute/path/to/ai-store-go build -trimpath -o "$out/aistore-test-fixture" ./cmd/aistore-test-fixture
DSH_HOST_ROOT=/data/softwares/deepseek-harness-master \
  AISTORE_BINARY="$out/aistore" \
  AISTORE_FIXTURE_BINARY="$out/aistore-test-fixture" \
  npm test
```

The suite uses synthetic credentials and temporary files only. It starts real local child processes, preserves exit-code-3 handoffs, exercises the current built DSH tool registry, creates a real parent Agent as `exec.agent`, starts a real in-process managed activation through `spawn`, and uses a scripted local LLM adapter to produce structured output. With the two binary variables set, it creates a schema-7 disposable store and drives real Go claim, in-flight, packet, native accept, deadline, cancellation, and unknown-task rejection paths. It does not contact Slack, OpenRouter, or another network service.

-----

## Daily application

The `./daily` Host entry runs a deterministic driver over the existing Go/native entries. Launch it through an installed profile with the base Host registries, one explicitly selected minimal preset, pinned model routes, and the standalone adapter rows disabled. It exposes `daily run`, read-only `daily status`, and `daily check` (mount validation and a disposable real parent Session, with zero model turns). DSH 0.2.1 profiles use `@deepseek-ai/dsh-agent-preset-registry` and a bundle-carried `@deepseek-ai/dsh-agent-preset` declaration; the daily entry resolves the preset and rejects its activation diagnostic before claiming work.

On Linux, `daily-start.sh WAIT_SECONDS MOUNT STORE NODE CLI [CLI_ARGS...]` waits for the mount, store directory, executable Node, and readable official CLI before changing directory and executing the CLI. Install this launcher on an already available filesystem and set the systemd service's initial working directory there; an unavailable `WorkingDirectory` fails before an `ExecStartPre` can wait. Readiness expiry exits 75 without starting intake. The service's overall timeout also bounds this wait.

The driver freezes a Slack window and resumes unfinished batches before creating another. Go commits the export association and collection checkpoint together, fixes one run ID, and enforces campaign-wide native/classifier budgets inside the claim transaction. The driver holds a separate Go-backed filesystem lock until all children and reporting work have stopped. Losing the driver closes the lock child's stdin; cancellation alone does not release ownership early.

Reader articles receive a fresh-context `content_review` task, with the article hashes and the Reader's saved public source bodies. The review must cover every article exactly once with `approve`, `reject`, or `insufficient` and a concrete reason. Only accepted approvals reach Jev; quote matching is not a semantic approval. A second call to the same model can share its errors and is not proof of factual correctness.

Configure all deployment paths (`aistoreExecutable`, `storeRoot`, `intakeConfig`, `reportsRoot`, `backupsRoot`, `notifyExecutable`), `presetId`, an explicit idle `parentRoute`, and positive `deadlineSeconds`, `cleanupSeconds`, `notificationSeconds`, `exitGraceSeconds`, and `maxTransitions`. The parent is never prompted; it owns the native tool calls. The daily parent allows only `aistore_native_task`; its children allow only their scoped structured-output tool. Disable title-generation and automatic LLM retries in this profile so they cannot incur unrelated calls.

Private JSON/Markdown reports preserve counts, task states, reported costs and missing-cost flags. Desktop notification failure does not restart intake. A fully processed batch can finish with terminal held items while its human-facing status remains `needs_attention`; that is not a claim that every article was registered. Reposts of already-held identities carry the hold forward without new dispatch. Pending, active and unknown attempts prevent batch completion, so a new date cannot bypass their budget. Batches with new registrations require a verified backup before final completion; an incomplete backup is retained and needs operator attention. Over-limit exports remain attached to the unfinished batch. The daily cap applies to native task attempts, not a guaranteed monetary total.

After the parent and native workers have settled, the daily entry requests the official launcher's application disposal. An unreferenced `exitGraceSeconds` timer bounds any residual process handles: it preserves the requested exit code only when the launcher has recorded completion of its application disposer; otherwise it exits with failure. A grace expiry records resource types and the disposal observation in the journal. This does not claim that the underlying provider's handle leak is repaired, and the systemd process-group timeout remains the outer limit.

Reviewer output accepts only `classified` with an existing taxonomy key, or `needs_review`/`excluded` with a null category, and requires a reason. Unsupported statuses are not translated. A malformed result accepted by an older adapter is retained as evidence and reported as a terminal hold rather than published or retried.

The native entry accepts an optional absolute `receiptRoot`. After a dispatched task fails or acceptance becomes uncertain, it retains the private temporary directory there (or in the OS temporary directory for older configurations). Do not delete these receipts before reconciliation. Unknown attempts are never automatically replayed. A failed daily batch stops without switching models, issuing grants, or modifying the taxonomy.

## Slack daily-report bridge (2026-10-06)

The separately mounted `./bridge` Host entry reuses Go collection/classification records, posts completed-batch digests, receives authorized seven-policy selections over Socket Mode, and runs one durable development-verification job at a time. It does not change the original standalone, Reader/Reviewer, or daily driver entries. The installable local bundle and operator guide are [here](/data/softwares/slack-intake/docs/slack-digest-automation-2026-10-06.md).

The bridge requires a pinned team/channel, explicit human-user allowlist, a bot credential with posting/channel-info scopes, and an app-level Socket Mode credential from the same Slack App. Normalized decisions reach a private durable inbox before ACK; Go owns policy versions, atomic outbox, separate SQLite jobs and replay guards. Notification retries never re-run verification. Unknown job and message-send outcomes are retained for reconciliation.

The verification Session supplies only `development_read`, `development_command`, and `verification_result` in native mode. Its project cwd, route, deadline and steps are configured; cwd is not an OS filesystem sandbox. A successful command is necessary for a model-reported verified result, but semantic correctness is not independently certified. Costs remain unknown unless separately observed.

Offline/new-pipeline tests, official-runtime no-model mount checks and actual Slack/model execution are separate evidence. The current deployment still needs Slack scopes, app token, authorized user ID and a Web Host restart; installation reported restart-required, not live activation.

## Known limitations

Offline verification does not install or enable a profile, use a real credential, call a real model, or run against production `/data/references/AI`. Scripted-model success is separate from live API and model availability. The package is POSIX-only for secure credential metadata and executable fixtures. A same-user or root attacker and a malicious configured executable remain outside this adapter's protection.

## Model Experience

The bundle patch has no model-facing surface. The separately mounted `./agent` entry exposes one native task tool whose output contains only accepted status, task ID, and attempt number.

### Dev Note

None.
