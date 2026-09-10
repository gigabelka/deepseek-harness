/** Supervision of one `dsh --profile web` child process. */

import type { ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import type { Logger } from '../log.ts'
import { parseRuntimeVersion, type RuntimeProbe } from './resolve.ts'
import { spawnRuntime } from './spawn.ts'

/** Grace period between SIGTERM and SIGKILL during teardown. */
const TERMINATION_GRACE_MS = 5_000
/** Bound on a `--version` probe; a hung candidate must not stall activation. */
const PROBE_TIMEOUT_MS = 10_000
/** How much stderr to retain for diagnostics when the child dies early. */
const STDERR_TAIL_BYTES = 4_096

/** Environment variable carrying the file-effect mode into the runtime. */
export const PERMISSION_MODE_ENV = 'DSH_PERMISSION_MODE'

/**
 * File-effect modes the runtime accepts, in increasing reach. Mirrors the
 * `SandboxMode` vocabulary of `packages/sandbox/sandbox-policy`; the extension
 * declares no workspace dependency on it, so the wire value is restated here.
 */
export const PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const

/** One file-effect mode the runtime can be launched with. */
export type PermissionMode = typeof PERMISSION_MODES[number]

/**
 * Interpret the `dsh.permissionMode` setting.
 * @param value - the raw setting value, of any type.
 * @returns the value when it names a mode, otherwise `workspace-write`.
 */
export function resolvePermissionMode(value: unknown): PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)
    ? value as PermissionMode
    : 'workspace-write'
}

/** The loopback endpoint a booted `dsh web` published. */
export interface WebEndpoint {
  /** Port the server bound, always on 127.0.0.1. */
  readonly port: number
  /** One-shot launch token that mints the browser auth cookie. */
  readonly launchToken: string
}

/** A running `dsh web` owned by the extension. */
export interface RunningServer extends WebEndpoint {
  /** Stop the child, escalating SIGTERM to SIGKILL; idempotent. */
  dispose(): Promise<void>
}

/**
 * Parse the readiness line `dsh web` prints once its routes are mounted.
 *
 * `packages/bundle/web-app/src/index.ts` documents this line as the supervisor
 * contract. The LAN suffix is ignored: the extension only ever talks to
 * loopback.
 * @param line - one complete stdout line.
 * @returns the endpoint, or `undefined` when the line is not the readiness line.
 */
export function parseReadinessLine(line: string): WebEndpoint | undefined {
  const match = /^dsh web: (\S+)$/.exec(line.trim())
    ?? /^dsh web: (\S+) \(LAN: \S+\)$/.exec(line.trim())
  if (match?.[1] === undefined) return undefined
  let url: URL
  try {
    url = new URL(match[1])
  } catch {
    // A future readiness line whose first token is not a URL: not ours.
    return undefined
  }
  const launchToken = url.searchParams.get('token')
  if (launchToken === null || launchToken === '') return undefined
  const port = Number(url.port)
  if (!Number.isInteger(port) || port <= 0) return undefined
  return { port, launchToken }
}

/**
 * Split a growing stdout buffer into complete lines.
 * @param buffered - text accumulated so far, including the partial tail.
 * @returns the complete lines and the leftover partial line.
 */
export function splitLines(buffered: string): { lines: readonly string[]; rest: string } {
  const parts = buffered.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts, rest }
}

/**
 * Probe a candidate executable for its reported version.
 * @param command - absolute path to the candidate.
 * @returns the release string, or `undefined` when the candidate is unusable.
 */
export const probeRuntimeVersion: RuntimeProbe = async (command) => {
  const child = spawnRuntime(command, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
  let output = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => { output += chunk })
  const timer = setTimeout(() => { child.kill('SIGKILL') }, PROBE_TIMEOUT_MS)
  try {
    const code = await new Promise<number | null>((resolve) => {
      child.once('error', () => { resolve(null) })
      child.once('close', resolve)
    })
    return code === 0 ? parseRuntimeVersion(output) : undefined
  } finally {
    clearTimeout(timer)
  }
}

