---
name: quint-cli
description: >
  Invoke the `quint` CLI (typecheck / run / test) inside this DeepSeek Harness, where the agent's
  `bash` tool runs in a sandbox that cannot reach a host-installed `quint`. Quint runs inside the
  prebuilt `localhost/claudecode:latest` container image (Quint 0.32.0) through the `container_exec`
  (podman) tool, with the repository mounted. Use this whenever you actually need to EXECUTE a
  `.qnt` spec — typecheck it, simulate invariants/witnesses, run scenario tests, or reproduce a
  counterexample trace — not for Quint syntax questions (those are `quint-lang`). The `quint-lang`,
  `quint-modeling`, and `quint-execute-spec` skills teach WHAT to run; this skill teaches HOW to
  invoke `quint` in this harness. Keywords: quint, typecheck, run, test, verify, container_exec,
  podman, claudecode, sandbox, simulation, invariant, counterexample.
whenToUse: >
  You are about to run `quint typecheck|run|test` on a `.qnt` file in this harness, or a Quint
  command failed because `quint` is not found or permission-denied in the sandbox. Load this for
  the exact `container_exec` invocation, then load `quint-lang` for CLI flags and reading output.
---

# Running the `quint` CLI in this harness

The agent `bash` tool is sandboxed (Mirage VFS): no `quint` on PATH, and it cannot reach host
tools. Quint is provided by the prebuilt image `localhost/claudecode:latest` (`quint` 0.32.0 at
`/usr/bin/quint`). Run it through the **`container_exec`** tool (`runtime: "podman"`), **not**
`bash`.

## Canonical invocation

Call `container_exec` with `runtime: "podman"`; everything after the image name is the `quint`
subcommand and its args (passed verbatim — no shell, so no pipes or redirects):

```
run --rm --user 0 --entrypoint /usr/bin/quint \
  -v quint-eval-cache:/root/.quint \
  -v /data/softwares/deepseek-harness-plugins:/work -w /work \
  localhost/claudecode:latest  <SUBCOMMAND> <QUINT_ARGS...>
```

Why each flag:

| Flag | Reason |
|---|---|
| `--user 0` | Repo `.qnt` files are mode `0600`, owned by the host user. Rootless podman maps container UID 0 → the host user, so `quint` can read them. Without it: `EACCES: permission denied`. |
| `--entrypoint /usr/bin/quint` | Bypass the image `entrypoint.sh`, which on first boot writes `.mcp.json`/`.claude` into the workdir and would pollute the mounted repo. `/usr/bin/quint` is the CLI (`@informalsystems/quint`). |
| `-v quint-eval-cache:/root/.quint` | `quint run`/`test` download a Rust evaluator on first use to `~/.quint`. A named volume persists it across runs so it is fetched once, not every call. (`typecheck` does not need it.) |
| `-v <repo>:/work -w /work` | Mount the repository as the workdir; give spec paths relative to the repo root. For another repo, replace the mount source with that repo's root. |

## Subcommands

Verified here against `skills/implement-task/spec/`:

Typecheck — exit 0 on success (verified):
```
... typecheck skills/implement-task/spec/implementTask.qnt
```

Simulate invariants + witnesses — `[ok] No violation found` (verified, small samples):
```
... run skills/implement-task/spec/implementTask.qnt --main=implTaskGate \
    --invariants=fixRoundCap --max-steps=40 --max-samples=1000
```
The full invariant/witness lists and the `--main=implTaskPreApproved` instance are in
`skills/implement-task/spec/README.md`.

Scenario tests — same simulator as `run`:
```
... test skills/implement-task/spec/implementTask_test.qnt --main=implTaskGateTest
```

`quint verify` (Apalache/TLA backend) is not covered here — it needs the Apalache jar; confirm the
image has it before relying on `verify`.

## Notes

- `container_exec` passes `args` verbatim (no shell): one `quint` subcommand per call.
- Output (states, `[ok]`/violation, counterexample traces) prints to stdout — read it directly.
- For Quint syntax, operators, and reading counterexamples, load **`quint-lang`**.
