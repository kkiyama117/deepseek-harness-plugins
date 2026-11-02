# Workspace attach

Sessions created with `dsh --profile headless` appear as "Ungrouped" in the web sidebar. The web host attaches a Session to a workspace only when the web UI creates it. A headless process must not write the workspace store directly, because the running web host keeps that store in memory and rewrites the whole file.

This package provides a hint-file handoff using two rows from one bundle:

- `local-workspace-attach-producer`: runs in the headless process.
- `local-workspace-attach`: runs in the web host. It injects `workspaceRegistry`, so it stays unmounted where that service is absent, such as the headless profile.

Install the bundle in both the web and headless profiles.

## Use

Run headless from the workspace directory with `DSH_WORKSPACE_ID` set to an explicit workspace id, or to the literal `cwd` to pick the workspace whose path equals the Session cwd:

```bash
cd /path/to/workspace
DSH_WORKSPACE_ID=cwd dsh --profile headless "Summarize the open issues."
```

If `DSH_WORKSPACE_ID` is unset or empty, the producer does nothing.

To override `hintRoot` across both rows in the profile's `cordis.patch.yml` (`hintRoot` must be an absolute path):

```yaml
- id: local-workspace-attach
  config:
    hintRoot: /srv/dsh/workspace-attach-hints
- id: local-workspace-attach-producer
  config:
    hintRoot: /srv/dsh/workspace-attach-hints
```

Producer and consumer must use the same `hintRoot` path.

Consumer-only options:

- `scanIntervalMs` (number, default `30000`): background scan period in milliseconds.
- `maxPendingMs` (number, default `600000`): maximum time in milliseconds to keep retrying an unreadable Session before rejecting it as expired.

## Behavior

On `session/created` for a top-level Session (Sessions with a parent or `origin: subagent` are skipped), the producer writes `<hintRoot>/<sessionId>.json` atomically through a temporary file and rename. It never overwrites an existing hint or rejected record.

The consumer runs in the web host:

- Scans the hint directory at startup, on directory changes (debounced), and periodically every `scanIntervalMs`.
- Processes hints sequentially one at a time.
- Calls the official `attachSession`, which requires the Session's stored cwd to equal the workspace path.

Hint outcomes:

- Attached: hint file deleted.
- Retry: kept while the Session is not readable yet, until `maxPendingMs` elapses, at which point it is rejected as `expired`.
- Rejected: renamed to `<sessionId>.rejected.json` containing the original hint, reason (`malformed-hint`, `unknown-workspace`, `no-workspace-for-cwd`, `attach-failed`, or `expired`), and timestamp. Rejected records are never retried.

Timers and the directory watcher are unreferenced and do not keep a process alive.

## Limits

- The Session cwd must equal the workspace path exactly. Runs started from a scratch directory or a separate git worktree cannot join. The `cwd` mode compares the stored cwd as written, so a cwd reached through a symlink does not match the workspace's resolved path.
- The web host must be running for the attach to happen. Hints wait until the consumer processes them and expire after `maxPendingMs`.
- A hint naming a workspace that does not exist is rejected immediately and is not retried later.

Run package tests with:

```bash
node --test tests/*.test.mjs
```
