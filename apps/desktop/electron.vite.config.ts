import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    envPrefix: "VITE_",
    build: {
      // @acx/agent-runtime publishes raw TSX with no build step, so leaving it
      // external makes the packaged main process import a .ts file at runtime.
      // Bundle it; its own npm deps stay external.
      externalizeDeps: {
        exclude: ["@acx/agent-runtime"],
      },
      outDir: "out/main",
    },
  },
  preload: {
    build: {
      // The preload output must remain CJS, while AuthKit Electron is ESM-only.
      // Bundle its preload bridge so the generated CJS never require()s it.
      externalizeDeps: {
        exclude: ["@workos/authkit-electron"],
      },
      outDir: "out/preload",
      lib: {
        entry: "src/preload/index.ts",
        formats: ["cjs"],
      },
      rollupOptions: {
        output: {
          entryFileNames: "index.js",
        },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
    build: {
      // Relative to the electron-vite root (apps/desktop), NOT the renderer
      // `root` above — "../../out/renderer" escaped to the repo root, so
      // main's `join(__dirname, "../renderer/index.html")` found nothing in a
      // packaged build.
      outDir: "out/renderer",
    },
  },
});
