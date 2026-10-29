# Agent Note: pi-web-access's keyless DuckDuckGo search transported into the web seam

Status: implemented

English | [中文](2026-08-14-pi-web-access-duckduckgo-transport.zh.md)

## Problem

The harness's only mounted search provider, `web-search-deepseek`, requires a funded DeepSeek API account: with an empty balance every `web_search` call fails (`HTTP 402 insufficient_quota`, surfaced raw as `Error: Insufficient Balance`). The goal is web search with no billing at all.

The user's pi environment runs a `pi-package` called `pi-web-access` (`~/.pi/agent/npm/node_modules/pi-web-access`, v0.22.0, MIT) whose search backends include a keyless DuckDuckGo HTML scraper. The request is to transport pi plugins into the DeepSeek Harness, starting with pi-web-access's search capability.

pi-web-access's per-provider modules are runtime-agnostic: each exports `isXAvailable()` / `searchWithX(query, options)` over plain `fetch` and `linkedom` parsing, with the pi-only coupling (the `pi-coding-agent` `ExtensionAPI` registration and config-file key resolution) confined to the top-level `index.ts` and the routing hub. That separation is what makes a faithful port small.

## Decision

This repository hosts hand-made harness plugins out-of-tree, separated from the deepseek-harness main body. The first plugin, `@kkiyama117/dsh-web-search`, ports pi-web-access's DuckDuckGo backend into a `WebSearchProvider` registered under the id `pi-web-access`. It ships as a dsh bundle: `dsh plugin --profile <name> add <package-directory>` installs the package into a profile and activates its `cordis.patch.yml` layer, which inserts the provider row and overrides the base bundle's `web` row to select `searchProvider: pi-web-access`. The in-box base bundle keeps `deepseek-official` as its default; DeepSeek search stays available as a config-selected alternative for funded accounts.

Port adaptations, each a deliberate deviation from the upstream module:

- **Error taxonomy**: upstream throws plain `Error`s; the port throws `WebError` with the seam's codes (`WEB_PROVIDER_ERROR`, `WEB_ABORTED`), so the tool consumer, retry routing, and GUI display behave like every other provider.
- **Redirect policy**: the request carries no credentials (the repo's credential-redirect rule does not apply), but `redirect: 'error'` is set for uniform provider hygiene, with a real-HTTP regression spec proving the `Location` target is never contacted.
- **Cancellation**: the upstream `AbortSignal.timeout(30s)` is dropped; the caller's `searchTimeoutMs` owns time budgets, consistent with the sibling providers.
- **No activity monitor**: upstream's in-memory `activityMonitor` logging is dropped.
- **Answer text**: upstream's concatenated `answer` (snippet + `Source: title (url)` lines) is not mapped to `content`; the seam's `formatSearchOutput` already renders sources with snippets, so mapping it would duplicate model-facing text.
- **Attribution**: the port keeps an MIT attribution header and the upstream `User-Agent` string; `linkedom` becomes a package dependency (maintained dependency over hand-rolled HTML parsing).

The `PiSearchResult`/`PiSearchResponse` types keep the upstream backend-neutral surface so keyed backends (Tavily, Brave, Exa, Perplexity, Kagi, SearXNG) are mechanical follow-ups, each still needing dsh credential resolution and redirect-policy vetting.

## Alternatives considered

- **Bridge the installed npm package directly.** Rejected: pi-web-access's search routing imports `ExtensionContext` from `pi-coding-agent` and resolves keys from its own config file, bypassing the dsh credential seam; its keyed providers send `Authorization` headers with default redirect-following, violating the repo's credential-redirect policy without patching upstream; and the package's peer dependencies (`pi-coding-agent`, `pi-tui`) would drag the pi runtime into the harness.
- **A general pi-extension bridge** (load any `npm:pi-*` package by shimming pi's extension API). Deferred as a separate architecture project: the per-plugin port is small precisely because the runtime coupling is confined, and a shim's compatibility risk is not justified by the current one-plugin demand.
- **Keeping the plugin inside the deepseek-harness monorepo.** Rejected: hand-made plugins belong in their own repository so the main body stays upstream-clean; the monorepo gates (per-file coverage, README/translation checks, Agent Notes) do not apply out-of-tree, and the package loads as built `lib/` from its checkout.
- **Hand-rolling DuckDuckGo parsing without `linkedom`.** Rejected: the harness prefers maintained dependencies over owned parsing code, and the port keeps pi's tested parsing (ad exclusion, `uddg` decoding, domain filters) instead of re-deriving it.

## Consequences

`web_search` works with zero keys and zero billing for every profile that stacks this bundle; the empty-balance DeepSeek failure remains only for deployments that opt back in. The port is a fork, not a dependency: upstream pi-web-access changes do not flow in automatically. DuckDuckGo HTML scraping is inherently fragile — markup changes or anomaly pages degrade to the explicit no-parseable-results error, never a silent empty result. Runtime resolution of the harness peers (`@deepseek-ai/dsh-web`, `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-invariants`) relies on the package's own `node_modules` (linked to the harness checkout for development) or the profile's pnpm-managed install, so a fresh clone needs `pnpm install` here before the harness can boot it.

## Testing

28 unit tests at per-file 100% coverage: result parsing (ads, `uddg` decoding, domain filters, caps), error and abort mapping, plugin registration/HMR disposal, and a real-HTTP redirect spec proving the `Location` target is never contacted across 301/302/303/307/308.
