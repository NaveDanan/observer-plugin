import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { AgentEntity, EdgeEntity, EdgeType, Provenance } from "@observer-ai/protocol"
import {
  MESSAGE_SOURCE_HANDLE,
  MESSAGE_TARGET_HANDLE,
  PEER_EDGE_TYPE,
  isPeerMessage,
  toFlowEdges,
} from "../src/canvasEdges"
import { branchColor, computeLineage } from "../src/lineage"
import { peerEdgePath } from "../src/PeerEdge"

function edge(edgeType: EdgeType, provenance: Provenance = "authoritative", label: string | null = null): EdgeEntity {
  return {
    id: `edge-${edgeType}`,
    sessionId: "opencode:root",
    fromAgentId: "opencode:root~session:a",
    toAgentId: "opencode:root~session:b",
    edgeType,
    label,
    provenance,
    createdAt: 1,
  }
}

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

/** root -> a, b; a -> a1. Enough to have cousins, siblings and a bloodline. */
function family(): { agents: AgentEntity[]; edges: EdgeEntity[] } {
  return {
    agents: [
      agent("root", null, 0),
      agent("a", "root", 1),
      agent("b", "root", 2),
      agent("a1", "a", 3),
    ],
    edges: [link("root", "a"), link("root", "b"), link("a", "a1")],
  }
}

describe("toFlowEdges", () => {
  it.each(["spawned", "delegated", "messaged", "forked"] as const)(
    "preserves the %s relationship type independently from provenance",
    (edgeType) => {
      const [flowEdge] = toFlowEdges([edge(edgeType, "reconciled")], false)

      expect(flowEdge).toMatchObject({
        id:
          edgeType === "messaged"
            ? "message-pair:opencode:root:opencode:root~session:a<->opencode:root~session:b"
            : `edge-${edgeType}`,
        source: "opencode:root~session:a",
        target: "opencode:root~session:b",
        type: edgeType === "messaged" ? PEER_EDGE_TYPE : "step",
        data: { edgeType, provenance: "reconciled", label: null, bidirectional: false },
        pathOptions: { borderRadius: 0 },
      })
      expect(flowEdge?.className).toContain(`edge-${edgeType}`)
      expect(flowEdge?.className).toContain("edge-reconciled")
    },
  )

  it("animates communication only when motion is allowed", () => {
    const types = ["spawned", "delegated", "messaged", "forked"] as const
    expect(toFlowEdges(types.map((type) => edge(type)), false).map((entry) => entry.animated)).toEqual([
      false,
      false,
      true,
      false,
    ])
    expect(toFlowEdges([edge("messaged")], true)[0]?.animated).toBe(false)
  })

  it("retains an authoritative relationship label", () => {
    const [flowEdge] = toFlowEdges([edge("messaged", "authoritative", "direct message")], false)

    expect(flowEdge?.label).toBeUndefined()
    expect(flowEdge?.ariaLabel).toBe("direct message")
  })

  it("falls back to provenance when the host supplied no label", () => {
    expect(toFlowEdges([edge("spawned", "inferred")], false)[0]?.label).toBe("inferred")
    expect(toFlowEdges([edge("spawned", "authoritative")], false)[0]?.label).toBeUndefined()
  })

  it("routes every message through the dedicated side handles", () => {
    const [message] = toFlowEdges([edge("messaged")], false)
    const [spawn] = toFlowEdges([edge("spawned")], false)

    expect(message).toMatchObject({
      sourceHandle: MESSAGE_SOURCE_HANDLE,
      targetHandle: MESSAGE_TARGET_HANDLE,
    })
    expect(spawn?.sourceHandle).toBeUndefined()
    expect(spawn?.targetHandle).toBeUndefined()
  })

  it("collapses both directions into one animated connection", () => {
    const { agents, edges } = family()
    const forward = { ...link("a", "b", "messaged"), createdAt: 1 }
    const backward = { ...link("b", "a", "messaged"), id: "b->a:messaged", createdAt: 2 }
    const messages = toFlowEdges([forward, backward], false, computeLineage(agents, edges))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      source: "b",
      target: "a",
      type: PEER_EDGE_TYPE,
      animated: true,
      data: { bidirectional: true },
    })
  })
})

