import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Broadcaster, DEFAULT_CONFIG, Diagnostics, Pipeline, createServer } from "@observer-ai/daemon"
import { Store } from "@observer-ai/storage"

/**
 * Static UI serving.
 *
 * The regression these cover is platform-specific and invisible on CI running
 * Linux: the path-traversal guard compared against a hardcoded "/" separator,
 * so on Windows — where `resolve` yields backslashes — no real asset ever
 * looked "inside" the web root. Every request fell through to index.html, the
 * JS bundle arrived as `text/html`, and the canvas rendered blank.
 */

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function setup(): { webDir: string; build: () => Promise<Awaited<ReturnType<typeof createServer>>> } {
  const webDir = mkdtempSync(join(tmpdir(), "observer-web-"))
  cleanups.push(() => rmSync(webDir, { recursive: true, force: true }))

  writeFileSync(join(webDir, "index.html"), "<!doctype html><div id=root></div>")
  mkdirSync(join(webDir, "assets"), { recursive: true })
  writeFileSync(join(webDir, "assets", "index-abc123.js"), "export const canvas = 1\n")
  writeFileSync(join(webDir, "assets", "index-abc123.css"), ":root{color:red}\n")

  const build = async () => {
    const store = new Store({ path: ":memory:" })
    cleanups.push(() => store.close())
    const config = { ...DEFAULT_CONFIG, token: "test-token" }
    return createServer({
      store,
      pipeline: new Pipeline({ store, config, onChanges: () => {} }),
      config,
      broadcaster: new Broadcaster(),
      diagnostics: new Diagnostics(),
      webDir,
    })
  }
  return { webDir, build }
}

describe("static UI", () => {
  it("serves a nested asset as itself, not as the index fallback", async () => {
    const app = await (await setup()).build()

    const js = await app.inject({ method: "GET", url: "/assets/index-abc123.js" })
    expect(js.statusCode).toBe(200)
    expect(js.body).toContain("export const canvas")
    // The bug served HTML here, which is what blanked the canvas.
    expect(js.headers["content-type"]).toContain("javascript")

    const css = await app.inject({ method: "GET", url: "/assets/index-abc123.css" })
    expect(css.statusCode).toBe(200)
    expect(css.headers["content-type"]).toContain("css")
    expect(css.body).toContain("color:red")
  })

  it("serves index.html at the root and for unknown client routes", async () => {
    const app = await (await setup()).build()

    for (const url of ["/", "/session/abc"]) {
      const response = await app.inject({ method: "GET", url })
      expect(response.statusCode, url).toBe(200)
      expect(response.headers["content-type"], url).toContain("html")
      expect(response.body, url).toContain("id=root")
    }
  })

  it("still refuses to escape the web root", async () => {
    const app = await (await setup()).build()
    // Traversal must fall back to index.html rather than reading outside.
    const response = await app.inject({ method: "GET", url: "/../../../etc/passwd" })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain("id=root")
  })

  it("keeps API 404s as JSON rather than the SPA shell", async () => {
    const app = await (await setup()).build()
    const response = await app.inject({ method: "GET", url: "/v1/nope" })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: "not found" })
  })
})
