/** Nonce-gated, read-only loopback proxy that feeds the webview document. */

import { randomBytes } from 'node:crypto'
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
  /** Unguessable first path segment every request must carry. */
  readonly nonce: string
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
 * Serve the harness UI's documents and assets to the webview.
 *
 * Two rules make this safe to expose on loopback. Only `GET` and `HEAD` are
 * answered, so nothing here can change harness state; and every request must
 * carry an unguessable path prefix, so another local process cannot reach the
 * proxy by scanning ports. Everything that mutates state travels over the
 * webview `postMessage` bridge instead, which no other process can address.
 * @param request - session, bridge source, and logger.
 * @returns the listening proxy.
 */
export async function startAssetProxy(request: AssetProxyRequest): Promise<AssetProxy> {
  const nonce = randomBytes(24).toString('base64url')
  const prefix = `/${nonce}`

  const server: Server = createServer((incoming, response) => {
    void (async () => {
      if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
        response.writeHead(405)
        response.end()
        return
      }
      const target = incoming.url ?? '/'
      if (target !== prefix && !target.startsWith(`${prefix}/`) && !target.startsWith(`${prefix}?`)) {
        response.writeHead(403)
        response.end()
        return
      }
      const path = target.slice(prefix.length) || '/'
      const upstream = await request.session.request(incoming.method, path)
      const isIndex = (upstream.headers['content-type'] ?? '').startsWith('text/html')
      const body = isIndex
        ? Buffer.from(transformIndexHtml(upstream.body.toString('utf8'), {
          proxyOrigin: origin(server),
          nonce,
          bridgeScript: request.bridgeScript,
        }), 'utf8')
        : upstream.body
      response.writeHead(upstream.status, { ...upstream.headers, 'content-length': body.byteLength })
      response.end(incoming.method === 'HEAD' ? undefined : body)
    })().catch((cause: unknown) => {
      request.logger.error(`asset proxy failed for ${incoming.url ?? '(no url)'}`, cause)
      if (!response.headersSent) response.writeHead(502)
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
    nonce,
    dispose() {
      closed ??= new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      return closed
    },
  }
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
