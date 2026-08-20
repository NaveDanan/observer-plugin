import { afterEach, describe, expect, it } from "vitest"
import { Store } from "@observer-ai/storage"
import type { Change } from "@observer-ai/protocol"
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

function setup(config = makeConfig()): { store: Store; pipeline: Pipeline; changes: Change[] } {
  const store = new Store({ path: ":memory:" })
  const changes: Change[] = []
  const pipeline = new Pipeline({ store, config, onChanges: (batch) => changes.push(...batch) })
  return { store, pipeline, changes }
}

const closers: Array<() => void> = []
afterEach(() => {
  while (closers.length > 0) closers.pop()?.()
})

describe("Pipeline", () => {
  it("ingests a hook and projects entities", () => {
    const { store, pipeline, changes } = setup()
    closers.push(() => store.close())

    const result = pipeline.ingestHook({
      host: "claude",
      event: "SessionStart",
      deliveryId: "d1",
      workspaceRoot: "/repo",
      payload: { session_id: "s1", source: "startup", model: "claude-opus-5" },
    })

    expect(result.accepted).toBe(1)
    expect(store.listSessions()[0]?.model).toBe("claude-opus-5")
    expect(changes.some((change) => change.table === "session")).toBe(true)
  })

  it("treats a replayed delivery as a duplicate", () => {
    const { store, pipeline } = setup()
    closers.push(() => store.close())
    const delivery = {
      host: "claude" as const,
      event: "UserPromptSubmit",
      deliveryId: "same",
      payload: { session_id: "s1", prompt: "hi", prompt_id: "p1" },
    }

    expect(pipeline.ingestHook(delivery).accepted).toBeGreaterThan(0)
    expect(pipeline.ingestHook(delivery).accepted).toBe(0)
    expect(pipeline.ingestHook(delivery).duplicates).toBeGreaterThan(0)
  })

  it("ignores hook events it does not understand", () => {
    const { store, pipeline } = setup()
    closers.push(() => store.close())
    expect(pipeline.ingestHook({ host: "claude", event: "Nonsense", deliveryId: "d", payload: {} }).accepted).toBe(0)
  })

  it("redacts secrets before they reach the database", () => {
    const { store, pipeline } = setup()
    closers.push(() => store.close())

    pipeline.ingestHook({
      host: "claude",
      event: "UserPromptSubmit",
      deliveryId: "d",
      payload: { session_id: "s1", prompt_id: "p1", prompt: "deploy with ghp_abcdefghijklmnopqrstuvwxyz0123" },
    })

    const agents = store.listAgents("claude:s1")
    const messages = store.listMessages(agents[0]!.id)
    expect(messages[0]?.text).toBe("deploy with [redacted]")
  })

  it("drops message content entirely when capture is disabled", () => {
    const config = makeConfig({ capture: { ...DEFAULT_CONFIG.capture, messages: false } })
    const { store, pipeline } = setup(config)
    closers.push(() => store.close())

    pipeline.ingestHook({
      host: "claude",
      event: "UserPromptSubmit",
      deliveryId: "d",
      payload: { session_id: "s1", prompt_id: "p1", prompt: "private" },
    })

    const agents = store.listAgents("claude:s1")
    expect(agents.length > 0 ? store.listMessages(agents[0]!.id) : []).toHaveLength(0)
  })

  it("omits tool output when that capture switch is off", () => {
    const config = makeConfig({ capture: { ...DEFAULT_CONFIG.capture, toolOutput: false } })
    const { store, pipeline } = setup(config)
    closers.push(() => store.close())

    pipeline.ingestHook({
      host: "claude",
      event: "PostToolUse",
      deliveryId: "d",
      payload: { session_id: "s1", tool_name: "Bash", tool_use_id: "t1", tool_input: {}, tool_response: "secret" },
    })

    const agent = store.listAgents("claude:s1")[0]!
    expect(store.listToolCalls(agent.id)[0]?.output).toBeNull()
  })
})

describe("Broadcaster", () => {
  it("replays buffered changes to a reconnecting client", () => {
    const broadcaster = new Broadcaster(10)
    const change: Change = { table: "todo", op: "delete", id: "x" }
    broadcaster.publish([change])
    broadcaster.publish([change])

    const received: string[] = []
    const ok = broadcaster.replay({ send: (data) => received.push(data), close: () => undefined }, 1)

    expect(ok).toBe(true)
    expect(received).toHaveLength(1)
    expect(JSON.parse(received[0]!).cursor).toBe(2)
  })

  it("asks for a full resync when the gap exceeds the buffer", () => {
    const broadcaster = new Broadcaster(2)
    for (let i = 0; i < 5; i++) broadcaster.publish([{ table: "todo", op: "delete", id: String(i) }])

    const ok = broadcaster.replay({ send: () => undefined, close: () => undefined }, 1)
    expect(ok).toBe(false)
  })

  it("drops clients whose socket throws", () => {
    const broadcaster = new Broadcaster()
    broadcaster.add({
      send: () => {
        throw new Error("closed")
      },
      close: () => undefined,
    })
    broadcaster.publish([{ table: "todo", op: "delete", id: "x" }])
    expect(broadcaster.size).toBe(0)
  })
})

describe("HTTP API", () => {
  it("rejects unauthenticated requests and serves data with a token", async () => {
    const config = makeConfig()
    const { store, pipeline } = setup(config)
    const broadcaster = new Broadcaster()
    const app = await createServer({ store, pipeline, config, broadcaster, webDir: "/nonexistent" })
    closers.push(() => {
      void app.close()
      store.close()
    })

    const unauthorized = await app.inject({ method: "GET", url: "/v1/sessions" })
    expect(unauthorized.statusCode).toBe(401)

    const hook = await app.inject({
      method: "POST",
      url: "/v1/hook",
      headers: { authorization: `Bearer ${config.token}` },
      payload: {
        host: "codex",
        event: "SessionStart",
        deliveryId: "d1",
        workspaceRoot: "/repo",
        payload: { session_id: "s1", model: "gpt-5.3-codex" },
      },
    })
    expect(hook.statusCode).toBe(200)

    const sessions = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { authorization: `Bearer ${config.token}` },
    })
    expect(sessions.json().sessions[0].model).toBe("gpt-5.3-codex")

    const snapshot = await app.inject({
      method: "GET",
      url: `/v1/sessions/${encodeURIComponent("codex:s1")}`,
      headers: { authorization: `Bearer ${config.token}` },
    })
    expect(snapshot.json().agents).toHaveLength(1)
  })

  it("blocks requests with a foreign Host header", async () => {
    const config = makeConfig()
    const { store, pipeline } = setup(config)
    const broadcaster = new Broadcaster()
    const app = await createServer({ store, pipeline, config, broadcaster, webDir: "/nonexistent" })
    closers.push(() => {
      void app.close()
      store.close()
    })

    const response = await app.inject({ method: "GET", url: "/health", headers: { host: "evil.example.com" } })
    expect(response.statusCode).toBe(403)
  })

  it("exposes host capabilities so the UI can state its limits", async () => {
    const config = makeConfig()
    const { store, pipeline } = setup(config)
    const broadcaster = new Broadcaster()
    const app = await createServer({ store, pipeline, config, broadcaster, webDir: "/nonexistent" })
    closers.push(() => {
      void app.close()
      store.close()
    })

    const body = (await app.inject({ method: "GET", url: "/v1/bootstrap" })).json()
    expect(body.token).toBe(config.token)
    expect(body.hosts.map((host: { host: string }) => host.host).sort()).toEqual([
      "claude",
      "codex",
      "copilot",
      "opencode",
    ])
  })
})
