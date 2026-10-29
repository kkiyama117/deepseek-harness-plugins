import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  PI_DUCKDUCKGO_SEARCH_URL,
  PI_WEB_ACCESS_PROVIDER_ID,
  PiWebAccessSearchProvider,
  parseDuckDuckGoResults,
} from '@kkiyama117/dsh-web-search'
import * as piWebAccessPlugin from '@kkiyama117/dsh-web-search'

/** Construct the provider over fixed options; production passes resolved config. */
const provider = (overrides: Partial<{ baseURL: string; numResults: number }> = {}): PiWebAccessSearchProvider =>
  new PiWebAccessSearchProvider({
    baseURL: overrides.baseURL ?? PI_DUCKDUCKGO_SEARCH_URL,
    ...overrides.numResults !== undefined ? { numResults: overrides.numResults } : {},
  })

/** Realistic DuckDuckGo HTML page: an ad, two organic results, and a blocked-domain hit. */
const SAMPLE_HTML = '<!doctype html><html><body>'
  + '<div class="result results_links results_links_deep result--ad">'
  + '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fads.example%2Fsponsored">Sponsored Ad</a>'
  + '</div>'
  + '<div class="result results_links web-result">'
  + '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc123">Example Page</a>'
  + '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">This is the snippet for example.</a>'
  + '</div>'
  + '<div class="result results_links web-result">'
  + '<a class="result__a" href="https://direct.test/article">Direct Article</a>'
  + '</div>'
  + '<div class="result results_links web-result">'
  + '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fblocked.test%2Fpage">Blocked Domain</a>'
  + '</div>'
  + '</body></html>'

function htmlResponse(html: string, init: ResponseInit = {}): Response {
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseDuckDuckGoResults', () => {
  it('parses organic results, decodes uddg links, and skips ads and snippet-less entries', () => {
    const parsed = parseDuckDuckGoResults(SAMPLE_HTML, {}, PI_DUCKDUCKGO_SEARCH_URL)
    expect(parsed.results).toEqual([
      { title: 'Example Page', url: 'https://example.com/page', snippet: 'This is the snippet for example.' },
      { title: 'Direct Article', url: 'https://direct.test/article', snippet: '' },
      { title: 'Blocked Domain', url: 'https://blocked.test/page', snippet: '' },
    ])
  })

  it('caps results at numResults (1..20 window, default 5)', () => {
    const one = parseDuckDuckGoResults(SAMPLE_HTML, { numResults: 1 }, PI_DUCKDUCKGO_SEARCH_URL)
    expect(one.results).toHaveLength(1)
    const clamped = parseDuckDuckGoResults(SAMPLE_HTML, { numResults: 99 }, PI_DUCKDUCKGO_SEARCH_URL)
    expect(clamped.results).toHaveLength(3)
    const zero = parseDuckDuckGoResults(SAMPLE_HTML, { numResults: 0 }, PI_DUCKDUCKGO_SEARCH_URL)
    expect(zero.results).toHaveLength(1)
    const defaulted = parseDuckDuckGoResults(SAMPLE_HTML, {}, PI_DUCKDUCKGO_SEARCH_URL)
    expect(defaulted.results.length).toBeLessThanOrEqual(5)
  })

  it('applies allow and block domain filters', () => {
    const allowed = parseDuckDuckGoResults(
      SAMPLE_HTML,
      { domainFilter: ['example.com'] },
      PI_DUCKDUCKGO_SEARCH_URL,
    )
    expect(allowed.results.map(result => result.url)).toEqual(['https://example.com/page'])
    const blocked = parseDuckDuckGoResults(
      SAMPLE_HTML,
      { domainFilter: ['-blocked.test'] },
      PI_DUCKDUCKGO_SEARCH_URL,
    )
    expect(blocked.results.map(result => result.url)).not.toContain('https://blocked.test/page')
  })

  it('ignores malformed filter entries and subdomain-inclusive matching', () => {
    const parsed = parseDuckDuckGoResults(
      SAMPLE_HTML,
      { domainFilter: ['   ', '-', 'https://example.com', 'www.example.com', 'not a host'] },
      PI_DUCKDUCKGO_SEARCH_URL,
    )
    expect(parsed.results.map(result => result.url)).toEqual(['https://example.com/page'])
  })

  it('throws WEB_PROVIDER_ERROR when no result container parsed (block page)', () => {
    expect(() => parseDuckDuckGoResults('<html><body>anomaly</body></html>', {}, PI_DUCKDUCKGO_SEARCH_URL))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'DuckDuckGo returned no parseable results (invalid response)' }))
  })

  it('skips result containers without an anchor or with an undecodable href', () => {
    const parsed = parseDuckDuckGoResults(
      '<div class="result"><a class="result__snippet">anchorless</a></div>'
      + '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=http%3A%2F%2F%25">Broken</a></div>'
      + '<div class="result"><a class="result__a" href="https://good.test/">Good</a></div>',
      {},
      PI_DUCKDUCKGO_SEARCH_URL,
    )
    expect(parsed.results).toEqual([{ title: 'Good', url: 'https://good.test/', snippet: '' }])
  })

  it('rejects non-http(s) decoded destinations while keeping valid results', () => {
    const parsed = parseDuckDuckGoResults(
      '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=javascript%3Aalert(1)">Bad</a></div>'
      + '<div class="result"><a class="result__a" href="https://good.test/">Good</a></div>',
      {},
      PI_DUCKDUCKGO_SEARCH_URL,
    )
    expect(parsed.results).toEqual([{ title: 'Good', url: 'https://good.test/', snippet: '' }])
  })
})

