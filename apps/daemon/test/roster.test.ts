import { afterEach, describe, expect, it } from "vitest"
import type { Change } from "@observer-ai/protocol"
import { Store } from "@observer-ai/storage"
import { Broadcaster, DEFAULT_CONFIG, Pipeline, createServer } from "@observer-ai/daemon"
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

describe("roster API", () => {
  const closers: Array<() => void> = []
  afterEach(() => {
    while (closers.length > 0) closers.pop()?.()
  })

  async function setup() {
    const config = makeConfig()
    const store = new Store({ path: ":memory:" })
    const changes: Change[] = []
    const pipeline = new Pipeline({ store, config, onChanges: (batch) => changes.push(...batch) })
    const app = await createServer({ store, pipeline, config, broadcaster: new Broadcaster(), webDir: "/nonexistent" })
    closers.push(() => {
      void app.close()
      store.close()
    })
    return app
  }

  it("serves every profile with a resolved image URL", async () => {
    const app = await setup()
    const roster = await app.inject({
      method: "GET",
      url: "/v1/roster",
      headers: { authorization: "Bearer test-token" },
    })
    expect(roster.statusCode).toBe(200)
    const { profiles } = roster.json()
    expect(profiles).toHaveLength(14)
    for (const profile of profiles) expect(profile.imageUrl).toMatch(/^\/roster\/.+\.png$/)
  })

  it("seats the right employee on a task and returns a directive", async () => {
    const app = await setup()
    const match = await app.inject({
      method: "POST",
      url: "/v1/roster/match",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      payload: { task: "Kubernetes deployment is unhealthy in every environment", limit: 2 },
    })
    expect(match.statusCode).toBe(200)
    const { matches } = match.json()
    expect(matches[0].id).toBe("elias-mercer")
    expect(matches[0].directive).toContain("Elias Mercer")
  })

  it("rejects unauthenticated and malformed requests", async () => {
    const app = await setup()
    const unauthed = await app.inject({ method: "GET", url: "/v1/roster" })
    expect(unauthed.statusCode).toBe(401)

    const bad = await app.inject({
      method: "POST",
      url: "/v1/roster/match",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      payload: { task: 42 },
    })
    expect(bad.statusCode).toBe(400)
  })
})
