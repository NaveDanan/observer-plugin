import { describe, expect, it } from "vitest"
import { Store } from "@observer-ai/storage"
import { agentId, sessionId } from "@observer-ai/protocol"
import type { IngestEvent } from "@observer-ai/protocol"

function store(): Store {
  return new Store({ path: ":memory:", retentionDays: 30 })
}

function ingest(overrides: Partial<IngestEvent> & { id: string; at: number }): IngestEvent & { id: string; at: number } {
  return {
    host: "codex",
    adapter: "test",
    workspaceRoot: "/work",
    sessionKey: "s1",
    agentKey: "main",
    provenance: "authoritative",
    body: { kind: "session.status", status: "active" },
    ...overrides,
  }
}

describe("Store", () => {
  it("applies migrations on a fresh database", () => {
    const db = store()
    expect(db.cursor()).toBe(0)
    expect(db.listSessions()).toEqual([])
    db.close()
  })

  it("assigns increasing sequences and rejects duplicate ids", () => {
    const db = store()
    const first = db.appendEvent(ingest({ id: "a", at: 1 }))
    const second = db.appendEvent(ingest({ id: "b", at: 2 }))
    const replay = db.appendEvent(ingest({ id: "a", at: 1 }))

    expect(first?.seq).toBe(1)
    expect(second?.seq).toBe(2)
    expect(replay).toBeUndefined()
    expect(db.countEvents()).toBe(2)
    db.close()
  })

  it("round-trips every entity type", () => {
    const db = store()
    const session = sessionId("codex", "s1")
    const agent = agentId(session, "main")
    const now = 1_000

    db.putSession({
      id: session,
      host: "codex",
      hostVersion: "1.2.3",
      sessionKey: "s1",
      workspaceRoot: "/work",
      title: "title",
      status: "active",
      model: "gpt-5",
      goal: "do things",
      goalStatus: "derived",
      cwd: "/work",
      startedAt: now,
      endedAt: null,
      updatedAt: now,
      lastEventSeq: 3,
    })
    db.putAgent({
      id: agent,
      sessionId: session,
      agentKey: "main",
      agentType: "main",
      displayName: null,
      parentAgentId: null,
      status: "running",
      model: "gpt-5",
      modelConfidence: "authoritative",
      description: null,
      delegationPrompt: null,
      summary: null,
      startedAt: now,
      endedAt: null,
      updatedAt: now,
      totalTokens: 42,
      durationMs: null,
    })
    db.putToolCall({
      id: `${agent}~t:1`,
      sessionId: session,
      agentId: agent,
      callId: "1",
      tool: "bash",
      title: null,
      input: { command: "ls" },
      output: "a",
      error: null,
      status: "ok",
      startedAt: now,
      endedAt: now + 5,
      durationMs: 5,
    })
    db.replaceTodos(agent, [
      {
        id: `${agent}~todo:0`,
        sessionId: session,
        agentId: agent,
        position: 0,
        content: "step",
        status: "pending",
        originalStatus: "pending",
        priority: null,
        updatedAt: now,
      },
    ])

    expect(db.getSession(session)?.goal).toBe("do things")
    expect(db.getAgentByKey(session, "main")?.totalTokens).toBe(42)
    expect(db.listToolCalls(agent)[0]?.input).toEqual({ command: "ls" })
    expect(db.listTodos(agent)).toHaveLength(1)
    db.close()
  })

  it("replaces todos rather than accumulating them", () => {
    const db = store()
    const session = sessionId("codex", "s1")
    const agent = agentId(session, "main")
    const base = { sessionId: session, agentId: agent, originalStatus: null, priority: null, updatedAt: 1 }

    db.replaceTodos(agent, [
      { ...base, id: `${agent}~todo:0`, position: 0, content: "a", status: "pending" },
      { ...base, id: `${agent}~todo:1`, position: 1, content: "b", status: "pending" },
    ])
    db.replaceTodos(agent, [{ ...base, id: `${agent}~todo:0`, position: 0, content: "a", status: "completed" }])

    const todos = db.listTodos(agent)
    expect(todos).toHaveLength(1)
    expect(todos[0]?.status).toBe("completed")
    db.close()
  })

  it("deletes a session and all of its data", () => {
    const db = store()
    const session = sessionId("codex", "s1")
    db.appendEvent(ingest({ id: "a", at: 1 }))
    db.putSession({
      id: session,
      host: "codex",
      hostVersion: null,
      sessionKey: "s1",
      workspaceRoot: "/work",
      title: null,
      status: "active",
      model: null,
      goal: null,
      goalStatus: null,
      cwd: null,
      startedAt: 1,
      endedAt: null,
      updatedAt: 1,
      lastEventSeq: 1,
    })

    db.deleteSession(session)

    expect(db.getSession(session)).toBeUndefined()
    expect(db.countEvents()).toBe(0)
    db.close()
  })

  it("prunes only finished sessions past the retention window", () => {
    const db = new Store({ path: ":memory:", retentionDays: 1 })
    const old = Date.now() - 5 * 24 * 60 * 60 * 1000
    const base = {
      host: "codex" as const,
      hostVersion: null,
      workspaceRoot: "/work",
      title: null,
      model: null,
      goal: null,
      goalStatus: null,
      cwd: null,
      endedAt: null,
      lastEventSeq: 0,
    }
    db.putSession({ ...base, id: "codex:old", sessionKey: "old", status: "ended", startedAt: old, updatedAt: old })
    db.putSession({ ...base, id: "codex:live", sessionKey: "live", status: "active", startedAt: old, updatedAt: old })

    expect(db.prune()).toBe(1)
    expect(db.getSession("codex:old")).toBeUndefined()
    expect(db.getSession("codex:live")).toBeDefined()
    db.close()
  })

  it("counts activity per agent without loading rows", () => {
    const db = store()
    const session = sessionId("codex", "s1")
    const agent = agentId(session, "main")
    const other = agentId(session, "agent:a1")
    const now = 1_000
    const baseAgent = {
      sessionId: session,
      agentType: "main",
      displayName: null,
      parentAgentId: null,
      status: "running" as const,
      model: null,
      modelConfidence: null,
      description: null,
      delegationPrompt: null,
      summary: null,
      startedAt: now,
      endedAt: null,
      updatedAt: now,
      totalTokens: null,
      durationMs: null,
    }
    db.putAgent({ ...baseAgent, id: agent, agentKey: "main" })
    db.putAgent({ ...baseAgent, id: other, agentKey: "agent:a1" })
    db.putMessage({
      id: `${agent}~m:1`,
      sessionId: session,
      agentId: agent,
      role: "user",
      messageKey: "1",
      text: "hi",
      streaming: false,
      createdAt: now,
      updatedAt: now,
      seq: 1,
    })
    db.putToolCall({
      id: `${agent}~t:1`,
      sessionId: session,
      agentId: agent,
      callId: "1",
      tool: "bash",
      title: null,
      input: null,
      output: null,
      error: null,
      status: "ok",
      startedAt: now,
      endedAt: now,
      durationMs: 0,
    })

    const counts = db.countsByAgent(session)

    expect(counts[agent]).toEqual({ messages: 1, toolCalls: 1, todos: 0 })
    // Agents with no activity still appear, so every node can show a total.
    expect(counts[other]).toEqual({ messages: 0, toolCalls: 0, todos: 0 })
    db.close()
  })

  it("survives session keys containing colons", () => {
    const db = store()
    const key = "project:branch:1"
    db.appendEvent(ingest({ id: "x", at: 1, sessionKey: key }))
    expect(db.listRawEvents(sessionId("codex", key))).toHaveLength(1)
    db.close()
  })

  it("returns the running tool per agent", () => {
    const db = store()
    const session = sessionId("codex", "s1")
    const agent = agentId(session, "main")
    const other = agentId(session, "agent:a1")
    const now = 1_000
    db.putAgent({
      sessionId: session,
      id: agent,
      agentKey: "main",
      agentType: "main",
      displayName: null,
      parentAgentId: null,
      status: "running",
      model: null,
      modelConfidence: null,
      description: null,
      delegationPrompt: null,
      summary: null,
      startedAt: now,
      endedAt: null,
      updatedAt: now,
      totalTokens: null,
      durationMs: null,
    })
    db.putAgent({
      sessionId: session,
      id: other,
      agentKey: "agent:a1",
      agentType: "Explore",
      displayName: null,
      parentAgentId: agent,
      status: "running",
      model: null,
      modelConfidence: null,
      description: null,
      delegationPrompt: null,
      summary: null,
      startedAt: now,
      endedAt: null,
      updatedAt: now,
      totalTokens: null,
      durationMs: null,
    })
    db.putToolCall({
      id: `${agent}~t:1`,
      sessionId: session,
      agentId: agent,
      callId: "1",
      tool: "Bash",
      title: null,
      input: null,
      output: null,
      error: null,
      status: "running",
      startedAt: now,
      endedAt: null,
      durationMs: null,
    })
    db.putToolCall({
      id: `${other}~t:2`,
      sessionId: session,
      agentId: other,
      callId: "2",
      tool: "Grep",
      title: null,
      input: null,
      output: null,
      error: null,
      status: "ok",
      startedAt: now,
      endedAt: now + 10,
      durationMs: 10,
    })

    const running = db.runningToolsByAgent(session)
    expect(running[agent]?.tool).toBe("Bash")
    expect(running[other]).toBeNull()
    db.close()
  })
})
