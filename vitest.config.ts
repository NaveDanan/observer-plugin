import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    server: {
      deps: {
        /**
         * Load the built workspace packages with Node instead of transforming
         * them through Vite. Vite's builtin-module handling does not recognise
         * `node:sqlite`, and inlining these packages breaks that import.
         */
        external: [/packages\/[^/]+\/dist/, /apps\/[^/]+\/dist/],
      },
    },
  },
})
