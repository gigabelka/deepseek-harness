/** Extension-host side of the webview transport bridge. */

import type { WebSocket } from 'ws'
import { describeCause, type Logger } from '../log.ts'
import type { HarnessSession } from '../runtime/session.ts'
import { parseBridgeClientMessage, type BridgeHostMessage } from './protocol.ts'

/** Exact WebSocket route carrying every Typert Remote stream. */
const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'
/** Only this channel may be reached through the bridge's unary path. */
const API_CHANNEL_PREFIX = '/api/'

/** The webview surface the bridge talks to, narrowed away from the `vscode` types. */
export interface BridgeChannel {
  /** Deliver one message to the page. */
  postMessage(message: BridgeHostMessage): void
  /** Subscribe to page messages; the returned function unsubscribes. */
  onMessage(listener: (value: unknown) => void): () => void
}

/** A live bridge bound to one webview. */
export interface Bridge {
  /** Cancel every in-flight stream and drop the mux socket. */
  dispose(): void
}

/**
 * Relay the page's transport calls to the authenticated session.
 *
 * Unary `/api` calls become buffered HTTP requests carrying the session cookie.
 * Streams are multiplexed over one `/api/remote.mux` WebSocket held here, so the
 * page never opens a socket whose `Origin` the trust fence would reject. The
 * logical-stream frames are the ones `packages/api/gateway/src/stream-protocol.ts`
 * defines; this side speaks them verbatim.
 * @param channel - the webview to serve.
 * @param session - the authenticated connection to `dsh web`.
 * @param logger - diagnostics sink.
 * @returns the bridge, which must be disposed with the panel.
 */
export function attachBridge(channel: BridgeChannel, session: HarnessSession, logger: Logger): Bridge {
  const openStreams = new Set<string>()
  let socket: WebSocket | undefined
  let socketReady: Promise<WebSocket> | undefined
  let disposed = false

  const ensureSocket = async (): Promise<WebSocket> => {
    socketReady ??= new Promise<WebSocket>((resolve, reject) => {
      const candidate = session.openSocket(REMOTE_STREAM_MUX_PATH)
      candidate.on('message', (data: Buffer | string) => { onServerFrame(String(data)) })
      candidate.on('error', (cause: Error) => {
        logger.error('remote stream socket failed', cause)
        reject(cause)
      })
      candidate.on('close', () => {
        socket = undefined
        socketReady = undefined
        for (const id of openStreams) {
          channel.postMessage({ kind: 'stream-error', id, message: 'the dsh runtime closed the stream connection' })
        }
        openStreams.clear()
      })
      candidate.on('open', () => {
        socket = candidate
        resolve(candidate)
      })
    })
    return socketReady
  }

  const onServerFrame = (text: string): void => {
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch (cause) {
      logger.error('remote stream frame is not JSON', cause)
      return
    }
    if (typeof frame !== 'object' || frame === null) return
    const { type, streamId } = frame as { type?: unknown; streamId?: unknown }
    if (typeof streamId !== 'string' || !openStreams.has(streamId)) return
    if (type === 'item') {
      const value = (frame as { value?: unknown }).value
      channel.postMessage(
        Object.hasOwn(frame, 'value')
          ? { kind: 'stream-item', id: streamId, value }
          : { kind: 'stream-item', id: streamId },
      )
      return
    }
    openStreams.delete(streamId)
    if (type === 'end') {
      channel.postMessage({ kind: 'stream-end', id: streamId })
      return
    }
    const error = (frame as { error?: { message?: unknown } }).error
    const message = typeof error?.message === 'string' ? error.message : 'remote stream failed'
    channel.postMessage({ kind: 'stream-error', id: streamId, message })
  }

  const unsubscribe = channel.onMessage((value) => {
    if (disposed) return
    const message = parseBridgeClientMessage(value)
    if (message === undefined) return
    void handle(message).catch((cause: unknown) => {
      logger.error(`bridge message ${message.kind} failed`, cause)
      if (message.kind === 'fetch') {
        channel.postMessage({ kind: 'fetch-error', id: message.id, message: describeCause(cause) })
      } else if (message.kind === 'stream-open') {
        openStreams.delete(message.id)
        channel.postMessage({ kind: 'stream-error', id: message.id, message: describeCause(cause) })
      }
    })
  })

  async function handle(message: ReturnType<typeof parseBridgeClientMessage> & object): Promise<void> {
    if (message.kind === 'fetch') {
      if (!message.path.startsWith(API_CHANNEL_PREFIX)) {
        throw new Error(`bridge refuses ${message.path}: only ${API_CHANNEL_PREFIX} is relayed`)
      }
      const response = await session.request(
        message.method,
        message.path,
        message.headers,
        message.body === undefined ? undefined : Buffer.from(message.body, 'base64'),
      )
      channel.postMessage({
        kind: 'fetch-result',
        id: message.id,
        status: response.status,
        headers: response.headers,
        body: response.body.toString('base64'),
      })
      return
    }
    if (message.kind === 'stream-open') {
      openStreams.add(message.id)
      const live = await ensureSocket()
      if (!openStreams.has(message.id)) return
      live.send(JSON.stringify({
        type: 'open',
        streamId: message.id,
        endpoint: message.endpoint,
        payload: message.payload,
      }))
      return
    }
    if (!openStreams.delete(message.id)) return
    socket?.send(JSON.stringify({ type: 'cancel', streamId: message.id }))
  }

  return {
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      openStreams.clear()
      socket?.close()
      socket = undefined
      socketReady = undefined
    },
  }
}
