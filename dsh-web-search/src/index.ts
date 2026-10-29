/**
 * `@kkiyama117/dsh-web-search`: registers a keyless
 * DuckDuckGo-backed `WebSearchProvider` (ported from pi-web-access) with
 * `ctx.web`. A function/namespace plugin (NOT a default-export service): a
 * search provider does not own the `ctx.web` key — it registers INTO the
 * seam's provider registry, exactly as `@deepseek-ai/dsh-web-search-deepseek`
 * does. The key is owned by `@deepseek-ai/dsh-web`.
 *
 * @module @kkiyama117/dsh-web-search
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  PI_DUCKDUCKGO_SEARCH_URL,
  PiWebAccessSearchProvider,
} from './provider.ts'
import type { PiWebAccessSearchProviderOptions } from './provider.ts'

export {
  PI_DUCKDUCKGO_SEARCH_URL,
  PI_WEB_ACCESS_DEFAULT_RESULTS,
  PI_WEB_ACCESS_PROVIDER_ID,
  PiWebAccessSearchProvider,
  parseDuckDuckGoResults,
} from './provider.ts'
export type { PiWebAccessSearchProviderOptions } from './provider.ts'
export type { PiSearchOptions, PiSearchResponse, PiSearchResult } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-pi-web-access'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills constant defaults). */
export interface Config {
  /** DuckDuckGo HTML endpoint base. Defaults to the public endpoint. */
  baseURL?: string
  /** Default result count when a request carries no `maxResults`. */
  numResults?: number
}

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  numResults: z.number().step(1).min(1),
})

/** Register the keyless DuckDuckGo search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  const options: PiWebAccessSearchProviderOptions = {
    baseURL: config.baseURL ?? PI_DUCKDUCKGO_SEARCH_URL,
    ...config.numResults !== undefined ? { numResults: config.numResults } : {},
  }
  ctx.web.registerSearchProvider(new PiWebAccessSearchProvider(options))
}
