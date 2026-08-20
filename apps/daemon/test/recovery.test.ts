import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Store } from "@observer-ai/storage"
import { Broadcaster, CopilotTailer, DEFAULT_CONFIG, Pipeline, drainSpool } from "@observer-ai/daemon"

let home: string
let store: Store
let pipeline: Pipeline

const config = { ...DEFAULT_CONFIG, token: "t" }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "observer-test-"))
  process.env["OBSERVER_HOME"] = home
  store = new Store({ path: ":memory:" })
  pipeline = new Pipeline({ store, config, onChanges: () => undefined })
})

afterEach(() => {
  store.close()
  delete process.env["OBSERVER_HOME"]
  delete process.env["COPILOT_HOME"]
  rmSync(home, { recursive: true, force: true })
})

describe("spool recovery", () => {
  it("replays deliveries captured while the daemon was down", () => {
    mkdirSync(join(home, "spool"), { recursive: true })
    const lines = [
      JSON.stringify({
        host: "claude",
        event: "SessionStart",
        deliveryId: "d1",
        workspaceRoot: "/repo",
        payload: { session_id: "s1", model: "claude-opus-5" },
      }),
      "not json",
      JSON.stringify({ host: "nope", event: "X", deliveryId: "d2", payload: {} }),
    ]
    writeFileSync(join(home, "spool", "2026-01-01.jsonl"), `${lines.join("\n")}\n`)

    const result = drainSpool(pipeline)

    expect(result.accepted).toBe(1)
    expect(store.listSessions()[0]?.model).toBe("claude-opus-5")
  })

  it("is safe to run twice on the same data", () => {
    mkdirSync(join(home, "spool"), { recursive: true })
    const line = JSON.stringify({
      host: "claude",
      event: "SessionStart",
      deliveryId: "d1",
      workspaceRoot: "/repo",
      payload: { session_id: "s1" },
    })
    writeFileSync(join(home, "spool", "a.jsonl"), `${line}\n`)
    drainSpool(pipeline)

    // Simulate the same delivery being spooled again after a crash.
    writeFileSync(join(home, "spool", "b.jsonl"), `${line}\n`)
    const second = drainSpool(pipeline)

    expect(second.accepted).toBe(0)
    expect(second.duplicates).toBe(1)
    expect(store.listSessions()).toHaveLength(1)
  })

  it("does nothing when there is no spool directory", () => {
    expect(drainSpool(pipeline)).toEqual({ files: 0, accepted: 0, duplicates: 0 })
  })
})

describe("Copilot session log tailer", () => {
  function writeLog(sessionKey: string, lines: string[]): void {
    const dir = join(home, "copilot", "session-state", sessionKey)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "events.jsonl"), `${lines.join("\n")}\n`)
  }

  function seedSession(sessionKey: string): void {
    pipeline.ingestHook({
      host: "copilot",
      event: "sessionStart",
      deliveryId: "seed",
      workspaceRoot: "/repo",
      payload: { sessionId: sessionKey, timestamp: Date.now() },
    })
  }

  it("recovers main-agent replies that hooks never expose", () => {
    process.env["COPILOT_HOME"] = join(home, "copilot")
    seedSession("cs1")
    writeLog("cs1", [
      JSON.stringify({
        id: "e1",
        timestamp: new Date().toISOString(),
        type: "assistant.message",
        data: { messageId: "m1", content: "Here is the fix." },
      }),
      JSON.stringify({
        id: "e2",
        timestamp: new Date().toISOString(),
        type: "assistant.usage",
        data: { model: "gpt-5.4" },
      }),
    ])

    const tailer = new CopilotTailer(store, pipeline, 10_000)
    expect(tailer.tick()).toBe(2)

    const agent = store.listAgents("copilot:cs1")[0]!
    expect(store.listMessages(agent.id)[0]?.text).toBe("Here is the fix.")
    expect(agent.model).toBe("gpt-5.4")
    expect(agent.modelConfidence).toBe("reconciled")
  })

  it("skips subagent-originated and ephemeral entries", () => {
    process.env["COPILOT_HOME"] = join(home, "copilot")
    seedSession("cs2")
    writeLog("cs2", [
      JSON.stringify({ id: "e1", type: "assistant.message", agentId: "sub", data: { content: "sub text" } }),
      JSON.stringify({ id: "e2", type: "assistant.message_delta", ephemeral: true, data: { deltaContent: "x" } }),
    ])

    const tailer = new CopilotTailer(store, pipeline, 10_000)
    expect(tailer.tick()).toBe(0)
  })

  it("only reads newly appended lines on the next pass", () => {
    process.env["COPILOT_HOME"] = join(home, "copilot")
    seedSession("cs3")
    const first = JSON.stringify({ id: "e1", type: "assistant.message", data: { messageId: "m1", content: "one" } })
    writeLog("cs3", [first])

    const tailer = new CopilotTailer(store, pipeline, 10_000)
    expect(tailer.tick()).toBe(1)
    expect(tailer.tick()).toBe(0)

    writeLog("cs3", [
      first,
      JSON.stringify({ id: "e2", type: "assistant.message", data: { messageId: "m2", content: "two" } }),
    ])
    expect(tailer.tick()).toBe(1)
  })
})

describe("Broadcaster integration", () => {
  it("publishes reducer output to connected clients", () => {
    const broadcaster = new Broadcaster()
    const received: string[] = []
    broadcaster.add({ send: (data) => received.push(data), close: () => undefined })

    const local = new Pipeline({ store, config, onChanges: (changes) => broadcaster.publish(changes) })
    local.ingestHook({
      host: "codex",
      event: "SessionStart",
      deliveryId: "d",
      workspaceRoot: "/repo",
      payload: { session_id: "s1", model: "gpt-5.3-codex" },
    })

    expect(received).toHaveLength(1)
    expect(JSON.parse(received[0]!).type).toBe("changes")
  })
})
