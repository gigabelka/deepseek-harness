import { defineConfig } from 'tsdown'

/**
 * The VS Code extension host loads `main` through CommonJS `require`, while the
 * repository keeps every package ESM. `fixedExtension` emits `lib/extension.cjs`,
 * whose extension makes it CommonJS regardless of the manifest's `"type"`, so
 * both constraints hold without a per-package exemption.
 */
export default defineConfig({
  entry: ['lib/types/extension.js'],
  outDir: 'lib',
  format: ['cjs'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: true,
  dts: false,
  clean: false,
  // `vscode` is injected by the extension host and is never installable.
  deps: { neverBundle: ['vscode'] },
})
