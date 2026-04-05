import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // proxy API requests in dev
    proxy: {
      "/auth": "http://localhost:3001",
      "/playlists": "http://localhost:3001",
      "/tracks": "http://localhost:3001",
      "/comments": "http://localhost:3001",
      "/shares": "http://localhost:3001",
      "/health": "http://localhost:3001",
    },
  },
});
