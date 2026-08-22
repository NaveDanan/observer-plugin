import { describe, expect, it } from "vitest"
import { MemoryStore, reduce } from "@observer-ai/core"
import { MAIN_AGENT_KEY, agentId, sessionId } from "@observer-ai/protocol"
import type { EventBody, StoredEvent } from "@observer-ai/protocol"

let sequence = 0

function event(body: EventBody, overrides: Partial<StoredEvent> = {}): StoredEvent {
  sequence++
  return {
    id: `e${sequence}`,
    seq: sequence,
    host: "claude",
    adapter: "test",
    workspaceRoot: "/work",
    sessionKey: "s1",
    agentKey: MAIN_AGENT_KEY,
    at: 1_000 + sequence,
    receivedAt: 1_000 + sequence,
    provenance: "authoritative",
    body,
    ...overrides,
  }
}

const SESSION = sessionId("claude", "s1")
const MAIN = agentId(SESSION, MAIN_AGENT_KEY)

describe("reduce", () => {
  it("creates a session and a root agent from any first event", () => {
    const store = new MemoryStore()
    reduce(store, event({ kind: "message.user", messageKey: "m1", text: "hello" }))

    expect(store.getSession(SESSION)?.status).toBe("active")
    expect(store.getAgent(MAIN)?.agentType).toBe("main")
  })

  it("is idempotent: replaying the same event changes nothing", () => {
    const store = new MemoryStore()
    const started = event({ kind: "agent.started", agentType: "Explore", parentAgentKey: MAIN_AGENT_KEY }, {
      agentKey: "agent:a1",
    })

    reduce(store, started)
    const first = structuredClone(store.agents.get(agentId(SESSION, "agent:a1")))
    reduce(store, started)
    const second = store.agents.get(agentId(SESSION, "agent:a1"))

    expect(second).toEqual(first)
    expect(store.listAgents(SESSION)).toHaveLength(2)
    expect(store.listEdges(SESSION)).toHaveLength(1)
  })

  it("tolerates a child arriving before its parent edge is known", () => {
    const store = new MemoryStore()
    // Subagent reports in first; the spawn is only reconciled afterwards.
    reduce(store, event({ kind: "agent.started", agentType: "Explore" }, { agentKey: "agent:a1" }))
    expect(store.agents.get(agentId(SESSION, "agent:a1"))?.parentAgentId).toBeNull()

    reduce(
      store,
      event(
        { kind: "edge.observed", fromAgentKey: MAIN_AGENT_KEY, toAgentKey: "agent:a1", edgeType: "spawned" },
        { provenance: "reconciled" },
      ),
    )

    expect(store.agents.get(agentId(SESSION, "agent:a1"))?.parentAgentId).toBe(MAIN)
    expect(store.listEdges(SESSION)[0]?.provenance).toBe("reconciled")
  })

  it("never downgrades edge provenance", () => {
    const store = new MemoryStore()
    const spawn = { kind: "edge.observed", fromAgentKey: MAIN_AGENT_KEY, toAgentKey: "a", edgeType: "spawned" } as const

    reduce(store, event(spawn, { provenance: "authoritative" }))
    reduce(store, event(spawn, { provenance: "inferred" }))

    expect(store.listEdges(SESSION)[0]?.provenance).toBe("authoritative")
  })

  it("accumulates streaming deltas and clears the streaming flag on the last chunk", () => {
    const store = new MemoryStore()
    reduce(store, event({ kind: "message.assistant.delta", messageKey: "m1", delta: "Hello" }))
    reduce(store, event({ kind: "message.assistant.delta", messageKey: "m1", delta: " world", final: true }))

    const message = store.listMessages(MAIN)[0]
    expect(message?.text).toBe("Hello world")
    expect(message?.streaming).toBe(false)
  })

  it("keeps captured text when a later event carries none", () => {
    const store = new MemoryStore()
    reduce(store, event({ kind: "message.assistant", messageKey: "m1", text: "answer", final: true }))
    reduce(store, event({ kind: "message.assistant", messageKey: "m1", text: "", final: true }))

    expect(store.listMessages(MAIN)[0]?.text).toBe("answer")
  })

  it("derives the session goal from the first user prompt only", () => {
    const store = new MemoryStore()
    reduce(store, event({ kind: "message.user", messageKey: "m1", text: "Fix the login bug" }))
    reduce(store, event({ kind: "message.user", messageKey: "m2", text: "Also update docs" }))

    expect(store.getSession(SESSION)?.goal).toBe("Fix the login bug")
    expect(store.getSession(SESSION)?.goalStatus).toBe("derived")
  })

  it("prefers a host-reported goal over the derived one", () => {
    const store = new MemoryStore()
    reduce(store, event({ kind: "message.user", messageKey: "m1", text: "Fix the login bug" }))
    reduce(store, event({ kind: "goal.updated", objective: "Ship auth v2", source: "task_complete" }))

    expect(store.getSession(SESSION)?.goal).toBe("Ship auth v2")
    expect(store.getSession(SESSION)?.goalStatus).toBe("task_complete")
  })

  it("replaces the todo list wholesale and reports removals", () => {
    const store = new MemoryStore()
    reduce(
      store,
      event({
        kind: "todos.updated",
        todos: [
          { content: "a", status: "completed" },
          { content: "b", status: "pending" },
        ],
      }),
    )
    const changes = reduce(store, event({ kind: "todos.updated", todos: [{ content: "a", status: "completed" }] }))

    expect(store.listTodos(MAIN)).toHaveLength(1)
    expect(changes.filter((change) => change.op === "delete")).toHaveLength(1)
  })

  it("pairs tool start and finish into one row even when results arrive first", () => {
    const store = new MemoryStore()
    reduce(store, event({ kind: "tool.finished", callId: "c1", tool: "Bash", ok: true, output: "done" }))
    reduce(store, event({ kind: "tool.started", callId: "c1", tool: "Bash", input: { command: "ls" } }))

    const calls = store.listToolCalls(MAIN)
    expect(calls).toHaveLength(1)
    // A late "started" must not resurrect a finished call.
    expect(calls[0]?.status).toBe("ok")
    expect(calls[0]?.output).toBe("done")
  })

  it("marks unconfirmed agents idle when the session ends, never completed", () => {
    const store = new MemoryStore()
    reduce(store, event({ kind: "agent.started", agentType: "Explore" }, { agentKey: "agent:a1" }))
    reduce(store, event({ kind: "session.ended", reason: "clear" }))

    expect(store.getSession(SESSION)?.status).toBe("ended")
    expect(store.agents.get(agentId(SESSION, "agent:a1"))?.status).toBe("idle")
  })

  it("does not revive a terminal agent with a later status update", () => {
    const store = new MemoryStore()
    reduce(store, event({ kind: "agent.stopped", status: "completed" }, { agentKey: "agent:a1" }))
    reduce(store, event({ kind: "agent.status", status: "running" }, { agentKey: "agent:a1" }))

    expect(store.agents.get(agentId(SESSION, "agent:a1"))?.status).toBe("completed")
  })

  // The plugin reports a finished delegation as agent.status completed/failed;
  // the host's own session.idle for the child may still arrive afterwards, in
  // either order. These pin the guard those deliveries rely on.
  it("keeps a completed agent terminal when a late idle reports after it", () => {
    const store = new MemoryStore()
    reduce(store, event({ kind: "agent.started", agentType: "Explore" }, { agentKey: "agent:a1" }))
    reduce(store, event({ kind: "agent.status", status: "completed" }, { agentKey: "agent:a1" }))
    reduce(store, event({ kind: "agent.status", status: "idle" }, { agentKey: "agent:a1" }))

    expect(store.agents.get(agentId(SESSION, "agent:a1"))?.status).toBe("completed")
  })

  it("still upgrades an idle agent to completed", () => {
    const store = new MemoryStore()
    reduce(store, event({ kind: "agent.started", agentType: "Explore" }, { agentKey: "agent:a1" }))
    reduce(store, event({ kind: "agent.status", status: "idle" }, { agentKey: "agent:a1" }))
    reduce(store, event({ kind: "agent.status", status: "completed" }, { agentKey: "agent:a1" }))

    expect(store.agents.get(agentId(SESSION, "agent:a1"))?.status).toBe("completed")
  })

  it("makes failed stick against later non-terminal statuses like completed does", () => {
    const store = new MemoryStore()
    reduce(store, event({ kind: "agent.started", agentType: "Explore" }, { agentKey: "agent:a1" }))
    reduce(store, event({ kind: "agent.status", status: "failed" }, { agentKey: "agent:a1" }))
    reduce(store, event({ kind: "agent.status", status: "idle" }, { agentKey: "agent:a1" }))
    reduce(store, event({ kind: "agent.status", status: "running" }, { agentKey: "agent:a1" }))

    expect(store.agents.get(agentId(SESSION, "agent:a1"))?.status).toBe("failed")
  })

  it("collapses repeated writes to one change per row", () => {
    const store = new MemoryStore()
    const changes = reduce(store, event({ kind: "session.started", title: "t", model: "m", cwd: "/w" }))
    const sessionChanges = changes.filter((change) => change.table === "session")

    expect(sessionChanges).toHaveLength(1)
  })
})
