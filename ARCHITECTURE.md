# Architecture Overview

Two axes. Do not mix them: **what runs** is not **what is proven**.

## 1. Runtime structure

DSH boots a **host** Cordis tree, then mounts one **agent preset** per session. Plugins are rows. Rows come from stacked layers, and each layer applies its patches in order: a plain patch updates the row it matches **by id** (later layer wins on the fields it sets; a match-less patch warns and is skipped), while an `insert:` appends new rows and is **not** deduplicated — two layers inserting the same row id both land and the composition fails to load.

```
shipped DSH install          this repository                 ~/.dsh (user runtime)
─────────────────            ───────────────                 ────────────────────
@deepseek-ai/dsh-*           plugin packages                 profiles/<name>/
shipped agent-presets        skills/                         ├─ package.json  (bundle list)
(do not edit)                subagent-fallback/              ├─ cordis.patch.yml
                             llm-fallback/                   └─ node_modules (links)
                             dsh-slack-intake/               cordis.patch.yml   (home overlay)
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

The `implement-task` skill is a process. Three artifacts sit under `skills/implement-task/spec/`. They are not equally strong.

| Layer | What it is | What it proves | What it does **not** prove |
|---|---|---|---|
| Skill prose | `SKILL.md` flow | Intent | Anything at runtime |
| Quint model | `implementTask.qnt` + scenario tests | The *specified* phase machine (guards, invariants, witnesses) | That a live agent followed the skill |
| Proto-1 gate | Locked counterexample on `BUGGY_FIX_CAP` | Deterministic regression on the **model** | Live agent behavior |
| Proto-2 replay | Coordinator-written `trace.jsonl` → `replay.mjs` → `quint test` | That a **self-reported** trace is allowed by the model | Honesty. A skipped line is invisible. **Experimental / self-reported.** |
| Proto-3 emitter | Host plugin on `tools/result` → per-session `trace.observed.<sid>.jsonl` | **Experimental telemetry, not a gate**: observed tool calls (gate question shape, worker/verify/frontier report heads) can be mapped and replayed; the mapper omits unevidenced actions | Internal phases (SCOPE/CLARIFY/PLAN), the REPORT action, `reportHonesty`, and success beyond recorded evidence. Needs a **dsh restart** after the home-patch row is added; live emit is unverified until then. |

Read `scripts/local-setup.mjs` output and this table before claiming a gate is “enforced.”
