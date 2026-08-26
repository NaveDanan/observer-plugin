import { describe, expect, it } from "vitest"
import { CHURN_MARKER_KEY, DEFAULT_REDACTION, MemoryStore, redactText, reduce } from "@observer-ai/core"
import { MAIN_AGENT_KEY, agentId, sessionId, toolCallId } from "@observer-ai/protocol"
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

  it("derives a missing subagent task title from its first user instruction", () => {
    const store = new MemoryStore()
    const childKey = "agent:a1"
    const childId = agentId(SESSION, childKey)
    reduce(store, event({ kind: "agent.started", agentType: "subagent", parentAgentKey: MAIN_AGENT_KEY }, { agentKey: childKey }))
    reduce(store, event({ kind: "message.user", messageKey: "child-1", text: "Trace the payment failure." }, { agentKey: childKey }))
    reduce(store, event({ kind: "message.user", messageKey: "child-2", text: "Also check retries." }, { agentKey: childKey }))

    expect(store.getAgent(childId)?.description).toBe("Trace the payment failure.")
  })

  it("updates a harness title without changing the session status", () => {
    const store = new MemoryStore()
    reduce(store, event({ kind: "session.status", status: "idle" }))
    reduce(store, event({ kind: "session.title", title: "Fix inherited sidebar titles" }))

    expect(store.getSession(SESSION)).toMatchObject({
      title: "Fix inherited sidebar titles",
      status: "idle",
    })
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

  it("resumes an interrupted subagent under the same stable id and keeps its context", () => {
    const store = new MemoryStore()
    const key = "session:child"
    reduce(
      store,
      event({ kind: "agent.started", agentType: "malik-johnson", runtimeId: "child", prompt: "original context" }, { agentKey: key }),
    )
    reduce(store, event({ kind: "message.assistant", messageKey: "m1", text: "partial work" }, { agentKey: key }))
    reduce(store, event({ kind: "agent.stopped", status: "interrupted" }, { agentKey: key }))
    reduce(
      store,
      event({ kind: "agent.started", agentType: "malik-johnson", runtimeId: "child", resumed: true }, { agentKey: key }),
    )

    const id = agentId(SESSION, key)
    expect(store.getAgent(id)).toMatchObject({ runtimeId: "child", status: "running", endedAt: null })
    expect(store.listMessages(id)[0]?.text).toBe("partial work")
    expect(store.getAgent(id)?.delegationPrompt).toBe("original context")
  })

  it("reopens a failed subagent only when the host explicitly resumes it", () => {
    const store = new MemoryStore()
    const key = "session:child"
    reduce(store, event({ kind: "agent.stopped", status: "failed" }, { agentKey: key }))
    reduce(
      store,
      event({ kind: "agent.started", agentType: "malik-johnson", runtimeId: "child", resumed: true }, { agentKey: key }),
    )
    expect(store.getAgent(agentId(SESSION, key))).toMatchObject({ runtimeId: "child", status: "running", endedAt: null })
  })

  it("reopens a completed subagent when task_id explicitly continues its context", () => {
    const store = new MemoryStore()
    const key = "session:child"
    reduce(store, event({ kind: "agent.stopped", status: "completed" }, { agentKey: key }))
    reduce(
      store,
      event({ kind: "agent.started", agentType: "malik-johnson", runtimeId: "child", resumed: true }, { agentKey: key }),
    )
    expect(store.getAgent(agentId(SESSION, key))).toMatchObject({ runtimeId: "child", status: "running", endedAt: null })
  })

  it("records direct peer messaging without changing parentage", () => {
    const store = new MemoryStore()
    reduce(
      store,
      event({ kind: "agent.started", agentType: "one", parentAgentKey: MAIN_AGENT_KEY }, { agentKey: "session:a" }),
    )
    reduce(
      store,
      event({ kind: "agent.started", agentType: "two", parentAgentKey: MAIN_AGENT_KEY }, { agentKey: "session:b" }),
    )
    const before = store.getAgent(agentId(SESSION, "session:b"))?.parentAgentId
    reduce(
      store,
      event({
        kind: "edge.observed",
        fromAgentKey: "session:a",
        toAgentKey: "session:b",
        edgeType: "messaged",
      }),
    )

    expect(store.listEdges(SESSION).some((edge) => edge.edgeType === "messaged")).toBe(true)
    expect(store.getAgent(agentId(SESSION, "session:b"))?.parentAgentId).toBe(before)
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
// Churn is an accumulating field, so every guarantee here is about a number
// that must not drift: not upward on a replay, not downward on a stale
// redelivery, and never into existence at all for a side nobody stated.
describe("reduce: code churn", () => {
  const MAIN_CALL = toolCallId(MAIN, "c1")

  /** One completed tool call, start then finish, as a host normally delivers it. */
  function call(callId: string, tool: string, input: unknown, agentKey = MAIN_AGENT_KEY) {
    return [
      event({ kind: "tool.started", callId, tool, input }, { agentKey }),
      event({ kind: "tool.finished", callId, tool, ok: true, output: "ok" }, { agentKey }),
    ] as const
  }

  const edit = (callId: string, input: unknown, agentKey = MAIN_AGENT_KEY) =>
    call(callId, "edit", input, agentKey)

  /** The normalized marker an adapter must emit for host-stated churn. */
  const stated = (churn: Record<string, unknown>) => JSON.stringify({ [CHURN_MARKER_KEY]: churn })

  it("counts lines added and removed from an edit's arguments, as inferred", () => {
    const store = new MemoryStore()
    for (const e of edit("c1", { filePath: "/a.ts", oldString: "one\ntwo", newString: "1\n2\n3" })) reduce(store, e)

    const agent = store.getAgent(MAIN)
    expect(agent?.linesAdded).toBe(3)
    expect(agent?.linesRemoved).toBe(2)
    // Arguments say what was asked for, never what the file ended up as.
    expect(agent?.churnConfidence).toBe("inferred")
  })

  // The guarantee the whole design exists for: the spool replays after a crash,
  // hooks retry, and the Copilot tailer re-reads file regions.
  it("does not double-count when the same tool-result event is applied twice", () => {
    const store = new MemoryStore()
    const [started, finished] = edit("c1", { oldString: "a\nb\nc", newString: "x" })

    reduce(store, started)
    reduce(store, finished)
    const once = structuredClone(store.getAgent(MAIN))

    reduce(store, finished)
    reduce(store, finished)
    reduce(store, started)

    expect(store.getAgent(MAIN)?.linesAdded).toBe(once?.linesAdded)
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(once?.linesRemoved)
    expect(store.getAgent(MAIN)?.linesAdded).toBe(1)
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(3)
  })

  it("counts each distinct tool call id once and sums them", () => {
    const store = new MemoryStore()
    for (const e of edit("c1", { oldString: "a", newString: "b\nc" })) reduce(store, e)
    for (const e of edit("c2", { oldString: "d\ne", newString: "f" })) reduce(store, e)

    expect(store.getAgent(MAIN)?.linesAdded).toBe(3)
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(3)
  })

  it("contributes nothing when the tool result states no churn", () => {
    const store = new MemoryStore()
    // An edit whose arguments never reached the reducer: the result is all we
    // have, and it says nothing about lines.
    reduce(store, event({ kind: "tool.finished", callId: "c1", tool: "edit", ok: true, output: "done" }))
    // And a tool that is not a file edit at all.
    reduce(store, event({ kind: "tool.started", callId: "c2", tool: "bash", input: { command: "sed -i s/a/b/ f" } }))
    reduce(store, event({ kind: "tool.finished", callId: "c2", tool: "bash", ok: true, output: "" }))

    const agent = store.getAgent(MAIN)
    // Absent, not zero: "read some files" must not render as "+0 -0".
    expect(agent?.linesAdded).toBeUndefined()
    expect(agent?.linesRemoved).toBeUndefined()
    expect(agent?.churnConfidence).toBeUndefined()
    // The ledger must stay unmarked too, or a later fuller delivery is blocked.
    expect(store.getToolCall(MAIN_CALL)?.linesAdded).toBeUndefined()
    expect(store.getToolCall(MAIN_CALL)?.churnConfidence).toBeUndefined()
    expect(store.getToolCall(toolCallId(MAIN, "c2"))?.linesAdded).toBeUndefined()
  })

  it("records zero on both the ledger and the total for an edit that changed nothing", () => {
    const store = new MemoryStore()
    // Both strings were *stated*, and both are empty. That is a measurement.
    for (const e of edit("c1", { oldString: "", newString: "" })) reduce(store, e)

    expect(store.getAgent(MAIN)?.linesAdded).toBe(0)
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(0)
    // Marking the ledger is what stops the zero being re-credited forever.
    expect(store.getToolCall(MAIN_CALL)?.linesAdded).toBe(0)
    expect(store.getToolCall(MAIN_CALL)?.churnConfidence).toBe("inferred")
  })

  it("counts an edit whose arguments arrive after its result", () => {
    const store = new MemoryStore()
    const [started, finished] = edit("c1", { oldString: "a\nb", newString: "c" })

    // Order tolerance: the result lands first, with nothing to count.
    reduce(store, finished)
    expect(store.getAgent(MAIN)?.linesAdded).toBeUndefined()

    reduce(store, started)
    expect(store.getAgent(MAIN)?.linesAdded).toBe(1)
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(2)

    // …and the late start is itself replayable.
    reduce(store, started)
    reduce(store, finished)
    expect(store.getAgent(MAIN)?.linesAdded).toBe(1)
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(2)
  })

  it("ignores a failed edit but still counts it if it later succeeds", () => {
    const store = new MemoryStore()
    reduce(store, event({ kind: "tool.started", callId: "c1", tool: "edit", input: { oldString: "a", newString: "b" } }))
    reduce(store, event({ kind: "tool.finished", callId: "c1", tool: "edit", ok: false, error: "not found" }))
    expect(store.getAgent(MAIN)?.linesAdded).toBeUndefined()

    reduce(store, event({ kind: "tool.finished", callId: "c1", tool: "edit", ok: true, output: "ok" }))
    expect(store.getAgent(MAIN)?.linesAdded).toBe(1)
  })

  // ---------------------------------------------------------------- P1-1
  // Better evidence must be able to land, exactly once; worse evidence must not.

  it("completes a half-stated term when the missing side arrives later", () => {
    const store = new MemoryStore()
    // First delivery states only what was removed.
    reduce(store, event({ kind: "tool.started", callId: "c1", tool: "edit", input: { oldString: "a\nb" } }))
    reduce(store, event({ kind: "tool.finished", callId: "c1", tool: "edit", ok: true, output: "ok" }))

    expect(store.getAgent(MAIN)?.linesRemoved).toBe(2)
    // The additions side was never stated, so it stays absent rather than +0.
    expect(store.getAgent(MAIN)?.linesAdded).toBeUndefined()

    // A fuller redelivery of the same call id supplies the other half.
    reduce(store, event({ kind: "tool.started", callId: "c1", tool: "edit", input: { newString: "x\ny\nz" } }))

    expect(store.getAgent(MAIN)?.linesAdded).toBe(3)
    // …without the already-credited side being added a second time.
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(2)
  })

  it("upgrades an inferred term to host-stated counts without adding the edit twice", () => {
    const store = new MemoryStore()
    for (const e of edit("c1", { oldString: "a", newString: "b" })) reduce(store, e)
    expect(store.getAgent(MAIN)?.linesAdded).toBe(1)
    expect(store.getToolCall(MAIN_CALL)?.churnConfidence).toBe("inferred")

    // The host now reports the real figures for the same call.
    reduce(
      store,
      event({
        kind: "tool.finished",
        callId: "c1",
        tool: "edit",
        ok: true,
        output: stated({ linesAdded: 10, linesRemoved: 4 }),
      }),
    )

    // Replaced, not added: 1 + 10 would be 11.
    expect(store.getAgent(MAIN)?.linesAdded).toBe(10)
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(4)
    expect(store.getToolCall(MAIN_CALL)?.churnConfidence).toBe("authoritative")

    // And the upgrade is itself idempotent.
    reduce(
      store,
      event({
        kind: "tool.finished",
        callId: "c1",
        tool: "edit",
        ok: true,
        output: stated({ linesAdded: 10, linesRemoved: 4 }),
      }),
    )
    expect(store.getAgent(MAIN)?.linesAdded).toBe(10)
  })

  it("keeps the stronger term when a weaker delivery follows it", () => {
    const store = new MemoryStore()
    reduce(store, event({ kind: "tool.started", callId: "c1", tool: "edit", input: { oldString: "a", newString: "b" } }))
    reduce(
      store,
      event({ kind: "tool.finished", callId: "c1", tool: "edit", ok: true, output: stated({ linesAdded: 9, linesRemoved: 2 }) }),
    )
    expect(store.getAgent(MAIN)?.linesAdded).toBe(9)

    // A later redelivery whose output no longer carries the marker, so the
    // reducer genuinely falls back to the arguments and produces an *inferred*
    // term. It must not overwrite host-stated figures.
    reduce(store, event({ kind: "tool.started", callId: "c1", tool: "edit", input: { newString: "q\nr\ns" } }))
    reduce(store, event({ kind: "tool.finished", callId: "c1", tool: "edit", ok: true, output: "ok" }))
    expect(store.getToolCall(MAIN_CALL)?.output).toBe("ok")

    expect(store.getAgent(MAIN)?.linesAdded).toBe(9)
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(2)
    expect(store.getToolCall(MAIN_CALL)?.churnConfidence).toBe("authoritative")
  })

  it("holds the total steady under a long run of conflicting redeliveries", () => {
    const store = new MemoryStore()
    const args = event({ kind: "tool.started", callId: "c1", tool: "edit", input: { oldString: "a\nb", newString: "c" } })
    const plain = event({ kind: "tool.finished", callId: "c1", tool: "edit", ok: true, output: "ok" })
    const marked = event({
      kind: "tool.finished",
      callId: "c1",
      tool: "edit",
      ok: true,
      output: stated({ linesAdded: 8, linesRemoved: 5 }),
    })
    const failed = event({ kind: "tool.finished", callId: "c1", tool: "edit", ok: false, error: "stale" })

    // Every ordering a retrying hook and a re-reading tailer can produce.
    for (const e of [args, plain, marked, plain, failed, args, marked, plain, args]) reduce(store, e)

    // The host-stated term wins and is credited exactly once, whatever the
    // order or the count of deliveries.
    expect(store.getAgent(MAIN)?.linesAdded).toBe(8)
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(5)
    expect(store.getToolCall(MAIN_CALL)?.status).toBe("ok")
  })

  it("reports a term as inferred while any credited side is still a guess", () => {
    const store = new MemoryStore()
    // Inferred removals land first.
    reduce(store, event({ kind: "tool.started", callId: "c1", tool: "edit", input: { oldString: "a\nb\nc" } }))
    reduce(store, event({ kind: "tool.finished", callId: "c1", tool: "edit", ok: true, output: "ok" }))
    // Then the host states only the additions side.
    reduce(
      store,
      event({ kind: "tool.finished", callId: "c1", tool: "edit", ok: true, output: stated({ linesAdded: 7 }) }),
    )

    expect(store.getAgent(MAIN)?.linesAdded).toBe(7)
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(3)
    // One authoritative side does not make the pair authoritative.
    expect(store.getToolCall(MAIN_CALL)?.churnConfidence).toBe("inferred")
  })

  it("keeps an agent's confidence at the weakest level ever credited", () => {
    const store = new MemoryStore()
    reduce(store, event({ kind: "tool.started", callId: "c1", tool: "edit", input: { oldString: "a", newString: "b" } }))
    reduce(
      store,
      event({ kind: "tool.finished", callId: "c1", tool: "edit", ok: true, output: stated({ linesAdded: 5, linesRemoved: 5 }) }),
    )
    expect(store.getAgent(MAIN)?.churnConfidence).toBe("authoritative")

    // One inferred contribution drags the whole total down, and it stays down:
    // recomputing an exact weakest would mean rescanning every call.
    for (const e of edit("c2", { oldString: "x", newString: "y" })) reduce(store, e)
    expect(store.getAgent(MAIN)?.churnConfidence).toBe("inferred")
  })

  it("treats a late failure as a stale redelivery, not an undo", () => {
    const store = new MemoryStore()
    for (const e of edit("c1", { oldString: "a\nb", newString: "c" })) reduce(store, e)
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(2)

    // A retried hook re-reports the call as failed, long after it succeeded.
    reduce(store, event({ kind: "tool.finished", callId: "c1", tool: "edit", ok: false, error: "stale" }))

    // The decision: ignore the downgrade. A duplicate must not erase captured
    // data, and no host reports a rollback this way.
    expect(store.getToolCall(MAIN_CALL)?.status).toBe("ok")
    expect(store.getToolCall(MAIN_CALL)?.error).toBeNull()
    expect(store.getAgent(MAIN)?.linesAdded).toBe(1)
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(2)
  })

  it("does not let a sparser redelivery overwrite richer captured arguments", () => {
    const store = new MemoryStore()
    reduce(
      store,
      event({ kind: "tool.started", callId: "c1", tool: "edit", input: { oldString: "a\nb\nc", newString: "x\ny" } }),
    )
    // A retry that lost a field. `??` alone would have replaced the whole object.
    reduce(store, event({ kind: "tool.started", callId: "c1", tool: "edit", input: { oldString: "a\nb\nc" } }))
    reduce(store, event({ kind: "tool.finished", callId: "c1", tool: "edit", ok: true, output: "ok" }))

    expect(store.getAgent(MAIN)?.linesAdded).toBe(2)
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(3)
  })

  it("never lets a late event decrease a count", () => {
    const store = new MemoryStore()
    for (const e of edit("c1", { oldString: "a\nb\nc", newString: "x\ny" })) reduce(store, e)

    reduce(store, event({ kind: "tool.started", callId: "c1", tool: "edit", input: undefined }))
    reduce(store, event({ kind: "tool.finished", callId: "c1", tool: "edit", ok: true }))

    expect(store.getAgent(MAIN)?.linesAdded).toBe(2)
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(3)
  })

  // ---------------------------------------------------------------- P1-2
  // An unknown side stays absent. Zero is only ever a measurement.

  it("counts a write as additions only, leaving the replaced side absent", () => {
    const store = new MemoryStore()
    for (const e of call("c1", "Write", { content: "a\nb\nc\n" })) reduce(store, e)

    // Trailing newline does not open a fourth line.
    expect(store.getAgent(MAIN)?.linesAdded).toBe(3)
    // A write reveals new content and nothing about what it replaced. `-0`
    // would be a fabricated half of a diff Observer never saw.
    expect(store.getAgent(MAIN)?.linesRemoved).toBeUndefined()
    expect(store.getToolCall(MAIN_CALL)?.linesRemoved).toBeUndefined()
  })

  it("still leaves the replaced side absent when a write overwrites a file", () => {
    const store = new MemoryStore()
    // Nothing in a write's arguments distinguishes a create from an overwrite,
    // which is precisely why the removed side cannot be reported as zero.
    for (const e of call("c1", "write", { filePath: "/existing.ts", content: "one\ntwo" })) reduce(store, e)

    expect(store.getAgent(MAIN)?.linesAdded).toBe(2)
    expect(store.getAgent(MAIN)?.linesRemoved).toBeUndefined()
  })

  it("leaves the removed side absent when only newString was stated", () => {
    const store = new MemoryStore()
    for (const e of edit("c1", { newString: "a\nb" })) reduce(store, e)

    expect(store.getAgent(MAIN)?.linesAdded).toBe(2)
    expect(store.getAgent(MAIN)?.linesRemoved).toBeUndefined()
  })

  it("leaves the added side absent when only oldString was stated", () => {
    const store = new MemoryStore()
    for (const e of edit("c1", { oldString: "a\nb\nc" })) reduce(store, e)

    expect(store.getAgent(MAIN)?.linesRemoved).toBe(3)
    expect(store.getAgent(MAIN)?.linesAdded).toBeUndefined()
  })

  it("sums a MultiEdit only over sides every entry stated", () => {
    const store = new MemoryStore()
    const input = {
      edits: [
        { old_string: "a", new_string: "b\nc" },
        { old_string: "d\ne", new_string: "f" },
      ],
    }
    for (const e of call("c1", "multi_edit", input)) reduce(store, e)
    reduce(store, event({ kind: "tool.finished", callId: "c1", tool: "multi_edit", ok: true, output: "ok" }))

    expect(store.getAgent(MAIN)?.linesAdded).toBe(3)
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(3)
  })

  it("withdraws a MultiEdit side when one entry did not state it", () => {
    const store = new MemoryStore()
    const input = {
      edits: [
        { old_string: "a", new_string: "b\nc" },
        // No `old_string`: the removed total would have a hole in it, which is
        // an unknown number rather than a smaller one.
        { new_string: "f" },
      ],
    }
    for (const e of call("c1", "multi_edit", input)) reduce(store, e)

    expect(store.getAgent(MAIN)?.linesAdded).toBe(3)
    expect(store.getAgent(MAIN)?.linesRemoved).toBeUndefined()
  })

  it("refuses a MultiEdit containing an illegible entry", () => {
    const store = new MemoryStore()
    const input = { edits: [{ old_string: "a", new_string: "b" }, { note: "unreadable" }] }
    for (const e of call("c1", "multi_edit", input)) reduce(store, e)

    expect(store.getAgent(MAIN)?.linesAdded).toBeUndefined()
    expect(store.getAgent(MAIN)?.linesRemoved).toBeUndefined()
  })

  it("refuses a MultiEdit batch long enough to have been clipped by redaction", () => {
    const store = new MemoryStore()
    // `redactValue` keeps only the first 200 array entries, so a batch of
    // exactly 200 may be a truncated view of a longer one.
    const edits = Array.from({ length: 200 }, () => ({ old_string: "a", new_string: "b" }))
    for (const e of call("c1", "multi_edit", { edits })) reduce(store, e)

    expect(store.getAgent(MAIN)?.linesAdded).toBeUndefined()
  })

  // ---------------------------------------------------------------- P1-3
  // Redaction and truncation substitute a different string; counting it
  // measures the redactor rather than the file.

  it("refuses churn from an argument the redactor rewrote", () => {
    const store = new MemoryStore()
    // A real secret through the real redactor, so the marker literals in
    // reduce.ts cannot drift away from redact.ts unnoticed.
    const original = "line one\nAWS_SECRET_ACCESS_KEY=abcdefghijklmnop\nline three"
    const redacted = redactText(original, DEFAULT_REDACTION)
    expect(redacted).not.toBe(original)

    for (const e of call("c1", "write", { content: redacted })) reduce(store, e)

    expect(store.getAgent(MAIN)?.linesAdded).toBeUndefined()
    // Unmarked, so a clean redelivery of the same call could still be credited.
    expect(store.getToolCall(MAIN_CALL)?.churnConfidence).toBeUndefined()
  })

  it("refuses churn from a truncated argument", () => {
    const store = new MemoryStore()
    const original = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")
    const truncated = redactText(original, { enabled: true, maxTextLength: 40 })
    expect(truncated).toContain("truncated")

    for (const e of call("c1", "write", { content: truncated })) reduce(store, e)

    // 40 characters of a 50-line file is not a line count.
    expect(store.getAgent(MAIN)?.linesAdded).toBeUndefined()
  })

  it("refuses churn from a value redactValue replaced at the depth limit", () => {
    const store = new MemoryStore()
    // `redactValue` substitutes "[depth limit]" rather than dropping the branch.
    for (const e of call("c1", "edit", { oldString: "[depth limit]", newString: "a\nb" })) reduce(store, e)

    expect(store.getAgent(MAIN)?.linesAdded).toBe(2)
    expect(store.getAgent(MAIN)?.linesRemoved).toBeUndefined()
  })

  // ---------------------------------------------------------------- P1-4
  // A patch is validated by its grammar, not by a prefix that looks like one.

  it("counts a unified diff from its hunk headers", () => {
    const store = new MemoryStore()
    const patch = ["--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,3 @@", " kept", "-old", "+new", "+extra"].join("\n")
    for (const e of call("c1", "apply_patch", { patch })) reduce(store, e)

    expect(store.getAgent(MAIN)?.linesAdded).toBe(2)
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(1)
  })

  it("counts an apply_patch envelope from its file directives", () => {
    const store = new MemoryStore()
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@ function foo()",
      "-old",
      "+new",
      "+extra",
      " kept",
      "*** End Patch",
    ].join("\n")
    for (const e of call("c1", "apply_patch", { patch })) reduce(store, e)

    expect(store.getAgent(MAIN)?.linesAdded).toBe(2)
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(1)
  })

  it("rejects prose, marker-shaped prose and content-free patches", () => {
    const store = new MemoryStore()
    const cases: Array<[string, string]> = [
      // No marker at all.
      ["c1", "+1 for that"],
      // Marker-shaped, but not a hunk header: `@@ not a hunk` carries no ranges.
      ["c2", "@@ not a hunk\n+fabricated"],
      // Marker-shaped, but not an apply_patch directive.
      ["c3", "*** not a patch\n+fabricated"],
      // A valid envelope that states no changed line at all.
      ["c4", "*** Begin Patch\n*** Update File: a.ts\n@@\n unchanged\n*** End Patch"],
      // A hunk header alone.
      ["c5", "@@ -1,2 +1,2 @@"],
      // A file directive outside any envelope.
      ["c6", "*** Update File: a.ts\n+fabricated"],
    ]
    for (const [callId, patch] of cases) {
      for (const e of call(callId, "apply_patch", { patch })) reduce(store, e)
    }

    expect(store.getAgent(MAIN)?.linesAdded).toBeUndefined()
    expect(store.getAgent(MAIN)?.linesRemoved).toBeUndefined()
    for (const [callId] of cases) {
      expect(store.getToolCall(toolCallId(MAIN, callId))?.churnConfidence).toBeUndefined()
    }
  })

  // ---------------------------------------------------------------- P1-5
  // `authoritative` means an adapter identified the numbers as churn.

  it("ignores generic JSON output that merely carries additions and deletions", () => {
    const store = new MemoryStore()
    // A package manager summary, not a diff. Promoting this to authoritative
    // churn was the earlier bug.
    const output = JSON.stringify({ package: "left-pad", additions: 42, deletions: 7 })
    reduce(store, event({ kind: "tool.started", callId: "c1", tool: "edit", input: { newString: "a" } }))
    reduce(store, event({ kind: "tool.finished", callId: "c1", tool: "edit", ok: true, output }))

    // Falls back to the arguments, and stays inferred.
    expect(store.getAgent(MAIN)?.linesAdded).toBe(1)
    expect(store.getToolCall(MAIN_CALL)?.churnConfidence).toBe("inferred")
  })

  it("rejects a non-integer count rather than truncating it", () => {
    const store = new MemoryStore()
    reduce(store, event({ kind: "tool.started", callId: "c1", tool: "edit", input: { oldString: "a\nb" } }))
    reduce(
      store,
      event({ kind: "tool.finished", callId: "c1", tool: "edit", ok: true, output: stated({ linesAdded: 1.9, linesRemoved: 0 }) }),
    )

    // 1.9 is not a count of lines, and `1` is a number the host never stated.
    expect(store.getAgent(MAIN)?.linesAdded).toBeUndefined()
    // The integer sibling is still honoured.
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(0)
    expect(store.getToolCall(MAIN_CALL)?.churnConfidence).toBe("authoritative")
  })

  it("rejects negative and non-numeric stated counts", () => {
    const store = new MemoryStore()
    reduce(store, event({ kind: "tool.started", callId: "c1", tool: "edit", input: { oldString: "a" } }))
    reduce(
      store,
      event({ kind: "tool.finished", callId: "c1", tool: "edit", ok: true, output: stated({ linesAdded: -3, linesRemoved: "4" }) }),
    )

    expect(store.getAgent(MAIN)?.linesAdded).toBeUndefined()
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(1)
    expect(store.getToolCall(MAIN_CALL)?.churnConfidence).toBe("inferred")
  })

  it("accepts a host-stated marker on a call whose arguments were never captured", () => {
    const store = new MemoryStore()
    reduce(
      store,
      event({
        kind: "tool.finished",
        callId: "c1",
        tool: "edit",
        ok: true,
        output: stated({ linesAdded: 12, linesRemoved: 3 }),
      }),
    )

    expect(store.getAgent(MAIN)?.linesAdded).toBe(12)
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(3)
    expect(store.getAgent(MAIN)?.churnConfidence).toBe("authoritative")
  })

  // ----------------------------------------------------------------- misc

  it("credits churn to the agent that ran the tool, not the root", () => {
    const store = new MemoryStore()
    reduce(store, event({ kind: "agent.started", agentType: "Explore" }, { agentKey: "agent:a1" }))
    for (const e of edit("c1", { oldString: "a", newString: "b\nc" }, "agent:a1")) reduce(store, e)

    expect(store.getAgent(agentId(SESSION, "agent:a1"))?.linesAdded).toBe(2)
    expect(store.getAgent(MAIN)?.linesAdded).toBeUndefined()
  })

  it("counts two calls editing one file separately, as gross call churn", () => {
    const store = new MemoryStore()
    // Deliberate: the reducer has no view of the file, only of host operations.
    for (const e of edit("c1", { filePath: "/a.ts", oldString: "a", newString: "b" })) reduce(store, e)
    for (const e of edit("c2", { filePath: "/a.ts", oldString: "b", newString: "c" })) reduce(store, e)

    expect(store.getAgent(MAIN)?.linesAdded).toBe(2)
    expect(store.getAgent(MAIN)?.linesRemoved).toBe(2)
  })

  it("emits one agent change carrying the new totals", () => {
    const store = new MemoryStore()
    reduce(store, event({ kind: "tool.started", callId: "c1", tool: "edit", input: { oldString: "a", newString: "b" } }))
    const changes = reduce(store, event({ kind: "tool.finished", callId: "c1", tool: "edit", ok: true, output: "ok" }))

    const agentChanges = changes.filter((change) => change.table === "agent" && change.op === "upsert")
    expect(agentChanges).toHaveLength(1)
    expect(agentChanges[0]).toMatchObject({ row: { linesAdded: 1, linesRemoved: 1 } })
  })
})
