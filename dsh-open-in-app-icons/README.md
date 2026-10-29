---
description: "Supply generic icons for selected local applications without changing DSH Core or its application launcher."
kind: "package-bundle"
---

# @local/dsh-open-in-app-icons

English | [日本語](README.ja.md)

## Summary

This bundle supplies cacheable generic images for application icon URLs that have no usable icon on this host. Its default selection covers `filemanager`, `cursor`, and `vscode`. It preserves the existing browser authentication, application catalog, launcher, and other icon URLs. It adds no browser code and changes no Core files.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Install the verified release archive into the intended profile through Plugin Manager, using `action: install_bundle` and its absolute archive path as `target`. The layer inserts only `local-open-in-app-icons`; it does not disable or replace the upstream plugins. Disable this bundle through Plugin Manager to remove its routes. A browser may retain already cached images until their cache lifetime expires.

The complete local selection is in [cordis.patch.yml](cordis.patch.yml). `applicationIds` is a required nonempty list of distinct lowercase application ids. `cacheMaxAgeSeconds` is a required nonnegative integer; the supplied layer uses 3600 seconds. A profile override replaces the complete config, so retain both fields.

Only authenticated GET requests for the selected exact paths receive an SVG with status 200 and a private browser cache lifetime. Authentication and trust failures remain 401 or 403; other methods remain 405. Other paths retain the upstream response, including unknown icon ids and unavailable change summaries.

## Understand the implementation

[The Host plugin](index.mjs) registers exact routes through the public `webServer.register` API. Exact routes take precedence over the existing upstream icon prefix. Every route uses `connection.requestRejection` before returning image bytes. Context effects remove all registrations on unload; activation fails for invalid config, duplicate ids, a missing bundled image, or an exact-route collision.

[The SVG](assets/fallback.svg) reuses DSH's existing `right-up-outline` geometry under the included [MIT license](LICENSE). Its neutral gray works as a standalone image on light and dark backgrounds; it does not claim to be an application logo.

Run the source regressions with `uv run --no-project bin/test.py`. Pass `--package /absolute/path/to/unpacked/package` to run the same tests against an unpacked release. The tests use a real Cordis Loader, WebServer, and upstream open-in-app implementation, with deterministic desktop and authentication fixtures. The running browser is verified separately after deployment.

## Model Experience

None. This bundle adds no model tools, instructions, or Session events.

### Token effect

None.

### KV Cache effect

None.

## Known Limitations and Deferred Work

Each selected URL intentionally serves the generic image, even if an application icon becomes available later. Remove that application id and reload the configuration to restore upstream icon discovery. The plugin does not discover missing icons automatically, change application availability, create desktop entries, persist change summaries, or filter Console errors. Its manifest restricts activation to the tested DSH version; verify compatibility before widening that requirement.
