import { describe, expect, it } from 'vitest'
import { proxyRoot, transformIndexHtml } from '../src/webview/html.ts'

const REQUEST = {
  proxyOrigin: 'http://localhost:51234',
  nonce: 'abc123',
  bridgeScript: 'globalThis.marker=1',
} as const

// The served index is shaped by dsh-host-frontend-static plus the index
// injections the Client modules plugin emits; only the base tag is contractual.
const SERVED_INDEX = '<!doctype html><html><head><base href="/">'
  + '<script>window.__ModuleLoader__=[]</script>'
  + '<script src="/plugins/??core/client.js&rev=deadbeef"></script>'
  + '<script>globalThis["__DSH_BOOT__"]={}</script>'
  + '<link rel="icon" href="/favicon.svg">'
  + '</head><body><script type="module" src="./assets/index-abc.js"></script></body></html>'

describe('transformIndexHtml', () => {
  it('re-anchors the document at the proxy root', () => {
    expect(transformIndexHtml(SERVED_INDEX, REQUEST))
      .toContain('<base href="http://localhost:51234/abc123/">')
  })

  it('drops the served root base so assets never resolve at the webview origin', () => {
    expect(transformIndexHtml(SERVED_INDEX, REQUEST)).not.toContain('<base href="/">')
  })

  it('installs the bridge ahead of every boot script that reads the transport', () => {
    const output = transformIndexHtml(SERVED_INDEX, REQUEST)
    expect(output.indexOf('globalThis.marker=1')).toBeLessThan(output.indexOf('__ModuleLoader__'))
    expect(output.indexOf('globalThis.marker=1')).toBeLessThan(output.indexOf('__DSH_BOOT__'))
  })

  it('preserves the server-owned injections verbatim', () => {
    const output = transformIndexHtml(SERVED_INDEX, REQUEST)
    expect(output).toContain('<script src="/plugins/??core/client.js&rev=deadbeef"></script>')
    expect(output).toContain('<script>globalThis["__DSH_BOOT__"]={}</script>')
    expect(output).toContain('<script type="module" src="./assets/index-abc.js"></script>')
  })

  it('keeps unsafe-inline and adds no nonce, which CSP3 would let override it', () => {
    const output = transformIndexHtml(SERVED_INDEX, REQUEST)
    expect(output).toContain("script-src 'unsafe-inline' 'unsafe-eval' http://localhost:51234")
    expect(output).not.toContain('nonce-')
  })

  it('refuses an index whose composition no longer matches this extension', () => {
    expect(() => transformIndexHtml('<!doctype html><html><head></head></html>', REQUEST))
      .toThrow(/not compatible/)
  })
})

describe('proxyRoot', () => {
  it('ends in the slash a base href needs to resolve siblings', () => {
    expect(proxyRoot(REQUEST)).toBe('http://localhost:51234/abc123/')
  })
})
