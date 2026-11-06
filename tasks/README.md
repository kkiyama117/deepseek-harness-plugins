# Cards

A card is one reviewable diff that belongs to one issue. Leads write cards for the kstack card-flow skill (`/data/softwares/kstack/skills/card-flow/SKILL.md`), and a DSH worker implements one card per run under the [Rules for card implementers](../AGENTS.md#rules-for-card-implementers). The issue stays the unit of intake and delivery ([issue-driven-development](../skills/issue-driven-development/SKILL.md)); a card never replaces it.

## Files and numbers

- One card per file: `tasks/T<n>.md` holds the section `## T<n>. <title>`. Cards are written in English.
- Card numbers are unique across the repository. `dsh-manager` gives each lead a range; use only numbers from your range.
- Cards land on `<land>`, card-flow's name for the branch that cards are committed on. Here `<land>` is the issue's branch `issue/<N>-<slug>`, checked out in the issue worktree `reports/worktrees/issue-<N>`, because `main` changes only through a pull request that the human merges. The card's own worktree is `reports/worktrees/T<n>` on branch `card/T<n>`, made from `<land>`. A card lands by `git merge --ff-only` into `<land>`, never into `main`.
- A card gets `Status: done` once its commit is on `<land>`. The issue is done when its pull request is merged into `main`.

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
- Add one `Must fail without:` line per privacy, contract, or safety guard that the card adds as code: a check that the lead can delete to watch the named tests fail (card-flow section 4, step 5). A rule that only forbids an action, such as "never open Session files" or "print no dump", with no guard code to delete, gets no line. Leave the line out when the card adds no such guard code.
- `Done:` names the gate, normally `python3 bin/gate.py` (see [Card-flow adapter](../AGENTS.md#card-flow-adapter)). A card that runs before the gate exists lists the exact commands instead, always including `python3 bin/check-layout-links.py` and a whitespace check that also sees the card's new, untracked files (`git diff --check` alone does not).
- Add `Status: done` only after the land. A card without it is not done.
