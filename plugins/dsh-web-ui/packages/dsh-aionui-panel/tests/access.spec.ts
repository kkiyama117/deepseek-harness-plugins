import type { IncomingMessage } from 'node:http'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isPanelAllowed } from '../src/host/access.ts'

function request(options: {
  remoteAddress?: string
  host?: string
  origin?: string
  secFetchSite?: string
} = {}): IncomingMessage {
  return {
    headers: {
      host: options.host ?? '127.0.0.1:3000',
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.secFetchSite === undefined ? {} : { 'sec-fetch-site': options.secFetchSite }),
    },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  } as IncomingMessage
}

describe('isPanelAllowed', () => {
  it('allows loopback without trustedHosts or pairing', () => {
    assert.equal(isPanelAllowed({} as never, request()), true)
  })

  it('refuses a LAN client when trustedHosts and pairing are absent', () => {
    const ctx = { get: () => undefined }
    assert.equal(isPanelAllowed(ctx as never, request({
      remoteAddress: '192.168.1.20',
      host: 'boiled.local:3080',
    })), false)
  })

  it('allows a LAN client whose Host is in webRuntime.trustedHosts', () => {
    const ctx = {
      get: (name: string) => name === 'webRuntime' ? { trustedHosts: ['boiled.local'] } : undefined,
    }
    assert.equal(isPanelAllowed(ctx as never, request({
      remoteAddress: '192.168.1.20',
      host: 'boiled.local:3080',
    })), true)
  })

  it('refuses a LAN client whose Host is not in trustedHosts', () => {
    const ctx = {
      get: (name: string) => name === 'webRuntime' ? { trustedHosts: ['boiled.local'] } : undefined,
    }
    assert.equal(isPanelAllowed(ctx as never, request({
      remoteAddress: '192.168.1.20',
      host: 'evil.example:3080',
    })), false)
  })

  it('refuses a trusted Host that is marked cross-site', () => {
    const ctx = {
      get: (name: string) => name === 'webRuntime' ? { trustedHosts: ['boiled.local'] } : undefined,
    }
    assert.equal(isPanelAllowed(ctx as never, request({
      remoteAddress: '192.168.1.20',
      host: 'boiled.local:3080',
      secFetchSite: 'cross-site',
    })), false)
  })

  it('allows a LAN client with a live paired-device cookie', () => {
    const ctx = {
      get: (name: string) => name === 'remoteWebUiPairing' ? { isPairedDevice: () => true } : undefined,
    }
    assert.equal(isPanelAllowed(ctx as never, request({
      remoteAddress: '192.168.1.20',
      host: 'dsh.example:443',
    })), true)
  })
})
