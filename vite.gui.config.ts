import { defineConfig } from 'vite';
import { gui } from '@opencode/plugin/gui/vite';

/**
 * The desktop sidebar bundle (`./gui-experimental`).
 *
 * Kept apart from `vite.config.ts` on purpose: that one is the **library**
 * build (`vp pack` → `dist/index.js` + `.d.ts`, what the server loads), this one
 * is the **GUI** build (one CommonJS file the desktop app evaluates in every
 * window). `gui()` compiles Solid JSX, inlines every dynamic `import()`, and
 * keeps the modules the app provides (`effect`, `@opencode/plugin/gui`,
 * `@opencode/plugin/rpc`, `solid-js`, …) external — so the bundle never carries a
 * second copy of Solid or of the app's own SDK.
 *
 * `emptyOutDir: false` (the preset sets it) is what lets this run *after*
 * `vp pack`: the library build cleans `dist`, this one adds one file to it.
 */
export default defineConfig({
  plugins: [gui({ entry: 'src/gui.tsx', outFile: 'dist/gui-experimental.cjs' })],
  build: {
    // The GUI bundle is read by the app, not by a browser fetching chunks.
    target: 'chrome120',
    sourcemap: false
  }
});
