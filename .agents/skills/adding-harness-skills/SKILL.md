---
name: adding-harness-skills
description: "How to add a skill to the DeepSeek Harness (DSH): where skill files live, the SKILL.md frontmatter contract and name rules, discovery roots and precedence, and the silent-drop pitfalls that make a skill not appear. Use when asked to create, edit, or debug a harness skill, or when a skill does not show up in the \"/\" menu or the agent skill catalog."
whenToUse: "Use when creating a new skill, moving or registering skills, or debugging a missing skill (not listed under \"/\" or absent from the agent skill catalog)."
metadata:
  appliesTo: deepseek-harness
---

# adding-harness-skills — how to add a skill to the DeepSeek Harness

## 1. The pipeline

`@deepseek-ai/dsh-skill-filesystem` registers a provider on the host `skills`
registry (the `SkillRegistry` in `@deepseek-ai/dsh-skill`). It discovers
candidate skill files from a set of roots, parses each `SKILL.md` frontmatter,
and the registry merges the candidates (dedupe by name, precedence by rank)
and serves summaries. The GUI `/` menu's "Skills" group and the agent's skill
catalog are both views of that registry snapshot, filtered by
`user-invocable` / `model-invocable`.

## 2. Where skills live (roots and precedence)

`gitroot` = the first ancestor of the session cwd that contains a `.git`
directory. Discovery scans these roots in this order (lower rank wins when two
roots offer the same skill name; the nearest scope layer wins across layers):

| Root | source | rank |
|---|---|---|
| `<gitroot>/.dsh/skills` | project-dsh | 100 |
| `<gitroot>/.agents/skills` | project-agents | 200 |
| preset `customSkillDirs` (agent.cordis.yml) | custom | 300 |
| `~/.dsh/skills` | user-dsh | 400 |
| `~/.agents/skills` | user-agents | 500 |
| bundled (deployment `config/agent-presets/.../skills`) | bundled | 600 |

Consequences:

- Project-root skills (`.dsh/skills`, `.agents/skills`) are visible **only to
  sessions whose cwd is inside that repo** (the git root is derived from the
  session cwd).
- `~/.dsh/skills` is global to the machine. Symlinks into it work (the
  filesystem layer follows them with `stat`) — the convention in this repo is
  to keep the source in `skills/<name>` and symlink `~/.dsh/skills/<name>`.

## 3. File formats and the frontmatter contract

Two accepted layouts per root entry:

- Directory bundle: `<name>/SKILL.md` (resources may sit next to it; the skill
  reports its directory as the resource base).
- Flat file: `<name>.md`.

Frontmatter (between the leading `---` lines), parsed with the `yaml` npm
package:

| Key | Required | Rules |
|---|---|---|
| `name` | yes | must match `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` (kebab-case, lowercase) |
| `description` | yes | non-empty string; shown in menus and used for matching |
| `whenToUse` | no | string; guidance for when the model should load the skill |
| `metadata` | no | any YAML object (carried through to consumers) |
| `user-invocable` | no | boolean, default `true` — whether it appears for `/name` invocation |
| `disable-model-invocation` | no | boolean, default `false` |

Legacy keys `modelInvocable` / `userInvocable` are **rejected** (the file is
ignored, not migrated). The markdown body after the closing `---` is the
instruction text.

## 4. Pitfalls that silently drop a skill

Any of these makes the provider log a warning (`skill file <path> ignored:
...`) and skip the file — nothing appears in the UI:

- **Invalid YAML frontmatter.** The classic trap: a plain-scalar value
  containing `: ` (colon followed by space) is a YAML syntax error
  (`Nested mappings are not allowed in compact mappings`). Quote such values,
  e.g. `description: "Implement ... (flow: scope → plan) ..."`.
- Missing frontmatter, or `name`/`description` missing or empty.
- Skill name failing the kebab-case regex.
- An entry that is neither a directory with `SKILL.md` nor a `.md` file.

## 5. Authoring guidance (good practice)

Follow the established agent-skills authoring conventions rather than
inventing your own — the canonical references are `skill-creator` from
[anthropics/skills](https://github.com/anthropics/skills) and the
[Agent Skills authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices):

- **Description triggers.** Write it as an imperative "Use when ..." — name
  the user phrases and contexts that should trigger the skill, and what it
  enables. Specific beats generic: say what the skill does, not "handles
  errors appropriately". Optimize it iteratively; the description is what
  decides whether the skill fires.
- **Body.** Concise, structured, actionable instructions (steps, tables,
  formats) grounded in the actual domain — the roots, contract, and pitfalls
  above are the model. Do not narrate the author's own debugging sessions,
  repo history, or how the skill came to exist; state the rules, not the story.
- **Process.** Author like a creator, not a writer: capture intent, draft,
  then run real test prompts through an agent with access to the skill,
  evaluate results, and rewrite. Skills with objectively verifiable outputs
  benefit from test cases; subjective ones need evaluation by use.
- **Name.** Short kebab-case; the harness enforces
  `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`.

## 6. Refresh and testing

- The provider watches every root (chokidar) and model-facing `write`/`edit`
  mutations invalidate the catalog immediately — no restart needed.
- Test by typing `/name` in the GUI input (it shows under the "Skills" group),
  or by asking the agent to list its skills.
- If a skill still does not appear, check the host log for the
  `skill file ... ignored` warning — it names the exact reason.
