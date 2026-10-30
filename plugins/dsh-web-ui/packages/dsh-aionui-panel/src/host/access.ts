/**
 * Panel trust fence: loopback (the desktop) always passes; then
 * web-runtime `trustedHosts` (LAN / mDNS / Tailscale Host authorities);
 * then a live paired-device cookie when remote-web-ui is loaded. The
 * panel never depends on that plugin — without the service and without
 * trustedHosts the fence stays loopback-only (issue #146).
 */
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { isLoopbackRequest } from './loopback.ts'

/** Structural pairing lookup (no package dependency on remote-web-ui). */
interface PairingAccess {
  isPairedDevice(request: IncomingMessage): boolean
}

/** ctx.get is optional on the test harness; production Context always has it. */
type LookupCtx = Context & {
  get?(name: string, strict?: boolean): unknown
  remoteWebUiPairing?: PairingAccess
}

/**
 * Whether this request may enter any /aionui-panel route.
 * @param ctx - host context; may expose webRuntime and remoteWebUiPairing.
 * @param request - the incoming HTTP request.
 * @returns true for loopback, a trusted Host, or a live paired-device cookie.
 */
export function isPanelAllowed(ctx: Context, request: IncomingMessage): boolean {
  if (isLoopbackRequest(request)) return true
  if (isTrustedHostRequest(request, trustedHostAuthorities(ctx))) return true
  const bag = ctx as LookupCtx
  const fromGet = typeof bag.get === 'function' ? bag.get('remoteWebUiPairing', false) : undefined
  const pairing = (isPairingAccess(fromGet) ? fromGet : bag.remoteWebUiPairing)
  return pairing?.isPairedDevice(request) === true
}

/** Non-loopback Host authorities this deployment serves (web-runtime `trustedHosts`); empty in non-web profiles. */
function trustedHostAuthorities(ctx: Context): string[] {
  const bag = ctx as LookupCtx
  const runtime = (typeof bag.get === 'function' ? bag.get('webRuntime', false) : undefined) as { trustedHosts?: unknown } | undefined
  const hosts = runtime?.trustedHosts
  return Array.isArray(hosts) ? hosts.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * Host matches a trustedHosts entry, plus browser same-origin markers.
 * Port-less entries match the hostname on any port (connection /api fence).
 */
function isTrustedHostRequest(request: IncomingMessage, trustedHosts: string[]): boolean {
  if (trustedHosts.length === 0) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const trusted = trustedHosts.some((entry) => {
    try {
      const entryUrl = new URL(`http://${entry}`)
      return entryUrl.port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
    } catch {
      return false
    }
  })
  if (!trusted) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function isPairingAccess(value: unknown): value is PairingAccess {
  return value !== undefined
    && value !== null
    && typeof (value as PairingAccess).isPairedDevice === 'function'
}
