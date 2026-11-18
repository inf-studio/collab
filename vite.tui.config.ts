import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

/**
 * The TUI half (`./tui` → `dist/tui.js`).
 *
 * Same reasoning as `vite.gui.config.ts`, one difference: the terminal UI is
 * not a DOM. `generate: 'universal'` makes `babel-preset-solid` emit
 * `createElement` / `insert` / `spread` for intrinsics (no `template`), and
 * `moduleName: '@opentui/solid'` takes those from OpenTUI's Solid adapter — the
 * module the host already runs. Every module the host provides stays external
 * (`@opencode/*`, `@opentui/*`, `solid-js`), so the bundle never carries a
 * second copy of Solid or of the renderer.
 *
 * `emptyOutDir: false` (the same rule as the GUI build) is what lets this run
 * *after* `vp pack` + the GUI build: those write `dist/index.js`, this adds one
 * more file to it.
 */
export default defineConfig({
  plugins: [
    solid({
      solid: {
        generate: 'universal',
        moduleName: '@opentui/solid',
        hydratable: false,
        // The terminal UI has no custom elements: keep the DOM-flavoured
        // treatment (props as strings/objects) out of the generated code.
        contextToCustomElements: false
      }
    })
  ],
  build: {
    target: 'node22',
    outDir: 'dist',
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    lib: {
      entry: 'src/tui.tsx',
      formats: ['es'],
      fileName: () => 'tui.js'
    },
    rollupOptions: {
      // Provided by the host at load time (peer dependencies, like `./tui` docs
      // require). Bundling any of them would break instance sharing.
      external: (id: string) => /^(@opencode\/|@opentui\/|solid-js(\/|$))/.test(id)
    }
  }
});
