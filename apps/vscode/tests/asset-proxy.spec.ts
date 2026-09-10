import { describe, expect, it, onTestFinished } from 'vitest'
import type { Logger } from '../src/log.ts'
import { startAssetProxy, type AssetProxy } from '../src/proxy/asset-proxy.ts'
import type { HarnessSession, SessionResponse } from '../src/runtime/session.ts'

const logger: Logger = { info: () => {}, error: () => {} }

const INDEX = '<!doctype html><html><head><base href="/"></head><body></body></html>'

function session(seen: { method: string; path: string }[]): HarnessSession {
  return {
    endpoint: { port: 1, launchToken: 't' },
    request: (method, path) => {
      seen.push({ method, path })
      const response: SessionResponse = path.startsWith('/assets/')
        ? { status: 200, headers: { 'content-type': 'text/javascript' }, body: Buffer.from('export{}') }
        : { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(INDEX) }
      return Promise.resolve(response)
    },
    openSocket: () => { throw new Error('not used in this test') },
  }
}

async function proxy(seen: { method: string; path: string }[] = []): Promise<AssetProxy> {
  const started = await startAssetProxy({ session: session(seen), bridgeScript: 'void 0', logger })
  onTestFinished(() => started.dispose())
  return started
}

describe('startAssetProxy', () => {
  it('serves assets under the nonce prefix and strips it upstream', async () => {
    const seen: { method: string; path: string }[] = []
    const running = await proxy(seen)
    const response = await fetch(`${running.origin}/${running.nonce}/assets/index-abc.js`)
    expect(response.status).toBe(200)
    expect(seen).toEqual([{ method: 'GET', path: '/assets/index-abc.js' }])
  })

  it('rewrites an HTML response so nested navigations stay on the proxy', async () => {
    const running = await proxy()
    const body = await (await fetch(`${running.origin}/${running.nonce}/`)).text()
    expect(body).toContain(`<base href="${running.origin}/${running.nonce}/">`)
  })

  it('refuses a request that does not carry the nonce', async () => {
    const seen: { method: string; path: string }[] = []
    const running = await proxy(seen)
    expect((await fetch(`${running.origin}/assets/index-abc.js`)).status).toBe(403)
    expect(seen).toHaveLength(0)
  })

  it('refuses a guessed nonce', async () => {
    const running = await proxy()
    expect((await fetch(`${running.origin}/not-the-nonce/`)).status).toBe(403)
  })

  it('refuses every state-changing method, so loopback exposure stays read-only', async () => {
    const seen: { method: string; path: string }[] = []
    const running = await proxy(seen)
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await fetch(`${running.origin}/${running.nonce}/api/x`, { method })
      expect(response.status, method).toBe(405)
    }
    expect(seen).toHaveLength(0)
  })

  it('binds loopback only', async () => {
    const running = await proxy()
    expect(running.origin).toBe(`http://localhost:${String(running.port)}`)
  })
})