describe("lineage colouring", () => {
  const { agents, edges } = family()
  const lineage = computeLineage(agents, edges)

  it("paints a hierarchy edge with the hue of the agent it leaves", () => {
    const [rootToA, rootToB, aToA1] = toFlowEdges(edges, false, lineage)

    expect(rootToA?.style).toEqual({ "--app-lineage": lineage.get("root")?.color })
    expect(rootToB?.style).toEqual({ "--app-lineage": lineage.get("root")?.color })
    // The point of the whole exercise: a subagent's own subagents hang off a
    // colour that is not its parent's.
    expect(aToA1?.style).toEqual({ "--app-lineage": lineage.get("a")?.color })
    expect(lineage.get("a")?.color).not.toBe(lineage.get("root")?.color)
  })

  it("marks lineage-coloured edges for the stylesheet", () => {
    const [rootToA] = toFlowEdges(edges, false, lineage)
    expect(rootToA?.className).toContain("edge-lineage")
  })

  it("gives a subagent the hue of the parent that spawned it", () => {
    expect(lineage.get("a1")?.parentColor).toBe(lineage.get("a")?.color)
    expect(lineage.get("root")?.parentColor).toBeNull()
  })

  it("gives every agent on the canvas a distinct hue", () => {
    const hues = agents.map((entry) => lineage.get(entry.id)?.color)
    expect(new Set(hues).size).toBe(agents.length)
  })

  it("does not recolour an agent when a later one is spawned", () => {
    // Colours must not move under a developer mid-read, so the index a hue is
    // derived from has to be append-only.
    const grown = computeLineage([...agents, agent("late", "b", 9)], [...edges, link("b", "late")])
    for (const entry of agents) expect(grown.get(entry.id)?.color).toBe(lineage.get(entry.id)?.color)
  })

  it("keeps successive branches far apart on the colour wheel", () => {
    expect(branchColor(0)).not.toBe(branchColor(1))
    // Golden-angle steps: no two of the first twenty land on the same hue.
    expect(new Set(Array.from({ length: 20 }, (_, i) => branchColor(i))).size).toBe(20)
  })

  it("leaves hierarchy edges on their per-type colour before the first layout", () => {
    expect(toFlowEdges(edges, false)[0]?.style).toBeUndefined()
    expect(toFlowEdges(edges, false)[0]?.className).not.toContain("edge-lineage")
  })

  it("never paints a message with a branch colour", () => {
    // A branch colour on a peer message would claim a parentage that is not
    // there — the tree already owns that reading.
    const [message] = toFlowEdges([link("a", "b", "messaged")], false, lineage)
    expect(message?.style).toBeUndefined()
  })
})

describe("peer messages", () => {
  const { agents, edges } = family()
  const lineage = computeLineage(agents, edges)

  it("treats a message between agents outside each other's bloodline as a peer message", () => {
    expect(isPeerMessage(link("a", "b", "messaged"), lineage)).toBe(true)
    expect(isPeerMessage(link("a1", "b", "messaged"), lineage)).toBe(true)
  })

  it("does not treat a message to an ancestor or a descendant as a peer message", () => {
    // The hierarchy edge beside it already says these two are related, so a
    // second arc would be drawing the same fact twice.
    expect(isPeerMessage(link("a", "a1", "messaged"), lineage)).toBe(false)
    expect(isPeerMessage(link("a1", "root", "messaged"), lineage)).toBe(false)
  })

  it("never treats a hierarchy edge as a peer message", () => {
    for (const edgeType of ["spawned", "delegated", "forked"] as const) {
      expect(isPeerMessage(link("a", "b", edgeType), lineage)).toBe(false)
    }
  })

  it("gives a peer message its own edge type and drops the repeated label", () => {
    const [peer] = toFlowEdges([{ ...link("a", "b", "messaged"), label: "direct message" }], false, lineage)

    expect(peer?.type).toBe(PEER_EDGE_TYPE)
    expect(peer?.className).toContain("edge-peer")
    expect(peer?.data?.peer).toBe(true)
    expect(peer?.label).toBeUndefined()
    // The relationship still has to reach anyone who cannot see the shape.
    expect(peer?.ariaLabel).toBe("direct message")
  })

  it("collapses a back-and-forth into one two-way arc", () => {
    // Two stored directions would otherwise be drawn as two arcs bowing
    // opposite ways around the same pair, which reads as two relationships.
    const drawn = toFlowEdges(
      [
        { ...link("a", "b", "messaged"), createdAt: 1 },
        { ...link("b", "a", "messaged"), createdAt: 2 },
      ],
      false,
      lineage,
    )

    expect(drawn).toHaveLength(1)
    expect(drawn[0]?.data?.bidirectional).toBe(true)
    expect(drawn[0]?.ariaLabel).toBe("peer messages between b and a")
    // The most recent direction is the representative, so the one-way arrow
    // points the way the last message went.
    expect(drawn[0]?.source).toBe("b")
  })

  it("marks a one-way conversation as one-way", () => {
    expect(toFlowEdges([link("a", "b", "messaged")], false, lineage)[0]?.data?.bidirectional).toBe(false)
  })

  it("keeps two different conversations apart", () => {
    const drawn = toFlowEdges([link("a", "b", "messaged"), link("a1", "b", "messaged")], false, lineage)

    expect(drawn).toHaveLength(2)
    expect(new Set(drawn.map((entry) => entry.id)).size).toBe(2)
  })

  it("uses the communication arc for ancestor messages too", () => {
    const [message] = toFlowEdges([link("a", "a1", "messaged")], false, lineage)

    expect(message?.type).toBe(PEER_EDGE_TYPE)
    expect(message?.className).toContain("edge-peer")
    expect(message?.data?.peer).toBe(true)
  })
})


