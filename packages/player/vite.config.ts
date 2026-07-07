import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/player.ts",
      name: "DemoLockerPlayer",
      formats: ["iife"],
      fileName: () => "embed.js",
    },
    outDir: "dist",
    emptyOutDir: true,
  },
});
