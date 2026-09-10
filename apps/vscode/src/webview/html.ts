/** Rewrite of the served `dsh web` index for a webview document. */

/** The exact tag `dsh-host-frontend-static` splices into every served index. */
const SERVED_BASE_TAG = '<base href="/">'

/** Inputs the rewrite needs; all of them are extension-controlled. */
export interface IndexTransformRequest {
  /** Origin of the extension's asset proxy, e.g. `http://localhost:51234`. */
  readonly proxyOrigin: string
  /** Unguessable path prefix the proxy requires, without slashes. */
  readonly nonce: string
  /** Page-side transport installer, inlined ahead of every boot script. */
  readonly bridgeScript: string
}

/**
 * Point the served index at the extension's proxy and install the transport.
 *
 * Exactly two edits are made. Replacing `<base href="/">` re-anchors every
 * root-absolute URL in the document at once — the `/plugins/??…` combo bundles,
 * the Vite assets, the manifest and the favicon — so no per-URL rewriting is
 * needed and nothing has to know the shape of the server's index injections.
 * The bridge is inserted immediately after, ahead of the boot scripts that read
 * `globalThis.__DSH_TRANSPORT__`.
 *
 * The CSP must keep `'unsafe-inline'` and must not carry a nonce: the index
 * contains several inline scripts whose text the server owns, and under CSP3 a
 * nonce would override `'unsafe-inline'` and stop them executing.
 * @param html - the index exactly as `dsh web` served it.
 * @param request - proxy origin, path nonce, and bridge source.
 * @returns the document to hand the webview.
 * @throws when the base tag is absent, meaning the server composition changed.
 */
export function transformIndexHtml(html: string, request: IndexTransformRequest): string {
  if (!html.includes(SERVED_BASE_TAG)) {
    throw new Error(
      'dsh web served an index without the expected <base href="/"> tag; '
      + 'this dsh runtime is not compatible with this version of the extension.',
    )
  }
  const base = `<base href="${proxyRoot(request)}">`
  const csp = contentSecurityPolicy(request.proxyOrigin)
  const bridge = `<script>${request.bridgeScript}</script>`
  return html.replace(SERVED_BASE_TAG, `${csp}${base}${bridge}`)
}

/**
 * Absolute URL every relative document reference resolves against.
 * @param request - proxy origin and path nonce.
 * @returns the proxy root, with the trailing slash `<base>` requires.
 */
export function proxyRoot(request: Pick<IndexTransformRequest, 'proxyOrigin' | 'nonce'>): string {
  return `${request.proxyOrigin}/${request.nonce}/`
}

function contentSecurityPolicy(proxyOrigin: string): string {
  const policy = [
    'default-src \'none\'',
    `script-src 'unsafe-inline' 'unsafe-eval' ${proxyOrigin}`,
    `style-src 'unsafe-inline' ${proxyOrigin}`,
    `img-src data: blob: ${proxyOrigin}`,
    `font-src data: ${proxyOrigin}`,
    `connect-src ${proxyOrigin}`,
    `media-src blob: ${proxyOrigin}`,
    'worker-src blob:',
  ].join('; ')
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">`
}
