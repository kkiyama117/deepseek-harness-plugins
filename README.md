# deepseek-harness-plugins

Unofficial plugins, local forks, presets, skills, and maintenance tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). This is a source collection, not a single installable plugin or a distribution of DSH.

## Contents

- [Compatibility](#compatibility)
- [Plugins and presets](#plugins-and-presets)
- [Skills](#skills)
- [Installation](#installation)
- [Development](#development)
- [Repository scope and ownership](#repository-scope-and-ownership)
- [License](#license)

## Compatibility

Choose an individual package and read its README before installing it. Packages target different DSH releases; presence in this repository does not mean a package supports your installed version.

- [DSH Evolve](plugins/dsh-evolve/README.md) declares DSH `0.2.1-rc.3` and Node.js `>=24.9.0`.
- [Prompt Compact](plugins/dsh-prompt-compact/README.md) targets DSH `0.2.1` and only replaces upstream prompt text whose fingerprint matches its reviewed version.
- The root [pnpm workspace](pnpm-workspace.yaml) retains development dependencies from the DSH `0.1.0-rc.8` line. Its build and test scripts are not a repository-wide compatibility check.
- [Compatibility copies](compat/) and older adapters have package-specific requirements. In particular, the Web Search and Cursor invariant companions depend on a registry absent from current DSH master. Do not treat their older installation examples as current-version guidance.

The [maintenance scope](docs/maintenance-scope.md) distinguishes maintained extensions, retained reference implementations, and removed managed providers. The `managed-standard` and `managed-cordis` preset names do not imply use of those removed providers.

## Plugins and presets

These entry points describe each component's setup, behavior, and limitations; this is not an install-all list.

| Component | Purpose |
|---|---|
| [DSH Evolve](plugins/dsh-evolve/README.md) | Observes tool failures and repeated calls. Installation defaults to observation without LLM calls; proposal generation is opt-in, and activation and rollback require human commands. |
| [Prompt Compact](plugins/dsh-prompt-compact/README.md) | Opt-in, preset-scoped alternatives for the Workflow and Ralph prompt sections. Tool schemas and execution behavior remain unchanged; it registers no Cordis Skill. |
| [Goal acceptance](plugins/dsh-goal-acceptance/README.md) | Retains the original request and checks evidence records for Goal completion and initial delegation. See the [restricted pilot](plugins/dsh-request-acceptance-pilot/README.md) before enabling it in a shared Host. |
| [Workflow result selection](plugins/dsh-workflow-results/README.md) | Saves a complete workflow result before returning selected fields through `resultKeys`; requires a tool replacement in the chosen preset. |
| [Codex transport recovery](plugins/dsh-codex-transport-recovery/README.md) | Classifies specific premature WebSocket closures as transport errors so the official retry policy can handle them. Does not add retries or change models. |
| [AI reference-store daily preset](presets/ai-reference-store-daily/README.md) | Declares the preset for a separately configured reference-store application. Selecting the preset does not start a daily batch. |

Older integrations and local forks:

| Component | Purpose |
|---|---|
| [Web Search](plugins/dsh-web-search/README.md) — `@kkiyama117/dsh-web-search` | Keyless DuckDuckGo HTML search, ported from [pi-web-access](https://github.com/nicobailon/pi-web-access). |
| [Cursor adapter](plugins/dsh-llm-cursor/README.md) — `@kkiyama117/dsh-llm-cursor` | Runs a Cursor SDK agent for each harness model call, with replay-state session continuity. |
| [Web UI family](plugins/dsh-web-ui/packages/) | Local copies of UI, SSH, Git graph, settings, and Modlens packages; consult each package's README. |
| [Market](plugins/dsh-market/README.md) | Local plugin-market copy with its own build and compatibility checks. |

Plugin sources and forks live under [plugins/](plugins/); configuration-only bundles under [configs/](configs/); profile declarations under [presets/](presets/). These directories are source collections, not deployment inventories.

**Layout migration:** Existing installations, profiles, systemd units, and scripts may still refer to old root-level paths. Moving this repository's sources does not update them; inventory and migrate those references before replacing an active checkout. In particular, the retained Slack worker configuration and compatibility patch still contain old absolute paths. Do not assume that an isolated checkout or a passing source test has migrated the live runtime. See the [migration checklist](docs/layout-migration.md).

## Skills

[skills/](skills/) contains authored skills and upstream-derived copies. Cloning this repository does not install or enable them. Local deployments may link individual skill directories into a DSH skill search path; edit the source directory, not a separate copied version. Read each skill's prerequisites before enabling it.

| Skill | Purpose and prerequisites |
|---|---|
| [issue-driven-development](skills/issue-driven-development/SKILL.md) | Shared issue intake, feature and bugfix delivery, verification, and development-process improvement for humans and AI agents. See [contributing](CONTRIBUTING.md) for this repository's setup. |
| [orchestrate-agents](skills/orchestrate-agents/SKILL.md) | Task formulation, direct-versus-delegated execution, and bounded orchestration. See its [runtime limits](skills/orchestrate-agents/README.md). |
| [archify](skills/archify/SKILL.md) | Local fork of [archify](https://github.com/tt-a1i/archify) for architecture visualization, with screenshot checks at 1920×1080 and 2048×1320. |
| [quint-lang](skills/quint-lang/SKILL.md) | Quint syntax and CLI reference, imported from [quint-llm-kit](https://github.com/quint-co/quint-llm-kit). |
| [quint-modeling](skills/quint-modeling/SKILL.md) | Build or review Quint specifications from requirements or source code. |
| [quint-execute-spec](skills/quint-execute-spec/SKILL.md) | Implement code against an existing Quint specification. |
| [quint-cli](skills/quint-cli/SKILL.md) | Container-based Quint CLI instructions; requires the documented container tool and image. |
| [quint-verify](skills/quint-verify/SKILL.md) | Run invariant and witness checks and produce a structured verification report. Requires the documented Quint container environment. |
| [slack-reference-intake](skills/slack-reference-intake/SKILL.md) | Reference intake for a separately configured private Go aistore, with authorized Slack access and DSH credentials. Not a standalone public demo. |
| [implement-task](skills/implement-task/SKILL.md) | Retained implementation-flow reference with a [Quint specification](skills/implement-task/spec/README.md). It depends on legacy `subagent-fallback` tools; migrate the callers and specification before using it with current DSH. |

## Installation

1. Install DSH separately and choose the target profile.
2. Check the selected package's README, manifest, and patch for DSH compatibility, prerequisites, and activation scope. Build compiled packages using their own development instructions before loading them.
3. Install only the selected bundle through DSH's Plugin Manager or plugin CLI. A bundle declares `dsh.bundle.patch` in its package manifest; the repository root and plain skill directories are not bundles.
4. Complete any package-specific opt-in steps. For example, Prompt Compact has an empty bundle patch and needs a row in a locally authored preset. DSH Evolve instead mounts in observation mode on installation.

For CLI usage from a DSH source checkout:

```sh
pnpm dsh plugin --help
```

Use your own package location rather than the maintainer's filesystem paths in older examples. See the upstream [bundle publishing guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md) for profile installation. Do not edit shipped DSH presets to enable these extensions.

## Development

Use [Issues](https://github.com/kkiyama117/deepseek-harness-plugins/issues) to report problems or propose improvements. [CONTRIBUTING.md](CONTRIBUTING.md) describes the shared human/AI development flow and this repository's verification and publication scope.

The root [package manifest](package.json) pins pnpm to `11.7.0`. The root workspace includes Web Search, Cursor, and five Web UI family packages—not every package in this repository.

| Root command | Scope |
|---|---|
| `pnpm install` | Installs dependencies for the root workspace using its lockfile. |
| `pnpm build` | Runs the build script of each workspace member. Builds are not all plain `tsc`; UI packages also bundle client assets. |
| `pnpm test` | Runs workspace-member test scripts with workspace concurrency set to one. |

For packages outside that workspace, follow their own README and package scripts. Do not use a passing root build or test run as evidence that those packages work with your DSH version. Compiled packages load generated output, not edited source; follow the package's rebuild and reload instructions.

The read-only [local setup diagnostic](scripts/local-setup.mjs) inspects a local DSH profile. It imports `plugins/dsh-market/lib/check.js`, so it requires a built Market package, which is outside the root workspace. It is not a fresh-clone setup command or an installer.

## Repository scope and ownership

This repository publishes plugin, preset, skill, test, and maintenance-tool sources. Credentials, private design and review material, execution reports, deployment inventories, local caches, and release archives stay outside Git. Review new files for sensitive data before committing; ignore rules are not a secret scanner.

The public history starts with a source-only snapshot; earlier local history is not available here. See [architecture](ARCHITECTURE.md) for composition and verification limits, and the [source ownership policy](SOURCE-OWNERSHIP.md) for the upstream Core baseline and reviewed exception.

## License

[MIT](LICENSE). Preserve the upstream license and attribution notices included with imported code, forks, and skills.
