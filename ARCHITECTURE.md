# Architecture Overview

Two axes. Do not mix them: **what runs** is not **what is proven**.

## 1. Runtime structure

DSH boots a **host** Cordis tree, then mounts one **agent preset** per session. Plugins are rows. Rows come from stacked layers, and each layer applies its patches in order: a plain patch updates the row it matches **by id** (later layer wins on the fields it sets; a match-less patch warns and is skipped), while an `insert:` appends new rows and is **not** deduplicated — two layers inserting the same row id both land and the composition fails to load.

```
shipped DSH install          this repository                 ~/.dsh (user runtime)
─────────────────            ───────────────                 ────────────────────
@deepseek-ai/dsh-*           plugins/                        profiles/<name>/
shipped agent-presets        configs/                        ├─ package.json  (bundle list)
(do not edit)                skills/                         ├─ cordis.patch.yml
                             presets/                        └─ node_modules (links)
                                                             cordis.patch.yml   (home overlay)
                             …                               skills/<name> → repo or local dir
```

| Layer | What it is | Source of truth | Owner |
|---|---|---|---|
| Repository code | Plugin/skill implementations | this repo | this repo |
| Profile bundles | `dsh.profile.bundles` + linked packages | `~/.dsh/profiles/web/package.json` | user runtime (links point here) |
| Profile patch | Per-profile row overrides (fs/mirage, bind address, disable pet, …) | `~/.dsh/profiles/web/cordis.patch.yml` | user runtime |
| Home patch | Host-wide inserts after the profile (subagent routes, container tools, proto-3 emitter, …) | `~/.dsh/cordis.patch.yml` | user runtime |
| Skill links | Discovery names the harness loads | `~/.dsh/skills/<name>` | link in `~/.dsh`; **code** is the symlink target |
| Shipped preset / harness checkout | Upstream composition and CLI | DSH install | **do not edit** — upgrades overwrite |

Host vs client: a package may have a Node `apply` (host) and a `dsh.client` browser half. Host owns files, tools, events, settings namespaces. Client owns slots and page UI. Only JSON crosses the seam.

Local diagnostic (read-only, no secrets):

```sh
node scripts/local-setup.mjs
```

## 2. Verification structure

Development follows the issue-driven-development skill ([skills/issue-driven-development/SKILL.md](skills/issue-driven-development/SKILL.md)). The skill is a procedure, not an execution platform: it does not enforce permissions, exclusive edits, budgets, or stopping. A task is complete only when its original acceptance conditions and required delivery targets are checked; an agent's success report, a passing test, or an opened PR is not enough.

Each check below proves one narrow thing; do not substitute one for another.

| Check | What it proves | What it does **not** prove |
|---|---|---|
| Package tests and builds (see each package README) | Package source behaves as its tests specify | Compatibility with the user's DSH version; that the runtime loads rebuilt output |
| Root `pnpm build` / `pnpm test` | Root workspace members build and pass | Packages outside the root workspace |
| `bin/gate.py` | Every changed package listed in `bin/gate-checks.json` passes its checks, and the document checks pass | Packages without an entry (it fails instead), packages that need their own `node_modules`, or the live install |
| `bin/check-layout-links.py` | Local Markdown links resolve to tracked targets | That linked content is accurate |
| `bin/check-core-separation.py` | The Core checkout differs from upstream only by the recorded, hash-matched exception ([SOURCE-OWNERSHIP.md](SOURCE-OWNERSHIP.md)) | Runtime placement or profile composition |
| `bin/check-runtime-placement.py`, `bin/verify-runtime-location.mjs` | Services start from the intended checkout and dependency paths ([bin/runtime-placement.md](bin/runtime-placement.md)) | Package behavior inside those services |
| `bin/pack-local-bundle.py` | A release archive contains exactly the reviewed files | That the archive works before it is installed and the profile is checked |
| Skill-bundled checks (for example skills/orchestrate-agents) | The skill's files and scripts pass their own checks | That an agent follows the skill at runtime |

The retained implement-task reference keeps its Quint model and proof-strength table in its spec README ([skills/implement-task/spec/README.md#enforcement-layers](skills/implement-task/spec/README.md#enforcement-layers)); none of those layers gates current development.

Read `scripts/local-setup.mjs` output and this table before claiming a gate is “enforced.”
