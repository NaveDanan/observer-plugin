import { describe, expect, it } from "vitest"
import type { AgentEntity, SessionEntity, ToolCallEntity } from "@observer-ai/protocol"
import { selectCurrentActivity, selectEmployeeMatch, selectSessions } from "../src/store"

function session(host: SessionEntity["host"], key: string, updatedAt: number): SessionEntity {
  return {
    id: `${host}:${key}`,
    host,
    hostVersion: null,
    sessionKey: key,
    workspaceRoot: "/repo",
    title: null,
    status: "active",
    model: null,
    goal: null,
    goalStatus: null,
    cwd: null,
    startedAt: updatedAt,
    endedAt: null,
    updatedAt,
    lastEventSeq: 0,
  }
}

function stateWith(scopeHost: string | undefined, sessions: SessionEntity[]) {
  return {
    scopeHost,
    sessions: new Map(sessions.map((entry) => [entry.id, entry])),
  } as unknown as Parameters<typeof selectSessions>[0]
}

const all = [session("claude", "cl-1", 30), session("codex", "cx-1", 20), session("opencode", "oc-1", 10)]

describe("session scope", () => {
  it("shows only the host the canvas is bound to", () => {
    // Observer is opened by a host and stays connected to it; there is no
    // in-app picker, so this filter is the whole binding.
    expect(selectSessions(stateWith("codex", all)).map((s) => s.id)).toEqual(["codex:cx-1"])
    expect(selectSessions(stateWith("claude", all)).map((s) => s.id)).toEqual(["claude:cl-1"])
  })

  it("shows every host when unbound", () => {
    expect(selectSessions(stateWith(undefined, all))).toHaveLength(3)
  })

  it("returns nothing when the bound host has no sessions yet", () => {
    expect(selectSessions(stateWith("copilot", all))).toEqual([])
  })

  it("orders by most recent activity", () => {
    const ordered = selectSessions(stateWith(undefined, all)).map((s) => s.id)
    expect(ordered).toEqual(["claude:cl-1", "codex:cx-1", "opencode:oc-1"])
  })
})

function toolCall(overrides: Partial<ToolCallEntity> = {}): ToolCallEntity {
  return {
    id: "claude:s1~main~t:1",
    sessionId: "claude:s1",
    agentId: "claude:s1~main",
    callId: "1",
    tool: "Bash",
    title: null,
    input: null,
    output: null,
    error: null,
    status: "running",
    startedAt: 1_000,
    endedAt: null,
    durationMs: null,
    ...overrides,
  }
}

describe("current activity", () => {
  it("returns the running tool and elapsed milliseconds for a supplied now", () => {
    const state = {
      runningTools: new Map([["claude:s1~main", toolCall({ startedAt: 1_000 })]]),
    } as unknown as Parameters<typeof selectCurrentActivity>[0]
    const activity = selectCurrentActivity(state, "claude:s1~main", 5_500)
    expect(activity?.tool.tool).toBe("Bash")
    expect(activity?.elapsedMs).toBe(4_500)
  })

  it("returns nothing for an idle agent", () => {
    const state = { runningTools: new Map() } as unknown as Parameters<typeof selectCurrentActivity>[0]
    expect(selectCurrentActivity(state, "claude:s1~main", 2_000)).toBeUndefined()
  })

  it("picks the running call when an agent has several completed ones", () => {
    // Only the running entry is kept in the map; completed ones are not.
    const running = toolCall({ id: "claude:s1~main~t:2", callId: "2", tool: "Grep", startedAt: 2_000, status: "running" })
    const state = {
      runningTools: new Map([["claude:s1~main", running]]),
    } as unknown as Parameters<typeof selectCurrentActivity>[0]
    const activity = selectCurrentActivity(state, "claude:s1~main", 3_000)
    expect(activity?.tool.tool).toBe("Grep")
    expect(activity?.elapsedMs).toBe(1_000)
  })
})

function agent(overrides: Partial<AgentEntity> = {}): AgentEntity {
  return {
    id: "opencode:s1~session:c1",
    sessionId: "opencode:s1",
    agentKey: "session:c1",
    agentType: "subagent",
    displayName: null,
    parentAgentId: "opencode:s1~main",
    status: "running",
    model: null,
    modelConfidence: null,
    description: null,
    delegationPrompt: null,
    summary: null,
    startedAt: 1_000,
    endedAt: null,
    updatedAt: 1_000,
    totalTokens: null,
    durationMs: null,
    ...overrides,
  }
}

describe("employee seating", () => {
  const state = { matchCache: new Map() } as unknown as Parameters<typeof selectEmployeeMatch>[0]

  it("seats an employee from the delegation prompt", () => {
    const node = agent({
      delegationPrompt: "Our deployments work differently in every environment. Set up kubernetes and CI/CD.",
    })
    expect(selectEmployeeMatch(state, node)?.profile.id).toBeDefined()
  })

  it("never seats anyone on a subcontractor node, however strong the text looks", () => {
    const node = agent({
      agentType: "subcontractor",
      delegationPrompt: "Our deployments work differently in every environment. Set up kubernetes and CI/CD.",
    })
    expect(selectEmployeeMatch(state, node)).toBeUndefined()
  })

  it("never seats anyone on an @observer activation node", () => {
    const node = agent({
      agentType: "observer",
      delegationPrompt: "Confirm that Observer staffing is active for this session.",
    })
    expect(selectEmployeeMatch(state, node)).toBeUndefined()
  })
})
