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

- None beyond a package directory under `plugins/` or an archive under `releases/`. `dshv up` performs the install.

- **Install.** Run `dshv up plugins/<pkg>` (or `releases/<pkg>.tgz`). Exit code 0, and the output ends with the run path.
- **Composed tree.** Run `dshv exec "$RUN" -- dsh --profile web --dump-config`. The output has a `# == <package name>` section listing the bundle's row ids.
- **Active in the host.** Run `dshv doctor "$RUN"`. One `ok   <entryId> is active` line appears for every row of the package.
- **Headless pending.** Run `dshv exec "$RUN" --cd "$RUN/home" -- dsh --profile headless "Say hello"`. Stdout is `mock response recovered`. Stderr lists any web-only row as `pending (waiting for service: …)`.

## Gotchas

- `dsh plugin add link:` prints a peerDependencies warning for `@deepseek-ai/cordis`. It is harmless when doctor shows the rows active.
- A bundle whose manifest pins DSH versions (`engines.dsh`, peer ranges) can install and still fail to mount on another DSH version. Doctor's `failed` rows show this; the DSH version is the first doctor line.
- `link:` tests the working tree, including uncommitted edits. Pass the `.tgz` to test what will ship.
- Rows that inject a web-only service (for example `workspaceRegistry`) stay `pending` in headless by design. That is not a failure of this feature.
