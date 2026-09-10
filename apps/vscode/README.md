DeepSeek Harness (dsh) — это открытый агентный «харнесс» (обвязка для агентов) от DeepSeek AI, написанный на TypeScript/Node. Проще говоря, это платформа, которая превращает языковую модель в работающего агента: ведёт цикл «запрос → вызов инструментов», хранит сессии, подключает инструменты и политики.

Ключевая идея — «всё есть плагин» Проект построен на фреймворке Cordis: плагины добавляют в общий контекст сервисы, типизированные события и обратимые эффекты. Даже адаптер модели, реестр инструментов, журнал сессии и сам agent-loop — это плагины, а значит заменяемые из конфигурации. Привилегированного «ядра, которое нужно патчить», нет: расширение — это подключение плагина рядом с остальными.

Как это собирается и запускается

Профиль — именованная композиция плагинов (хранится в домашнем каталоге Harness). Поставляются шаблоны web, headless, sdk, sdk-minimal, acp; есть и десктопное Electron-приложение.
Бандл — формат поставки строк конфигурации Cordis и кода к ним; общий первый слой dsh-base (адаптеры модели, инструменты, персистентность, песочница и политика подтверждений, настройки, учётные данные, телеметрия) дополняется, например, dsh-web-app или dsh-headless.
Запуск: npx @deepseek-ai/dsh web (веб-интерфейс на
http://127.0.0.1:3080
) или из исходников — pnpm install && pnpm run build && pnpm dsh web. Любое поддерживаемое приложение стартует только через CLI dsh с именованным профилем.
Что внутри (основные подсистемы)

core/ — позвоночник продуктового API: сессии, системный промпт, реестр инструментов, абстракция агента и его цикл (turn/step).
llm/ — работа с моделями, shell/, fs/, subprocess/, lsp/, web/, terminal/ — возможности-инструменты для агента.
session/ — долговечный лог сессии (append-only SessionEvent): именно из него выводится история, которую видит модель.
subagent/, workflow/, skill/, plan/, todo/, guard/ — делегирование подагентам, воркфлоу, навыки, режим планирования, гигиена цикла.
sdk/ и python/ — SDK (JSON-RPC + TypeScript-клиент и Python-рантайм), acp/ — сервер Agent Client Protocol.
Для разработки: pnpm-монорепозиторий с жёсткими требованиями — strict TypeScript, 100% покрытие на уровне файлов, bilingual-документация, обязательные Agent Notes для нетривиальных изменений, снапшот-тесты ключевых сценариев.

# DeepSeek Harness — расширение для VS Code

Расширение показывает веб‑интерфейс DeepSeek Harness (`dsh web`) внутри панели
VS Code. Оно поднимает рантайм `dsh`, проксирует его UI в webview и связывает
страницу с расширением по `postMessage`‑мосту.

Ниже — как собрать расширение и как поставить его в текущую IDE
(**Antigravity IDE** — форк VS Code; для обычного VS Code замените CLI
`antigravity-ide` на `code`).

---

## 1. Предпосылки

- **Node 24.**
- **`pnpm` установлен в системе** и доступен в `PATH` — все команды пакета
  запускаются как `pnpm …`.
- **IDE CLI:**
  `C:\Users\viktor\AppData\Local\Programs\Antigravity IDE\bin\antigravity-ide.cmd`
  — это стандартный `cli.js` VS Code, понимает `--install-extension`,
  `--list-extensions`, `--force`.

---

## 2. Сборка расширения

```powershell
pnpm install                                                # один раз
pnpm --filter @deepseek-ai/dsh-vscode run build
```

`build` = `tsc -b && tsdown`. Результат — единственный рантайм‑файл
`apps/vscode/lib/extension.cjs` (он же `main` в `package.json`).
Зависимость `ws` **вшивается** в бандл через `deps.alwaysBundle` в
`tsdown.config.ts` — иначе установленное расширение падает при активации с
`Cannot find module 'ws'` (в `.vsix` не кладётся `node_modules`).

Тесты расширения (необязательно):

```powershell
pnpm exec vitest run apps/vscode
```

---

## 3. Упаковка в `.vsix`

`vsce` не принимает scoped‑имя `@deepseek-ai/dsh-vscode`
(`ERROR Invalid extension name`), поэтому имя нужно **временно** сделать
безскоупным на время упаковки и сразу вернуть обратно:

