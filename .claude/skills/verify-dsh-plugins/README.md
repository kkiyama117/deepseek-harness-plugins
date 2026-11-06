# verify-dsh-plugins

A project-local Claude Code skill that proves a plugin from this repository works inside a real DeepSeek Harness (DSH) host. It starts a disposable DSH web host and headless profile with the chosen package installed and a keyless mock LLM, drives the web UI and the headless CLI, and keeps screenshots, transcripts, and stored state as evidence. See [SKILL.md](SKILL.md) for the complete procedure and execution standards.

## Requirements

- A built DSH checkout (default: `deepseek-harness` next to this repository; it supplies the `dsh` CLI, the mock LLM server, and Playwright)
- Node.js
- Playwright's Chromium installed for that checkout
- Linux with `ss` and `tar` (the tool reads `/proc` and uses process groups)

## Setup

Copy `.env.example` to `.env` and change only what differs on your machine. `.env` is git-ignored, and shell environment variables override it.

| Variable | Default | Purpose |
|---|---|---|
| `DSHV_DSH_ROOT` | `$REPO/../deepseek-harness` | Built DSH checkout providing CLI, mock LLM, and Playwright |
| `DSHV_RUN_ROOT` | `${TMPDIR:-/tmp}/dshv` | Directory where disposable run instances live |
| `DSHV_EVIDENCE_ROOT` | `$REPO/reports/verify-dsh-plugins` | Directory where evidence is kept; survives `dshv down` |
| `PLAYWRIGHT_BROWSERS_PATH` | `$HOME/.cache/ms-playwright` | Real host browser cache used across isolated runs |
| `DSHV_LIVE_PORT` | `3080` | Port of operator's live web host; doctor fails if a run uses it |
| `DSHV_MOCK_SEQUENCE` | `success` | Response sequence script for the mock LLM |

## Quick start

From the repository root:

```sh
D=.claude/skills/verify-dsh-plugins/scripts/dshv
$D up plugins/dsh-workspace-attach
$D doctor latest
node .claude/skills/verify-dsh-plugins/scripts/journey-workspace-attach.mjs latest
$D down latest
```

Evidence is written to `reports/verify-dsh-plugins/<run-id>/` by default (git-ignored), and it survives `down`.

## Commands

| Group | Commands | Purpose |
|---|---|---|
| lifecycle | `up`, `doctor`, `down` | Start an isolated run, verify health, and stop processes while cleaning up |
| drive | `web`, `headless`, `exec` | Drive the persistent browser UI, run isolated CLI tasks, or execute shell commands |
| inspect | `state`, `store`, `logs` | Inspect run paths/pids, print persisted storage contents, and view process logs |

Every command has `--help`. Output is JSON, except `exec`, which passes the command's output through, and `state <run> <field>`, which prints one plain value.

## Safety

- Each run gets its own `HOME` and `DSH_HOME`, so it never touches the real `~/.dsh` or a running DSH instance.
- The environment is rebuilt from scratch, so provider API keys never reach it and the LLM is a local mock (no cost).
- No display is passed (`DISPLAY` and `WAYLAND_DISPLAY` are dropped), so no native dialog appears on the desktop.
- The web host listens on `127.0.0.1` on a free port, and `doctor` fails if that is the live port (`$DSHV_LIVE_PORT`).
- `down` stops only process groups this run started (checked by environment `DSHV_RUN`, never by name).

## Files

| File / Directory | Purpose |
|---|---|
| [SKILL.md](SKILL.md) | Agent procedure and proof standards |
| [features/](features/) | Feature map: one recipe per user-facing feature ([features/README.md](features/README.md) is the index) |
| `scripts/dshv` and `scripts/*.mjs` | The CLI: `config.mjs` settings, `run.mjs` lifecycle, `browser.mjs` browser |
| `scripts/journey-workspace-attach.mjs` | End-to-end workspace-attach proof |
| [.env.example](.env.example) | Template of configurable environment variables and defaults |

## Maintenance

The feature map is kept current by `/kstack:maintain-verification-skill`. The repository's [bin/weekly-verify-maintenance.sh](../../../bin/weekly-verify-maintenance.sh) runs it unattended in a throwaway worktree. Some recipes in [features/](features/) are marked "not yet run"; treat those as unverified.
