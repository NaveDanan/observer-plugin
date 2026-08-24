import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

/**
 * Autostart: a hook brings the daemon up when nothing is listening.
 *
 * This is the property that makes Observer something you install rather than
 * something you remember to run, so it is tested end to end — a real emitter
 * process, a real daemon, a real port — rather than by inspecting intent.
 *
 * Every run is sealed inside its own OBSERVER_HOME, so the daemon it starts has
 * its own database and its own port and cannot touch the developer's Observer.
 */

const EMITTER = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/emit.js")
const homes: string[] = []

afterEach(async () => {
  while (homes.length > 0) {
    const home = homes.pop()
    if (!home) continue
    await stopDaemon(home)
    await removeTree(home)
  }
})

/**
 * Removes a temp home, retrying briefly.
 *
 * Windows releases a terminated process's file handles asynchronously, so the
 * daemon's log and SQLite files can still be locked for a moment after it is
 * gone. Cleanup is not the thing under test, so a stubborn directory is left
 * to the OS rather than failing an otherwise passing assertion.
 */
async function removeTree(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
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
  const home = mkdtempSync(join(tmpdir(), "observer-autostart-"))
  homes.push(home)
  writeFileSync(join(home, "config.json"), JSON.stringify(config, null, 2))
  return home
}

function emit(home: string, event = "sessionStart"): void {
  const result = spawnSync(process.execPath, [EMITTER, "--host", "copilot", "--event", event], {
    input: JSON.stringify({ session_id: "s1", cwd: "/repo" }),
    env: { ...process.env, OBSERVER_HOME: home },
    encoding: "utf8",
    timeout: 20_000,
  })
  // Rule one of the emitter: never fail a hook.
  expect(result.status).toBe(0)
  expect(result.stdout).toBe("")
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

function spooled(home: string): string[] {
  const dir = join(home, "spool")
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl"))
}

describe("emitter autostart", () => {
  it("starts the daemon and replays the event that triggered it", async () => {
    const port = await freePort()
    const home = makeHome({ port, token: "test-token" })

    emit(home)

    const health = await waitForHealth(port, 25_000)
    expect(health, "daemon did not come up").toBeDefined()

    // The event is not lost in the race: it spools first, and the daemon
    // drains the spool on boot, so it must be counted by the time it answers.
    expect(health?.["events"]).toBeGreaterThan(0)
  }, 40_000)

  it("does nothing but spool when autostart is off", async () => {
    const port = await freePort()
    const home = makeHome({ port, token: "test-token", autostart: false })

    emit(home)

    expect(await waitForHealth(port, 3_000)).toBeUndefined()
    expect(existsSync(join(home, "autostart.stamp"))).toBe(false)
    // Off means "do not start it", never "throw the event away".
    expect(spooled(home)).toHaveLength(1)
  }, 20_000)

  it("claims the start once, so a burst of hooks cannot race for the port", async () => {
    const port = await freePort()
    const home = makeHome({ port, token: "test-token" })

    // A single prompt fires several hooks within milliseconds.
    for (const event of ["sessionStart", "userPromptSubmitted", "preToolUse"]) emit(home, event)

    const health = await waitForHealth(port, 25_000)
    expect(health, "daemon did not come up").toBeDefined()

    // The stamp is the claim. One file, written by whichever hook got there
    // first; the others saw it and stood down.
    expect(existsSync(join(home, "autostart.stamp"))).toBe(true)
    expect(health?.["events"]).toBeGreaterThan(0)
  }, 60_000)
})
