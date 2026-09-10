/** VS Code activation entry: commands and the panel's lifetime. */

import * as vscode from 'vscode'
import { createLogger, describeCause } from './log.ts'
import { HarnessPanel } from './webview/panel.ts'

let panel: HarnessPanel | undefined

/**
 * Register the extension's commands.
 *
 * Nothing is spawned here: the runtime boots on the first `dsh.open`, so a
 * window that never opens the panel never pays for it.
 * @param context - the extension context owning every disposable.
 */
export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('DeepSeek Harness')
  context.subscriptions.push(channel)
  const logger = createLogger((line) => { channel.appendLine(line) })
  const harness = new HarnessPanel(logger, context.extensionPath)
  panel = harness
  context.subscriptions.push({ dispose: () => { void harness.dispose() } })

  const run = (name: string, action: () => Promise<void>): vscode.Disposable =>
    vscode.commands.registerCommand(name, () => {
      void action().catch((cause: unknown) => {
        logger.error(`${name} failed`, cause)
        void vscode.window.showErrorMessage(`DeepSeek Harness: ${describeCause(cause)}`)
      })
    })

  context.subscriptions.push(
    run('dsh.open', () => harness.show()),
    run('dsh.restart', () => harness.restart()),
    run('dsh.showLogs', () => { channel.show(); return Promise.resolve() }),
  )
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
