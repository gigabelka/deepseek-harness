import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '../src/log.ts'
import type { HarnessSession, SessionResponse } from '../src/runtime/session.ts'
import { attachBridge, type BridgeChannel } from '../src/webview/bridge.ts'
import { parseBridgeClientMessage } from '../src/webview/protocol.ts'
import type { BridgeHostMessage } from '../src/webview/protocol.ts'

const logger: Logger = { info: () => {}, error: () => {} }

function harness(): {
  channel: BridgeChannel
  posted: BridgeHostMessage[]
  send: (value: unknown) => void
  requests: { method: string; path: string; body?: Buffer }[]
  session: HarnessSession
} {
  const posted: BridgeHostMessage[] = []
  const listeners: ((value: unknown) => void)[] = []
  const requests: { method: string; path: string; body?: Buffer }[] = []
  const response: SessionResponse = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{"ok":true}', 'utf8'),
  }
  return {
    posted,
    requests,
    channel: {
      postMessage: (message) => { posted.push(message) },
      onMessage: (listener) => {
        listeners.push(listener)
        return () => { listeners.splice(listeners.indexOf(listener), 1) }
      },
    },
    send: (value) => { for (const listener of [...listeners]) listener(value) },
    session: {
      endpoint: { port: 1, launchToken: 't' },
      request: (method, path, _headers, body) => {
        requests.push({ method, path, ...(body === undefined ? {} : { body }) })
        return Promise.resolve(response)
      },
      openSocket: () => { throw new Error('not used in this test') },
    },
  }
}

describe('attachBridge', () => {
  it('relays an /api call and returns the base64 body', async () => {
    const { channel, posted, send, session, requests } = harness()
    attachBridge(channel, session, logger)
    send({ kind: 'fetch', id: 'a', method: 'POST', path: '/api/x', headers: {}, body: Buffer.from('hi').toString('base64') })
    await vi.waitFor(() => { expect(posted).toHaveLength(1) })
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/api/x' })
    expect(requests[0]?.body?.toString('utf8')).toBe('hi')
    expect(posted[0]).toEqual({
      kind: 'fetch-result',
      id: 'a',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"ok":true}').toString('base64'),
    })
  })

  it('refuses a path outside the /api channel instead of proxying it', async () => {
    const { channel, posted, send, session, requests } = harness()
    attachBridge(channel, session, logger)
    send({ kind: 'fetch', id: 'b', method: 'GET', path: '/etc/passwd', headers: {} })
    await vi.waitFor(() => { expect(posted).toHaveLength(1) })
    expect(posted[0]).toMatchObject({ kind: 'fetch-error', id: 'b' })
    expect(requests).toHaveLength(0)
  })

  it('stops relaying once disposed', async () => {
    const { channel, posted, send, session } = harness()
    attachBridge(channel, session, logger).dispose()
    send({ kind: 'fetch', id: 'c', method: 'GET', path: '/api/x', headers: {} })
    await Promise.resolve()
    expect(posted).toHaveLength(0)
  })
})

describe('parseBridgeClientMessage', () => {
  it('accepts a well-formed stream request', () => {
    expect(parseBridgeClientMessage({ kind: 'stream-open', id: 'a', endpoint: '$events', payload: {} }))
      .toEqual({ kind: 'stream-open', id: 'a', endpoint: '$events', payload: {} })
  })

  it('lowercases header names so the relay sends one canonical form', () => {
    expect(parseBridgeClientMessage({
      kind: 'fetch', id: 'a', method: 'POST', path: '/api/x', headers: { 'Content-Type': 'application/json' },
    })).toMatchObject({ headers: { 'content-type': 'application/json' } })
  })

  it('rejects a path that is not rooted, which could otherwise escape the channel check', () => {
    expect(parseBridgeClientMessage({ kind: 'fetch', id: 'a', method: 'GET', path: 'api/x', headers: {} }))
      .toBeUndefined()
  })

  it('rejects a message with no kind of ours', () => {
    expect(parseBridgeClientMessage({ kind: 'other', id: 'a' })).toBeUndefined()
    expect(parseBridgeClientMessage(null)).toBeUndefined()
  })
})
