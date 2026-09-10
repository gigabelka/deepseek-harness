import { describe, expect, it } from 'vitest'
import { PERMISSION_MODES, resolvePermissionMode } from '../src/runtime/server.ts'
import { projectFolders, shouldAutoOpen } from '../src/startup.ts'

const folder = (scheme: string, fsPath: string) => ({ uri: { scheme, fsPath } })

describe('projectFolders', () => {
  it('keeps file folders in VS Code order', () => {
    expect(projectFolders([folder('file', '/one'), folder('file', '/two')])).toEqual(['/one', '/two'])
  })

  it('drops a folder with no filesystem path the runtime could adopt', () => {
    expect(projectFolders([folder('vscode-remote', '/one'), folder('file', '/two')])).toEqual(['/two'])
  })

  it('reports no folders for an empty window', () => {
    expect(projectFolders(undefined)).toEqual([])
  })
})

describe('shouldAutoOpen', () => {
  it('opens against the first project folder', () => {
    expect(shouldAutoOpen(true, ['/one', '/two'])).toBe(true)
  })

  it('never opens in a window without a project', () => {
    expect(shouldAutoOpen(true, [])).toBe(false)
  })

  it('honors the setting', () => {
    expect(shouldAutoOpen(false, ['/one'])).toBe(false)
  })
})

describe('resolvePermissionMode', () => {
  it('accepts every mode the runtime vocabulary carries', () => {
    for (const mode of PERMISSION_MODES) expect(resolvePermissionMode(mode)).toBe(mode)
  })

  it('falls back to workspace-write for an unset, unknown, or mistyped value', () => {
    expect(resolvePermissionMode(undefined)).toBe('workspace-write')
    expect(resolvePermissionMode('yolo')).toBe('workspace-write')
    expect(resolvePermissionMode(2)).toBe('workspace-write')
  })
})
