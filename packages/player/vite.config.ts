import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/player.ts",
      name: "DemoLockerPlayer",
      formats: ["es", "iife"],
      fileName: (format) => (format === "es" ? "player.js" : "embed.js"),
    },
    outDir: "dist",
    emptyOutDir: true,
  },
});
