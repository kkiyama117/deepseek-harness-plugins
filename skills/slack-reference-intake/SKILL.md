---
name: slack-reference-intake
description: Run private Slack reference intake through Go aistore collection, native Reader handoffs, coordinator acceptance, Jev classification, bounded no-match review, additive registration, and verification.
compatibility: Go aistore schema 7, DSH profile and preset ai-reference-store-next, authorized Slack access, and configured DSH credentials.
---

# Slack reference intake

Complete an authorized intake through verified additive registration, then present one final review. Collection, article preparation, coordinator acceptance, classification, no-match review, and registration are separate states in one Go run. Do not stop at an internal handoff unless a real blocker prevents the next state.

## Fixed production path

The production store is `/data/references/AI`. Use its `bin/aistore` CLI or the installed DSH profile `ai-reference-store-next`. Do not call Python, uv, legacy skill launchers, or the retired `slack-reference-intake` profile.

Read `/data/references/AI/README.md`, [DSH operation](references/dsh.md), [Slack collection](references/slack-setup.md), and [the Go topic pipeline](references/topic-pipeline.md) before changing data. The store is private. Never expose credentials, Slack message bodies, raw exports, claims, or authority receipts to a model or public retriever.

## Roles and routes

- Programs collect, normalize, hash, checkpoint, call Jev, register records, and verify the store.
- The native Reader prepares a standalone article from saved public bodies. Its fixed task packet selects `ollama-cloud/deepseek-v4.1-flash` at `xhigh`; do not substitute a route.
- The coordinator checks source hashes, verbatim anchors, and substantive fidelity before approving an article.
- Jev classifies only approved article text through the Go network-resume stage. Preserve its Choice and independent Noul distributions.
- Only an explicit Jev no-match may create a native reviewer task. The fixed reviewer route is `openai-codex/gpt-6-astra` at `high`; the run enforces its recorded attempt limit. Do not use low confidence or technical failure as a fallback trigger.

Never retry an `unknown` task or create an alternate model call. Reader batches contain at most 25 articles. Actual routes, attempts, sessions, outcomes, and reported costs come from saved receipts; a null cost is unknown, not zero.

## Run the state machine

Use the official installed DSH CLI and profile overlay shown in [references/dsh.md](references/dsh.md). The profile fixes `--store /data/references/AI --json`.

1. Run `intake slack plan` with the authorized channel configuration and explicit bounds. It is read-only.
2. Run `intake slack collect` only when live collection is authorized. The adapter supplies `SLACK_BOT_TOKEN` from DSH credentials only to this operation. A failed or continuity-unverified collection does not advance the checkpoint.
3. Run `intake plan` and `intake start` with private absolute input/config paths and explicit run/campaign IDs.
4. On a Reader or reviewer handoff, invoke `aistore_native_task` with exactly the returned `taskId` and `inputHash`. The tool claims once, records in-flight state, runs the packet's fixed route, verifies DSH runtime evidence, and submits the native receipt.
5. When article approval is required, inspect the saved article and evidence locally. Record `intake article approve` only after source and meaning checks; otherwise reject or hold with a concrete reason.
6. Resume offline by default. Use `intake resume --run RUN --allow-network` only for the authorized Jev stage; only this operation receives `OPENROUTER_API_KEY`.
7. Continue until the run reports completion or a specific held/review state. Classified accepted items are registered additively. Proposals do not modify the taxonomy without separate exact human approval.
8. Run `verify`, `history summary`, and the run/reference views. Report the collection window, registrations, held/excluded items, routes, attempts, costs, verification counts, and outstanding proposals.

Exit code 3 is a handoff, not completion. Preserve receipts when a write outcome is uncertain; reconcile before repeating an operation. Do not change existing records, historical decisions, original bytes, or taxonomy definitions merely to make a run finish.

## Read-only checks

```sh
/data/references/AI/bin/aistore --store /data/references/AI --json verify
/data/references/AI/bin/aistore --store /data/references/AI --json history summary
/data/references/AI/bin/aistore --store /data/references/AI --json history unregistered-classified
/data/references/AI/bin/aistore --store /data/references/AI --json search --limit 10 'agent memory'
```

Use `present` for the final human-readable report and non-secret primary artifacts. Never present the store database, object bodies, credentials, private claims, or raw Slack exports.
