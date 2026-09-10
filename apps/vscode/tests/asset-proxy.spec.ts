import { describe, expect, it, onTestFinished } from 'vitest'
import type { Logger } from '../src/log.ts'
import { startAssetProxy, type AssetProxy } from '../src/proxy/asset-proxy.ts'
import type { HarnessSession, SessionResponse } from '../src/runtime/session.ts'

const logger: Logger = { info: () => {}, error: () => {} }

const INDEX = '<!doctype html><html><head><base href="/"></head><body></body></html>'

// A Chromium webview subresource load always carries this; undici's fetch does
// not, so it stands in for "a browser fetched this from the webview document".
const BROWSER = { 'sec-fetch-site': 'cross-site' }

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
  it('serves a browser request from the origin root, forwarding the path unchanged', async () => {
    const seen: { method: string; path: string }[] = []
    const running = await proxy(seen)
    const response = await fetch(`${running.origin}/assets/index-abc.js`, { headers: BROWSER })
    expect(response.status).toBe(200)
    expect(seen).toEqual([{ method: 'GET', path: '/assets/index-abc.js' }])
  })

  it('rewrites an HTML response so nested navigations stay on the proxy', async () => {
    const running = await proxy()
    const body = await (await fetch(`${running.origin}/`, { headers: BROWSER })).text()
    expect(body).toContain(`<base href="${running.origin}/">`)
  })

  it('sends CORS headers so the webview service worker can relay the bytes', async () => {
    const running = await proxy()
    const response = await fetch(`${running.origin}/assets/index-abc.js`, { headers: BROWSER })
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('answers a CORS preflight without reaching upstream', async () => {
    const seen: { method: string; path: string }[] = []
    const running = await proxy(seen)
    const response = await fetch(`${running.origin}/assets/index-abc.js`, { method: 'OPTIONS' })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(seen).toHaveLength(0)
  })

  it('accepts a webview Origin in place of a Sec-Fetch header', async () => {
    const seen: { method: string; path: string }[] = []
    const running = await proxy(seen)
    const response = await fetch(`${running.origin}/assets/index-abc.js`, {
      headers: { origin: 'vscode-webview://0deadbeef' },
    })
    expect(response.status).toBe(200)
    expect(seen).toHaveLength(1)
  })

  it('refuses a request that carries no browser fetch-metadata', async () => {
    const seen: { method: string; path: string }[] = []
    const running = await proxy(seen)
    expect((await fetch(`${running.origin}/assets/index-abc.js`)).status).toBe(403)
    expect(seen).toHaveLength(0)
  })

  it('refuses a request whose Origin is some other local server', async () => {
    const running = await proxy()
    const response = await fetch(`${running.origin}/assets/index-abc.js`, {
      headers: { origin: 'http://localhost:9999' },
    })
    expect(response.status).toBe(403)
  })

  it('refuses every state-changing method, so loopback exposure stays read-only', async () => {
    const seen: { method: string; path: string }[] = []
    const running = await proxy(seen)
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await fetch(`${running.origin}/api/x`, { method, headers: BROWSER })
      expect(response.status, method).toBe(405)
    }
    expect(seen).toHaveLength(0)
  })

  it('binds loopback only', async () => {
    const running = await proxy()
    expect(running.origin).toBe(`http://localhost:${String(running.port)}`)
  })
})
