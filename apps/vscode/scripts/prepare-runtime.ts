/**
 * Stage a single-file dsh runtime into the extension for one target.
 *
 * The executable itself is produced by the shared pipeline in
 * `scripts/build-exe-for-python-sdk.ts`, which writes
 * `dist-exe/deepseek-harness-sdk-runtime-<platform>-<arch>[.exe]` plus the
 * sidecars that must sit beside it. This script only selects a target's files
 * and copies them under `runtime/<node platform>-<arch>/`, where
 * `src/runtime/resolve.ts` looks for them. It never rebuilds: run the pipeline
 * first, so a `.vsix` matrix can compile once per target and stage many times.
 */

import { chmod, copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..', '..', '..')
const extensionDir = resolve(import.meta.dirname, '..')

/** Where the shared pipeline leaves its products. */
const SOURCE_DIR = 'dist-exe'
/** Basename the shared pipeline gives every product. */
const SOURCE_BASENAME = 'deepseek-harness-sdk-runtime'
/** Basename the extension looks for, matching the `dsh` command it stands in for. */
const STAGED_BASENAME = 'dsh'

/** pkg platform names mapped to the `process.platform` values the extension resolves against. */
const NODE_PLATFORMS: Readonly<Record<string, string>> = {
  linux: 'linux',
  macos: 'darwin',
  win: 'win32',
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      platform: { type: 'string' },
      arch: { type: 'string', default: 'x64' },
      help: { type: 'boolean', default: false },
    },
  })
  if (values.help === true || values.platform === undefined) {
    process.stdout.write(usage())
    process.exitCode = values.help === true ? 0 : 1
    return
  }
  const platform = values.platform
  const arch = values.arch ?? 'x64'
  const nodePlatform = NODE_PLATFORMS[platform]
  if (nodePlatform === undefined) {
    throw new Error(`unknown platform ${JSON.stringify(platform)}; expected one of ${Object.keys(NODE_PLATFORMS).join(', ')}`)
  }

  const sourceDir = join(root, SOURCE_DIR)
  const suffix = platform === 'win' ? '.exe' : ''
  const productName = `${SOURCE_BASENAME}-${platform}-${arch}${suffix}`
  const products = await readdir(sourceDir).catch(() => {
    throw new Error(
      `${SOURCE_DIR}/ is missing; run the single-file executable build for ${platform}-${arch} first`,
    )
  })
  if (!products.includes(productName)) {
    throw new Error(`${SOURCE_DIR}/${productName} is missing; build that target before staging it`)
  }

  // Sidecars (the ripgrep binary, and the macOS spawn helper) are named for the
  // same target and must travel beside the executable.
  const targetTag = `${platform}-${arch}`
  const staged = join(extensionDir, 'runtime', `${nodePlatform}-${arch}`)
  await rm(staged, { recursive: true, force: true })
  await mkdir(staged, { recursive: true })
  for (const product of products) {
    if (!product.includes(targetTag)) continue
    const destination = product === productName
      ? join(staged, `${STAGED_BASENAME}${suffix}`)
      : join(staged, basename(product))
    await copyFile(join(sourceDir, product), destination)
    if (platform !== 'win') await chmod(destination, 0o755)
    process.stdout.write(`staged ${product} -> ${destination}\n`)
  }
}

function usage(): string {
  return [
    'Usage: tsx scripts/prepare-runtime.ts --platform <linux|macos|win> [--arch <x64|arm64>]',
    '',
    `Copies ${SOURCE_DIR}/${SOURCE_BASENAME}-<platform>-<arch> and its sidecars into`,
    'runtime/<node platform>-<arch>/, renaming the executable to dsh.',
    '',
  ].join('\n')
}

await main()
