---
name: verify-dsh-plugins
description: Prove a plugin or bundle from this repository works inside a real DeepSeek Harness (DSH) host. Starts a disposable DSH web host and headless profile with the package installed, a keyless mock LLM, and drives the web UI with Playwright and the `dsh` CLI. Use after changing a plugin under plugins/, before packing a release, or whenever "it passes its tests" is not enough and you need to see the behavior in DSH.
---

# Verify DSH plugins

This repository is a collection of DSH bundles, not one app. The app is DSH itself with the bundle under test installed. There are two user surfaces:

- **Web UI** (`dsh --profile web`): the primary one. Users add workspaces, manage plugins, and chat there.
- **CLI** (`dsh --profile headless "<task>"`): one-shot runs that print the answer. Several bundles act only here or across both.

Everything runs from a built DSH checkout, `$DSHV_DSH_ROOT` (default: `deepseek-harness` next to this repository).

## Configuration

Copy `.env.example` to `.env` in this directory and change only what differs on the machine. `.env` is git-ignored. Variables set in the shell override it. `dshv` reads it on every call. The settings are `DSHV_DSH_ROOT`, `DSHV_RUN_ROOT`, `DSHV_EVIDENCE_ROOT`, `PLAYWRIGHT_BROWSERS_PATH`, `DSHV_LIVE_PORT`, and `DSHV_MOCK_SEQUENCE`; `.env.example` documents each one and its default. Put machine paths and ports here, never in this skill's other files.

## Never touch the live instance

The operator may run a live DSH (a web host on `$DSHV_LIVE_PORT`, plus any services) on the real `~/.dsh`, often from the same checkout. Do not drive, restart, or install into it. Use only `scripts/dshv` instances:

- `HOME` and `DSH_HOME` both point into the run directory. `DSH_HOME` alone is not enough: some plugins write to `os.homedir()/.dsh` directly. For example, the workspace-attach default `hintRoot` would drop hint files into the live host's directory, and the live host would act on them.
- The environment is rebuilt from scratch. Provider keys from your shell never reach the instance, and `DEEPSEEK_BASE_URL` points at the mock LLM, so no run spends money.
- `DISPLAY` and `WAYLAND_DISPLAY` are dropped. With a display, DSH's directory picker opens a native zenity dialog on the operator's desktop. Without one, it uses the in-browser picker that the journeys drive.
- The web host binds `127.0.0.1` on an OS-chosen port, and doctor fails if that is `$DSHV_LIVE_PORT`. Any number of runs can coexist.

## Launch

`dshv` is this skill's CLI (Node, no dependencies beyond the DSH checkout). Every command has `--help`, prints JSON, and on failure prints `dshv: <what failed>` plus `next: <what to do>` to stderr. `<run>` is the path `up` printed, or `latest`.

```sh
D=.claude/skills/verify-dsh-plugins/scripts/dshv
$D up plugins/dsh-workspace-attach        # JSON with "run", "webUrl", "doctor"
RUN=latest                                 # or the printed "run" path
```

`up` takes one or more package directories (installed as `link:`, so the source tree is tested) or release archives such as `releases/<name>.tgz` (installed as `file:`, so the reviewed archive is tested). It then does the following:

1. Creates fresh `web` and `headless` profiles from the shipped templates under `<run>/home/.dsh/profiles/`.
2. Adds every package to both profiles with `dsh plugin --profile <p> add`.
3. Starts the mock LLM from the DSH checkout (`packages/test-support/llm-mock-server`) and waits for its `ready` record. `DSHV_MOCK_SEQUENCE=quota_exceeded,success` scripts failures. See that package's README for the list.
4. Starts `dsh --profile web --port 0 --host 127.0.0.1 --no-open` and waits for the line `dsh web: http://127.0.0.1:<port>/?token=…`.
5. Runs doctor. `up` exits 1 unless the instance is usable: the UI loads and every row of the packages under test is `active`. On failure it leaves the run up for inspection; run `down` afterwards.

Expect about 5 seconds. `dshv state <run>` prints the run's paths, pids, URLs, and packages (`<run>/state.json`). A first web start also creates a "Default workspace" under `<run>/home/ドキュメント/` or `Documents/`. That is normal.

## Doctor

```sh
$D doctor "$RUN"        # {"ok": true|false, "checks": [...]}, exit 1 on any failed check
```

Read-only. It reports the DSH version and checkout commit, then checks that each pid is alive and carries this run's `DSHV_RUN` in its environment. It also checks that the web port is owned by this run's pid and is not the live port, that the UI loads with no page errors, that `pluginManager/listPlugins` answers, that no row is `failed`, and that every row of the packages under test is `active`. Run it first whenever anything looks off. If it fails, read `$D logs "$RUN" web.err` and `$D logs "$RUN" mock.err`.

## Drive

Both handles are real user paths.

**Web UI.** `dshv web <run> <action>` drives one headless Chromium per run. The browser starts on first use and stays up, so each command continues on the page the previous one left. The UI is English (`--lang=en-US`), and the "Preview Notice" dialog is dismissed automatically. Targets are ARIA roles and accessible names (substring match unless `--exact`), optionally inside `--in "<role>=<name>"`:

