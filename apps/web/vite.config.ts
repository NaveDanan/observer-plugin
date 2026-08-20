import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

/**
 * The UI is served by the daemon in production, so assets use relative paths.
 * In dev, API and WebSocket traffic is proxied to the running daemon.
 */
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 4600,
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:4599",
        changeOrigin: false,
        ws: true,
      },
      "/health": "http://127.0.0.1:4599",
    },
  },
})
