# Agent Note: VS Code webview extension

Status: implemented

English | [中文](2026-09-10-vscode-webview-extension.zh.md)

## Problem

The harness reaches VS Code only as an external application to launch: `packages/host/open-in-app/src/catalog.ts` detects an installed editor and opens a folder in it. A user who works in VS Code must leave it to reach the agent. Hosting the existing web UI in an editor panel removes that switch without building a second UI.

The obvious approach — point a webview at `http://127.0.0.1:3080` — cannot work. Three independent fences reject it, and none of them is incidental:

- `packages/client/connection/src/api-request-trust.ts` refuses `sec-fetch-site: cross-site`, requires an attached `Origin` to equal the `Host` authority, and refuses the literal `"null"` origin. A webview document's origin is always `vscode-webview://<guid>`, so every `/api` call is refused. `--trusted-host` does not help: it widens only the `Host` check.
- `packages/client/connection/src/browser-auth.ts` serves the index only against an `HttpOnly; SameSite=Strict` cookie minted by a 303 redirect from `/?token=<launchToken>`. That exchange does not survive a third-party frame.
- `packages/host/frontend-static/src/index.ts` splices `<base href="/">` into every served index, and `packages/api/gateway/src/client/stream-client.ts` derives its WebSocket URL from `location.origin`.

## Decision

Add `apps/vscode`, a VS Code extension that spawns `dsh --profile web --port 0 --no-open`, reads the readiness line `packages/bundle/web-app/src/index.ts` prints, and performs the token-for-cookie handshake itself. The extension host is the only party that can satisfy the trust fence, because it controls `Host` and sends no browser markers at all — which `isTrustedApiRequest` accepts for a loopback `Host`.

Traffic is split by what each side may safely reach:

- The webview document is the served index, rewritten and assigned to `webview.html`. It must sit on the webview's own origin, because only the top-level webview document may call `acquireVsCodeApi()`.
- Its assets load from a loopback proxy the extension runs. The proxy answers `GET` and `HEAD` only, and only under an unguessable path prefix, so it cannot change harness state and cannot be found by a local port scan.
- Everything that changes state travels over `webview.postMessage`, which no other process can address: `/api` unary calls, and the Gateway streams, whose real `/api/remote.mux` socket the extension host holds.

The page-side carrier is installed through `globalThis.__DSH_TRANSPORT__` (`ClientTransportHooks` in `packages/client/connection/src/client/index.ts`) and `globalThis.__DSH_FILE_UPLOAD__` (`ClientFileUploadHooks` in `packages/client/file-upload/src/types.ts`). `ownsHost: true` restores `connection.isLoopback`, which the webview authority would otherwise make false — the same claim `apps/desktop-host` makes for the same reason.

The index rewrite is two substitutions, in `src/webview/html.ts`. Replacing `<base href="/">` re-anchors every root-absolute URL at once — the `/plugins/??…` combo bundles, the Vite assets, the manifest and the favicon — so nothing needs to know the shape of the server's index injections, and the `__ModuleLoader__` queue, the bootstrap script rows, `__DSH_BOOT__` and the `__DSH_BOOT_READY__` tail all execute unmodified in server-defined order. A missing base tag throws rather than serving a broken page. The CSP keeps `'unsafe-inline'` and carries no nonce: the index contains several inline scripts whose text the server owns, and under CSP3 a nonce overrides `'unsafe-inline'`.

`dsh --profile web` is the launcher, so the application-launch rule holds; the extension is a supervisor consuming the documented readiness line. No profile name is reserved and `apps/cli/src/args.ts` is untouched.

The extension runs in the VS Code extension host, not a Cordis context, so `ctx.effect()` does not apply; `context.subscriptions` carries the same disposal discipline.

## Alternatives considered

- **`apps/vscode-host` plus a reserved `vscode` profile over fd pipes**, mirroring `apps/desktop`. Architecturally cleaner — no HTTP, no fences to satisfy — but structurally incompatible with resolving a `dsh` the user already has. `apps/desktop-host` works because Electron installs its own pnpm project and runs it under a bundled upstream Node; there is no "find `dsh` on PATH" story there. It would also cost a reserved profile name, a `packages/bundle/vscode-app` patch layer, and a duplicate of the framing layer in `apps/desktop-host/src/wire.ts`. Revisit only if the PATH fallback is dropped.
- **A pure `postMessage` bridge with no proxy**, reconstructing the index injections page-side the way `packages/experimental/webworker-runtime/src/client/apply-injections.ts` does. The bootstrap batches are `<script src>` rows the HTML parser must execute, and a webview can intercept neither those nor the Vite module entry; the row table would have to be recovered by parsing server-owned markup. Retained as the fallback if a webview turns out not to be able to load subresources from `http://localhost`.
- **Bundling `@deepseek-ai/dsh-web-frontend/dist` in the `.vsix`** and serving it through `asWebviewUri`. Breaks as soon as the resolved `dsh` is a different version from the bundled one, which is the normal case once a workspace pins its own. The asset hashes, the `__DSH_BOOT__` graph, and the `/plugins/??` combos are all per-boot and server-owned.
- **`--trusted-host <authority>`.** Does not work: it widens the `Host` check only, leaving the `Origin` and `sec-fetch-site` fences intact.
- **`"type": "commonjs"` on the manifest**, since the extension host `require()`s `main`. That violates the repository's ESM rule. Emitting `lib/extension.cjs` instead satisfies both: the extension makes the file CommonJS regardless of the manifest's `type`. VS Code's newer ESM extension support is not dependable across the `engines` range worth supporting.

## Consequences

- `scripts/check-workspace-constraints.ts` gains `apps/vscode` in the release-member exclusion, and `desktopApplicationDirectory` becomes a set of applications assembled outside npm, since `vsce` packages this one exactly as electron-builder packages the desktop.
- `@vscode/vsce` pulls `@vscode/vsce-sign` and `keytar`, both denied in `allowBuilds`: signing and Marketplace credential storage belong to publishing, which no install performs here.
- The extension declares no workspace dependency and no `@deepseek-ai/*` types. It speaks only over the wire, so it does not skew with the runtime it drives — but it does depend on the served index carrying `<base href="/">`, which it asserts.
- `apps/vscode/src` is outside the per-file coverage gate, whose include is `packages/*/*/src`. Its tests still run under `pnpm run test` through the existing `apps/*/tests` glob.
- Unverified without running VS Code: whether a `vscode-webview://` document may load subresources from `http://localhost:<port>` (`portMapping` exists for this, and Chromium treats `localhost` as potentially trustworthy), how `<base>` interacts with that rewriting under Remote-SSH, and `postMessage` throughput during long generations.
- Unverified without a build: whether the `@yao-pkg/pkg` executable from `scripts/build-exe-for-python-sdk.ts` can boot `--profile web` standalone. Its asset globs already cover the frontend dist, but the profile templates need confirming.
- Escalation path if `open-in-app`, `directory-picker`, or `client-hmr` misbehave inside a webview: ship a patch overlay in the `.vsix` and pass `--patch`, exactly as `apps/desktop-host/config/desktop.cordis.patch.yml` disables them, without inventing a profile.
