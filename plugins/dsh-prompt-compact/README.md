# dsh-prompt-compact

Opt-in prompt alternatives for DeepSeek Harness 0.2.1. Upstream tool plugins remain installed; this plugin replaces reviewed Workflow and Ralph system-prompt sections in the selected preset.

## Behavior

- Workflow and Ralph retain explicit-request restrictions and alternatives. Ralph retains the warning that worker reports are not independent verification.
- Cordis and Subagent guidance come directly from DSH. The legacy dynamic-plugin Skill is not registered.
- Tool schemas, permissions, runtime context, execution defaults, ordering, and complete-prompt overrides are unchanged.

The plugin uses the public `system-prompt/assemble` waterfall and calls `next()`. Disposal restores upstream behavior on the next assembly without rewriting Session history.

Only the two sections in `index.mjs` are eligible. Each original must match its reviewed SHA-256 fingerprint. Changed or customized instructions remain intact and produce a warning once per text version; empty or missing sections stay absent. Review the upstream contract before changing a fingerprint.

## Install and opt in

Use the built CLI from the upstream version you run:

```sh
node "$DSH_UPSTREAM_ROOT/apps/cli/lib/bin.js" plugin --profile web add /path/to/deepseek-harness-plugins/plugins/dsh-prompt-compact
```

The bundle patch is empty: installation makes the package resolvable but does not enable it globally. Add this row to the `config.plugins` list of a locally authored `@deepseek-ai/dsh-agent-preset` declaration, never a shipped file:

```yaml
- id: prompt-compact
  name: '@kkiyama117/dsh-prompt-compact'
```

Keep the normal tool plugins. This row consumes `systemPrompt`, publishes no service, and needs no isolate realm. Restart DSH after changing package files and verify a new session. Remove the row to opt out; remove the bundle only after no preset references it.

The runtime imports only Node built-ins, avoiding a second copy of Cordis or DSH registries from this repository's older dependencies.

## Verification

```sh
DSH_UPSTREAM_ROOT=/path/to/built/upstream node --test plugins/dsh-prompt-compact/tests/plugin.test.mjs
```

Tests use that checkout's real Cordis, scope, and system-prompt services. They cover sibling-scope isolation, disposal, complete-prompt overrides, waterfall delegation, unchanged schemas/context, reviewed-source matching, and retention of customized instructions. They do not establish improved task quality for a live model. The legacy `tests/preset-probe.mjs` targets the retired directory-preset API and is not the validation entry point for 0.2.1.

## Provenance

`UPSTREAM.json` records the reviewed upstream commit. The retained Skill files document the old runtime and are not registered by this version. `LICENSE` preserves the upstream notice.