describe('PiWebAccessSearchProvider', () => {
  it('is available without any credential (keyless)', () => {
    expect(provider().available()).toBe(true)
    expect(provider({ baseURL: 'not a url' }).available()).toBe(false)
    expect(provider({ numResults: 0 }).available()).toBe(false)
    expect(provider({ numResults: 3 }).available()).toBe(true)
  })

  it('maps a DuckDuckGo page to sources with truncated false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(SAMPLE_HTML)))
    await expect(provider().search({ query: 'deepseek' })).resolves.toEqual({
      sources: [
        { url: 'https://example.com/page', title: 'Example Page', snippet: 'This is the snippet for example.' },
        { url: 'https://direct.test/article', title: 'Direct Article' },
        { url: 'https://blocked.test/page', title: 'Blocked Domain' },
      ],
      truncated: false,
    })
  })

  it('prefers the request maxResults over the configured default', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(SAMPLE_HTML)))
    await expect(provider({ numResults: 3 }).search({ query: 'q', maxResults: 1 })).resolves.toMatchObject({
      sources: [{ url: 'https://example.com/page', title: 'Example Page', snippet: 'This is the snippet for example.' }],
    })
  })

  it('maps an HTTP error to WEB_PROVIDER_ERROR with status and body excerpt', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited body', { status: 429 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: 'DuckDuckGo search error (HTTP 429): rate limited body',
      }))
  })

  it('keeps the status line when the error body is unreadable', async () => {
    const body = { text: () => Promise.reject(new TypeError('stream destroyed')), ok: false, status: 503 } as unknown as Response
    vi.stubGlobal('fetch', vi.fn(async () => body))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'DuckDuckGo search error (HTTP 503): ' }))
  })

  it('surfaces an abort during error-body read as WEB_ABORTED', async () => {
    const body = { text: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 } as unknown as Response
    vi.stubGlobal('fetch', vi.fn(async () => body))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces a block page as WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('<html>anomaly</html>')))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('observes cancellation before dispatch', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    controller.abort(new Error('caller cancelled'))
    await expect(provider().search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps an abort that fires mid-request to WEB_ABORTED', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('caller timeout')) }, { once: true })
      })))
    const search = provider().search({ query: 'q' }, controller.signal)
    controller.abort(new Error('timeout reason'))
    await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('wraps an unprocessable success body into WEB_PROVIDER_ERROR with cause', async () => {
    const body = { text: () => Promise.reject(new TypeError('stream destroyed')), ok: true, status: 200 } as unknown as Response
    vi.stubGlobal('fetch', vi.fn(async () => body))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'DuckDuckGo returned an unprocessable response body: TypeError: stream destroyed' }))
  })

  it('surfaces an abort during success-body read as WEB_ABORTED', async () => {
    const body = { text: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 } as unknown as Response
    vi.stubGlobal('fetch', vi.fn(async () => body))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-pi-web-access plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(SAMPLE_HTML)))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: PI_WEB_ACCESS_PROVIDER_ID })
    const fiber = await ctx.plugin(piWebAccessPlugin, {})
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('accepts a configured numResults default', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(SAMPLE_HTML)))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: PI_WEB_ACCESS_PROVIDER_ID })
    const fiber = await ctx.plugin(piWebAccessPlugin, { numResults: 1 })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({
      sources: [{ url: 'https://example.com/page', title: 'Example Page', snippet: 'This is the snippet for example.' }],
    })
    await fiber.dispose()
  })

  it('rejects numResults: 0 at plugin construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: PI_WEB_ACCESS_PROVIDER_ID })
    await expect(ctx.plugin(piWebAccessPlugin, { numResults: 0 }))
      .rejects.toThrow(/numResults expected number >= 1/)
  })
})
