/** Authenticated loopback client for one booted `dsh web`. */

import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http'
import { WebSocket } from 'ws'
import type { WebEndpoint } from './server.ts'

/** Bound on the token-for-cookie handshake. */
const HANDSHAKE_TIMEOUT_MS = 15_000

/** One buffered response relayed back to the webview. */
export interface SessionResponse {
  /** HTTP status code. */
  readonly status: number
  /** Response headers, lowercased, with `set-cookie` withheld. */
  readonly headers: Readonly<Record<string, string>>
  /** Complete response body. */
  readonly body: Buffer
}

/**
 * The privileged side of the connection to `dsh web`.
 *
 * Only this process can satisfy the `/api` trust fence: it controls the `Host`
 * header and, crucially, sends no `Origin` and no `sec-fetch-site`, which
 * `isTrustedApiRequest` accepts for a loopback Host. A webview cannot, because
 * the browser stamps its own `vscode-webview://` origin on every request.
 */
export interface HarnessSession {
  /** The endpoint this session authenticates against. */
  readonly endpoint: WebEndpoint
  /** Perform one buffered request carrying the session cookie. */
  request(
    method: string,
    path: string,
    headers?: Readonly<Record<string, string>>,
    body?: Buffer,
  ): Promise<SessionResponse>
  /** Open an authenticated WebSocket to a server route. */
  openSocket(path: string): WebSocket
}

/**
 * Exchange the one-shot launch token for the browser-session cookie.
 *
 * `browser-auth` answers `GET /?token=<launchToken>` with a 303 and a
 * `HttpOnly; SameSite=Strict` cookie. Redirects are not followed: the 303 itself
 * carries everything needed.
 * @param endpoint - the port and launch token from the readiness line.
 * @returns a session that stamps the cookie onto every later request.
 * @throws when the handshake does not yield a cookie.
 */
export async function openSession(endpoint: WebEndpoint): Promise<HarnessSession> {
  const authority = `127.0.0.1:${String(endpoint.port)}`
  const handshake = await performRequest(
    endpoint.port,
    authority,
    'GET',
    `/?token=${encodeURIComponent(endpoint.launchToken)}`,
    {},
    undefined,
    true,
  )
  const cookie = firstSessionCookie(handshake.setCookie)
  if (cookie === undefined) {
    throw new Error(
      `dsh web did not issue a session cookie (HTTP ${String(handshake.response.status)}); `
      + 'the launch token may already have been redeemed.',
    )
  }

  return {
    endpoint,
    async request(method, path, headers = {}, body) {
      const result = await performRequest(
        endpoint.port,
        authority,
        method,
        path,
        { ...headers, cookie },
        body,
        false,
      )
      return result.response
    },
    openSocket(path) {
      return new WebSocket(`ws://${authority}${path}`, {
        headers: { host: authority, cookie },
      })
    },
  }
}

/**
 * Pick the browser-session cookie out of a `set-cookie` header list.
 *
 * The name is `dsh-auth-<base64url sha256 of the authority>`, so it is matched
 * by prefix rather than reconstructed.
 * @param values - raw `set-cookie` header values.
 * @returns the `name=value` pair to echo back, or `undefined` when absent.
 */
export function firstSessionCookie(values: readonly string[]): string | undefined {
  for (const value of values) {
    const pair = value.split(';', 1)[0]?.trim()
    if (pair !== undefined && pair.startsWith('dsh-auth-')) return pair
  }
  return undefined
}

interface RawResult {
  readonly response: SessionResponse
  readonly setCookie: readonly string[]
}

function performRequest(
  port: number,
  authority: string,
  method: string,
  path: string,
  headers: Readonly<Record<string, string>>,
  body: Buffer | undefined,
  isHandshake: boolean,
): Promise<RawResult> {
  return new Promise<RawResult>((resolve, reject) => {
    // No Origin and no sec-fetch-site: `isTrustedApiRequest` accepts a request
    // with neither once the Host is loopback, and inventing browser markers
    // here would only risk drifting from that contract.
    const outgoing: OutgoingHttpHeaders = { ...headers, host: authority }
    if (body !== undefined) outgoing['content-length'] = body.byteLength
    const clientRequest = httpRequest(
      { host: '127.0.0.1', port, method, path, headers: outgoing },
      (message: IncomingMessage) => {
        const chunks: Buffer[] = []
        message.on('data', (chunk: Buffer) => chunks.push(chunk))
        message.once('end', () => {
          resolve({
            response: {
              status: message.statusCode ?? 0,
              headers: relayableHeaders(message),
              body: Buffer.concat(chunks),
            },
            setCookie: message.headers['set-cookie'] ?? [],
          })
        })
        message.once('error', reject)
      },
    )
    if (isHandshake) clientRequest.setTimeout(HANDSHAKE_TIMEOUT_MS, () => { clientRequest.destroy(new Error('dsh web handshake timed out')) })
    clientRequest.once('error', reject)
    if (body !== undefined) clientRequest.write(body)
    clientRequest.end()
  })
}

function relayableHeaders(message: IncomingMessage): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(message.headers)) {
    // The session cookie is this process's credential; it never reaches the
    // webview. Transfer-coding and length are re-derived by the relaying server.
    if (name === 'set-cookie' || name === 'transfer-encoding' || name === 'content-length') continue
    if (typeof value === 'string') headers[name] = value
  }
  return headers
}