```powershell
cd apps/vscode
node -e "const f='package.json',p=require('./'+f);p.name='dsh-vscode';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
pnpm exec vsce package --no-dependencies --out dist/dsh-vscode.vsix
git checkout -- package.json     # вернуть @deepseek-ai/dsh-vscode
cd ../..
```

Предупреждения `vsce` про отсутствующие `repository` и `LICENSE` — безвредны.

> Штатный скрипт `pnpm --filter @deepseek-ai/dsh-vscode run package -- --no-runtime`
> (`scripts/package-target.ts`, кладёт `dist/dsh-no-runtime.vsix`) внутри вызывает
> тот же `vsce`, поэтому спотыкается о scoped‑имя так же — перед ним нужен тот же
> временный `rename` из блока выше.

В архив по `.vscodeignore` попадают только `lib/extension.cjs` и `package.json`
(≈50 КБ). Исполняемый `dsh` в архив **не** кладётся при `--no-runtime` —
расширение берёт рантайм по настройке (§5).

---

## 4. Установка в Antigravity IDE

```powershell
& "C:\Users\viktor\AppData\Local\Programs\Antigravity IDE\bin\antigravity-ide.cmd" `
  --install-extension "C:\MyProjects\deepseek-harness\apps\vscode\dist\dsh-vscode.vsix" --force
```

Проверить:

```powershell
& "C:\Users\viktor\AppData\Local\Programs\Antigravity IDE\bin\antigravity-ide.cmd" `
  --list-extensions --show-versions | Select-String dsh
# -> deepseek-ai.dsh-vscode@0.1.5-rc.1
```

Затем в IDE: `Ctrl+Shift+P` → **Developer: Reload Window**
(установка через CLI не подхватывается на лету).

Альтернатива через UI: панель **Extensions** → меню «…» → **Install from VSIX…**.

---

## 5. Настройка рантайма `dsh`

Расширение ищет `dsh` в порядке: workspace/PATH → bundled
(`src/runtime/resolve.ts`). В этом монорепозитории `dsh` не линкуется в
`node_modules/.bin`, поэтому задайте путь явно.

1. Собрать монорепо:
   ```powershell
   pnpm run build
   ```
2. Обёртка `tmp/dsh-dev/dsh.cmd`:
   ```bat
   @echo off
   node "C:\MyProjects\deepseek-harness\apps\cli\lib\bin.js" %*
   ```
3. В `apps/vscode/.vscode/settings.json` (файл в `.gitignore`):
   ```json
   {
     "dsh.executablePath": "C:\\MyProjects\\deepseek-harness\\tmp\\dsh-dev\\dsh.cmd"
   }
   ```

---

## 6. Запуск и команды

- **Автозапуск:** при открытии окна с папкой‑проектом
  (`dsh.autoOpen: true`, `activationEvents: ["onStartupFinished"]`) панель
  открывается в этом же окне.
- **Вручную:** `Ctrl+Shift+P` → **DeepSeek Harness: Open**.
  Ещё команды: **DeepSeek Harness: Restart Runtime**, **DeepSeek Harness: Show Logs**.
- Первый запуск долгий — расширение ждёт строку готовности до
  `dsh.readinessTimeoutMs` (по умолчанию 180000 мс).

Настройки (`Settings` → «DeepSeek Harness»):

| Ключ                     | Назначение                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `dsh.autoOpen`           | открывать панель при старте окна (по умолч. `true`)                                     |
| `dsh.permissionMode`     | режим прав рантайма: `read-only` / `workspace-write` (по умолч.) / `danger-full-access` |
| `dsh.executablePath`     | абсолютный путь к `dsh`; приоритетнее всего                                             |
| `dsh.runtime`            | `auto` / `workspace` / `bundled`                                                        |
| `dsh.readinessTimeoutMs` | таймаут ожидания готовности `dsh web`                                                   |

---

## 7. Быстрый цикл разработки без `.vsix`

Открыть репозиторий в Antigravity IDE и нажать **F5** — конфигурация
**Run DSH Extension** (`.vscode/launch.json`) поднимает Extension Development
Host с расширением прямо из исходников; `preLaunchTask` «build extension»
(`.vscode/tasks.json`) предварительно собирает `lib/`. Пересборка после правок —
повторный запуск этой задачи или `Ctrl+Shift+P` → **Tasks: Run Build Task**.
