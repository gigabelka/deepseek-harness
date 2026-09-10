/** Message shapes carried over the webview `postMessage` bridge. */

/** One request the page asks the extension host to perform on its behalf. */
export type BridgeClientMessage =
  | {
    readonly kind: 'fetch'
    readonly id: string
    readonly method: string
    /** Path and query only; the page never names the server's authority. */
    readonly path: string
    readonly headers: Readonly<Record<string, string>>
    /** Base64 request body, absent for bodiless methods. */
    readonly body?: string
  }
  | {
    readonly kind: 'stream-open'
    readonly id: string
    readonly endpoint: string
    readonly payload: unknown
  }
  | { readonly kind: 'stream-cancel'; readonly id: string }

/** One result the extension host returns to the page. */
export type BridgeHostMessage =
  | {
    readonly kind: 'fetch-result'
    readonly id: string
    readonly status: number
    readonly headers: Readonly<Record<string, string>>
    /** Base64 response body. */
    readonly body: string
  }
  | { readonly kind: 'fetch-error'; readonly id: string; readonly message: string }
  | { readonly kind: 'stream-item'; readonly id: string; readonly value?: unknown }
  | { readonly kind: 'stream-end'; readonly id: string }
  | { readonly kind: 'stream-error'; readonly id: string; readonly message: string }

/**
 * Validate one message arriving from the webview.
 *
 * The page is extension-authored, but `postMessage` is a process boundary, so
 * its payloads are parsed rather than trusted.
 * @param value - untrusted message from the webview.
 * @returns the validated message, or `undefined` when it is not one of ours.
 */
export function parseBridgeClientMessage(value: unknown): BridgeClientMessage | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return undefined
  if (value.kind === 'stream-cancel') return { kind: 'stream-cancel', id: value.id }
  if (value.kind === 'stream-open') {
    if (typeof value.endpoint !== 'string' || value.endpoint === '') return undefined
    return { kind: 'stream-open', id: value.id, endpoint: value.endpoint, payload: value.payload }
  }
  if (value.kind === 'fetch') {
    if (typeof value.method !== 'string' || typeof value.path !== 'string') return undefined
    if (!value.path.startsWith('/')) return undefined
    const headers = isRecord(value.headers) ? stringRecord(value.headers) : {}
    return {
      kind: 'fetch',
      id: value.id,
      method: value.method,
      path: value.path,
      headers,
      ...(typeof value.body === 'string' ? { body: value.body } : {}),
    }
  }
  return undefined
}

function stringRecord(value: Record<string, unknown>): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === 'string') headers[name.toLowerCase()] = entry
  }
  return headers
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
