import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bundledRuntimePath, parseRuntimeVersion, runtimeCandidates,
  type RuntimeResolutionRequest,
} from '../src/runtime/resolve.ts'

function request(overrides: Partial<RuntimeResolutionRequest> = {}): RuntimeResolutionRequest {
  return {
    preference: 'auto',
    executablePath: '',
    workspaceFolders: ['/work'],
    extensionPath: '/ext',
    platform: 'linux',
    arch: 'x64',
    pathVariable: '/usr/bin:/opt/bin',
    ...overrides,
  }
}

describe('runtimeCandidates', () => {
  it('prefers the explicit setting over every discovered candidate', () => {
    const sources = runtimeCandidates(request({ executablePath: '/pinned/dsh' })).map(entry => entry.source)
    expect(sources[0]).toBe('setting')
  })

  it('prefers a workspace dsh over one on PATH, and PATH over the bundled runtime', () => {
    const sources = runtimeCandidates(request()).map(entry => entry.source)
    expect(sources.indexOf('workspace')).toBeLessThan(sources.indexOf('path'))
    expect(sources.indexOf('path')).toBeLessThan(sources.indexOf('bundled'))
  })

  it('drops the bundled runtime when the user pins the workspace', () => {
    const sources = runtimeCandidates(request({ preference: 'workspace' })).map(entry => entry.source)
    expect(sources).not.toContain('bundled')
  })

  it('offers only the bundled runtime when the user pins it', () => {
    const sources = runtimeCandidates(request({ preference: 'bundled', executablePath: '/pinned/dsh' }))
      .map(entry => entry.source)
    expect(sources).toEqual(['bundled'])
  })

  it('tries the directly spawnable .cmd shim before the extensionless shell script on Windows', () => {
    const commands = runtimeCandidates(request({ platform: 'win32', pathExtVariable: '.EXE;.CMD' }))
      .filter(entry => entry.source === 'workspace')
      .map(entry => entry.command)
    const shim = commands.findIndex(command => command.endsWith('dsh.cmd'))
    const bare = commands.findIndex(command => command.endsWith(join('.bin', 'dsh')))
    expect(shim).toBeGreaterThanOrEqual(0)
    expect(shim).toBeLessThan(bare)
  })

  it('covers every workspace folder', () => {
    const commands = runtimeCandidates(request({ workspaceFolders: ['/a', '/b'] }))
      .filter(entry => entry.source === 'workspace')
      .map(entry => entry.command)
    expect(commands).toEqual([
      join('/a', 'node_modules', '.bin', 'dsh'),
      join('/b', 'node_modules', '.bin', 'dsh'),
    ])
  })
})

describe('bundledRuntimePath', () => {
  it('names the platform directory the packaging step stages into', () => {
    expect(bundledRuntimePath(request())).toBe(join('/ext', 'runtime', 'linux-x64', 'dsh'))
  })

  it('carries the executable suffix on Windows', () => {
    expect(bundledRuntimePath(request({ platform: 'win32' })))
      .toBe(join('/ext', 'runtime', 'win32-x64', 'dsh.exe'))
  })
})

describe('parseRuntimeVersion', () => {
  it('accepts the prerelease the repository currently ships', () => {
    expect(parseRuntimeVersion('0.1.5-rc.1\n')).toBe('0.1.5-rc.1')
  })

  it('finds the release inside a decorated line', () => {
    expect(parseRuntimeVersion('dsh version 1.2.3')).toBe('1.2.3')
  })

  it('rejects output carrying no release', () => {
    expect(parseRuntimeVersion('command not found')).toBeUndefined()
  })
})
