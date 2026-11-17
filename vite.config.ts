import { defineConfig } from "vite-plus";

/**
 * Library build for the OpenCode plugin package.
 *
 * `vp pack` (tsdown under the hood) defaults an explicit `esm` build to
 * `.mjs` / `.d.mts`; the published entry must be `dist/index.js` +
 * `dist/index.d.ts` (R1), so the extensions are pinned here instead of
 * renaming the artifacts after the fact.
 */
export default defineConfig({
  pack: {
    entry: "src/index.ts",
    format: "esm",
    platform: "node",
    target: "node22.18",
    outDir: "dist",
    clean: true,
    dts: true,
    outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  },
});
