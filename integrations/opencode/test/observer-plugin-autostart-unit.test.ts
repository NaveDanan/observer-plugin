import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
// @ts-expect-error -- untyped plain-JS plugin, loaded on purpose
import { ObserverPlugin } from "../observer-plugin.js"

/**
 * Autostart bookkeeping, without really spawning anything.
 *
 * The end-to-end behaviour — the daemon actually coming up — lives in
 * observer-plugin-autostart.test.ts. Here the spawn is mocked so the claim,
 * the cooldown and the opt-out can be asserted exactly, once each.
 */

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}))

let home: string
let originalHome: string | undefined
let originalDaemonEnv: string | undefined
let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "observer-oc-autostart-"))
  originalHome = process.env.OBSERVER_HOME
  originalDaemonEnv = process.env.OBSERVER_DAEMON
  process.env.OBSERVER_HOME = home
  originalFetch = globalThis.fetch
  // Only the delivery endpoint is down: every other request succeeds, so the
  // sole trigger under test is the flush of an undeliverable event batch.
  globalThis.fetch = (async (url: any) => {
    if (String(url).endsWith("/v1/hooks")) throw new TypeError("fetch failed")
    return Response.json({})
  }) as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalHome === undefined) delete process.env.OBSERVER_HOME
  else process.env.OBSERVER_HOME = originalHome
  if (originalDaemonEnv === undefined) delete process.env.OBSERVER_DAEMON
  else process.env.OBSERVER_DAEMON = originalDaemonEnv
  vi.mocked(spawn).mockClear()
  rmSync(home, { recursive: true, force: true })
})

/** A fake daemon build the override can point at. */
function fakeDaemon(): string {
  const path = join(home, "fake-daemon.js")
  writeFileSync(path, "")
  return path
}

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ port: 7788, token: "t0k3n", ...config }),
  )
}

/**
 * Runs one turn far enough to flush a delivery: the message is queued, and
 * dispose() flushes it, hits the rejecting endpoint, and gives autostart its
 * chance — all awaited, so assertions need no polling.
 */
async function turn(): Promise<void> {
  const hooks = await ObserverPlugin({
    client: {
      session: {
        get: async () => {
          throw new Error("host unreachable")
        },
      },
    },
    directory: "/repo",
    worktree: "/repo",
  })
  await hooks["chat.message"](
    { sessionID: "root" },
    { message: { id: "m1", sessionID: "root" }, parts: [{ type: "text", text: "hello" }] },
  )
  await hooks.dispose()
}

describe("observer opencode plugin autostart: claims and cooldown", () => {
  it("spawns the recorded daemon once when deliveries cannot get through", async () => {
    writeConfig({})
    const daemon = fakeDaemon()
    process.env.OBSERVER_DAEMON = daemon

    await turn()

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1)
    const [node, args, options] = vi.mocked(spawn).mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ]
    expect(node).toBe(process.execPath)
    expect(args).toEqual([daemon])
    expect(options.detached).toBe(true)
    expect(existsSync(join(home, "autostart.stamp"))).toBe(true)

    // A second failing turn inside the cooldown stands down: one claim, one spawn.
    await turn()
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1)
  })

  it("spawns nothing when autostart is off", async () => {
    writeConfig({ autostart: false })
    process.env.OBSERVER_DAEMON = fakeDaemon()

    await turn()

    expect(vi.mocked(spawn)).not.toHaveBeenCalled()
    expect(existsSync(join(home, "autostart.stamp"))).toBe(false)
  })

  it("spawns nothing when neither the installer nor the environment names a daemon", async () => {
    writeConfig({})
    delete process.env.OBSERVER_DAEMON

    await turn()

    expect(vi.mocked(spawn)).not.toHaveBeenCalled()
    // Without a daemon to point at there is nothing to claim either, so the
    // next turn is free to try again rather than waiting out a cooldown.
    expect(existsSync(join(home, "autostart.stamp"))).toBe(false)
  })
})
