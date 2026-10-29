# deepseek-harness-plugins

Hand-made plugins, local forks, presets, and operational tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Keep their implementations here and load them through profile bundles and settings; the [source ownership policy](SOURCE-OWNERSHIP.md) records the official Core baseline and its exact reviewed exception.

What runs, who owns each layer, and what the Quint/replay gates actually prove: **[ARCHITECTURE.md](ARCHITECTURE.md)**. Read-only local setup: `node scripts/local-setup.mjs`.

Each plugin is an npm package that installs as a dsh **bundle**: `dsh plugin --profile <name> add <package-directory>` links the package into the profile and activates its `cordis.patch.yml` layer ([how profiles and bundles compose](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.md)).

## Plugins

| Package | What it does |
|---|---|
| [`dsh-evolve`](dsh-evolve/README.md) — `@kkiyama117/dsh-evolve` | Observes tool failures, validates skill proposals, and requires human commands for activation and rollback; opt-in, not enabled by installation here. |
| [`dsh-prompt-compact`](dsh-prompt-compact/README.md) — `@kkiyama117/dsh-prompt-compact` | Opt-in, preset-scoped prompt alternatives with an on-demand Cordis Skill; upstream tools and runtime remain unchanged. |
| [`dsh-web-search`](dsh-web-search/README.md) — `@kkiyama117/dsh-web-search` | Keyless DuckDuckGo search provider for the harness web seam (`ctx.web`), ported from [pi-web-access](https://github.com/nicobailon/pi-web-access) (MIT). |
| [`dsh-llm-cursor`](dsh-llm-cursor/README.md) — `@kkiyama117/dsh-llm-cursor` | Cursor SDK agent adapter for the harness LLM seam (`ctx.llm`): one Cursor agent run per model call, with replay-state session continuity. |

## Retired managed bundles

The five legacy provider forks and their dedicated release/launch tooling are removed. Their earlier local history is retained outside this public source snapshot, not as another published source archive. Current compatibility presets such as `managed-standard` and `managed-cordis` remain supported and use official providers. The [maintenance scope](docs/maintenance-scope.md) distinguishes these presets and current external extensions from the removed implementations.

## Managed skills

`skills/` holds hand-made agent skills whose source of truth lives here. Each
is symlinked into `~/.dsh/skills/<name>` (and the per-session workspace
`.dsh/skills/<name>`) so the harness loads it; edit only the copy in this
repository.

| Skill | What it does |
|---|---|
| [`implement-task`](skills/implement-task/SKILL.md) | Superpowers-style end-to-end implementation flow (scope → plan → gate → implement → verify → review → iterate → report) with role-specific subagent tools: `subagent_frontier` (planner/reviewer), `subagent_worker` (implementation), `subagent_verify` (deterministic checks). Requires `subagent-fallback` rows in `~/.dsh/cordis.patch.yml`. Formalized as Quint in [`skills/implement-task/spec/`](skills/implement-task/spec/README.md). |
| [`archify`](skills/archify/SKILL.md) | Fork of [`@tt-a1i/archify-dsh`](https://github.com/tt-a1i/archify) (v2.14) with a reduced visual-check: containment and screenshots at **1920×1080 and 2048×1320 only** (upstream checks 1440×900 / 1600×1000 / 1920×1080 / 2048×1320). Lives at `~/.dsh/skills/archify` (rank 400), shadowing the plugin's bundled copy (rank 600). Rebase from the upstream package when a new version ships. |
| [`quint-lang`](skills/quint-lang/SKILL.md) | Imported from [`quint-co/quint-llm-kit`](https://github.com/quint-co/quint-llm-kit) (lightweight path). Quint language + CLI reference: syntax, operators, types, `basicSpells`, typecheck/run/test, reading counterexamples. Rebasable. |
| [`quint-modeling`](skills/quint-modeling/SKILL.md) | Imported from `quint-co/quint-llm-kit`. Build, or review/audit, a Quint spec from an idea, requirements, source code (Rust/Go/TS/…), or TLA+. Rebasable. |
| [`quint-execute-spec`](skills/quint-execute-spec/SKILL.md) | Imported from `quint-co/quint-llm-kit`. Implement code against an existing Quint spec, with the spec as the formal constraint. Rebasable. |
| [`quint-cli`](skills/quint-cli/SKILL.md) | This repo's own. Runs the `quint` CLI through `container_exec` (podman) against the prebuilt `localhost/claudecode:latest` image (Quint 0.32.0) — the sandbox `bash` cannot reach a host-installed `quint`. `--user 0` reads the mode-`0600` `.qnt` files; `--entrypoint /usr/bin/quint` skips the image's MCP-setup entrypoint so the mounted repo is not polluted. |

## Public repository scope

This repository publishes plugin, preset, skill, test, and maintenance-tool sources. Credentials, private design/review material, execution reports, deployment inventories, local caches, and release archives stay outside Git. The initial public commit is a source-only snapshot; the preceding local history and staging state are retained in a private local backup, not pushed to GitHub. Review new files for sensitive data before committing; ignore rules are not a secret scanner.

## Install

From the harness checkout:

```sh
pnpm dsh plugin --profile web add /data/softwares/deepseek-harness-plugins/dsh-web-search
pnpm dsh plugin --profile web add /data/softwares/deepseek-harness-plugins/dsh-llm-cursor
```

The web-search bundle's patch layer overrides the base `web` row to select `searchProvider: pi-web-access`, so `web_search` works with no API key and no billing. The llm-cursor bundle's patch layer inserts the `llm-cursor` row, which registers the `cursor` provider route on the LLM seam (store a Cursor SDK API key through the credentials service or export `CURSOR_API_KEY`).

## Development

```sh
pnpm install   # registry deps, pinned to the @deepseek-ai/* versions dsh@0.1.0-rc.8 runs
pnpm build     # tsc for every package (dsh loads built lib/)
pnpm test      # vitest per package
```

The root workspace retains legacy development peers for its member packages. Other extensions, including DSH Evolve, declare their own DSH compatibility and development setup. Follow the owning package README; the root install/build commands are not a universal compatibility check for every extension.

**pnpm is pinned to `11.7.0`** (via `packageManager` and `.mise.toml`).

Source changes need `pnpm build` and a harness restart to take effect; the harness's hot reload does not watch this repository.
