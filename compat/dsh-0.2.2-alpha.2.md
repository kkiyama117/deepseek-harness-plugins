# DSH 0.2.2-alpha.2 compatibility preparation

These candidate manifests add the exact `0.2.2-alpha.2` runtime and its Cordis/Schemastery alpha versions to the existing supported ranges. They do not grant version exemptions, change preset policy, select different models, or alter the deployed profiles. The candidate packages require deployment approval and current-source integration review.

The external Goal policy retains its tool declaration, stored checkpoint format, selected-Session behavior, and provider configuration. Its typed consumers and Loader/Remote composition are exercised against the target. Native Slack adapter tests use the explicit target's Cordis, loader, and include identities; they reject an unreviewed Host version rather than loading the plugin repository's development peers.

## Required migration review

- Schedule replaces `schedule_update` and `schedule_delete` with `schedule_edit`, adds `schedule_view`, and uses RRULE plus an explicit target. Management becomes Host-wide rather than Session-local. Existing reminders retain timing, but the first successful storage-v2 write prevents the older binary from reopening that unit; back up before deployment and design rollback before allowing writes.
- Attachment reads require the complete image reference, not only an attachment id. Session membership is not the image-access check; review deployments that rely on per-Session image isolation.
- Client context-menu targets, hooks, and keyed icons have changed. Reasoning renderers use `rawText` only when they need the original output; ordinary display continues to use `text`.
- `session.follow` requires explicit `activate: true` when a consumer intends to resume an Agent. An opening snapshot alone does not establish activation readiness.
- Web file actions now provide browser Download for ordinary files. This can replace some local download additions, but equivalent placement, naming, content and usage must be verified before disabling a custom action.

The runtime's owning upgrade guides describe exact requests and types. A passing version-range check or basic profile launch does not certify every third-party UI operation, remote pairing, real model provider, or business batch.
