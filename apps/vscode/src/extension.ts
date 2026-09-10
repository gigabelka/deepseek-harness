/** VS Code activation entry: commands, auto-open, and the panel's lifetime. */

import * as vscode from 'vscode'
import { createLogger, describeCause } from './log.ts'
import { projectFolders, shouldAutoOpen } from './startup.ts'
import { HarnessPanel } from './webview/panel.ts'

let panel: HarnessPanel | undefined

/**
 * Register the extension's commands and open the panel when configured to.
 *
 * The runtime itself boots on the first `dsh.open` — or on activation through
 * `dsh.autoOpen` — so a window that never opens the panel never pays for it.
 * @param context - the extension context owning every disposable.
 */
export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('DeepSeek Harness')
  context.subscriptions.push(channel)
  const logger = createLogger((line) => { channel.appendLine(line) })
  const harness = new HarnessPanel(logger, context.extensionPath)
  panel = harness
  context.subscriptions.push({ dispose: () => { void harness.dispose() } })

  // Every path that touches the runtime reports the same way: a command
  // failure and a failed auto-open are equally invisible without it.
  const report = (what: string, action: () => Promise<void>): void => {
    void action().catch((cause: unknown) => {
      logger.error(`${what} failed`, cause)
      void vscode.window.showErrorMessage(`DeepSeek Harness: ${describeCause(cause)}`)
    })
  }
  const run = (name: string, action: () => Promise<void>): vscode.Disposable =>
    vscode.commands.registerCommand(name, () => { report(name, action) })

  context.subscriptions.push(
    run('dsh.open', () => harness.show()),
    run('dsh.restart', () => harness.restart()),
    run('dsh.showLogs', () => { channel.show(); return Promise.resolve() }),
  )

  const settings = vscode.workspace.getConfiguration('dsh')
  if (shouldAutoOpen(settings.get<boolean>('autoOpen') ?? true, projectFolders(vscode.workspace.workspaceFolders))) {
    report('dsh.open', () => harness.show())
  }
}

/**
 * Stop the runtime when the extension host unloads.
 * @returns once the child process has exited.
 */
export async function deactivate(): Promise<void> {
  const harness = panel
  panel = undefined
  await harness?.dispose()
}
