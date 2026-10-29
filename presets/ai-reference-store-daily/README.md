# AI reference-store daily preset

This configuration-only bundle declares `ai-reference-store-daily`. It preserves the supplied-task-only persona, native task provider, executable/store locations, and receipt directory. Selecting the preset does not start a daily batch; the daily application's profile owns that operation.

Maintain the declaration here and deploy its release archive through the DSH plugin CLI. The Harness home stores profile selection and overrides, not the maintained preset source. The retired directory-format files are preserved in Git history; the active declaration is `cordis.patch.yml`.

The existing preset name and description provide its user-facing identity. This source relocation does not add a new UI feature or change its appearance.
