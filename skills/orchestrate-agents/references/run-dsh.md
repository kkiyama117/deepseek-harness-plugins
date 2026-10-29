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

Keep the compact native tool result, full-result retrieval reference and observed run ID alongside the compiled artifacts. The Host saves the complete script result before returning the selected fields; use targeted `read`/`grep` retrieval only when acceptance needs more evidence. Do not label the inline projection as the full `result.json`. Preserve or copy the saved full artifact through authorized filesystem operations when retention beyond the spill store's lifetime is required. On host failure, record the error and known run ID rather than invent an equivalent success record. Requested role bindings are not proof of effective provider fallback: inspect child runtime metadata when an actual-model claim matters.

The adapter cannot resume a stopped graph or reuse child sessions. Before another run, inspect existing artifacts and uncertain effects. Do not blindly replay all nodes. A bounded repair inside a successful native call is different from resubmitting a failed workflow.

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
