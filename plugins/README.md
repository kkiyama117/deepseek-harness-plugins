# Plugin sources and local forks

Each subdirectory is an individual plugin, bundle, adapter, or retained reference implementation. This directory is not a single installable bundle. Check each component's manifest and README for compatibility, installation, and tests; presence here does not imply it is active or maintained.

The `dsh-web-ui` fork retains its own `packages/` layout. `subagent-fallback` is a legacy reference used by the retained `implement-task` materials, not a standalone bundle. See [maintenance scope](../docs/maintenance-scope.md) before removing any source.

Configuration-only bundles live under [configs/](../configs/); skills and preset declarations remain in [skills/](../skills/) and [presets/](../presets/).
