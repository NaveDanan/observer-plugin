import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { createServer } from "node:net"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
// @ts-expect-error -- untyped plain-JS plugin, loaded on purpose
import { ObserverPlugin } from "../observer-plugin.js"

/**
 * Autostart, end to end: an OpenCode session brings the daemon up by itself.
 *
 * This is the property the doctor used to answer with "run `observer start`";
 * it is tested against a real daemon on a real port, the same way the hook
 * emitter's autostart is. The plugin finds the daemon through the pointer file
 * `observer install opencode` writes, so that file — not an environment
 * override — is what this exercises.
 *
 * Every run is sealed inside its own OBSERVER_HOME: its own database, its own
 * port, nothing near the developer's Observer.
 */

const DAEMON = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/daemon/dist/main.js")
const homes: string[] = []
const originalHome = process.env.OBSERVER_HOME

afterEach(async () => {
  while (homes.length > 0) {
    const home = homes.pop()
    if (!home) continue
    await stopDaemon(home)
    rmTree(home)
  }
  if (originalHome === undefined) delete process.env.OBSERVER_HOME
  else process.env.OBSERVER_HOME = originalHome
})

function rmTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // Windows may hold the log or database open for a moment after the kill;
    // cleanup is not the thing under test.
  }
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

function makeHome(config: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "observer-oc-autostart-e2e-"))
  homes.push(home)
  process.env.OBSERVER_HOME = home
  writeFileSync(join(home, "config.json"), JSON.stringify({ port: 0, token: "test-token", ...config }))
  return home
}

/** The pointer `observer install opencode` writes; here written by hand. */
function recordInstallPaths(home: string): void {
  writeFileSync(
    join(home, "install.json"),
    JSON.stringify({ node: process.execPath, daemon: DAEMON }, null, 2),
  )
}

async function waitForHealth(port: number, timeoutMs: number): Promise<Record<string, any> | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return (await response.json()) as Record<string, any>
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return undefined
}

async function stopDaemon(home: string): Promise<void> {
  const pidFile = join(home, "daemon.pid")
  if (!existsSync(pidFile)) return
  const pid = Number(readFileSync(pidFile, "utf8").trim())
  if (!Number.isFinite(pid) || pid <= 0) return
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** A plugin over a stub host client; fetch stays real, so the port must be dead. */
async function startSession(): Promise<{ chat: () => Promise<void>; dispose: () => Promise<void> }> {
  const hooks = await ObserverPlugin({
    client: {
      session: {
        get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }),
      },
    },
    directory: "/repo",
    worktree: "/repo",
  })
  return {
    chat: async () => {
      await hooks["chat.message"](
        { sessionID: "root" },
        { message: { id: "m1", sessionID: "root" }, parts: [{ type: "text", text: "hello" }] },
      )
      // Give the batch timer its 120ms and let the flush fail for real.
      await new Promise((r) => setTimeout(r, 400))
    },
    dispose: () => hooks.dispose(),
  }
}

describe("observer opencode plugin autostart, end to end", () => {
  it("brings the daemon up from a user message alone", async () => {
    const port = await freePort()
    const home = makeHome({ port })
    recordInstallPaths(home)

    const session = await startSession()
    try {
      await session.chat()

      const health = await waitForHealth(port, 25_000)
      expect(health, "daemon did not come up").toBeDefined()
      expect(existsSync(join(home, "autostart.stamp"))).toBe(true)

      // Once up, the next turn's telemetry gets through for real.
      await session.chat()
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && (health?.["events"] ?? 0) === 0) {
        const fresh = await waitForHealth(port, 1_000)
        Object.assign(health ?? {}, fresh ?? {})
      }
      expect(health?.["events"]).toBeGreaterThan(0)
    } finally {
      await session.dispose()
    }
  }, 60_000)

  it("leaves the daemon down when autostart is off", async () => {
    const port = await freePort()
    const home = makeHome({ port, autostart: false })
    recordInstallPaths(home)

    const session = await startSession()
    try {
      await session.chat()
      expect(await waitForHealth(port, 3_000)).toBeUndefined()
      expect(existsSync(join(home, "autostart.stamp"))).toBe(false)
    } finally {
      await session.dispose()
    }
  }, 20_000)
})
