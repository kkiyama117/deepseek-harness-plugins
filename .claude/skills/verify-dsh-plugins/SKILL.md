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
- The environment is rebuilt with `env -i`. Provider keys from your shell never reach the instance, and `DEEPSEEK_BASE_URL` points at the mock LLM, so no run spends money.
- `DISPLAY` and `WAYLAND_DISPLAY` are dropped. With a display, DSH's directory picker opens a native zenity dialog on the operator's desktop. Without one, it uses the in-browser picker that the journeys drive.
- The web host binds `127.0.0.1` on an OS-chosen port, and doctor fails if that is `$DSHV_LIVE_PORT`. Any number of runs can coexist.

## Launch

```sh
.claude/skills/verify-dsh-plugins/scripts/dshv up plugins/dsh-workspace-attach   # prints RUN
RUN=<the printed path>
```

`up` takes one or more package directories (installed as `link:`, so the source tree is tested) or release archives such as `releases/<name>.tgz` (installed as `file:`, so the reviewed archive is tested). It then does the following:

1. Creates fresh `web` and `headless` profiles from the shipped templates under `$RUN/home/.dsh/profiles/`.
2. Adds every package to both profiles with `dsh plugin --profile <p> add`.
3. Starts the mock LLM from the DSH checkout (`packages/test-support/llm-mock-server`) and waits for its `ready` record. `DSHV_MOCK_SEQUENCE=quota_exceeded,success` scripts failures. See that package's README for the list.
4. Starts `dsh --profile web --port 0 --host 127.0.0.1 --no-open` and waits for the line `dsh web: http://127.0.0.1:<port>/?token=…`.
5. Runs `doctor`. `up` exits non-zero unless the instance is usable: the UI loads and every row of the packages under test is `active`.

Expect about 10 seconds. `$RUN/state.env` holds `WEB_URL` (with token), `WEB_ORIGIN`, `MOCK_URL`, `WEB_PID`, `MOCK_PID`, `EVIDENCE`, and `PACKAGES`. A first web start also creates a "Default workspace" under `$RUN/home/ドキュメント/` or `Documents/`. That is normal.

## Doctor

```sh
.claude/skills/verify-dsh-plugins/scripts/dshv doctor "$RUN"
```

Read-only. Doctor prints the DSH version and checkout commit, then checks that both pids are alive and carry this run's `DSHV_RUN` in their environment. It also checks that the web port is owned by this run's pid and is not the live port, that the UI loads with no page errors, that `pluginManager/listPlugins` answers, that no row is `failed`, and that every row of the packages under test is `active`. Run it first whenever anything looks off. If it fails, read `$RUN/web.err` and `$RUN/mock.err`.

## Drive

Two handles, both real user paths:

- **CLI**: `dshv exec "$RUN" [--cd DIR] -- <command>` runs a command inside the isolated environment, with a `dsh` on `PATH` that is the checkout's CLI. Example:
  `dshv exec "$RUN" --cd "$RUN/home/attach-project" -- env DSH_WORKSPACE_ID=cwd dsh --profile headless --json "Say hello"`.
  With `--json`, the first line is `{"type":"session","sessionId":…,"cwd":…}` and the run ends with `{"type":"final",…}`. Against the default mock, the answer text is `mock response recovered`.
- **Web**: `scripts/web.mjs` exports `openWeb(url)` and `rpc(page, method, args)`. `openWeb` launches headless Chromium (Playwright from the DSH checkout) with `locale: 'en-US'`, so labels are English. It dismisses the "Preview Notice" dialog and waits for the `New session` button. Run Node scripts through `dshv exec "$RUN" -- node <script>` so they see `DSHV_RUN`, `DSHV_EVIDENCE`, `HOME`, and `DSH_HOME`.

Stable handles (en-US): buttons `New session`, `Add workspace`, `Plugins`, `More`, `Send message`. The tree `Sessions` holds workspace headers (treeitems with `aria-expanded`), the session rows after each header, and an `Ungrouped` header. The dialog `Select Workspace Directory` has a `Edit path` button that turns into a textbox, then `Open`. The composer is the textbox `Describe what you want to build, / commands, @ files or sessions`. `rpc(page, 'pluginManager/listPlugins')` returns rows with `entryId`, `moduleName`, and `fiberPhase`.

Each feature in [features/README.md](features/README.md) has its recipe. A ready-made journey exists for workspace attach:

```sh
.claude/skills/verify-dsh-plugins/scripts/dshv exec "$RUN" -- node "$PWD/.claude/skills/verify-dsh-plugins/scripts/journey-workspace-attach.mjs"
```

## Evidence

Every run writes to `$DSHV_EVIDENCE_ROOT/<run-id>/` (default `reports/verify-dsh-plugins/`, which is git-ignored and private). Each journey writes `<feature>/` with numbered screenshots, ARIA snapshots, CLI transcripts, a copy of the stored state it checked, and `result.json` (`verdict`, steps, error). `down` adds `logs/` with the web and mock output.

The proof standards:

- Drive the path a user takes: sidebar buttons, the `dsh` CLI, the composer. Do not call plugin functions, write hint files by hand, or edit `storages/*.json`.
- Capture the action and the resulting state: a screenshot before and after, plus the CLI transcript.
- Check side effects next to what is visible. Workspace membership is in `$DSH_HOME/storages/workspace.json`, sessions are under `$DSH_HOME/sessions/`, and hints are in `$DSH_HOME/workspace-attach-hints/`. Mock LLM requests are in `$RUN/mock.jsonl`, one record per request with the behavior served.
- Include a control when the claim is "the plugin caused it": the same action without the plugin's trigger must not produce the effect.
- The mock LLM is the only mock, and it sits at the provider HTTP boundary. A bundle whose claim is about a real provider (model availability, credentials, live quota) is not proven by a mock run. Say so in the report.
- A source run (`link:`) proves the source tree. A release run (`releases/*.tgz`) proves the archive. Neither proves the live profile, which may pin other versions. Compare with `~/.dsh/profiles/<p>/package.json` before claiming it.

## Cleanup

```sh
.claude/skills/verify-dsh-plugins/scripts/dshv down "$RUN"
```

`down` signals only the two process groups this run started. It checks each pid's `DSHV_RUN` first, so it never kills by name, then copies logs into the evidence directory and deletes `$RUN`, including its `HOME`, profiles, sessions, and pnpm links. The evidence directory survives. Run `down` after every failed attempt too. If `$RUN/state.env` is gone but processes remain, find them with `pgrep -af "<run path>"` and kill only those pids.

## Helpers

| Script | Invocation | Purpose |
|---|---|---|
| `scripts/dshv` | `dshv up <pkg>... \| doctor <run> \| exec <run> [--cd DIR] -- <cmd> \| down <run>` | Lifecycle and the isolated environment |
| `scripts/web.mjs` | `import { openWeb, rpc } from './web.mjs'` | Playwright session on the isolated web UI |
| `scripts/doctor-web.mjs` | called by `dshv doctor` | Web half of doctor |
| `scripts/journey-workspace-attach.mjs` | `dshv exec "$RUN" -- node <path>` | End-to-end workspace-attach proof |

New journeys follow the same shape: read `DSHV_RUN/state.env`, write to `$DSHV_EVIDENCE/<feature>/`, and always write `result.json` (also on failure).
