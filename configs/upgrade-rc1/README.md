# Candidate configuration for DSH 0.2.2-rc.1

[The observation overlay](preserve-observation.patch.yml) keeps the filesystem read/observed-version policy enabled when upgrading from `0.2.2-alpha.2`, despite the new upstream default. It is a reviewable overlay, not an installed bundle. It does not change model routing, preset scope, or existing configuration values.

Exa users also need the [external compatibility provider](../../plugins/dsh-web-search-exa-compat/README.md), removal of the old Core-linked dependency, and explicit transfer of any old Exa row configuration. Do not change to a different search provider implicitly.

Before adopting this candidate, resolve every installed package's target-version requirements, test the complete selected profiles and preserve local Core changes. New subagent creation writes catalog payload version 3, and named Team task assignments also affect persisted data: old releases cannot safely reopen the new records. Upgrade all processes sharing the store and establish backup/restore limits before allowing those writes. These source and configuration candidates are not a completed live upgrade.
