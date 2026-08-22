import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Change } from "@observer-ai/protocol"
import { configPath } from "@observer-ai/storage"
import { Broadcaster, DEFAULT_CONFIG, Diagnostics, Pipeline, ProvidersConfigSchema, createServer, loadConfig, saveConfig } from "@observer-ai/daemon"
import type { ObserverConfig } from "@observer-ai/daemon"
import { Store } from "@observer-ai/storage"

let home: string
let originalHome: string | undefined
const closers: Array<() => void> = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "observer-config-api-"))
  originalHome = process.env["OBSERVER_HOME"]
  process.env["OBSERVER_HOME"] = home
})

afterEach(() => {
  while (closers.length > 0) closers.pop()?.()
  if (originalHome === undefined) delete process.env["OBSERVER_HOME"]
  else process.env["OBSERVER_HOME"] = originalHome
  rmSync(home, { recursive: true, force: true })
})

function makeConfig(overrides: Partial<ObserverConfig> = {}): ObserverConfig {
  return {
    ...DEFAULT_CONFIG,
    token: "test-token",
    ...overrides,
    capture: { ...DEFAULT_CONFIG.capture, ...(overrides.capture ?? {}) },
    redaction: { ...DEFAULT_CONFIG.redaction, ...(overrides.redaction ?? {}) },
  }
}

async function setup(config = makeConfig()): Promise<{ app: Awaited<ReturnType<typeof createServer>>; store: Store }> {
  const store = new Store({ path: ":memory:", retentionDays: config.retentionDays })
  const changes: Change[] = []
  const pipeline = new Pipeline({ store, config, onChanges: (batch) => changes.push(...batch) })
  const app = await createServer({ store, pipeline, config, broadcaster: new Broadcaster(), diagnostics: new Diagnostics(), webDir: "/nonexistent" })
  closers.push(() => {
    void app.close()
    store.close()
  })
  return { app, store }
}

function auth() {
  return { authorization: "Bearer test-token" }
}

describe("configuration API", () => {
  it("persists a valid patch and applies retention to the live store", async () => {
    const config = makeConfig()
    saveConfig(config)
    const { app, store } = await setup(config)

    const response = await app.inject({
      method: "PUT",
      url: "/v1/config",
      headers: auth(),
      payload: {
        capture: { ...config.capture, messages: false },
        retentionDays: 0,
        redaction: { enabled: false, maxTextLength: 128 },
        guidance: false,
        providers: { primary: { driver: "claude" } },
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      capture: { messages: false },
      retentionDays: 0,
      redaction: { enabled: false, maxTextLength: 128 },
      guidance: false,
      providers: { primary: { driver: "claude", enabled: true } },
    })
    expect(JSON.parse(readFileSync(configPath(), "utf8"))).toMatchObject({
      capture: { messages: false },
      retentionDays: 0,
      guidance: false,
      providers: { primary: { driver: "claude", enabled: true } },
    })
    expect(loadConfig().retentionDays).toBe(0)
    expect(store.prune()).toBe(0)
  })

  it("rejects an invalid patch without changing the file", async () => {
    const config = makeConfig()
    saveConfig(config)
    const before = readFileSync(configPath(), "utf8")
    const { app } = await setup(config)

    const response = await app.inject({
      method: "PUT",
      url: "/v1/config",
      headers: auth(),
      payload: { capture: { ...config.capture, messages: "off" } },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: "invalid config patch" })
    expect(readFileSync(configPath(), "utf8")).toBe(before)
    expect(config.capture.messages).toBe(true)
  })

  it("canonicalises string skills through a seats patch and persists them", async () => {
    const config = makeConfig()
    saveConfig(config)
    const { app } = await setup(config)

    const response = await app.inject({
      method: "PUT",
      url: "/v1/config",
      headers: auth(),
      payload: { seats: { control: false, employees: { "arjun-mehta": { skills: ["react"] } } } },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().seats.employees["arjun-mehta"].skills).toEqual([{ name: "react", description: "" }])
    expect(JSON.parse(readFileSync(configPath(), "utf8")).seats.employees["arjun-mehta"].skills).toEqual([
      { name: "react", description: "" },
    ])
  })

  it("serves a model list transport shape even when no catalogue is available", async () => {
    const { app } = await setup()

    const response = await app.inject({ method: "GET", url: "/v1/models", headers: auth() })
    const body = response.json()

    expect(response.statusCode).toBe(200)
    expect(typeof body.count).toBe("number")
    expect(typeof body.sources).toBe("string")
    expect(Array.isArray(body.models)).toBe(true)
    expect(body.count).toBe(body.models.length)
    for (const model of body.models) {
      expect(model).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          provider: expect.any(String),
          providerLabel: expect.any(String),
          label: expect.any(String),
          variants: expect.any(Object),
          known: expect.any(Boolean),
        }),
      )
    }
  })

  it("reports configured instances and known host sessions", async () => {
    const config = makeConfig({ providers: { local: { driver: "claude", displayName: "Local Claude", enabled: true } } })
    const { app, store } = await setup(config)
    store.putSession({
      id: "claude:session-1",
      host: "claude",
      hostVersion: null,
      sessionKey: "session-1",
      workspaceRoot: "/work",
      title: null,
      status: "active",
      model: null,
      goal: null,
      goalStatus: null,
      cwd: null,
      startedAt: 10,
      endedAt: null,
      updatedAt: 25,
      lastEventSeq: 0,
    })

    const response = await app.inject({ method: "GET", url: "/v1/providers/status", headers: auth() })
    const claude = response.json().hosts.find((host: { id: string }) => host.id === "claude")

    expect(response.statusCode).toBe(200)
    expect(claude).toMatchObject({ sessions: 1, lastActiveAt: 25, configured: true, enabledInstances: 1 })
  })
})

describe("provider config schema", () => {
  it("drops unusable entries while keeping valid siblings", () => {
    const providers = ProvidersConfigSchema.parse({
      broken: null,
      alsoBroken: { driver: 42 },
      good: { driver: "codex", enabled: "yes", note: "preserve" },
    })

    expect(providers).toEqual({ broken: {}, alsoBroken: {}, good: { driver: "codex", enabled: true, note: "preserve" } })
  })
})
