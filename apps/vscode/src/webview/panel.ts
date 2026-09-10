/** The webview panel and the runtime stack it owns. */

import * as vscode from 'vscode'
import type { Logger } from '../log.ts'
import { startAssetProxy, type AssetProxy } from '../proxy/asset-proxy.ts'
import { resolveRuntime, type RuntimePreference } from '../runtime/resolve.ts'
import { probeRuntimeVersion, startWebServer, type RunningServer } from '../runtime/server.ts'
import { openSession, type HarnessSession } from '../runtime/session.ts'
import { attachBridge, type Bridge } from './bridge.ts'
import { BRIDGE_SCRIPT } from './bridge-client.ts'
import { transformIndexHtml } from './html.ts'

const VIEW_TYPE = 'dsh.panel'
const PANEL_TITLE = 'DeepSeek Harness'

/** One booted stack: runtime process, authenticated session, and proxy. */
interface Stack {
  readonly server: RunningServer
  readonly session: HarnessSession
  readonly proxy: AssetProxy
}

/**
 * The single panel and the runtime behind it.
 *
 * Only one stack exists per window: a second `dsh.open` reveals the existing
 * panel rather than booting another harness against the same workspace.
 */
export class HarnessPanel {
  private panel: vscode.WebviewPanel | undefined
  private stack: Stack | undefined
  private bridge: Bridge | undefined
  private booting: Promise<void> | undefined

  /**
   * @param logger - diagnostics sink shared with the runtime.
   * @param extensionPath - absolute extension directory, holding `runtime/`.
   */
  constructor(private readonly logger: Logger, private readonly extensionPath: string) {}

  /**
   * Show the panel, booting the runtime on first use.
   * @returns once the panel is visible and loaded.
   */
  async show(): Promise<void> {
    if (this.panel !== undefined) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside)
      return
    }
    this.booting ??= this.boot().finally(() => { this.booting = undefined })
    await this.booting
  }

  /**
   * Tear the stack down and boot it again, keeping the panel open.
   * @returns once the panel has reloaded.
   */
  async restart(): Promise<void> {
    await this.disposeStack()
    if (this.panel !== undefined) {
      this.panel.dispose()
    }
    await this.show()
  }

  /** Release the panel and everything it owns. */
  async dispose(): Promise<void> {
    this.panel?.dispose()
    await this.disposeStack()
  }

  private async boot(): Promise<void> {
    const settings = vscode.workspace.getConfiguration('dsh')
    const folders = (vscode.workspace.workspaceFolders ?? [])
      .filter(folder => folder.uri.scheme === 'file')
      .map(folder => folder.uri.fsPath)

    const runtime = await resolveRuntime({
      preference: settings.get<RuntimePreference>('runtime') ?? 'auto',
      executablePath: settings.get<string>('executablePath') ?? '',
      workspaceFolders: folders,
      extensionPath: this.extensionPath,
      platform: process.platform,
      arch: process.arch,
      ...(process.env.PATH === undefined ? {} : { pathVariable: process.env.PATH }),
      ...(process.env.PATHEXT === undefined ? {} : { pathExtVariable: process.env.PATHEXT }),
    }, probeRuntimeVersion)
    this.logger.info(`using dsh ${runtime.version} from ${runtime.source} (${runtime.command})`)

    const server = await startWebServer({
      command: runtime.command,
      cwd: folders[0] ?? this.extensionPath,
      readinessTimeoutMs: settings.get<number>('readinessTimeoutMs') ?? 180_000,
      logger: this.logger,
    })
    let session: HarnessSession
    let proxy: AssetProxy
    try {
      session = await openSession(server)
      proxy = await startAssetProxy({ session, bridgeScript: BRIDGE_SCRIPT, logger: this.logger })
    } catch (cause) {
      await server.dispose()
      throw cause
    }
    this.stack = { server, session, proxy }
    this.logger.info(`serving the harness UI through ${proxy.origin}`)

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      PANEL_TITLE,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        // The harness reconnects its streams on load; keeping the context alive
        // avoids a full boot every time the user switches tabs.
        retainContextWhenHidden: true,
        // Makes `http://localhost:<port>` reach the extension host's port even
        // when the window is attached to a remote.
        portMapping: [{ webviewPort: proxy.port, extensionHostPort: proxy.port }],
      },
    )
    this.panel = panel
    panel.onDidDispose(() => {
      this.panel = undefined
      void this.disposeStack()
    })

    this.bridge = attachBridge({
      postMessage: (message) => { void panel.webview.postMessage(message) },
      onMessage: (listener) => {
        const subscription = panel.webview.onDidReceiveMessage(listener)
        return () => { subscription.dispose() }
      },
    }, session, this.logger)

    const index = await session.request('GET', '/')
    if (index.status !== 200) {
      throw new Error(`dsh web returned HTTP ${String(index.status)} for the UI index`)
    }
    // The document itself must sit on the webview's own origin, because only the
    // top-level webview document may call `acquireVsCodeApi()` — an iframe
    // pointed at the proxy would have no way to reach the bridge. The rewritten
    // `<base>` is what sends its assets to the proxy instead.
    panel.webview.html = transformIndexHtml(index.body.toString('utf8'), {
      proxyOrigin: proxy.origin,
      bridgeScript: BRIDGE_SCRIPT,
    })
  }

  private async disposeStack(): Promise<void> {
    this.bridge?.dispose()
    this.bridge = undefined
    const stack = this.stack
    this.stack = undefined
    if (stack === undefined) return
    await stack.proxy.dispose()
    await stack.server.dispose()
    this.logger.info('runtime stopped')
  }
}
