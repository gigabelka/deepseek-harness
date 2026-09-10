/** Fetch-metadata-gated, read-only loopback proxy that feeds the webview document. */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describeCause, type Logger } from '../log.ts'
import type { HarnessSession } from '../runtime/session.ts'
import { transformIndexHtml } from '../webview/html.ts'

/** The running proxy. */
export interface AssetProxy {
  /** Port the proxy bound on 127.0.0.1. */
  readonly port: number
  /** Origin the webview document loads from. */
  readonly origin: string
  /** Stop listening; idempotent. */
  dispose(): Promise<void>
}

/** Inputs the proxy needs to serve and rewrite the index. */
export interface AssetProxyRequest {
  /** The authenticated connection to `dsh web`. */
  readonly session: HarnessSession
  /** Page-side transport installer spliced into the index. */
  readonly bridgeScript: string
  /** Diagnostics sink. */
  readonly logger: Logger
}

/**
 * Headers every response carries.
 *
 * VS Code's webview relays `http://localhost` subresources through a service
 * worker that refetches them in CORS mode, so an asset with no
 * `Access-Control-Allow-Origin` reaches the page as a network error and the UI
 * never paints. `*` is safe here: the proxy is read-only and the `dsh web`
 * credential is attached by the extension host, never by the browser.
 */
const CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'cross-origin-resource-policy': 'cross-origin',
}

/**
 * Serve the harness UI's documents and assets to the webview.
 *
 * Three rules keep this safe to expose on loopback. Only `GET`/`HEAD` (and a
 * CORS `OPTIONS` preflight) are answered, so nothing here can change harness
 * state; the socket binds `127.0.0.1` on an OS-assigned port that lives only
 * while the panel is open; and every request must carry browser fetch-metadata
 * (`Sec-Fetch-Site`, or a `vscode-webview://` `Origin`), which a webview
 * subresource load always sends and a `curl` or bare-`http` probe from another
 * local process does not. Everything that mutates state travels over the webview
 * `postMessage` bridge instead, which no other process can address.
 * @param request - session, bridge source, and logger.
 * @returns the listening proxy.
 */
export async function startAssetProxy(request: AssetProxyRequest): Promise<AssetProxy> {
  const server: Server = createServer((incoming, response) => {
    void (async () => {
      if (incoming.method === 'OPTIONS') {
        response.writeHead(204, {
          ...CORS_HEADERS,
          'access-control-allow-methods': 'GET, HEAD, OPTIONS',
          'access-control-allow-headers': '*',
          'access-control-max-age': '600',
        })
        response.end()
        return
      }
      if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
        response.writeHead(405, CORS_HEADERS)
        response.end()
        return
      }
      if (!isBrowserRequest(incoming.headers)) {
        response.writeHead(403, CORS_HEADERS)
        response.end()
        return
      }
      const path = incoming.url ?? '/'
      const upstream = await request.session.request(incoming.method, path)
      const isIndex = (upstream.headers['content-type'] ?? '').startsWith('text/html')
      const body = isIndex
        ? Buffer.from(transformIndexHtml(upstream.body.toString('utf8'), {
          proxyOrigin: origin(server),
          bridgeScript: request.bridgeScript,
        }), 'utf8')
        : upstream.body
      response.writeHead(upstream.status, {
        ...upstream.headers,
        ...CORS_HEADERS,
        'content-length': body.byteLength,
      })
      response.end(incoming.method === 'HEAD' ? undefined : body)
    })().catch((cause: unknown) => {
      request.logger.error(`asset proxy failed for ${incoming.url ?? '(no url)'}`, cause)
      if (!response.headersSent) response.writeHead(502, CORS_HEADERS)
      response.end(describeCause(cause))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  let closed: Promise<void> | undefined
  return {
    port: address(server).port,
    origin: origin(server),
    dispose() {
      closed ??= new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      return closed
    },
  }
}

/**
 * Admit only requests a browser fetched from the webview document.
 *
 * A Chromium webview stamps `Sec-Fetch-Site` on every subresource and navigation
 * request, and an `Origin` on cross-origin loads; a local process reaching the
 * port with `curl` or `node:http` sends neither.
 * @param headers - the incoming request headers.
 * @returns whether the request carries browser fetch-metadata.
 */
function isBrowserRequest(headers: NodeJS.Dict<string | string[]>): boolean {
  if (headers['sec-fetch-site'] !== undefined) return true
  const rawOrigin = headers.origin
  const value = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin
  return value !== undefined && value.startsWith('vscode-webview://')
}

function address(server: Server): AddressInfo {
  const value = server.address()
  if (value === null || typeof value === 'string') {
    throw new Error('asset proxy did not bind a TCP port')
  }
  return value
}

// `localhost`, not `127.0.0.1`: VS Code's webview port mapping rewrites the
// former, which is what makes the panel work over Remote-SSH.
function origin(server: Server): string {
  return `http://localhost:${String(address(server).port)}`
}
