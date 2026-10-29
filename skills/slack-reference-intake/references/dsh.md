# DSH adapter

DSH discovers this skill through `~/.agents/skills/slack-reference-intake`. Keep one active discovery link. The skill contains instructions and Slack App manifests, not an intake runner or credentials.

## Active deployment

The only active profile is `ai-reference-store-next`; the legacy `slack-reference-intake` profile is retired. The active user preset is also `ai-reference-store-next`. Both point to:

- executable: `/data/references/AI/bin/aistore`
- store: `/data/references/AI`
- adapter: installed `@kkiyama117/dsh-slack-intake` 0.2.0

Use the official installed CLI:

```sh
CLI=/data/softwares/deepseek-harness-master/apps/cli/lib/bin.js
PROFILE=/home/kiyama/.dsh/profiles/ai-reference-store-next
node "$CLI" --profile ai-reference-store-next --patch "$PROFILE/standalone.patch.yml" verify
node "$CLI" --profile ai-reference-store-next --patch "$PROFILE/standalone.patch.yml" history summary
```

The profile fixes the store and JSON protocol arguments. Remaining arguments are the normal Go grammar. Run commands separately so each exit code remains visible.

## Credentials

The adapter uses DSH's credential service. It never parses the credential file or prints a value.

- Only `intake slack collect` receives `SLACK_BOT_TOKEN`.
- Only `intake resume ... --allow-network` receives `OPENROUTER_API_KEY`.
- Read-only operations and native Agent tasks receive neither credential.

Use `credential status` only for value-free metadata. Import or rotate a credential through the profile's documented credential command and an explicit owner-only file; do not put a token in chat, argv, a skill file, or a report.

## Native handoff

The user preset registers `aistore_native_task` with required `taskId` and `inputHash`. Invoke it only for a handoff returned by the same production store. The tool keeps claims and authority outside model input, uses the task packet's fixed provider/model/effort, verifies request and assistant runtime records, and submits one native receipt. Unknown, cancelled, or timed-out tasks are not retried automatically.

The preset consumes Host `tools` and `subagents`; it publishes no service. It belongs in the user preset, not the Host composition or a shipped preset. A changed preset must be mount-validated and checked in a disposable real Agent Session without sending a prompt. Do not restart the current Web process for this check.

## Exit handling

Exit 0 means the requested Go operation completed. Exit 3 means the caller must perform the returned handoff and resume. Other exits are failures. Preserve any created receipts and inspect the exact state before retrying. Never interpret a package install or module import alone as operational verification.
