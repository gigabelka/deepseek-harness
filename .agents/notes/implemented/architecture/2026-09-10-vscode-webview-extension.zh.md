# Agent Note: VS Code webview 扩展

Status: implemented

[English](2026-09-10-vscode-webview-extension.md) | 中文

## 问题

Harness 目前只把 VS Code 当作一个可以启动的外部应用：`packages/host/open-in-app/src/catalog.ts` 检测已安装的编辑器并在其中打开目录。在 VS Code 里工作的用户必须离开编辑器才能使用 Agent。把现有的 Web UI 放进编辑器面板，可以在不另建一套 UI 的前提下消除这次切换。

最直接的做法——让 webview 指向 `http://127.0.0.1:3080`——行不通。三道互相独立的关卡都会拒绝它，而且没有一道是偶然的：

- `packages/client/connection/src/api-request-trust.ts` 拒绝 `sec-fetch-site: cross-site`，要求随请求附带的 `Origin` 与 `Host` 权威完全相同，并拒绝字面量 `"null"` 来源。webview 文档的来源永远是 `vscode-webview://<guid>`，因此每次 `/api` 调用都会被拒。`--trusted-host` 无济于事：它只放宽 `Host` 检查。
- `packages/client/connection/src/browser-auth.ts` 只在持有 `HttpOnly; SameSite=Strict` Cookie 时提供索引页，而该 Cookie 由 `/?token=<launchToken>` 的 303 重定向签发。这一交换无法在第三方框架中存活。
- `packages/host/frontend-static/src/index.ts` 会把 `<base href="/">` 拼接进每一个服务端渲染的索引页，而 `packages/api/gateway/src/client/stream-client.ts` 从 `location.origin` 推导其 WebSocket URL。

## 决定

新增 `apps/vscode`：一个 VS Code 扩展，它启动 `dsh --profile web --port 0 --no-open`，读取 `packages/bundle/web-app/src/index.ts` 打印的就绪行，并自行完成「令牌换 Cookie」的握手。扩展宿主是唯一能满足信任关卡的一方，因为它掌握 `Host` 头，并且完全不发送浏览器标记——对于环回 `Host`，这正是 `isTrustedApiRequest` 所接受的。

流量按各方可安全触及的范围切分：

- webview 文档就是那份经过改写、赋给 `webview.html` 的索引页。它必须位于 webview 自身的来源上，因为只有顶层 webview 文档才能调用 `acquireVsCodeApi()`。
- 它的静态资源从扩展运行的环回代理加载。该代理只应答 `GET` 与 `HEAD`，且只在一段不可猜测的路径前缀之下，因此既无法改变 Harness 状态，也无法被本机端口扫描发现。
- 一切改变状态的流量都走 `webview.postMessage`，其他进程无法寻址：`/api` 一元调用，以及 Gateway 流——其真正的 `/api/remote.mux` 套接字由扩展宿主持有。

页面侧的载体通过 `globalThis.__DSH_TRANSPORT__`（`packages/client/connection/src/client/index.ts` 中的 `ClientTransportHooks`）与 `globalThis.__DSH_FILE_UPLOAD__`（`packages/client/file-upload/src/types.ts` 中的 `ClientFileUploadHooks`）安装。`ownsHost: true` 恢复了 `connection.isLoopback`——否则 webview 的权威会让它为假。`apps/desktop-host` 出于同样的理由做出同样的声明。

索引页的改写只有两处替换，位于 `src/webview/html.ts`。替换 `<base href="/">` 一次性重新锚定了文档中每一个根绝对 URL——`/plugins/??…` 合并包、Vite 资源、manifest 与 favicon——因此无需了解服务端索引注入的具体形状，`__ModuleLoader__` 队列、bootstrap 脚本行、`__DSH_BOOT__` 与末尾的 `__DSH_BOOT_READY__` 都按服务端定义的顺序原样执行。若 base 标签缺失则抛错，而不是提供一个坏掉的页面。CSP 保留 `'unsafe-inline'` 且不携带 nonce：索引页含有若干由服务端掌握文本的内联脚本，而在 CSP3 下 nonce 会覆盖 `'unsafe-inline'`。

启动器是 `dsh --profile web`，因此应用启动规则成立；扩展是消费文档化就绪行的监督者。没有保留任何 profile 名称，`apps/cli/src/args.ts` 未被改动。