/** Everything the launcher needs to boot and supervise the child. */
export interface ServerLaunchRequest {
  /** Absolute path to the resolved `dsh` executable. */
  readonly command: string
  /** Working directory, which `dsh` adopts as the workspace root. */
  readonly cwd: string
  /** File-effect mode the child starts from, exported as {@link PERMISSION_MODE_ENV}. */
  readonly permissionMode: PermissionMode
  /** How long to wait for the readiness line. */
  readonly readinessTimeoutMs: number
  /** Diagnostics sink; the child's stderr is mirrored into it. */
  readonly logger: Logger
}

/**
 * Boot `dsh --profile web` on an OS-assigned loopback port and wait for it.
 *
 * `--port 0` avoids colliding with a `dsh web` the user already runs, and
 * `--no-open` suppresses the browser handoff because the UI belongs in the
 * webview. The extension's own mode setting wins over an inherited
 * `DSH_PERMISSION_MODE`, so the value a user sees in VS Code settings is the
 * one the runtime starts from; the rest of the parent environment is passed
 * through unchanged, because the child needs the credentials it carries.
 * @param request - launch inputs.
 * @returns the running server once it has published its endpoint.
 * @throws when the child exits early or never announces readiness.
 */
export async function startWebServer(request: ServerLaunchRequest): Promise<RunningServer> {
  const child = spawnRuntime(
    request.command,
    ['--profile', 'web', '--port', '0', '--no-open'],
    {
      cwd: request.cwd,
      env: { ...process.env, [PERMISSION_MODE_ENV]: request.permissionMode },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stderrTail = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES)
    for (const line of chunk.split('\n')) {
      if (line.trim() !== '') request.logger.info(`dsh: ${line.trimEnd()}`)
    }
  })

  const dispose = terminator(child)
  try {
    const endpoint = await awaitReadiness(child, request, () => stderrTail)
    return { ...endpoint, dispose }
  } catch (cause) {
    await dispose()
    throw cause
  }
}

function awaitReadiness(
  child: ChildProcess,
  request: ServerLaunchRequest,
  stderrTail: () => string,
): Promise<WebEndpoint> {
  return new Promise<WebEndpoint>((resolve, reject) => {
    let buffered = ''
    let settled = false
    const finish = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      outcome()
    }
    const timer = setTimeout(() => {
      finish(() => {
        reject(new Error(
          `dsh web did not report readiness within ${String(request.readinessTimeoutMs)} ms. `
          + `Last output: ${stderrTail().trim() || '(none)'}`,
        ))
      })
    }, request.readinessTimeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffered += chunk
      const { lines, rest } = splitLines(buffered)
      buffered = rest
      for (const line of lines) {
        if (line.trim() !== '') request.logger.info(`dsh: ${line.trimEnd()}`)
        const endpoint = parseReadinessLine(line)
        if (endpoint !== undefined) {
          finish(() => { resolve(endpoint) })
          return
        }
      }
    })
    child.once('error', (cause: Error) => {
      finish(() => { reject(new Error(`dsh web could not start: ${cause.message}`, { cause })) })
    })
    child.once('exit', (code) => {
      finish(() => {
        reject(new Error(
          `dsh web exited with code ${String(code)} before reporting readiness. `
          + `Last output: ${stderrTail().trim() || '(none)'}`,
        ))
      })
    })
  })
}

function terminator(child: ChildProcess): () => Promise<void> {
  let pending: Promise<void> | undefined
  return () => {
    pending ??= (async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
      child.kill('SIGTERM')
      const escalate = delay(TERMINATION_GRACE_MS).then(() => 'timeout' as const)
      if (await Promise.race([exited.then(() => 'exited' as const), escalate]) === 'timeout') {
        child.kill('SIGKILL')
        await exited
      }
    })()
    return pending
  }
}
