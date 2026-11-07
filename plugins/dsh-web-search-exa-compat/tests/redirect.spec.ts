import { createServer, type RequestListener } from 'node:http'
import { once } from 'node:events'
import { expect, it, onTestFinished } from 'vitest'
import { ExaSearchProvider } from '../src/provider.ts'

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  onTestFinished(async () => {
    if (!server.listening) return
    const closed = once(server, 'close')
    server.closeAllConnections()
    server.close()
    await closed
  })
  const ready = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await ready
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback port')
  return `http://127.0.0.1:${address.port}`
}

it('rejects credential-bearing redirects before contacting the destination', async () => {
  let destinationCalls = 0
  const destination = await listen((_request, response) => { destinationCalls++; response.end('destination') })
  const origin = await listen((_request, response) => { response.writeHead(302, { location: destination }); response.end() })
  const provider = new ExaSearchProvider({ apiKey: 'synthetic-secret', baseURL: origin, searchType: 'auto', highlightsPerResult: 1 })
  await expect(provider.search({ query: 'synthetic query' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  expect(destinationCalls).toBe(0)
  // The same destination is reachable when a non-provider request follows the redirect.
  expect(await (await fetch(origin, { redirect: 'follow' })).text()).toBe('destination')
  expect(destinationCalls).toBe(1)
})
