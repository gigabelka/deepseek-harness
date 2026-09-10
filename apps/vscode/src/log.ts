/** Logging seam shared by every module that must not import `vscode`. */

/** Sink the extension writes diagnostics to; backed by a VS Code output channel. */
export interface Logger {
  /** Append one diagnostic line. */
  info(message: string): void
  /** Append one failure line, including the reason when a cause is available. */
  error(message: string, cause?: unknown): void
}

/**
 * Reduce an unknown thrown value to a single-line reason.
 * @param cause - value thrown or rejected anywhere in the extension.
 * @returns the error message, or the value's string form when it is not an Error.
 */
export function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Adapt a line-appending sink to {@link Logger}.
 * @param appendLine - receives one complete, already-formatted line.
 * @returns a logger that timestamps and formats every entry.
 */
export function createLogger(appendLine: (line: string) => void): Logger {
  const write = (level: string, message: string): void => {
    appendLine(`[${new Date().toISOString()}] ${level} ${message}`)
  }
  return {
    info: (message) => { write('info', message) },
    error: (message, cause) => {
      write('error', cause === undefined ? message : `${message}: ${describeCause(cause)}`)
    },
  }
}
