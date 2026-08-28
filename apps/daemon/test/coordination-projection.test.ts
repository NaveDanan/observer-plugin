import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DEFAULT_CONFIG, Pipeline } from "@observer-ai/daemon"
import { Store } from "@observer-ai/storage"

let store: Store
let pipeline: Pipeline

beforeEach(() => {
  store = new Store({ path: ":memory:" })
  pipeline = new Pipeline({ store, config: { ...DEFAULT_CONFIG, token: "test" }, onChanges: () => undefined })
})

afterEach(() => store.close())

describe("portable coordination assignment projection", () => {
  it("makes Claude subagents addressable after the host reports their stable ID", () => {
    pipeline.ingestHook({
      host: "claude",
      event: "SubagentStart",
      deliveryId: "claude-start",
      payload: { session_id: "claude-root", agent_id: "claude-child-1", agent_type: "reviewer" },
    })

    expect(store.getAgentAssignmentByRuntime("claude", "claude-child-1")).toMatchObject({
      rootSessionKey: "claude-root",
      parentRuntimeId: "claude-root",
      status: "running",
    })
  })

  it("makes Codex subagents addressable from lifecycle hooks and updates terminal status", () => {
    pipeline.ingestHook({
      host: "codex",
      event: "SessionStart",
      deliveryId: "root",
      payload: { session_id: "root-session", model: "gpt-5.6-sol" },
    })
    pipeline.ingestHook({
      host: "codex",
      event: "SubagentStart",
      deliveryId: "start",
      payload: { session_id: "root-session", agent_id: "child-1", agent_type: "observer-dr-mei-lin" },
    })

    expect(store.getAgentAssignmentByRuntime("codex", "child-1")).toMatchObject({
      rootSessionKey: "root-session",
      parentRuntimeId: "root-session",
      agentType: "observer-dr-mei-lin",
      status: "running",
    })

    pipeline.ingestHook({
      host: "codex",
      event: "SubagentStop",
      deliveryId: "stop",
      payload: { session_id: "root-session", agent_id: "child-1", agent_type: "observer-dr-mei-lin" },
    })
    expect(store.getAgentAssignmentByRuntime("codex", "child-1")?.status).toBe("completed")
  })

  it("uses Copilot's reconciled runtime ID once the session log reveals it", () => {
    pipeline.ingestHook({
      host: "copilot",
      event: "sessionStart",
      deliveryId: "root",
      payload: { sessionId: "copilot-root" },
    })
    pipeline.ingestEvents([
      {
        id: "copilot-log:subagent",
        host: "copilot",
        adapter: "copilot-session-log@1",
        workspaceRoot: "/repo",
        sessionKey: "copilot-root",
        agentKey: "sub:reviewer",
        at: 10,
        provenance: "reconciled",
        body: {
          kind: "agent.started",
          runtimeId: "copilot-child-1",
          agentType: "reviewer",
          parentAgentKey: "main",
        },
      },
    ])

    expect(store.getAgentAssignmentByRuntime("copilot", "copilot-child-1")).toMatchObject({
      rootSessionKey: "copilot-root",
      parentRuntimeId: "copilot-root",
      status: "running",
    })
  })
})
