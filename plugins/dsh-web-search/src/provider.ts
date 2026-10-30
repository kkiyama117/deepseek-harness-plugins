/**
 * Keyless DuckDuckGo search for the web capability seam, ported from
 * pi-web-access (MIT), https://github.com/nicobailon/pi-web-access
 * (`duckduckgo.ts`). Port adaptations: dsh error taxonomy (`WebError` codes),
 * `redirect: 'error'` on the request, caller-signal cancellation without a
 * provider-owned timeout (the tool's `searchTimeoutMs` owns time budgets),
 * and no activity monitor. pi's concatenated-answer text is not mapped to
 * `content`: the seam already renders sources with snippets, and mapping it
 * would duplicate that text in the model-facing result.
 * @module @kkiyama117/dsh-web-search/provider
 */

import { parseHTML } from 'linkedom'
import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { PiSearchOptions, PiSearchResponse, PiSearchResult } from './types.ts'

/** Stable id this provider registers under. */
export const PI_WEB_ACCESS_PROVIDER_ID = 'pi-web-access'

/** Default DuckDuckGo HTML endpoint (no API key, no billing). */
export const PI_DUCKDUCKGO_SEARCH_URL = 'https://html.duckduckgo.com/html/'

/** Default result count when a request carries no `maxResults` (pi's normalizeCount default). */
export const PI_WEB_ACCESS_DEFAULT_RESULTS = 5

/** Attribution header sent on every request (ported from pi-web-access). */
const USER_AGENT = 'Mozilla/5.0 (compatible; pi-web-access/1.0; +https://github.com/nicobailon/pi-web-access)'

/** Resolved provider options (the plugin's `apply` supplies constant defaults). */
export interface PiWebAccessSearchProviderOptions {
  /** DuckDuckGo HTML endpoint base. */
  baseURL: string
  /** Default result count when a request carries no `maxResults`. */
  numResults?: number
}

/** Clamp a requested result count into the backend's 1..20 window, defaulting to 5. */
function normalizeCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return PI_WEB_ACCESS_DEFAULT_RESULTS
  return Math.max(1, Math.min(Math.floor(value), 20))
}

/** Normalize one domain filter entry to a bare hostname, or null when unusable. */
function normalizeDomain(value: string): string | null {
  let input = value.trim().toLowerCase()
  if (input === '') return null
  if (input.startsWith('-')) input = input.slice(1).trim()
  if (input === '') return null
  try {
    const parsed = input.includes('://') ? new URL(input) : new URL(`https://${input}`)
    input = parsed.hostname
  } catch {
    // A split of a non-empty string always yields a first segment; the guards
    // exist only for noUncheckedIndexedAccess, so this arm is unreachable.
    /* v8 ignore next -- split of a string always has a first segment */
    input = input.split('/')[0]?.split(':')[0] ?? ''
  }
  input = input.replace(/^\.+|\.+$/g, '')
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null
}

/** Domain allow/block filters; `-`-prefixed entries block, others allow. */
interface NormalizedDomainFilters {
  allowed: string[]
  blocked: string[]
}

/** Normalize a `domainFilter` option into allow/block hostname lists. */
function normalizeDomainFilters(domainFilter: string[] | undefined): NormalizedDomainFilters {
  const filters: NormalizedDomainFilters = { allowed: [], blocked: [] }
  for (const raw of domainFilter ?? []) {
    const domain = normalizeDomain(raw)
    if (domain === null) continue
    const target = raw.trim().startsWith('-') ? filters.blocked : filters.allowed
    if (!target.includes(domain)) target.push(domain)
  }
  return filters
}

/** Whether `hostname` equals `domain` or is a subdomain of it. */
function hostMatchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

/** Whether a result URL passes the allow/block filters (no filters = pass). */
function matchesDomainFilters(url: string, filters: NormalizedDomainFilters): boolean {
  if (filters.allowed.length === 0 && filters.blocked.length === 0) return true
  const hostname = new URL(url).hostname.toLowerCase()
  if (filters.allowed.length > 0 && !filters.allowed.some(domain => hostMatchesDomain(hostname, domain))) return false
  return !filters.blocked.some(domain => hostMatchesDomain(hostname, domain))
}

/**
 * Decode a DuckDuckGo result href: an internal `//duckduckgo.com/l/?uddg=…`
 * redirect link resolves to its `uddg` destination; any other absolute URL is
 * returned as-is. Only `http:`/`https:` destinations survive.
 * @param href - the `result__a` anchor's `href` attribute.
 * @param baseURL - the search endpoint, resolving protocol-relative hrefs.
 * @returns the decoded destination, or null when it is missing or non-http(s).
 */
