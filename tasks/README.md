# Cards

A card is one reviewable diff that belongs to one issue. Leads write cards for the kstack card-flow skill (`/data/softwares/kstack/skills/card-flow/SKILL.md`), and a DSH worker implements one card per run under the [Rules for card implementers](../AGENTS.md#rules-for-card-implementers). The issue stays the unit of intake and delivery ([issue-driven-development](../skills/issue-driven-development/SKILL.md)); a card never replaces it.

## Files and numbers

- One card per file: `tasks/T<n>.md` holds the section `## T<n>. <title>`. Cards are written in English.
- Card numbers are unique across the repository. `dsh-manager` gives each lead a range; use only numbers from your range.
- A card is committed on its issue's branch `issue/<N>-<slug>`, in the issue worktree `reports/worktrees/issue-<N>`. The card's own worktree is `reports/worktrees/T<n>` on branch `card/T<n>`, made from the issue branch. A card lands by `git merge --ff-only` into the issue branch, never into `main`; `main` changes only through a pull request that the human merges.
- A card gets `Status: done` once its commit is on the issue branch. The issue is done when its pull request is merged into `main`.

## Card format

```text
## T<n>. <title>

Issue: #<N>.

Needs: <earlier card IDs that must be committed first, or nothing>.

Spec: <doc paths and sections that define the behavior, and the ADR it implements, if any>.

Files: <every file the card may create or change>.

<exact rules: names, signatures, units, error messages, defaults, order, tie-breaks>

| Test | Steps | Assert |
|---|---|---|

Must fail without: <guard> → <test names>.

Done: <the gate command> exits 0.

Status: done
```

- `Issue:` names the one issue the card belongs to.
- `Files:` never lists a dependency or build file (see the implementer rules). A card that needs one is not a card; the lead reports it to the manager.
- The test table gives exact test names and asserts that a user of the code can observe.
- Add one `Must fail without:` line per privacy, contract, or safety guard that the card adds. Leave the line out when the card adds no such guard.
- `Done:` names the gate. The repository gate and the narrower gate that a worker can run in its sandbox are added in [#47](https://github.com/kkiyama117/deepseek-harness-plugins/issues/47); until then, `Done:` lists the exact commands, always including `uv run --no-project bin/check-layout-links.py` and `git diff --check`.
- Add `Status: done` only after the land. A card without it is not done.
