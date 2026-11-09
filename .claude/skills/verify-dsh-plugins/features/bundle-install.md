# Install a bundle into a profile

A user adds one of this repository's bundles to a DSH profile. After that, the bundle's rows mount when the profile boots and appear as active plugins in the web UI's plugin inventory.

## Sub-features

- `install-cli` adds a source directory or release archive to a profile with `dsh plugin`.
- `install-compose` lists the bundle's rows in the composed profile tree.
- `install-active` makes every row of the bundle `active` in the running web host.
- `install-headless-pending` leaves web-only rows `pending` in the headless profile, with a printed warning.

## How to get to it (user POV)

- Run `dsh plugin --profile <web|headless> add <link:dir | file:archive.tgz>` in a terminal.
- Run `dsh --profile <p> --dump-config` to see the composed tree.
- Open the web UI and choose `Plugins` in the sidebar.

## Driving it with dshv

Preconditions:

- A package directory under `plugins/` or an archive under `releases/` whose `engines.dsh` and `@deepseek-ai/dsh-*` peer ranges include the checkout's DSH version. `dshv up` performs the install.

- **Install.** Run `dshv up plugins/<pkg>` (or `releases/<pkg>.tgz`). Exit code 0; the JSON has `"run"` and `"doctor": {"ok": true}`.
- **Composed tree.** Run `dshv exec "$RUN" -- dsh --profile web --dump-config`. The output has a `# == <package name>` section listing the bundle's row ids.
- **Active in the host.** Run `dshv doctor "$RUN"`. `checks` has an `<entryId> is active` entry with `"ok": true` for every row of the package.
- **Headless pending.** Run `dshv headless "$RUN" "Say hello"`. `text` is `mock response recovered`, and `warnings` lists any web-only row as `pending (waiting for service: …)`.

## Gotchas

- `dsh plugin add link:` prints a peerDependencies warning for `@deepseek-ai/cordis`. It is harmless when doctor shows the rows active.
- `dsh plugin add` checks `engines.dsh` (or, without it, the `@deepseek-ai/dsh-*` peer ranges) before installing. A bundle pinned to another DSH version is rejected with `installation rejected: Plugin <name>@<version> is incompatible with dsh <version>`, `nothing was installed`, and `dshv up` fails at the install step. The checkout's DSH version is the `dsh build` check, the first doctor line. The `@deepseek-ai/cordis` peer range is not checked, so a stale cordis pin only warns.
- `link:` tests the working tree, including uncommitted edits. Pass the `.tgz` to test what will ship.
- Rows that inject a web-only service (for example `workspaceRegistry`) stay `pending` in headless by design. That is not a failure of this feature.
