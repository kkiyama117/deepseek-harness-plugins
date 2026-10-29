# @kkiyama117/dsh-web-search

English | [中文](README.zh.md)

A keyless `WebSearchProvider` for the DeepSeek Harness [web capability seam](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/architecture.md) (`ctx.web`), ported from [pi-web-access](https://github.com/nicobailon/pi-web-access) (MIT). It fetches DuckDuckGo's HTML results endpoint server-side and parses the result rows into the seam's normalized `WebSearchResult`. No API key, no billing: the provider is available unconditionally.

This is an **implementation** plugin: it registers a provider into `ctx.web`, it does not own the `ctx.web` key and it does not register a model-facing tool (that is [dsh-tool-web](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/web/tool-web/README.md)). Like `@deepseek-ai/dsh-web-search-deepseek`, it is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service.

## Install

The package ships as a dsh **bundle**: its `cordis.patch.yml` layer mounts the provider row and overrides the base bundle's `web` row to select `searchProvider: pi-web-access`. Install it into a profile from the harness checkout:

```sh
pnpm dsh plugin --profile web add /data/softwares/deepseek-harness-plugins/dsh-web-search
```

The layer applies after the base bundle's, so the keyless default wins; `searchProvider: deepseek-official` (config or `$DSH_WEB_SEARCH_PROVIDER`) still selects DeepSeek search where a funded account exists.

## Config

| Key | Default | Meaning |
|---|---|---|
| `baseURL` | `https://html.duckduckgo.com/html/` | DuckDuckGo HTML endpoint. An unparseable value makes the provider unavailable. |
| `numResults` | (unset) | Default result count when a request carries no `maxResults`. Must be a positive integer; the backend clamps to 1..20. |

```yaml
- id: web-search-pi-web-access
  name: '@kkiyama117/dsh-web-search'
```

## Mapping

DuckDuckGo returns a results page, not an API envelope, so each `.result` row (ad rows excluded) maps to a `WebSearchSource`: `url` ← the decoded `uddg` redirect destination (non-http(s) destinations are dropped), `title` ← the `result__a` anchor text, `snippet` ← the `result__snippet` text (omitted when blank). A request's `maxResults` wins over the configured `numResults` default; the final bound is enforced by the seam. A page with no parseable result row at all (an anomaly/block page) is an error, not an empty result.

pi-web-access's concatenated-answer text is not mapped to `content`: the seam's own formatting already renders sources with snippets, and mapping it would duplicate that text in the model-facing result.

Provider failures (HTTP errors, network failure, unparseable responses) surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. There is no provider-owned timeout: the caller's `searchTimeoutMs` owns time budgets.

## Model Experience

No auxiliary model request: unlike DeepSeek search, this provider never calls a model — one plain HTTP GET to DuckDuckGo per search, so no provider tokens are incurred beyond the result text.

Indirectly, through `dsh-tool-web`, the conversation model sees the `maxResults`-bounded URLs, titles, and snippets or the provider's exact `DuckDuckGo search aborted`, `DuckDuckGo search request failed: <error>`, `DuckDuckGo search error (HTTP <status>): <detail>`, `DuckDuckGo returned no parseable results (invalid response)`, and `DuckDuckGo returned an unprocessable response body: <error>` failures under the consumer's error wrapper.

#### KV Cache effect

None. The provider holds no conversation context and makes no model request.

## Known Limitations and Deferred Work

- **HTML scraping is fragile** — DuckDuckGo can change its result markup or serve an anomaly page under load; a changed page degrades to the no-parseable-results error rather than a silent empty result.
- **Only the DuckDuckGo backend is ported so far** — pi-web-access's keyed backends (Tavily, Brave, Exa, Perplexity, Kagi, SearXNG, …) remain upstream; porting one is mechanical through the shared result types, but each needs dsh credential resolution and redirect-policy vetting.
- **Out-of-tree loading** — dsh loads the built `lib/` from this checkout, so a source change needs `pnpm build` here and a harness restart; hot reload does not watch this repository.
- **No `content` answer** — pi-web-access's concatenated answer is deliberately dropped (see Mapping); a backend with a genuine generated answer (Perplexity) can reintroduce it.
