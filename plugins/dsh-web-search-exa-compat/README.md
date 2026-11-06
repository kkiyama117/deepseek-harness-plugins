# Exa search compatibility candidate

This external provider retains the Exa implementation from DSH `0.2.2-alpha.2` for the `0.2.2-rc.1` runtime, which removed the bundled Exa package. It registers provider `exa`, preserves result mapping and explicit request limits, and rejects credential-bearing redirects. The provider does not select itself or change model routes, billing settings, or credentials.

## Migration before enabling

Remove the old `@deepseek-ai/dsh-web-search-exa` dependency through the supported package manager: a link to its removed Core directory cannot remain. This bundle disables the old `web-search-exa` row and inserts `web-search-exa-compat`; its different id avoids asserting a different plugin name on the old row.

Copy any old row configuration to the new row before enabling it. The fields remain `apiKey`, `baseURL`, `searchType`, `numResults`, and `highlightsPerResult`. Configuration does not transfer between ids. Without `apiKey`, the provider uses the launch environment's `EXA_API_KEY`. Preserve the credential reference without placing secrets in source control. Preserve the existing `web` row's complete configuration, including `searchProvider: exa`; do not replace other fields when patching it.

## Validation and limits

The package carries synthetic request/response, lifecycle, error and proxy tests under `tests/`. Run them through the repository's target-pinned upgrade test configuration. No real Exa request or paid model request is required. Real credentials, installed inventory artwork, and full profile migration still require acceptance before deployment.

The source and MIT license are retained from upstream; [UPSTREAM.json](UPSTREAM.json) records the origin. The magnifier icon is original SVG artwork. This is an unofficial compatibility package, not a new official Exa release.
