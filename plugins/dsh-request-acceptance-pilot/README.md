# Request acceptance pilot

This bundle confines the acceptance policy to the exact Session ids in [cordis.patch.yml](./cordis.patch.yml). It imports the maintained external `@kkiyama117/dsh-goal-acceptance` package; no source or runtime module under Core's former Goal acceptance directory is required.

The patch disables the official Goal/subagent provider rows and installs the external subclasses. The replacement subagent row explicitly retains the deployment's `maxDepth: 2`; settings on the disabled row do not transfer. Other Session ids retain ordinary Goal completion and delegation behavior. The recorded checkpoint format, projection key, and model-facing tool text remain unchanged.

The legacy synthetic probe remains restricted to its original fixed Session ids and existing evidence check. It writes to a fixed private report directory outside a separate worktree. Do not run it from another checkout or widen its ids to test a deployment. Use fresh isolated fixture Sessions and the package's composition tests instead. The manifest also references a machine-local Goal acceptance archive; a fresh checkout does not supply that archive.