扩展运行在 VS Code 扩展宿主中，而非 Cordis 上下文，因此 `ctx.effect()` 不适用；`context.subscriptions` 承担同样的释放纪律。

## Alternatives considered

- **`apps/vscode-host` 加上通过 fd 管道的保留 `vscode` profile**，对标 `apps/desktop`。架构上更干净——没有 HTTP，也无需满足任何关卡——但与「复用用户已有的 `dsh`」在结构上不相容。`apps/desktop-host` 之所以可行，是因为 Electron 安装自己的 pnpm 项目并在内置的上游 Node 下运行它；那里根本不存在「在 PATH 中寻找 `dsh`」的路径。它还要付出一个保留 profile 名、一个 `packages/bundle/vscode-app` 补丁层，以及 `apps/desktop-host/src/wire.ts` 中成帧层的一份副本。仅当放弃 PATH 回退时才重新考虑。
- **纯 `postMessage` 桥、不设代理**，像 `packages/experimental/webworker-runtime/src/client/apply-injections.ts` 那样在页面侧重建索引注入。bootstrap 批次是 HTML 解析器必须执行的 `<script src>` 行，webview 既无法拦截它们也无法拦截 Vite 模块入口；注入行表将不得不靠解析服务端掌握的标记来还原。若最终证实 webview 无法从 `http://localhost` 加载子资源，则保留此方案作为回退。
- **把 `@deepseek-ai/dsh-web-frontend/dist` 打进 `.vsix`** 并通过 `asWebviewUri` 提供。一旦解析到的 `dsh` 与内置版本不同就会失效，而在工作区固定了自己的版本之后这正是常态。资源哈希、`__DSH_BOOT__` 图与 `/plugins/??` 合并包全都是每次启动生成、由服务端掌握的。
- **`--trusted-host <authority>`。** 行不通：它只放宽 `Host` 检查，`Origin` 与 `sec-fetch-site` 两道关卡依旧生效。
- **在清单中写 `"type": "commonjs"`**，因为扩展宿主对 `main` 执行 `require()`。这违反本仓库的 ESM 规则。改为产出 `lib/extension.cjs` 可同时满足两者：无论清单的 `type` 为何，该扩展名都使文件成为 CommonJS。VS Code 较新的 ESM 扩展支持在值得支持的 `engines` 范围内并不可靠。

## Consequences

- `scripts/check-workspace-constraints.ts` 在发布成员排除项中加入 `apps/vscode`，且 `desktopApplicationDirectory` 变为「在 npm 之外组装的应用」集合，因为 `vsce` 打包本应用的方式与 electron-builder 打包桌面端完全一致。
- `@vscode/vsce` 引入 `@vscode/vsce-sign` 与 `keytar`，两者在 `allowBuilds` 中均被拒绝：签名与 Marketplace 凭据存储属于发布行为，而这里没有任何安装会执行它。
- 扩展不声明任何工作区依赖，也不使用 `@deepseek-ai/*` 类型。它只通过线路通信，因此不会与其驱动的运行时产生版本偏移——但它确实依赖服务端索引页携带 `<base href="/">`，并对此做了断言。
- `apps/vscode/src` 不在逐文件覆盖率关卡之内，后者的 include 是 `packages/*/*/src`。其测试仍通过既有的 `apps/*/tests` 通配符在 `pnpm run test` 中运行。
- 未经 VS Code 实机验证：`vscode-webview://` 文档能否从 `http://localhost:<port>` 加载子资源（`portMapping` 正是为此存在，且 Chromium 视 `localhost` 为潜在可信）、在 Remote-SSH 下 `<base>` 与该重写如何相互作用，以及长生成期间 `postMessage` 的吞吐。
- 未经构建验证：`scripts/build-exe-for-python-sdk.ts` 产出的 `@yao-pkg/pkg` 可执行文件能否独立引导 `--profile web`。其资源通配符已覆盖前端 dist，但 profile 模板仍需确认。
- 若 `open-in-app`、`directory-picker` 或 `client-hmr` 在 webview 中表现异常，升级路径是：在 `.vsix` 中随附一个补丁覆盖层并传入 `--patch`，正如 `apps/desktop-host/config/desktop.cordis.patch.yml` 停用它们那样，无需发明新的 profile。