function decodeResultUrl(href: string, baseURL: string): string | null {
  try {
    const link = new URL(href, baseURL)
    const destination = link.searchParams.get('uddg') ?? link.href
    const url = new URL(destination)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/**
 * Parse DuckDuckGo's HTML results page into normalized hits: `.result`
 * containers (ad rows excluded) with a `result__a` anchor and decoded URL;
 * the `result__snippet` excerpt becomes `snippet`. A page with no parseable
 * result container at all (anomaly/block page) is an error, not an empty
 * result — an empty answer and a blocked page are different failures.
 * @param html - the response body.
 * @param options - result cap and domain filters.
 * @param baseURL - the search endpoint (href resolution base).
 * @returns the normalized hits, already capped and filtered.
 * @throws {@link WebError} `WEB_PROVIDER_ERROR` when no result container parsed.
 */
export function parseDuckDuckGoResults(html: string, options: PiSearchOptions, baseURL: string): PiSearchResponse {
  const { document } = parseHTML(html)
  const filters = normalizeDomainFilters(options.domainFilter)
  const results: PiSearchResult[] = []
  let parseableResults = 0
  for (const container of document.querySelectorAll('.result')) {
    if (container.classList.contains('result--ad')) continue
    const anchor = container.querySelector('.result__a')
    const title = anchor?.textContent.trim() ?? ''
    const href = anchor?.getAttribute('href')?.trim() ?? ''
    const resultUrl = href !== '' ? decodeResultUrl(href, baseURL) : null
    if (title === '' || resultUrl === null) continue
    parseableResults++
    if (!matchesDomainFilters(resultUrl, filters)) continue
    const snippet = container.querySelector('.result__snippet')?.textContent.trim() ?? ''
    results.push({ title, url: resultUrl, snippet })
    if (results.length >= normalizeCount(options.numResults)) break
  }
  if (parseableResults === 0) {
    throw new WebError('DuckDuckGo returned no parseable results (invalid response)', 'WEB_PROVIDER_ERROR')
  }
  return { results }
}

/** Project one parsed hit into the seam's source shape, omitting a blank snippet. */
function mapSource(result: PiSearchResult): WebSearchSource {
  return {
    url: result.url,
    // The parser guarantees a non-blank title, so it is always carried.
    title: result.title,
    ...result.snippet.length > 0 ? { snippet: result.snippet } : {},
  }
}

/** The keyless DuckDuckGo search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class PiWebAccessSearchProvider implements WebSearchProvider {
  readonly id = PI_WEB_ACCESS_PROVIDER_ID

  constructor(private readonly options: PiWebAccessSearchProviderOptions) {}

  available(): boolean {
    return URL.canParse(this.options.baseURL)
      && (this.options.numResults === undefined || isPositiveInteger(this.options.numResults))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    throwIfAborted(signal)
    const numResults = request.maxResults ?? this.options.numResults
    const response = await searchDuckDuckGo(request.query, {
      ...numResults !== undefined ? { numResults } : {},
      ...signal !== undefined ? { signal } : {},
    }, this.options.baseURL)
    // The web service owns the final `maxResults` truncation, so the provider
    // reports `truncated: false`.
    return { sources: response.results.map(mapSource), truncated: false }
  }
}

/**
 * Fetch and parse one DuckDuckGo HTML search. The request carries no
 * credentials, so redirects are still rejected for uniform provider hygiene.
 * @param query - the search query.
 * @param options - result cap, domain filters, and caller cancellation.
 * @param baseURL - the DuckDuckGo HTML endpoint.
 * @returns the parsed, capped, and filtered hits.
 * @throws {@link WebError} `WEB_ABORTED` on caller cancellation, `WEB_PROVIDER_ERROR`
 *   on transport, HTTP, or unparseable-response failures.
 */
async function searchDuckDuckGo(query: string, options: PiSearchOptions, baseURL: string): Promise<PiSearchResponse> {
  const url = new URL(baseURL)
  url.searchParams.set('q', query)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        'accept': 'text/html',
        'user-agent': USER_AGENT,
      },
      ...options.signal !== undefined ? { signal: options.signal } : {},
    })
  } catch (error: unknown) {
    if (options.signal?.aborted === true || isAbortError(error)) throw searchAborted(options.signal, error)
    throw new WebError(`DuckDuckGo search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }

  if (!response.ok) {
    // A status line always stands on its own; the body excerpt (when readable)
    // only enriches the message, never replaces the error.
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 300)
    } catch (error: unknown) {
      if (options.signal?.aborted === true || isAbortError(error)) throw searchAborted(options.signal, error)
    }
    throw new WebError(`DuckDuckGo search error (HTTP ${response.status}): ${detail}`, 'WEB_PROVIDER_ERROR')
  }

  try {
    return parseDuckDuckGoResults(await response.text(), options, baseURL)
  } catch (error: unknown) {
    if (options.signal?.aborted === true || isAbortError(error)) {
      throw searchAborted(options.signal, error)
    }
    if (error instanceof WebError) throw error
    throw new WebError(`DuckDuckGo returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(signal)
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('DuckDuckGo search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** True for a result-count bound the DuckDuckGo backend can honor. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
