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
        // The user turn itself identifies this as the root session. Child
        // lookups remain outside this fixture; an unknown session is never
        // allowed to become a provisional root merely to trigger autostart.
        get: async () => ({ data: { id: "root" } }),
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
  it("retries the failed cold-start batch ahead of events queued during startup", async () => {
    writeConfig({})
    process.env.OBSERVER_DAEMON = fakeDaemon()

    const attempts: Array<Array<Record<string, any>>> = []
    let resolveFirstAttempt: (() => void) | undefined
    const firstAttempt = new Promise<void>((resolve) => {
      resolveFirstAttempt = resolve
    })
    globalThis.fetch = (async (url: any, init?: any) => {
      if (!String(url).endsWith("/v1/hooks")) return Response.json({})
      const deliveries = JSON.parse(String(init?.body ?? "{}")).deliveries ?? []
      attempts.push(deliveries)
      if (attempts.length === 1) {
        resolveFirstAttempt?.()
        throw new TypeError("fetch failed")
      }
      return Response.json({})
    }) as typeof globalThis.fetch

    const hooks = await ObserverPlugin({
      client: { session: { get: async ({ path }: any) => ({ data: { id: path.id } }) } },
      directory: "/repo",
      worktree: "/repo",
    })
    const chat = (id: string) =>
      hooks["chat.message"](
        { sessionID: "root" },
        { message: { id, sessionID: "root" }, parts: [{ type: "text", text: id }] },
      )

    try {
      await chat("m1")
      await firstAttempt
      await chat("m2")

      await vi.waitFor(() => expect(attempts.length).toBeGreaterThanOrEqual(2))
      const retried = attempts.slice(1).flat()
      expect(retried.map((delivery) => delivery.payload.messageID)).toEqual(["m1", "m2"])
      expect(retried[0]?.deliveryId).toBe(attempts[0]?.[0]?.deliveryId)
    } finally {
      await hooks.dispose()
    }
  })

  it("stops retrying when the daemon never becomes reachable", async () => {
    vi.useFakeTimers()
    writeConfig({})
    process.env.OBSERVER_DAEMON = fakeDaemon()
    let hookAttempts = 0
    globalThis.fetch = (async (url: any) => {
      if (String(url).endsWith("/v1/hooks")) {
        hookAttempts++
        throw new TypeError("fetch failed")
      }
      return Response.json({})
    }) as typeof globalThis.fetch

    const hooks = await ObserverPlugin({
      client: { session: { get: async ({ path }: any) => ({ data: { id: path.id } }) } },
      directory: "/repo",
      worktree: "/repo",
    })
    try {
      await hooks["chat.message"](
        { sessionID: "root" },
        { message: { id: "m1", sessionID: "root" }, parts: [{ type: "text", text: "hello" }] },
      )
      await vi.advanceTimersByTimeAsync(60_000)
      expect(hookAttempts).toBe(31)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(hookAttempts).toBe(31)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await hooks.dispose()
      vi.useRealTimers()
    }
  })

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
