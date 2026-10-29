# Slack access and collection

## Read-only Slack App

Install an app from the appropriate `assets/manifest*.json`. Grant only the history scope required for the authorized channel and invite the bot only there. Collection needs no posting/deletion, Events API, Socket Mode, OAuth callback, browser cookie, or user session token.

## Go collection path

Use profile `ai-reference-store-next`; do not call the retired Python collector.

```sh
CLI=/data/softwares/deepseek-harness-master/apps/cli/lib/bin.js
PROFILE=/home/kiyama/.dsh/profiles/ai-reference-store-next
node "$CLI" --profile ai-reference-store-next --patch "$PROFILE/standalone.patch.yml" \
  intake slack plan --config /absolute/private/intake.toml \
  --oldest 1710000000.000000 --latest 1710086400.000000
node "$CLI" --profile ai-reference-store-next --patch "$PROFILE/standalone.patch.yml" \
  intake slack collect --config /absolute/private/intake.toml \
  --oldest 1710000000.000000 --latest 1710086400.000000
```

`plan` is read-only. `collect` receives `SLACK_BOT_TOKEN` from DSH credentials for that child only. The token is absent from argv, configuration, output, and stored objects.

The collector uses `conversations.history`, follows pagination to exhaustion, keeps Slack timestamps as decimal strings, and enforces page/response limits. A successful collection saves immutable raw response bytes and advances the channel checkpoint only after continuity and the complete page chain are verified. `is_limited` without a verified prior anchor, a missing/repeated cursor, truncation, failure, or interruption does not advance the checkpoint.

Coverage is top-level messages in the explicit time window. It does not include thread replies, reconstruct edits/deletions, or prove history outside the verified anchor. Collection is not classification; pass the returned export hash to the separate Go intake plan/start stages.