describe("peerEdgePath", () => {
  it("arcs clear of the row it spans instead of running through it", () => {
    const { d, apex } = peerEdgePath({ x: 0, y: 100 }, { x: 600, y: 100 })

    expect(d.startsWith("M 0,100")).toBe(true)
    expect(d).toContain("C ")
    expect(apex.y).toBeLessThan(100)
  })

  it("arcs to the other side when the sender sits to the right of the recipient", () => {
    // Direction without colour: the two halves of a back-and-forth do not land
    // on top of each other.
    const forward = peerEdgePath({ x: 0, y: 100 }, { x: 600, y: 100 })
    const backward = peerEdgePath({ x: 600, y: 100 }, { x: 0, y: 100 })

    expect(forward.apex.y).toBeLessThan(100)
    expect(backward.apex.y).toBeGreaterThan(100)
  })

  it("points its arrowhead at the recipient", () => {
    const { arrow } = peerEdgePath({ x: 0, y: 0 }, { x: 400, y: 0 })
    const [tip] = arrow.split(" ")
    expect(tip).toBe("400,0")
  })

  it("survives a message an agent sends to itself", () => {
    const { d, apex, arrow } = peerEdgePath({ x: 50, y: 50 }, { x: 50, y: 50 })
    expect(d).not.toContain("NaN")
    expect(Number.isFinite(apex.x) && Number.isFinite(apex.y)).toBe(true)
    expect(arrow).not.toContain("NaN")
  })
})

describe("edge type styles", () => {
  const css = readFileSync(new URL("../src/app-surfaces.css", import.meta.url), "utf8")

  it.each([
    ["spawned", "success"],
    ["delegated", "warning"],
    ["messaged", "info"],
    ["forked", "primary"],
  ] as const)("gives %s relationships their own semantic color", (edgeType, color) => {
    expect(css).toContain(`--app-edge-${edgeType}: var(--${color});`)
    expect(css).toContain(`.react-flow__edge.edge-${edgeType} .react-flow__edge-path`)
  })

  it("keeps provenance selectors separate from relationship selectors", () => {
    expect(css).toContain(".react-flow__edge.edge-inferred .react-flow__edge-path")
    expect(css).toContain(".react-flow__edge.edge-reconciled .react-flow__edge-path")
  })

  it("lets the branch colour outrank the relationship colour, and selection outrank both", () => {
    const lineage = css.indexOf(".react-flow__edge.edge-lineage .react-flow__edge-path")
    const spawned = css.indexOf(".react-flow__edge.edge-spawned .react-flow__edge-path")
    const selected = css.indexOf(".react-flow__edge.selected .react-flow__edge-path")

    expect(spawned).toBeGreaterThan(-1)
    expect(lineage).toBeGreaterThan(spawned)
    expect(selected).toBeGreaterThan(lineage)
  })

  it("draws the peer arc as a curve rather than as crisp steps", () => {
    const rule = /\.react-flow__edge\.edge-peer \.react-flow__edge-path\s*\{([^}]*)\}/.exec(css)?.[1] ?? ""
    expect(rule).toContain("shape-rendering: geometricPrecision")
    expect(rule).toContain("stroke: var(--app-edge-messaged)")
  })
})
