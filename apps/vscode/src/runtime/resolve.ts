/** Ordered discovery of a usable `dsh` executable, bundled runtime last. */

import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

/** Where a resolved executable came from; surfaced to the user in the log. */
export type RuntimeSource = 'setting' | 'workspace' | 'path' | 'bundled'

/** Which candidates the user allows the extension to consider. */
export type RuntimePreference = 'auto' | 'workspace' | 'bundled'

/** One executable the extension is willing to probe. */
export interface RuntimeCandidate {
  /** Absolute path to the executable; never passed through a shell. */
  readonly command: string
  /** Which discovery rule produced this candidate. */
  readonly source: RuntimeSource
}

/** A candidate that answered `--version` with a usable release. */
export interface ResolvedRuntime extends RuntimeCandidate {
  /** The version the executable reported. */
  readonly version: string
}

/** Inputs the discovery order depends on. */
export interface RuntimeResolutionRequest {
  /** The user's `dsh.runtime` choice. */
  readonly preference: RuntimePreference
  /** The user's `dsh.executablePath`; empty when unset. */
  readonly executablePath: string
  /** Absolute workspace folder paths, in VS Code's order. */
  readonly workspaceFolders: readonly string[]
  /** Absolute extension install directory, holding `runtime/<platform>-<arch>/`. */
  readonly extensionPath: string
  /** `process.platform` of the extension host. */
  readonly platform: NodeJS.Platform
  /** `process.arch` of the extension host. */
  readonly arch: string
  /** `PATH` as seen by the extension host; absent when the variable is unset. */
  readonly pathVariable?: string
  /** `PATHEXT` on Windows; ignored elsewhere. */
  readonly pathExtVariable?: string
}

/**
 * Ask an executable for its version.
 *
 * Injected so tests never spawn a process. Returns `undefined` when the
 * candidate is missing, times out, exits nonzero, or prints no release.
 */
export type RuntimeProbe = (command: string) => Promise<string | undefined>

/** Minimum `dsh` whose served index this extension knows how to rewrite. */
export const MINIMUM_RUNTIME_VERSION = '0.1.5-rc.1'

const EXECUTABLE_STEM = 'dsh'

/**
 * List every candidate executable in the order the extension prefers them.
 *
 * The explicit setting wins, then a `dsh` the workspace itself pins, then one on
 * `PATH`, then the runtime shipped inside the extension. A `workspace`
 * preference drops the bundled runtime; a `bundled` preference drops everything
 * else, so a user can pin either side when both exist.
 * @param request - discovery inputs.
 * @returns candidates in probe order, without touching the filesystem.
 */
export function runtimeCandidates(request: RuntimeResolutionRequest): readonly RuntimeCandidate[] {
  const candidates: RuntimeCandidate[] = []
  if (request.preference !== 'bundled') {
    if (request.executablePath !== '') {
      candidates.push({ command: request.executablePath, source: 'setting' })
    }
    for (const folder of request.workspaceFolders) {
      for (const name of binaryNames(request.platform)) {
        candidates.push({ command: join(folder, 'node_modules', '.bin', name), source: 'workspace' })
      }
    }
    for (const directory of (request.pathVariable ?? '').split(delimiter)) {
      if (directory === '') continue
      for (const name of binaryNames(request.platform, request.pathExtVariable)) {
        candidates.push({ command: join(directory, name), source: 'path' })
      }
    }
  }
  if (request.preference !== 'workspace') {
    candidates.push({ command: bundledRuntimePath(request), source: 'bundled' })
  }
  return candidates
}

/**
 * Absolute path of the runtime staged into the extension for this platform.
 * @param request - discovery inputs carrying the extension path and platform.
 * @returns the expected executable path, which need not exist.
 */
export function bundledRuntimePath(request: RuntimeResolutionRequest): string {
  const suffix = request.platform === 'win32' ? '.exe' : ''
  return join(request.extensionPath, 'runtime', `${request.platform}-${request.arch}`, `${EXECUTABLE_STEM}${suffix}`)
}

/**
 * Probe candidates in order and return the first that answers with a version.
 * @param request - discovery inputs.
 * @param probe - version probe, injected so tests do not spawn processes.
 * @returns the first usable runtime.
 * @throws when no candidate answers, naming what was tried.
 */
export async function resolveRuntime(
  request: RuntimeResolutionRequest,
  probe: RuntimeProbe,
): Promise<ResolvedRuntime> {
  const candidates = runtimeCandidates(request)
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (seen.has(candidate.command)) continue
    seen.add(candidate.command)
    if (!await isExecutableFile(candidate.command)) continue
    const version = await probe(candidate.command)
    if (version === undefined) continue
    return { ...candidate, version }
  }
  throw new Error(
    `no usable dsh runtime; tried ${String(seen.size)} candidate(s). `
    + 'Install @deepseek-ai/dsh in the workspace, put dsh on PATH, set dsh.executablePath, '
    + 'or install the platform-specific build of this extension.',
  )
}

/**
 * Recognize the release string a `dsh --version` run prints.
 * @param output - complete stdout of the probe.
 * @returns the first semver-shaped token, or `undefined` when there is none.
 */
export function parseRuntimeVersion(output: string): string | undefined {
  return /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(output)?.[0]
}

function binaryNames(platform: NodeJS.Platform, pathExtVariable?: string): readonly string[] {
  if (platform !== 'win32') return [EXECUTABLE_STEM]
  // pnpm writes both `dsh` (a shell script) and `dsh.cmd`; only the latter is
  // directly spawnable on Windows without a shell, so it must come first.
  const extensions = (pathExtVariable ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(entry => entry !== '')
    .map(entry => entry.toLowerCase())
  return [...new Set([...extensions.map(entry => `${EXECUTABLE_STEM}${entry}`), EXECUTABLE_STEM])]
}

async function isExecutableFile(command: string): Promise<boolean> {
  try {
    if (!(await stat(command)).isFile()) return false
  } catch {
    // ENOENT and friends: this candidate simply is not installed.
    return false
  }
  if (process.platform === 'win32') return true
  try {
    await access(command, constants.X_OK)
    return true
  } catch {
    // Present but not executable: a staged runtime that lost its mode bit.
    return false
  }
}
