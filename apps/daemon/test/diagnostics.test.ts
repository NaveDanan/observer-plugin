import { describe, expect, it } from "vitest"
import { Store } from "@observer-ai/storage"
import { Broadcaster, DEFAULT_CONFIG, Diagnostics, Pipeline, createServer } from "@observer-ai/daemon"
import type { ObserverConfig } from "@observer-ai/daemon"

function makeConfig(overrides: Partial<ObserverConfig> = {}): ObserverConfig {
  return {
    ...DEFAULT_CONFIG,
    token: "test-token",
    ...overrides,
    capture: { ...DEFAULT_CONFIG.capture, ...(overrides.capture ?? {}) },
    redaction: { ...DEFAULT_CONFIG.redaction, ...(overrides.redaction ?? {}) },
  }
}

function setup(config = makeConfig()): { store: Store; pipeline: Pipeline; diagnostics: Diagnostics } {
  const store = new Store({ path: ":memory:" })
  const diagnostics = new Diagnostics()
  const pipeline = new Pipeline({ store, config, diagnostics, onChanges: () => undefined })
  return { store, pipeline, diagnostics }
}

describe("Diagnostics", () => {
  it("counts accepted deliveries per host", () => {
    const { pipeline, diagnostics, store } = setup()
    pipeline.ingestHook({
      host: "claude",
      event: "SessionStart",
      deliveryId: "d1",
      payload: { session_id: "s1", model: "claude-opus-5" },
    })

    const snapshot = diagnostics.snapshot()
    expect(snapshot.accepted).toBeGreaterThan(0)
    expect(snapshot.faults).toBe(0)
    expect(Object.keys(snapshot.lastAcceptedByHost)).toEqual(["claude"])
    store.close()
  })

  it("records an event no adapter understands as unmapped", () => {
    const { pipeline, diagnostics, store } = setup()
    pipeline.ingestHook({
      host: "claude",
      event: "SomeFutureEvent",
      deliveryId: "d1",
      payload: { session_id: "s1", weird: true },
    })

    const snapshot = diagnostics.snapshot()
    expect(snapshot.counters.unmapped).toBe(1)
    expect(snapshot.faults).toBe(1)
    expect(snapshot.recent[0]).toMatchObject({ host: "claude", event: "SomeFutureEvent", reason: "unmapped" })
    store.close()
  })

  it("distinguishes a malformed payload from an unmapped event", () => {
    const { pipeline, diagnostics, store } = setup()
    pipeline.ingestHook({
      host: "codex",
      event: "SessionStart",
      deliveryId: "d1",
      payload: { text: "not json at all" },
      payloadError: "Bad control character in string literal",
    })

    const snapshot = diagnostics.snapshot()
    expect(snapshot.counters.malformed).toBe(1)
    expect(snapshot.counters.unmapped).toBe(0)
    expect(snapshot.recent[0]?.detail).toContain("Bad control character")
    store.close()
  })

  it("records a payload missing its session id", () => {
    const { pipeline, diagnostics, store } = setup()
    pipeline.ingestHook({ host: "claude", event: "SessionStart", deliveryId: "d1", payload: { model: "x" } })

    // The recorded keys are what tells you the id was absent.
    expect(diagnostics.snapshot().recent[0]?.payloadKeys).toEqual(["model"])
    store.close()
  })

  it("never stores payload values, only key names", () => {
    const { pipeline, diagnostics, store } = setup()
    pipeline.ingestHook({
      host: "claude",
      event: "Unknown",
      deliveryId: "d1",
      payload: { session_id: "s1", prompt: "my private prompt", token: "ghp_secret" },
    })

    const serialised = JSON.stringify(diagnostics.snapshot())
    expect(serialised).not.toContain("my private prompt")
    expect(serialised).not.toContain("ghp_secret")
    expect(serialised).toContain("session_id")
    store.close()
  })

  it("separates capture-filtered drops from faults", () => {
    const config = makeConfig({ capture: { ...DEFAULT_CONFIG.capture, messages: false } })
    const { pipeline, diagnostics, store } = setup(config)
    pipeline.ingestHook({
      host: "claude",
      event: "UserPromptSubmit",
      deliveryId: "d1",
      payload: { session_id: "s1", prompt_id: "p1", prompt: "hello" },
    })

    const snapshot = diagnostics.snapshot()
    expect(snapshot.counters.filtered).toBeGreaterThan(0)
    // Deliberate configuration is not a fault, so it must not raise an alarm.
    expect(snapshot.faults).toBe(0)
    store.close()
  })

  it("counts replayed deliveries as duplicates rather than faults", () => {
    const { pipeline, diagnostics, store } = setup()
    const delivery = {
      host: "claude" as const,
      event: "SessionStart",
      deliveryId: "same",
      payload: { session_id: "s1" },
    }
    pipeline.ingestHook(delivery)
    pipeline.ingestHook(delivery)

    const snapshot = diagnostics.snapshot()
    expect(snapshot.counters.duplicate).toBeGreaterThan(0)
    expect(snapshot.faults).toBe(0)
    store.close()
  })

  it("keeps only the most recent samples", () => {
    const diagnostics = new Diagnostics(3)
    for (let i = 0; i < 10; i++) {
      diagnostics.record({ host: "claude", event: `E${i}`, reason: "unmapped" })
    }

    const snapshot = diagnostics.snapshot()
    expect(snapshot.counters.unmapped).toBe(10)
    expect(snapshot.recent).toHaveLength(3)
    // Newest first, so the latest failure is the one you read.
    expect(snapshot.recent[0]?.event).toBe("E9")
  })
})

describe("diagnostics API", () => {
  it("reports faults over HTTP so the CLI and UI can surface them", async () => {
    const config = makeConfig()
    const { store, pipeline, diagnostics } = setup(config)
    const broadcaster = new Broadcaster()
    const app = await createServer({ store, pipeline, config, broadcaster, diagnostics, webDir: "/nonexistent" })

    pipeline.ingestHook({ host: "claude", event: "Mystery", deliveryId: "d1", payload: { session_id: "s1" } })

    const health = await app.inject({ method: "GET", url: "/health" })
    expect(health.json().faults).toBe(1)

    const unauthorized = await app.inject({ method: "GET", url: "/v1/diagnostics" })
    expect(unauthorized.statusCode).toBe(401)

    const report = await app.inject({
      method: "GET",
      url: "/v1/diagnostics",
      headers: { authorization: `Bearer ${config.token}` },
    })
    expect(report.json().recent[0].event).toBe("Mystery")

    await app.close()
    store.close()
  })
})
