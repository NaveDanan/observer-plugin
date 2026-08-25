import { describe, expect, it } from "vitest"
import type { AgentEntity, EdgeEntity, EdgeType } from "@observer-ai/protocol"
import { branchColor, branchHue, computeLineage, sharesBloodline } from "../src/lineage"

function agent(id: string, parentAgentId: string | null, startedAt = 0): AgentEntity {
  return {
    id,
    sessionId: "opencode:root",
    agentKey: id,
    agentType: parentAgentId ? "subagent" : "root",
    displayName: id,
    parentAgentId,
    status: "running",
    model: null,
    modelConfidence: null,
    description: null,
    delegationPrompt: null,
    summary: null,
    startedAt,
    endedAt: null,
    updatedAt: 0,
    totalTokens: null,
    durationMs: null,
  }
}

function link(from: string, to: string, edgeType: EdgeType = "spawned"): EdgeEntity {
  return {
    id: `${from}->${to}:${edgeType}`,
    sessionId: "opencode:root",
    fromAgentId: from,
    toAgentId: to,
    edgeType,
    label: null,
    provenance: "authoritative",
    createdAt: 1,
  }
}

/** root -> a, b; a -> a1. Enough to have a sibling, a cousin and a bloodline. */
function family(): { agents: AgentEntity[]; edges: EdgeEntity[] } {
  return {
    agents: [agent("root", null, 0), agent("a", "root", 1), agent("b", "root", 2), agent("a1", "a", 3)],
    edges: [link("root", "a"), link("root", "b"), link("a", "a1")],
  }
}

describe("branchColor", () => {
  it("keeps successive branches far apart on the colour wheel", () => {
    // Golden-angle steps, so no two of the first hundred spawners land on the
    // same hue — a fixed palette of N repeats on the N+1th subagent, which is
    // exactly the collision the canvas exists to avoid.
    expect(new Set(Array.from({ length: 100 }, (_, i) => branchColor(i))).size).toBe(100)
    expect(Math.abs(branchHue(0) - branchHue(1))).toBeGreaterThan(90)
  })

  it("stays inside the hue circle for any index", () => {
    for (const index of [0, 1, 7, 63, 500]) {
      expect(branchHue(index)).toBeGreaterThanOrEqual(0)
      expect(branchHue(index)).toBeLessThan(360)
    }
  })

  it("varies hue only, so no branch reads as more important than another", () => {
    const lightnessAndChroma = Array.from({ length: 12 }, (_, i) =>
      branchColor(i).replace(/oklch\((\S+) (\S+) .*\)/, "$1 $2"),
    )
    expect(new Set(lightnessAndChroma).size).toBe(1)
  })
})

describe("computeLineage", () => {
  const { agents, edges } = family()
  const lineage = computeLineage(agents, edges)

  it("records nesting level and parent for every agent", () => {
    expect(lineage.size).toBe(agents.length)
    expect(lineage.get("root")).toMatchObject({ depth: 0, parentId: null })
    expect(lineage.get("a")).toMatchObject({ depth: 1, parentId: "root" })
    expect(lineage.get("a1")).toMatchObject({ depth: 2, parentId: "a" })
  })

  it("records the full ancestor trail, root first", () => {
    expect(lineage.get("a1")?.ancestors).toEqual(["root", "a"])
    expect(lineage.get("root")?.ancestors).toEqual([])
  })

  it("gives every agent a hue no other agent on the canvas has", () => {
    expect(new Set(agents.map((entry) => lineage.get(entry.id)?.color)).size).toBe(agents.length)
  })

  it("hands a subagent the hue of the parent that spawned it", () => {
    // This is the pairing the whole scheme rests on: the accent on a node and
    // the edges leaving it are one colour, and that colour is what the child
    // reports as its parent's.
    expect(lineage.get("a1")?.parentColor).toBe(lineage.get("a")?.color)
    expect(lineage.get("a")?.parentColor).toBe(lineage.get("root")?.color)
    expect(lineage.get("root")?.parentColor).toBeNull()
  })

  it("gives a subagent's subagents a hue nothing like their grandparent's", () => {
    // The case the canvas was hardest to read in: three nesting levels of one
    // colour looked like a single fan-out.
    expect(lineage.get("a")?.color).not.toBe(lineage.get("root")?.color)
    expect(lineage.get("a1")?.color).not.toBe(lineage.get("a")?.color)
  })

  it("does not recolour anything when a later agent is spawned", () => {
    // Colours must not move under a developer mid-read, so the index a hue is
    // derived from has to be append-only. A tree-order index would renumber
    // every agent to the right of a new one.
    const grown = computeLineage([...agents, agent("late", "b", 9)], [...edges, link("b", "late")])
    for (const entry of agents) expect(grown.get(entry.id)?.color).toBe(lineage.get(entry.id)?.color)
  })

  it("is stable across repeated runs", () => {
    const again = computeLineage(agents, edges)
    for (const entry of agents) expect(again.get(entry.id)).toEqual(lineage.get(entry.id))
  })

  it("does not let a peer message create a lineage", () => {
    const messaged = computeLineage(agents, [...edges, link("a1", "b", "messaged")])
    expect(messaged.get("b")?.parentId).toBe("root")
    expect(messaged.get("b")?.ancestors).toEqual(["root"])
  })

  it("treats an agent whose parent is off the canvas as a root", () => {
    const orphaned = computeLineage([agent("stray", "filtered-out")], [])
    expect(orphaned.get("stray")).toMatchObject({ depth: 0, parentId: null, parentColor: null })
  })

  it("survives a parent cycle", () => {
    const cyclic = computeLineage([agent("x", "y", 1), agent("y", "x", 2)], [])
    expect(cyclic.size).toBe(2)
    expect([...cyclic.values()].map((entry) => entry.depth).sort()).toEqual([0, 1])
  })
})

describe("sharesBloodline", () => {
  const { agents, edges } = family()
  const lineage = computeLineage(agents, edges)

  it("is true up and down a branch, in either direction", () => {
    expect(sharesBloodline(lineage, "a", "a1")).toBe(true)
    expect(sharesBloodline(lineage, "a1", "a")).toBe(true)
    expect(sharesBloodline(lineage, "a1", "root")).toBe(true)
  })

  it("is false between siblings and between cousins", () => {
    expect(sharesBloodline(lineage, "a", "b")).toBe(false)
    expect(sharesBloodline(lineage, "a1", "b")).toBe(false)
  })

  it("is false for an agent it has never seen", () => {
    expect(sharesBloodline(lineage, "a", "nobody")).toBe(false)
  })
})
