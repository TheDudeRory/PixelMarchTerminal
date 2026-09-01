// vitest/config re-exports vite's defineConfig with the `test` block typed.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  resolve: {
    alias: {
      // @xterm/headless@6 ships a broken "module" field ("lib/xterm.mjs" — the
      // file does not exist in the tarball; the real ESM build is
      // lib-headless/xterm-headless.mjs). Vite prefers "module" and dies with
      // "Failed to resolve entry for package". Point it at the real bundle.
      // Drop this alias once upstream fixes the package.json.
      "@xterm/headless": "@xterm/headless/lib-headless/xterm-headless.mjs",
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    // Spelling out the vitest defaults because adding `exclude` replaces them
    // rather than extending them. The one addition is `.swarm/`: agent swarms
    // keep git worktrees there, each holding a full copy of the suite pinned at
    // some older commit, and without this a plain `vitest run` measures those
    // stale copies alongside the checkout it was actually invoked in.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      "**/.swarm/**",
    ],
  },
}));