```sh
$D web "$RUN" snapshot                                   # ARIA tree of the page: find roles and names here
$D web "$RUN" click --role button --name "Add workspace"
$D web "$RUN" fill  --in "dialog=Select Workspace Directory" --role textbox --name "Edit path" --value "$DIR"
$D web "$RUN" press --in "dialog=Select Workspace Directory" --role textbox --name "Edit path" --key Enter
$D web "$RUN" click --in "dialog=Select Workspace Directory" --role button --name Open --exact
$D web "$RUN" wait  --in "tree=Sessions" --role treeitem --name attach-project
$D web "$RUN" attr  --in "tree=Sessions" --role treeitem --name attach-project --attribute aria-expanded
$D web "$RUN" open --reload
$D web "$RUN" screenshot workspace-attach/after.png      # relative paths land in the run's evidence
```

Stable handles (en-US): buttons `New session`, `Add workspace`, `Plugins`, `More`, `Send message`. The tree `Sessions` holds workspace headers (treeitems with `aria-expanded`), the session rows after each header, and an `Ungrouped` header. The dialog `Select Workspace Directory` has an `Edit path` button that turns into a textbox, then `Open`. The composer is the textbox `Describe what you want to build, / commands, @ files or sessions`.

**CLI.** `dshv headless <run> [--cd DIR] [--env K=V]... "<task>"` runs `dsh --profile headless --json` in the isolated environment and prints `exitCode`, `sessionId`, `finished`, `text`, `warnings`, and the saved `transcript`. Against the default mock, `text` is `mock response recovered`. `dshv exec <run> [--cd DIR] -- <command>` runs anything else there, with the checkout's `dsh` on `PATH`.

**State.** `dshv store <run> workspace` prints a storage file (workspaces and their session ids). `dshv logs <run> <web.err|web.out|mock.out|mock.err|browser.err> [--tail N]` prints log lines. `mock.out` has one record per LLM request with the behavior served.

Each feature in [features/README.md](features/README.md) has its recipe in these commands. A ready-made journey runs the whole workspace-attach proof:

```sh
node .claude/skills/verify-dsh-plugins/scripts/journey-workspace-attach.mjs "$RUN"
```

## Evidence

Every run writes to `$DSHV_EVIDENCE_ROOT/<run-id>/` (default `reports/verify-dsh-plugins/`, which is git-ignored and private). `headless` saves transcripts under `headless/`. Each journey writes `<feature>/` with numbered screenshots, ARIA snapshots, a copy of the stored state it checked, and `result.json` (`verdict`, steps, error), also on failure. `down` adds `logs/`, and `run/` with `--keep`.

The proof standards:

- Drive the path a user takes: sidebar buttons, the `dsh` CLI, the composer. Do not call plugin functions, write hint files by hand, or edit `storages/*.json`.
- Capture the action and the resulting state: a screenshot before and after, plus the CLI transcript.
- Check side effects next to what is visible. Workspace membership is in `dshv store <run> workspace`, sessions are under `<run>/home/.dsh/sessions/`, and hints are in `<run>/home/.dsh/workspace-attach-hints/`. Mock LLM requests are in `dshv logs <run> mock.out`.
- Include a control when the claim is "the plugin caused it": the same action without the plugin's trigger must not produce the effect.
- The mock LLM is the only mock, and it sits at the provider HTTP boundary. A bundle whose claim is about a real provider (model availability, credentials, live quota) is not proven by a mock run. Say so in the report.
- A source run (`link:`) proves the source tree. A release run (`releases/*.tgz`) proves the archive. Neither proves the live profile, which may pin other versions. Compare with `~/.dsh/profiles/<p>/package.json` before claiming it.

## Cleanup

```sh
$D down "$RUN" --dry-run     # what would be stopped and deleted; changes nothing
$D down "$RUN"               # stop, copy logs to evidence, delete the run directory
$D down "$RUN" --keep        # same, but first copy the run directory (sessions, storages) into evidence/run/
```

`down` signals only the process groups this run started (web host, mock LLM, browser). It checks each pid's `DSHV_RUN` first, so it never kills by name. Then it copies logs into the evidence directory and deletes the run directory, including its `HOME`, profiles, sessions, browser profile, and pnpm links. The evidence directory survives. Run `down` after every failed attempt too. If `state.json` is gone but processes remain, find them with `pgrep -af "<run path>"` and kill only those pids.

## Helpers

| Script | Invocation | Purpose |
|---|---|---|
| `scripts/dshv` | `dshv --help`, then `dshv <command> --help` | The CLI: lifecycle, driving, inspection |
| `scripts/config.mjs` | imported | Settings (`.env`, defaults) and errors that say what to do next |
| `scripts/run.mjs` | imported | Run lifecycle, isolated environment, headless runs, stores, logs |
| `scripts/browser.mjs` | imported | The run's persistent browser and ARIA targets |
| `scripts/journey-workspace-attach.mjs` | `node <path> <run>` | End-to-end workspace-attach proof |

New journeys follow the same shape: take `<run>`, use `connect`/`target` from `browser.mjs` and `headless`/`store` from `run.mjs`, write to `<evidence>/<feature>/`, always write `result.json`, and leave the page on the UI's start.
