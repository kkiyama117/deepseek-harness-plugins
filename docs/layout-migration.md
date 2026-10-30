# Migrating an existing installation to the new layout

The source layout moves plugin packages and forks under `plugins/`, and configuration-only bundles under `configs/`. `skills/`, `presets/`, and `compat/` retain their existing locations. Package names and selected workspace members do not change. This is a source-tree change, not an installation or profile migration.

## Before switching a live checkout

1. Inventory references to the old root-level directories in every affected profile's package dependencies, installed links, Cordis patches, preset declarations, service files, timers, scripts, and other projects. Include relative links, absolute paths, `file:` and `link:` dependencies, and configuration copied from this repository. Record the current configuration and hashes without exposing secrets.
2. Account for ignored build output and dependencies as well as tracked files. A fresh worktree does not include generated `lib/` directories. Rebuild each selected package with its documented toolchain, and inspect its pack contents before installation.
3. Check the scheduled and currently active work, agree on a safe cutover window, and prepare a tested rollback. A `rename` followed by a compatibility symlink is not atomic; it can temporarily break a live reference. Node's realpath-based dependency resolution can also differ after a move. Do not assume a symlink or an old generated bundle is sufficient without testing the actual loader and profile.
4. Update only authorized live configurations using the supported installation and service-management mechanisms. Validate the actual affected profiles and service start paths, and exercise the relevant functionality. Retain compatibility links until all consumers have been accounted for and verified.

The retained Slack worker configuration and compatibility daemon patch contain machine-specific absolute paths and must be checked before deployment elsewhere. Some historical, one-off maintenance scripts and reports also retain old paths and must not be reused without review. In particular, the 2026-10-30 compatibility preparation script is specific to its original candidate and is not a general-purpose migration tool. The request-acceptance pilot depends on a machine-local release archive, and its retained synthetic probe writes to a fixed private report directory: do not run that probe from another checkout. The migration does not alter DSH core, user configuration, installed profiles, or running services.

## Source checks

From a checkout that has the new layout, `python3 bin/check-layout-links.py` checks local Markdown links against tracked targets at the checkout's current `HEAD`. With a separate pre-migration checkout, `python3 bin/compare-layout-packages.py /path/to/baseline` compares `npm pack --dry-run` file lists. The latter requires both checkouts to have their generated outputs and does not verify file contents or a fresh build. Run package-specific tests and the selected workspace's frozen install, build, and tests separately; neither helper proves that a live configuration works.
