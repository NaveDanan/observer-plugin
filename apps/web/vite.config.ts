import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

/**
 * The UI is served by the daemon in production, so assets use relative paths.
 * In dev, API and WebSocket traffic is proxied to the running daemon.
 *
 * Tailwind runs as a Vite plugin rather than through PostCSS: v4 is CSS-first,
 * and the token layer in `src/index.css` is written in its `@theme`,
 * `@variant` and `@utility` syntax, none of which survives without it.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
