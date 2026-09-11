/**
 * Install a packaged `.vsix` into a VS Code-family IDE through its CLI.
 *
 * The CLI is `DSH_IDE_CLI` when set, else the per-user Antigravity IDE install
 * on Windows when present, else `code` from `PATH`. The script installs with
 * `--force`, so a same-version archive replaces the installed copy, and then
 * prints the installed `dsh` extensions. The running IDE window picks the new
 * build up only after **Developer: Reload Window**.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const extensionDir = resolve(import.meta.dirname, '..')

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      vsix: { type: 'string', default: join('dist', 'dsh-no-runtime.vsix') },
      help: { type: 'boolean', default: false },
    },
  })
  if (values.help === true) {
    process.stdout.write(usage())
    return
  }

  const vsix = resolve(extensionDir, values.vsix ?? join('dist', 'dsh-no-runtime.vsix'))
  if (!existsSync(vsix)) {
    throw new Error(`${vsix} does not exist; build it first with \`pnpm run build:vscode\``)
  }
  const cli = resolveCli()
  process.stdout.write(`Installing ${vsix}\n  via ${cli}\n`)
  await run(cli, ['--install-extension', vsix, '--force'])
  const installed = await run(cli, ['--list-extensions', '--show-versions'], { capture: true })
  const lines = installed.split(/\r?\n/).filter(line => line.includes('dsh'))
  process.stdout.write(`${lines.join('\n')}\nReload the IDE window (Developer: Reload Window) to activate the new build.\n`)
}

/** Pick the IDE CLI: explicit override, then the Antigravity IDE install, then `code`. */
function resolveCli(): string {
  const override = process.env['DSH_IDE_CLI']
  if (override !== undefined && override !== '') return override
  const localAppData = process.env['LOCALAPPDATA']
  if (localAppData !== undefined) {
    const antigravity = join(localAppData, 'Programs', 'Antigravity IDE', 'bin', 'antigravity-ide.cmd')
    if (existsSync(antigravity)) return antigravity
  }
  return 'code'
}

/**
 * Run the IDE CLI and resolve with its captured stdout (empty unless `capture`).
 *
 * IDE CLIs on Windows are `.cmd` wrappers, which Node starts only through a
 * shell; the shell receives one joined command line, so every part is quoted
 * to keep paths with spaces intact.
 */
function run(command: string, args: readonly string[], options: { capture?: boolean } = {}): Promise<string> {
  return new Promise<string>((settle, reject) => {
    const commandLine = [command, ...args].map(part => `"${part}"`).join(' ')
    const child = spawn(commandLine, {
      stdio: ['ignore', options.capture === true ? 'pipe' : 'inherit', 'inherit'],
      shell: true,
    })
    let stdout = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) settle(stdout)
      else reject(new Error(`${command} exited with code ${String(code)}`))
    })
  })
}

function usage(): string {
  return [
    'Usage: tsx scripts/install-ide.ts [--vsix <path>]',
    '',
    'Installs <path> (default dist/dsh-no-runtime.vsix) with `--install-extension --force`.',
    'IDE CLI: $DSH_IDE_CLI, else %LOCALAPPDATA%\\Programs\\Antigravity IDE\\bin\\antigravity-ide.cmd, else `code`.',
    '',
  ].join('\n')
}

await main()
