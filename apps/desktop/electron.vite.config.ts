import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    envPrefix: "VITE_",
    build: {
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
      outDir: "../../out/renderer",
    },
  },
});
