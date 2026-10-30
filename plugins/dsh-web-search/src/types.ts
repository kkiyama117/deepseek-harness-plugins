/**
 * Backend-neutral search types shared by the ported pi-web-access providers.
 * Ported from pi-web-access (MIT), https://github.com/nicobailon/pi-web-access
 * (`perplexity.ts`). pi's `answer` field is dropped: the seam renders sources
 * with snippets itself, so mapping a concatenated answer would duplicate text.
 * `recencyFilter` is omitted until a ported backend uses it.
 * @module @kkiyama117/dsh-web-search/types
 */

/** One normalized search hit shared by every backend. */
export interface PiSearchResult {
  title: string
  url: string
  snippet: string
}

/** One backend's normalized search outcome. */
export interface PiSearchResponse {
  results: PiSearchResult[]
}

/** Backend-agnostic search options. */
export interface PiSearchOptions {
  /** Upper bound on returned results (1..20). */
  numResults?: number
  /** Domain allow/block filters; entries starting with `-` block. */
  domainFilter?: string[]
  /** Caller cancellation for the underlying HTTP request. */
  signal?: AbortSignal
}
