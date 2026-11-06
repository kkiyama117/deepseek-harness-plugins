# Compile and run on DSH

## Prepare

Read the request format and deployment policy. Discover current provider/model routes with `list_subagent_models`; do not assume the example policy is available in another environment. Store real packets privately outside this skill. Do not read credentials or install another DSH launcher.

`bin/compile.mjs` is an offline generator, not an application entry point. The optional [Jev routing generator](jev-routing.ja.md) can make one authorized external classification request; it never executes agents. Runtime execution goes through the existing native `workflow` tool. Node.js 22+ is sufficient; there are no package dependencies or build/install steps for the compiler.

From this skill directory, compile a synthetic example into a new private directory whose parent already exists:

```sh
node bin/compile.mjs examples/single.json examples/policy.json /ABSOLUTE/PRIVATE/new-run
```

The generator validates inputs before creating a mode-0700 directory. It writes mode-0600 `tool-input.json`, `workflow.js`, `args.json` and `manifest.json`. It refuses to overwrite an existing directory. Interrupted output is not a submitted workflow; preserve it and use a new directory for another compilation.

For real tasks, use the same command with your prepared request and separately authorized policy. The tool input includes all resolved data so its exact SHA-256 identifies the submitted intent; it is not evidence that submission or acceptance happened.

## Submit

Confirm that the live `workflow` tool declares `resultKeys`; an older Host must be updated before submission. Do not drop the field as a fallback. Read `tool-input.json` using the harness file tool. Call `workflow` with its exact four fields: `meta`, `script`, `args`, `resultKeys`. The runner source is fixed, not rewritten by the selecting model. Data stays in `args`; do not interpolate task text into executable JavaScript. Do not run the script via a replacement server, unofficial Node application, dynamic import, or filesystem access inside the workflow VM.

Use native workflow only after an explicit human workflow/large-orchestration request. The parent waits while the runtime coordinates fresh children. The script handles ordinary null results explicitly, does not use `filter(Boolean)` as success checking, and never silently downgrades a failed route. Host cancellation and host call ceilings still apply.

Keep the compact native tool result, full-result retrieval reference and observed run ID alongside the compiled artifacts. The Host saves the complete script result before returning the selected fields; use targeted `read`/`grep` retrieval only when acceptance needs more evidence. Do not label the inline projection as the full `result.json`. Preserve or copy the saved full artifact through authorized filesystem operations when retention beyond the spill store's lifetime is required. On host failure, record the error and known run ID rather than invent an equivalent success record. Requested role bindings are not proof of effective provider fallback: inspect child runtime metadata when an actual-model claim matters, and find it as [Confirm the effective model](run-dsh.md#confirm-the-effective-model) says.

The adapter cannot resume a stopped graph or reuse child sessions. Before another run, inspect existing artifacts and uncertain effects. Do not blindly replay all nodes. A bounded repair inside a successful native call is different from resubmitting a failed workflow.

## Confirm the effective model

Requested routes are not observed identity ([acceptance evidence](acceptance-evidence.md)). The Session root is composed from the profile, its bundles, the profile's and the home `cordis.patch.yml`, and any `--patch` overlay, so searching a fixed `<DSH_HOME>/sessions` path can read a stale store and miss the run entirely.

Resolve the log from the same composition that ran the work. From this skill directory, pass the profile and the same `--patch` overlays as the run:

```sh
node bin/session-log-path.mjs --profile <profile> [--patch <overlay>]... --session-id <child-id>
```

It prints the effective `root`, the config `layer` that set it, and the `log` path of the newest generation, chosen as the Session backend chooses it. When nothing matches, it exits 1 and prints the pattern it searched and the effective root with its layer; that output is the coverage gap to report, rather than a reason to search other roots by hand. It reads directory listings only and never opens a Session file. Like every `dsh` start, it rewrites the profile's fixed `cordis.yml`; it refuses a profile that does not exist yet, so a lookup never creates one. When the launcher cannot run in the current environment, save `dsh --profile <profile> --dump-config` where it can run, pass that file with `--dump-file`, and record why.

Then read the route recorded in that log:

```sh
node bin/session-route.mjs <log>
```

It prints the `log`, how many `inherited` events a forked child copied from its parent (those are skipped), the `descriptor` the parent wrote when it created the child, and one `route` line per distinct `request/header` route after the inherited events. A continuable child's descriptor names the requested route (`agentProvider`, `agentModel`, `agentReasoningEffort`); `subagentProvider` is the subagent provider, not an LLM provider; a one-shot child's descriptor has no route. The `route` lines are what each request was prepared with, so they are the evidence for the effective model. The tool prints only these values and never other Session content; still run it only when an actual-model claim needs it. A missing log, or a log without a route, is not evidence that a different model ran, and it is not evidence for the requested route either.

## Verify

```sh
node --test tests/*.test.mjs
uv run bin/check-files.py
```

Use `node bin/update-expected.mjs` only when intentionally updating prompt snapshots, then review the generated diff. Tests use fake agents and synthetic data. They cover template transitions, parallel admission, condition branches, repair limits, invalid inputs, graph authoring constraints and compact summary preservation. The compiler tests execute generated plain JavaScript with only documented hook names in a local VM and verify private artifact output. They do not prove host cancellation behavior or model performance; a separate small native workflow smoke covers actual DSH integration.

## Install or migrate the skill

```sh
uv run bin/install.py
```

The installer links this entire source directory as `~/.agents/skills/orchestrate-agents`. If a different directory or link already exists there, it moves the exact entry to a private timestamp/UUID backup under `~/.local/state/orchestrate-agents/backups/`. It also moves the retired `task-router` entry there, keeping only one active skill policy. It does not edit global instructions, unrelated skill names, DSH profiles or credentials. Repeated installation against the same link is a no-op.

If another harness uses a different discovery directory, follow that harness's documented installation mechanism. Source control belongs to the source directory, not the discovery link. Confirm discovery using the native skill tool after installation.
