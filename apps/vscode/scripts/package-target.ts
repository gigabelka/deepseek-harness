/**
 * Assemble a `.vsix` for one platform, or a runtime-less one for every platform.
 *
 * `vsce` is the packager here, which is why the manifest declares no npm
 * publication files: nothing about this application is published to npm.
 * Staging is cleared before each target so an executable never survives into
 * the wrong platform's archive.
 */

import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const extensionDir = resolve(import.meta.dirname, '..')

/** Targets `vsce` accepts, paired with the pipeline names the runtime build uses. */
const TARGETS: Readonly<Record<string, { platform: string; arch: string }>> = {
  'win32-x64': { platform: 'win', arch: 'x64' },
  'win32-arm64': { platform: 'win', arch: 'arm64' },
  'darwin-x64': { platform: 'macos', arch: 'x64' },
  'darwin-arm64': { platform: 'macos', arch: 'arm64' },
  'linux-x64': { platform: 'linux', arch: 'x64' },
  'linux-arm64': { platform: 'linux', arch: 'arm64' },
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'no-runtime': { type: 'boolean', default: false },
      out: { type: 'string', default: 'dist' },
      help: { type: 'boolean', default: false },
    },
  })
  if (values.help === true) {
    process.stdout.write(usage())
    return
  }

  const outDir = values.out ?? 'dist'
  if (values['no-runtime'] === true) {
    // Users who already have dsh installed take a far smaller archive; the
    // extension then resolves the workspace or PATH executable as usual.
    await rm(join(extensionDir, 'runtime'), { recursive: true, force: true })
    await run('vsce', ['package', '--no-dependencies', '--out', join(outDir, 'dsh-no-runtime.vsix')])
    return
  }

  const targets = positionals.length > 0 ? positionals : Object.keys(TARGETS)
  for (const target of targets) {
    const source = TARGETS[target]
    if (source === undefined) {
      throw new Error(`unknown target ${JSON.stringify(target)}; expected one of ${Object.keys(TARGETS).join(', ')}`)
    }
    await rm(join(extensionDir, 'runtime'), { recursive: true, force: true })
    await run('tsx', [
      join(extensionDir, 'scripts', 'prepare-runtime.ts'),
      '--platform', source.platform,
      '--arch', source.arch,
    ])
    await run('vsce', [
      'package',
      '--no-dependencies',
      '--target', target,
      '--out', join(outDir, `dsh-${target}.vsix`),
    ])
  }
}

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise<void>((settle, reject) => {
    const child = spawn('pnpm', ['exec', command, ...args], { cwd: extensionDir, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) settle()
      else reject(new Error(`${command} exited with code ${String(code)}`))
    })
  })
}

function usage(): string {
  return [
    'Usage: tsx scripts/package-target.ts [target...] [--out <dir>]',
    '       tsx scripts/package-target.ts --no-runtime [--out <dir>]',
    '',
    `Targets: ${Object.keys(TARGETS).join(', ')}`,
    'With no target, every target is packaged in turn.',
    '',
    'Build the single-file runtimes first; this script only stages and archives them.',
    '',
  ].join('\n')
}

await main()
