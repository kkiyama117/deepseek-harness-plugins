# Aistore structured reader

This bundle declares `aistore-native` for structured reader and reviewer child Sessions. It installs no task tools, excludes global tools through a scoped restriction, and mounts the native tool executor in its own scope before publishing the preset. The subagent runtime adds its activation-owned `structured_output` tool. Registrations and restrictions are effect-owned by Cordis.

The native aistore adapter selects this preset explicitly. A missing preset rejects child creation; it never falls back to the parent's tool-enabled composition. Install the bundle into every profile that runs native aistore tasks. The icon is original artwork created for this local bundle.
