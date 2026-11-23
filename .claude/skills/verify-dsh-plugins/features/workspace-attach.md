# Headless sessions join a web workspace

A user runs `dsh --profile headless` from a directory that is a workspace in the web UI, with `DSH_WORKSPACE_ID=cwd` (or a workspace id). The session then appears under that workspace in the web sidebar instead of under `Ungrouped`. Without the variable, nothing changes. The web host attaches the session when it next scans the hints, so a run made while the host is down joins after the host starts; a hint still unattachable after 600 seconds is rejected as `expired`. Subagent sessions never join; only the parent does.

## Sub-features

- `attach-cwd` attaches when `DSH_WORKSPACE_ID=cwd` and the run's cwd equals a workspace path.
- `attach-id` attaches when `DSH_WORKSPACE_ID=<workspace id>` names an existing workspace and the session's cwd resolves (after `realpath`) to that workspace's path.
- `attach-none` does nothing when the variable is unset (the control).
- `attach-reject` rewrites the hint as `<sessionId>.rejected.json` (`{hint, reason, at}`) with reason `unknown-workspace`, `no-workspace-for-cwd`, `attach-failed` (for example an id whose workspace path differs from the cwd), `malformed-hint`, or `expired`. A rejected session is not retried.

## How to get to it (user POV)

- In the web UI, choose `Add workspace`, then `Edit path`, type the directory, press Enter, and choose `Open`.
- In a terminal: `cd <that directory>; DSH_WORKSPACE_ID=cwd dsh --profile headless "<task>"`. The bundle must be installed in both profiles: the producer row writes the hint from `headless`, and the consumer row attaches it in `web`.
- Back in the web UI, the session shows under the workspace header in the `Sessions` tree.

## Driving it with dshv

Preconditions:

- `dshv up plugins/dsh-workspace-attach` (or its release `.tgz`), and doctor shows `include:local-workspace-attach` and `include:local-workspace-attach-producer` active.
- No workspace named `attach-project` exists yet (a fresh run). `DIR=$(dshv state "$RUN" run)/home/attach-project; mkdir -p "$DIR"`.

- **Whole journey.** Run `node .claude/skills/verify-dsh-plugins/scripts/journey-workspace-attach.mjs "$RUN"`. It prints `pass: evidence in …/workspace-attach` and exits 0. It runs the steps below and writes the numbered files named in each.
- **Add workspace.** Run `dshv web "$RUN" click --role button --name "Add workspace"`, then with `--in "dialog=Select Workspace Directory"`: `click --role button --name "Edit path"`, `fill --role textbox --name "Edit path" --value "$DIR"`, `press --role textbox --name "Edit path" --key Enter`, `click --role button --name Open --exact`. `dshv web "$RUN" wait --in "tree=Sessions" --role treeitem --name attach-project` succeeds, and the tree shows one draft `New Session` row under it (`1-workspace-added.png`, `1-sidebar.aria.txt`).
- **Control run.** Run `dshv headless "$RUN" --cd "$DIR" "Say hello"`. `finished` is true, and no `<sessionId>.json` appears in `$(dshv state "$RUN" run)/home/.dsh/workspace-attach-hints/`.
- **Attach run (`attach-cwd`).** Run `dshv headless "$RUN" --cd "$DIR" --env DSH_WORKSPACE_ID=cwd "Say hello"`. Note its `sessionId`.
- **Side effect.** Within 60 s, `dshv store "$RUN" workspace` lists that `sessionId` in the `attach-project` record and not the control's id, and the hint directory has no file for it (`4-workspace-store.json`).
- **Visible result.** Run `dshv web "$RUN" open --reload`, then `dshv web "$RUN" snapshot --role tree --name Sessions`. `attach-project` has exactly one more session row than the baseline (`5-session-grouped.png`, `5-sidebar.aria.txt`), and `result.json` has `"verdict": "pass"`.
- **By workspace id (`attach-id`).** After the journey, find the id with `dshv store "$RUN" workspace` (the key of the `attach-project` record), then run `dshv headless "$RUN" --cd "$DIR" --env DSH_WORKSPACE_ID=<id> "Say hello"`. Within a few seconds its `sessionId` is in the `attach-project` record's `sessionIds`, and the sidebar shows one more `Untitled` row under `attach-project` after `open --reload`.
- **Rejected hint (`attach-reject`).** Run `dshv headless "$RUN" --env DSH_WORKSPACE_ID=no-such-id "Say hello"`. Within a few seconds, `<sessionId>.rejected.json` exists in the hint directory with `"reason":"unknown-workspace"`, and the session is in no workspace record.

## Gotchas

- The default `hintRoot` is `os.homedir()/.dsh/workspace-attach-hints`, not `$DSH_HOME`. Outside `dshv`, a test run writes into the live host's hint directory. `dshv` isolates `HOME` for this reason.
- Adding a workspace in the UI also creates one empty `New Session` in it. Count rows relative to that baseline; do not expect an empty workspace.
- With `DSH_WORKSPACE_ID=cwd`, the cwd must equal the workspace path exactly as stored, which is the `realpath`. A cwd reached through a symlink does not match. The id form compares after `realpath`, so a symlinked cwd can match there.
- Session rows are siblings of their workspace header in the `Sessions` tree, not children. Headers carry `aria-expanded`; rows do not. Clicking a header toggles it, so read `aria-expanded` before clicking.
- A headless session against the mock is titled `Untitled` in the sidebar. Match rows by count or session id, not by title.
- With the bundle in both profiles (as `dshv up` installs it), the headless run warns that `local-workspace-attach` is pending on `workspaceRegistry`. That is expected; only the producer row does anything there.
