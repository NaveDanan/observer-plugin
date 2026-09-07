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

  async function setup(config = makeConfig()) {
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
    expect(profiles).toHaveLength(8)
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
    expect(matches[0].id).toBe("platform-engineer")
    expect(matches[0].directive).toContain("Itai Friedman")
  })

  it("keeps specialists discoverable in settings but opt-in for briefs and matching", async () => {
    const config = makeConfig({ seats: { control: false, employees: { "security-specialist": { enabled: true } } } })
    const app = await setup(config)
    const headers = { authorization: "Bearer test-token" }
    const catalog = (await app.inject({ method: "GET", url: "/v1/roster", headers })).json()
    expect(catalog.profiles).toHaveLength(8)
    expect(catalog.activeEmployeeIds).toHaveLength(7)
    const brief = (await app.inject({ method: "GET", url: "/v1/roster/brief?employeeId=nia-okafor", headers })).json()
    expect(brief.employeeId).toBe("security-specialist")
    expect(brief.enabled).toBe(true)
    const payload = { task: "Security threat modeling and vulnerability management", limit: 8 }
    const enabled = (await app.inject({ method: "POST", url: "/v1/roster/match", headers, payload })).json()
    expect(enabled.matches[0].id).toBe("security-specialist")
    config.seats.employees["security-specialist"]!.enabled = false
    const disabled = (await app.inject({ method: "POST", url: "/v1/roster/match", headers, payload })).json()
    expect(disabled.matches.map((match: { id: string }) => match.id)).not.toContain("security-specialist")
    expect((await app.inject({ method: "GET", url: "/v1/roster/brief?employeeId=security-specialist", headers })).json().enabled).toBe(false)
    expect((await app.inject({ method: "GET", url: "/v1/roster/brief", headers })).json().employees).toHaveLength(6)
  })

  it("returns a compact roster or a selected contract with configured skills", async () => {
    const app = await setup(makeConfig({ seats: { control: false, employees: { "frontend-engineer": { skills: [{ name: "project-ui", description: "Use project tokens" }] } } } }))
    const headers = { authorization: "Bearer test-token" }
    const list = await app.inject({ method: "GET", url: "/v1/roster/brief", headers })
    expect(list.statusCode).toBe(200)
    expect(list.json().employees).toHaveLength(6)
    expect(list.body).not.toContain("Specialty workflow")
    const response = await app.inject({ method: "GET", url: "/v1/roster/brief?employeeId=frontend-engineer&mode=review", headers })
    expect(response.statusCode).toBe(200)
    const brief = response.json()
    expect(brief.mode).toBe("review")
    expect(brief.contract.defaultMode).toBe("implement")
    expect(brief.instructions).toContain("Default mode: review")
    expect(brief.instructions).toContain("project-ui: Use project tokens")
    expect(brief.capabilities.find((capability: { id: string }) => capability.id === "browser").availability).toBe("discover-in-host")
    const repeated = await app.inject({ method: "GET", url: "/v1/roster/brief?employeeId=frontend-engineer", headers })
    expect(repeated.json().mode).toBe("implement")
  })

  it("rejects unauthorized, unknown, and malformed employee brief requests", async () => {
    const app = await setup()
    expect((await app.inject({ method: "GET", url: "/v1/roster/brief" })).statusCode).toBe(401)
    for (const [query, status] of [
      ["employeeId=nobody", 404], ["employeeId=", 400], ["mode=review", 400],
      ["employeeId=frontend-engineer&mode=toString", 400], ["employeeId=frontend-engineer&extra=true", 400],
    ] as const) {
      const response = await app.inject({ method: "GET", url: `/v1/roster/brief?${query}`, headers: { authorization: "Bearer test-token" } })
      expect(response.statusCode, query).toBe(status)
    }
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

describe("configured skills reach the directive the plugin appends", () => {
  const closers: Array<() => void> = []
  afterEach(() => {
    while (closers.length > 0) closers.pop()?.()
  })

  async function matchWith(config: ObserverConfig, task: string) {
    const store = new Store({ path: ":memory:" })
    const pipeline = new Pipeline({ store, config, onChanges: () => {} })
    const app = await createServer({ store, pipeline, config, broadcaster: new Broadcaster(), webDir: "/nonexistent" })
    closers.push(() => {
      void app.close()
      store.close()
    })
    const response = await app.inject({
      method: "POST",
      url: "/v1/roster/match",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      payload: { task, limit: 1 },
    })
    return response.json().matches[0]
  }

  const K8S_TASK = "Kubernetes deployment is unhealthy in every environment"

  it("omits the skills line when nothing is configured", async () => {
    const match = await matchWith(makeConfig(), K8S_TASK)
    expect(match.id).toBe("platform-engineer")
    expect(match.directive).not.toContain("Skills available to you")
  })

  it("renders a configured skill on the matched employee's directive", async () => {
    const config = makeConfig({
      seats: { control: false, employees: { "platform-engineer": { skills: [{ name: "argocd", description: "" }] } } },
    })
    const match = await matchWith(config, K8S_TASK)
    expect(match.directive).toContain("Configured skill preferences, resolve against the current host inventory")
    expect(match.directive).toContain("- argocd:")
  })

  it("applies skills even with seat control off, because they are only prompt text", async () => {
    const config = makeConfig({
      seats: { control: false, employees: { "platform-engineer": { skills: [{ name: "argocd", description: "" }] } } },
    })
    expect(config.seats.control).toBe(false)
    expect((await matchWith(config, K8S_TASK)).directive).toContain("argocd")
  })

  it("leaves other employees' directives alone", async () => {
    const config = makeConfig({
      seats: { control: false, employees: { "frontend-engineer": { skills: [{ name: "react", description: "" }] } } },
    })
    const match = await matchWith(config, K8S_TASK)
    expect(match.id).toBe("platform-engineer")
    expect(match.directive).not.toContain("react")
  })
})
