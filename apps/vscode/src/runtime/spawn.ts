/** Shell-free process launch, including the Windows `.cmd` shim path. */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { extname } from 'node:path'

const WINDOWS_SHIM_EXTENSIONS = new Set(['.cmd', '.bat'])

/**
 * Spawn an executable without ever handing the command line to a shell.
 *
 * Node refuses to spawn a `.cmd` or `.bat` directly since the Windows command
 * injection fix, and pnpm's `node_modules/.bin/dsh.cmd` is exactly that shape.
 * Those two extensions are routed through `cmd.exe /d /s /c` with the command
 * and its arguments kept as separate argv entries, so no quoting of
 * caller-supplied values happens anywhere. Every other case spawns directly.
 * @param command - absolute path to the executable.
 * @param args - arguments passed through unchanged.
 * @param options - spawn options; `shell` is never set.
 * @returns the spawned child process.
 */
export function spawnRuntime(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  if (process.platform === 'win32' && WINDOWS_SHIM_EXTENSIONS.has(extname(command).toLowerCase())) {
    const comspec = process.env.ComSpec ?? 'cmd.exe'
    return spawn(comspec, ['/d', '/s', '/c', command, ...args], options)
  }
  return spawn(command, [...args], options)
}
