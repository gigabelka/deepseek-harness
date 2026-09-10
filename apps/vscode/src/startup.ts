/** Activation rules the extension applies before it touches the runtime. */

/**
 * One workspace folder, reduced to the fields every rule here reads, so this
 * module stays importable without the `vscode` module.
 */
export interface WorkspaceFolderLike {
  /** Folder location. */
  readonly uri: {
    /** URI scheme; only `file` folders carry a runtime workspace root. */
    readonly scheme: string
    /** Absolute local path of the folder. */
    readonly fsPath: string
  }
}

/**
 * List the workspace folders a harness can be rooted at.
 *
 * A virtual folder (a remote, notebook, or output scheme) has no filesystem
 * path the runtime could adopt, so it is never a candidate. Order is VS Code's
 * own, and the first entry is the root the runtime receives.
 * @param folders - `vscode.workspace.workspaceFolders`, or undefined in an empty window.
 * @returns absolute paths of the file-scheme folders.
 */
export function projectFolders(folders: readonly WorkspaceFolderLike[] | undefined): readonly string[] {
  return (folders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath)
}

/**
 * Decide whether activation opens the panel without an explicit command.
 *
 * An empty window has no project to open a harness against, so `dsh.autoOpen`
 * deliberately has no effect there.
 * @param autoOpen - the `dsh.autoOpen` setting.
 * @param folders - absolute paths of the window's file-scheme workspace folders.
 * @returns true when the panel should open on activation.
 */
export function shouldAutoOpen(autoOpen: boolean, folders: readonly string[]): boolean {
  return autoOpen && folders.length > 0
}
