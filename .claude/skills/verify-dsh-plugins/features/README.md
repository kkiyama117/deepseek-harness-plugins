# DSH plugins verification map

This directory is the maintained source for verifying the user-facing behavior of this repository's bundles inside DSH. Read the index before driving, then use the matching feature file as the recipe. `dshv` means `.claude/skills/verify-dsh-plugins/scripts/dshv`.

## Baseline preconditions

- A run started with `dshv up <package>...` for the bundle under test, with `RUN` set to the `run` it printed (or `latest`).
- `dshv doctor "$RUN"` passes: the pids and port belong to this run, the UI loads, and the bundle's rows are `active`.
- The mock LLM answers every request with `success` unless the recipe sets `DSHV_MOCK_SEQUENCE` before `up`.
- Never drive the operator's live host (`$DSHV_LIVE_PORT`) or anything under the real `~/.dsh`.

## Driving conventions

- Drive the web UI with `dshv web "$RUN" <action>` and headless runs with `dshv headless "$RUN" ...`. Use `dshv exec "$RUN" -- <command>` only for anything else. `RUN` may be `latest`.
- Target ARIA roles and accessible names in the English UI. When a name is unknown, run `dshv web "$RUN" snapshot` first. Do not use CSS selectors or coordinates.
- Start each recipe from a fresh `up`. Journeys change sessions and workspaces, and the next recipe's baseline would drift.
- Put user directories (workspaces, project folders) under `$(dshv state "$RUN" run)/home` so the in-browser picker can reach them and `down` removes them.

## Proof and skip reporting

- Write artifacts under `$(dshv state "$RUN" evidence)/<feature-id>/` (`dshv web ... screenshot <feature-id>/<file>` does this). Write `result.json` with the feature ID, the entry point used, the steps, and the verdict, on failure too.
- UI proof is an ARIA snapshot plus a screenshot taken before and after the action. CLI proof is the full `--json` transcript.
- Check the stored side effect (`dshv store "$RUN" <name>`, the run's `home/.dsh/sessions/`, `dshv logs "$RUN" mock.out`) next to the screen.
- Include a control run without the plugin's trigger when the claim is causal.
- Report an entry point you could not reach with the command you tried and the unmet precondition. Do not report it as verified through another entry point.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then has exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with dshv`, and `Gotchas`. Keep implementation details out unless they are a stable handle or a trap.

## Features

| Feature | Package | Last proven |
|---|---|---|
| [Install a bundle into a profile](./bundle-install.md) | any bundle | 2026-11-09, source dir on DSH 0.2.2-rc.1 (release `.tgz` last 2026-11-02) |
| [Headless sessions join a web workspace](./workspace-attach.md) | `plugins/dsh-workspace-attach` | 2026-11-09, `journey-workspace-attach.mjs`, `attach-id`, `attach-reject` |
| [Generic icons for open-in-app targets](./open-in-app-icons.md) | `plugins/dsh-open-in-app-icons` | 2026-11-09, routes and session `Open in` menu |
| [Model fallback on quota or rate limit](./llm-fallback.md) | `plugins/llm-fallback` | 2026-11-09, `fallback-quota` and the `fallback-other-model` control, against the mock |
| [Evolve human commands](./evolve-commands.md) | `plugins/dsh-evolve` | not yet run; install rejected on DSH 0.2.2-rc.1 |

Other bundles (goal acceptance, workflow results, Codex transport recovery, session cleanup, prompt compact, Slack intake, presets) have no recipe yet. Add one when a change touches them.
