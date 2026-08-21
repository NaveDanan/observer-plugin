import { describe, expect, it } from "vitest"
import type { AgentEntity, EdgeEntity, SessionEntity, ToolCallEntity } from "@observer-ai/protocol"
import { selectCurrentActivity, selectEmployeeMatch, selectSessions, stripHostTitleSuffix } from "../src/store"
import { NODE_HEIGHT, SEATED_NODE_HEIGHT, computeDepths, layoutGraph } from "../src/layout"

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

describe("host title suffix", () => {
  it("strips OpenCode's decorated child-session suffix", () => {
    expect(stripHostTitleSuffix("UI/UX review of canvas (@general subagent)")).toBe("UI/UX review of canvas")
    expect(stripHostTitleSuffix("Fix the login flow (@build subagent)")).toBe("Fix the login flow")
  })

  it("leaves an undecorated description alone", () => {
    expect(stripHostTitleSuffix("Set up kubernetes and CI/CD")).toBe("Set up kubernetes and CI/CD")
  })

  it("keeps parentheses that are part of the task", () => {
    expect(stripHostTitleSuffix("Rework the roster (v2)")).toBe("Rework the roster (v2)")
  })

  it("does not let the host's agent type become match evidence", () => {
    // Scoring is additive, so the suffix cannot lower a score. The damage is
    // the opposite: "@k8s" is roster vocabulary and outscores the actual task,
    // seating the devops profile on an accessibility ticket.
    const state = { matchCache: new Map() } as unknown as Parameters<typeof selectEmployeeMatch>[0]
    const task = "Tidy up the accessibility of the settings screen"
    const decorated = agent({ id: "a", description: `${task} (@k8s subagent)` })
    const plain = agent({ id: "b", description: task })
    expect(selectEmployeeMatch(state, plain)?.profile.id).toBe("sofia-moreno")
    expect(selectEmployeeMatch(state, decorated)?.profile.id).toBe("sofia-moreno")
  })

  it("still refuses to seat anyone on an explicit subcontractor node", () => {
    // Stripping must not become a back door around a Seating decision the
    // plugin already made upstream.
    const state = { matchCache: new Map() } as unknown as Parameters<typeof selectEmployeeMatch>[0]
    const node = agent({
      agentType: "subcontractor",
      description: "Kubernetes and CI/CD pipeline work for the deployment infrastructure (@build subagent)",
    })
    expect(selectEmployeeMatch(state, node)).toBeUndefined()
  })

  it("still matches the default subagent type, which is a fallback and not a decision", () => {
    const state = { matchCache: new Map() } as unknown as Parameters<typeof selectEmployeeMatch>[0]
    const node = agent({
      agentType: "subagent",
      description: "Kubernetes and CI/CD pipeline work for the deployment infrastructure (@build subagent)",
    })
    expect(selectEmployeeMatch(state, node)?.profile.id).toBeDefined()
  })
})

describe("depth", () => {
  it("counts a subagent that spawned its own subagents three layers deep", () => {
    const root = agent({ id: "r", agentKey: "main", parentAgentId: null })
    const child = agent({ id: "c", parentAgentId: "r" })
    const grandchild = agent({ id: "g", parentAgentId: "c" })
    const depths = computeDepths([root, child, grandchild], [])
    expect(depths.get("r")).toBe(0)
    expect(depths.get("c")).toBe(1)
    expect(depths.get("g")).toBe(2)
  })

  it("derives depth from edges when the parent link has not been reconciled", () => {
    const root = agent({ id: "r", agentKey: "main", parentAgentId: null })
    const child = agent({ id: "c", parentAgentId: null })
    const grandchild = agent({ id: "g", parentAgentId: null })
    const depths = computeDepths(
      [root, child, grandchild],
      [
        { id: "e1", fromAgentId: "r", toAgentId: "c" } as EdgeEntity,
        { id: "e2", fromAgentId: "c", toAgentId: "g" } as EdgeEntity,
      ],
    )
    expect(depths.get("g")).toBe(2)
  })
})

describe("node heights", () => {
  it("reserves more room for a seated node than an unseated one", () => {
    // A seated node carries a tone paragraph and a strengths row that wraps;
    // reserving the unseated height for it would let the layer below ride up
    // into it once the tree is deep.
    expect(SEATED_NODE_HEIGHT).toBeGreaterThan(NODE_HEIGHT)
  })

  it("puts the next layer below the reserved height of a seated parent", async () => {
    const root = agent({ id: "r", agentKey: "main", parentAgentId: null })
    const child = agent({ id: "c", parentAgentId: "r" })
    const edge = { id: "e1", fromAgentId: "r", toAgentId: "c" } as EdgeEntity
    const seated = await layoutGraph([root, child], [edge], new Map([["r", SEATED_NODE_HEIGHT]]))
    const unseated = await layoutGraph([root, child], [edge], new Map([["r", NODE_HEIGHT]]))
    const gapOf = (positions: Map<string, { x: number; y: number }>): number =>
      (positions.get("c")?.y ?? 0) - (positions.get("r")?.y ?? 0)
    expect(gapOf(seated)).toBeGreaterThanOrEqual(SEATED_NODE_HEIGHT)
    expect(gapOf(seated) - gapOf(unseated)).toBe(SEATED_NODE_HEIGHT - NODE_HEIGHT)
  })

})

