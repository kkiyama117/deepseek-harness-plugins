# DSH plugins verification map

This directory is the maintained source for verifying the user-facing behavior of this repository's bundles inside DSH. Read the index before driving, then use the matching feature file as the recipe. `dshv` means `.claude/skills/verify-dsh-plugins/scripts/dshv`.

## Baseline preconditions

- A run started with `dshv up <package>...` for the bundle under test, with `RUN` set to the path it printed.
- `dshv doctor "$RUN"` passes: the pids and port belong to this run, the UI loads, and the bundle's rows are `active`.
- The mock LLM answers every request with `success` unless the recipe sets `DSHV_MOCK_SEQUENCE` before `up`.
- Never drive the operator's live host (`$DSHV_LIVE_PORT`) or anything under the real `~/.dsh`.

## Driving conventions

- Run CLI actions as `dshv exec "$RUN" [--cd DIR] -- <command>`, and Node/Playwright scripts as `dshv exec "$RUN" -- node <script>`.
- Use the English UI (`openWeb` sets `en-US`) and ARIA roles with accessible names. Do not use CSS selectors or coordinates.
- Start each recipe from a fresh `up`. Journeys change sessions and workspaces, and the next recipe's baseline would drift.
- Put user directories (workspaces, project folders) under `$RUN/home` so the in-browser picker can reach them and `down` removes them.

## Proof and skip reporting

- Write artifacts under `$DSHV_EVIDENCE/<feature-id>/`. Write `result.json` with the feature ID, the entry point used, the steps, and the verdict, on failure too.
- UI proof is an ARIA snapshot plus a screenshot taken before and after the action. CLI proof is the full `--json` transcript.
- Check the stored side effect (`$DSH_HOME/storages/*.json`, `$DSH_HOME/sessions/`, `$RUN/mock.jsonl`) next to the screen.
- Include a control run without the plugin's trigger when the claim is causal.
- Report an entry point you could not reach with the command you tried and the unmet precondition. Do not report it as verified through another entry point.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then has exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with dshv`, and `Gotchas`. Keep implementation details out unless they are a stable handle or a trap.

## Features

| Feature | Package | Last proven |
|---|---|---|
| [Install a bundle into a profile](./bundle-install.md) | any bundle | 2026-11-02, source dir and release `.tgz` |
| [Headless sessions join a web workspace](./workspace-attach.md) | `plugins/dsh-workspace-attach` | 2026-11-02, `journey-workspace-attach.mjs` |
| [Generic icons for open-in-app targets](./open-in-app-icons.md) | `plugins/dsh-open-in-app-icons` | not yet run |
| [Model fallback on quota or rate limit](./llm-fallback.md) | `plugins/llm-fallback` | not yet run |
| [Evolve human commands](./evolve-commands.md) | `plugins/dsh-evolve` | not yet run |

Other bundles (goal acceptance, workflow results, Codex transport recovery, session cleanup, prompt compact, Slack intake, presets) have no recipe yet. Add one when a change touches them.
