# Slack worker invocation configuration

Install together with the compatible shared Slack Intake adapter in the headless profile. The bundle disables only that adapter's standalone credential/CLI rows; it does not start a worker during an ordinary headless invocation.

The existing systemd worker selects `daemon.patch.yml` explicitly. That overlay preserves the configured routes, limits, identifiers and state directories while resolving the worker through the installed `@kkiyama117/dsh-slack-intake/bridge` export instead of an unversioned absolute source file. It restores the stored credential, authorization, and account providers that the current headless profile disables by default; the worker reads its saved Slack credentials without changing their values. Normal application disposal retains receipt and in-flight-job handling. Because the worker replaces headless startup, its overlay supplies the sandbox policy directly without depending on `headlessStartup`; the existing environment-selected permission mode and process working directory remain in force.

Do not use this overlay for a smoke test against production: it starts the existing continuous worker. Use the adapter's offline tests and its no-model mount check, and restart the owned service only after confirming no job is active.
