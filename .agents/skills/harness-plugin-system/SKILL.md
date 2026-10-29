---
name: harness-plugin-system
description: "How to customize the DeepSeek Harness (DSH) itself and where to read about its plugin system: the Cordis composition model, host vs agent-preset planes, profile/bundle/patch layers, config file locations, and the source packages that implement everything. Use when asked how the harness is built, where its configuration lives, or where to look to extend it beyond skills."
whenToUse: "Use when customizing the harness (plugins, presets, profiles, bundles), researching how its plugin system works, finding where its configuration lives, or locating the package that implements a feature."
metadata:
  appliesTo: deepseek-harness
---

# harness-plugin-system — customizing the DeepSeek Harness

## 1. The core model

DSH is a **Cordis application**: every capability is a plugin row in a
`cordis.yml` composition. Plugins consume Services, listen to Events, provide
Services, register model Tools and browser UI slots. `@deepseek-ai/cordis`
(the bundled fork, v4) is the framework underneath.

Two planes decide where an edit belongs:

- **HOST composition** — registries and anything shared across sessions:
  persistence, sandbox/approval stack, model route, subagents, skills, jobs,
  the filesystem seam.
- **AGENT PRESET** — what one session contributes to those registries: its
  tools, persona, prompt sections. A preset may also own per-agent services
  through `isolate: { <service>: true }` realms.

## 2. Where the configuration lives (this machine)

- **Profile**: `~/.dsh/profiles/<name>/` — `cordis.yml` (base entry list;
  usually just `[]`), `cordis.patch.yml` (overlays; a patch replaces a row's
  whole `config`), `package.json` with `dsh.profile.bundles` listing the
  bundle packages. The web surface is `~/.dsh/profiles/web/`.
- **User overlays**: `~/.dsh/cordis.patch.yml` (applied after the profile).
- **Agent presets**: `~/.dsh/.agent-presets/<id>/` — `preset.yml` (roster
  name/description) + `agent.cordis.yml` (the composition). On this machine:
  `my-cordis` (a fork of the shipped `cordis` preset) and `my-standard`.
- **Shipped presets**: `<dsh install>/config/agent-presets/`
  (`standard`, `minimal`, `code`, `cordis`). NEVER edit them — copy into
  `~/.dsh/.agent-presets/` and edit the copy.
- **Bundles**: npm packages that ship a `cordis.patch.yml` layer.
  `dsh plugin --profile <name> add <package-dir>` links a package into the
  profile. See the harness repo docs, `docs/user/develop/basic/publish.md`.

## 3. Where to read the source

- **GitHub**: https://github.com/deepseek-ai/deepseek-harness — the canonical,
  complete source. Every installed package's `package.json` has a
  `repository.directory` mapping to its repo path (e.g.
  `@deepseek-ai/dsh-skill-filesystem` → `packages/skill/skill-filesystem`,
  `@deepseek-ai/dsh-client-ui-input-trigger` → `packages/client/ui-input-trigger`,
  `@deepseek-ai/dsh` → `apps/cli`).
- **The running install**: the `dsh` process runs from a bunx cache
  (`/tmp/bunx-1000-@deepseek-ai/dsh@latest/node_modules/@deepseek-ai/<pkg>/`),
  where each package's `lib/*.js` is readable, fully commented source. Treat
  it as ephemeral (regenerated per run) — GitHub is the source of truth.
- **This repo** pins a stable subset at `node_modules/@deepseek-ai/`
  (cordis, dsh-llm, dsh-settings, dsh-web, ...) at the exact `0.1.0-rc.6`
  versions the harness runs — enough to develop bundles without a checkout.
- **Docs**: the repo's `docs/` tree on GitHub; the shipped presets' own
  skills (`editing-cordis-compositions`, `cordis-plugin-development`) are the
  in-session guides for composition and dynamic-plugin work.

## 4. Map of the packages that matter

| Package | Role |
|---|---|
| `@deepseek-ai/cordis` | the framework (contexts, services, events, plugins) |
| `cordis-plugin-loader`, `cordis-plugin-include` | cordis.yml loading, entry groups, patch composition |
| `dsh-app-boot` | boot orchestration, profile boot script (`profile-boot-*.js`) |
| `dsh-base` | core service registries (shared by every surface) |
| `dsh-web-app` | the web bundle and its patch layer (`cordis.patch.yml`) |
| `dsh-skill`, `dsh-skill-filesystem` | skill registry and filesystem discovery |
| `dsh-client-ui-input-trigger` | the `/` and `@` candidate menus (sources: command, skill, subagent) |
| `dsh-agent-presets`, `dsh-agent-instructions`, `dsh-persona` | preset machinery and prompt assembly |
| `dsh-settings`, `dsh-settings-file` | `settings.yaml` (LLM provider routes, theme, ...) |
| `dsh-llm` | the LLM seam (provider routes; e.g. `dsh-llm-cursor` registers a provider here) |
| `dsh-tool-*` | one package per model tool (bash, fs, subagent, cordis, skill, ...) |
| `dsh-host-webserver`, `dsh-host-apiproxy` | HTTP surface and `/api` endpoints |

## 5. How to work here

- This repo is a pnpm workspace of hand-made bundles. Plugin deps peer on
  `@deepseek-ai/*` and are pinned at the root `package.json`. Source changes
  need `pnpm build`, then a harness restart (the harness does not watch this
  repo; HMR only covers client-plugin dev with `pnpm run dev:web`).
- In-session entry points: load `editing-cordis-compositions` before writing
  a composition; `cordis-plugin-development` for dynamic plugins. The
  `cordis_inspect_*` tools expose the live Service/Event/Slot/Tool contracts
  of the running instance.
