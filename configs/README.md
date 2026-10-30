# Configuration-only bundles

These directories contain configuration-only DSH bundles and related service configuration. They are not activated by being present in this repository. Inspect each manifest and patch before installation; some contain machine-specific paths or origins.

Moving these sources does not update existing DSH profiles, systemd configuration, or other external references. Inventory and migrate those references separately before deploying a changed layout.
