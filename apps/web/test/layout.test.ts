import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { AgentEntity, EdgeEntity } from "@observer-ai/protocol"
import {
  LAYER_GAP,
  NODE_GAP,
  NODE_HEIGHT,
  NODE_WIDTH,
  ROOT_GAP,
  SEATED_NODE_HEIGHT,
  SUBTREE_GAP,
  buildHierarchy,
  computeDepths,
  edgeAffectsHierarchy,
  graphSignature,
  layoutGraph,
  type Position,
} from "../src/layout"

function agent(id: string, parentAgentId: string | null, startedAt = 0): AgentEntity {
  return {
    id,
    sessionId: "opencode:s1",
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

function edge(from: string, to: string, edgeType: EdgeEntity["edgeType"] = "spawned"): EdgeEntity {
  return {
    id: `${from}->${to}`,
    sessionId: "opencode:s1",
    fromAgentId: from,
    toAgentId: to,
    edgeType,
    label: null,
    provenance: "authoritative",
    createdAt: 0,
  }
}

/**
 * Root agent -> two subagents -> two subagents each. Depth 3 is the shape the
 * product is actually about: subagents spawning their own subagents.
 */
function depthThree(): { agents: AgentEntity[]; edges: EdgeEntity[] } {
  const agents = [agent("root", null)]
  const edges: EdgeEntity[] = []
  for (const a of ["a0", "a1"]) {
    agents.push(agent(a, "root"))
    edges.push(edge("root", a))
    for (const b of [`${a}b0`, `${a}b1`]) {
      agents.push(agent(b, a))
      edges.push(edge(a, b))
    }
  }
  return { agents, edges }
}

/** Root -> `width` subagents, each with `kids` of its own. */
function fanOut(width: number, kids = 0): { agents: AgentEntity[]; edges: EdgeEntity[] } {
  const agents = [agent("root", null)]
  const edges: EdgeEntity[] = []
  for (let i = 0; i < width; i++) {
    const sub = `s${i}`
    agents.push(agent(sub, "root", i + 1))
    edges.push(edge("root", sub))
    for (let j = 0; j < kids; j++) {
      agents.push(agent(`${sub}k${j}`, sub, 100 + i * 10 + j))
      edges.push(edge(sub, `${sub}k${j}`))
    }
  }
  return { agents, edges }
}

/** Alternates seated and unseated so the layout is exercised with mixed heights. */
function mixedHeights(agents: AgentEntity[]): Map<string, number> {
  return new Map(agents.map((a, index) => [a.id, index % 2 === 0 ? SEATED_NODE_HEIGHT : NODE_HEIGHT]))
}

function overlaps(a: { pos: Position; h: number }, b: { pos: Position; h: number }): boolean {
  const overlapX = Math.min(a.pos.x + NODE_WIDTH, b.pos.x + NODE_WIDTH) - Math.max(a.pos.x, b.pos.x)
  const overlapY = Math.min(a.pos.y + a.h, b.pos.y + b.h) - Math.max(a.pos.y, b.pos.y)
  return overlapX > 0 && overlapY > 0
}

function collisions(agents: AgentEntity[], positions: Map<string, Position>, heights: Map<string, number>): string[] {
  const boxes = agents.map((a) => ({
    id: a.id,
    pos: positions.get(a.id) as Position,
    h: heights.get(a.id) as number,
  }))
  const found: string[] = []
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const first = boxes[i] as (typeof boxes)[number]
      const second = boxes[j] as (typeof boxes)[number]
      if (overlaps(first, second)) found.push(`${first.id}/${second.id}`)
    }
  }
  return found
}

/** Horizontal centre of a node, which is what a parent is centred against. */
function centre(positions: Map<string, Position>, id: string): number {
  return (positions.get(id) as Position).x + NODE_WIDTH / 2
}

describe("layoutGraph", () => {
  it("places every agent exactly once", () => {
    const { agents, edges } = depthThree()
    const positions = layoutGraph(agents, edges, mixedHeights(agents))
    expect(positions.size).toBe(agents.length)
    for (const a of agents) expect(positions.get(a.id)).toBeDefined()
  })

  it("never overlaps two nodes in a depth-3 graph with mixed heights", () => {
    const { agents, edges } = depthThree()
    const heights = mixedHeights(agents)
    expect(collisions(agents, layoutGraph(agents, edges, heights), heights)).toEqual([])
  })

  it("never overlaps two nodes in a wide graph of nested sub-trees", () => {
    const { agents, edges } = fanOut(14, 3)
    const heights = mixedHeights(agents)
    expect(collisions(agents, layoutGraph(agents, edges, heights), heights)).toEqual([])
  })

  it("gives every agent at one nesting level the same y", () => {
    // The whole point of the vertical axis. A node's y says how deeply nested
    // it is and nothing else, so nesting level is legible without tracing an
    // edge — which is exactly what wrapping a wide row onto a second line
    // destroyed: half a fan-out looked like a deeper level.
    const { agents, edges } = fanOut(9, 2)
    const heights = mixedHeights(agents)
    const positions = layoutGraph(agents, edges, heights)
    const depths = computeDepths(agents, edges)

    const rows = new Map<number, Set<number>>()
    for (const a of agents) {
      const depth = depths.get(a.id) as number
      const row = rows.get(depth) ?? new Set<number>()
      row.add((positions.get(a.id) as Position).y)
      rows.set(depth, row)
    }

    expect([...rows.keys()].sort((x, y) => x - y)).toEqual([0, 1, 2])
    for (const [, ys] of rows) expect(ys.size).toBe(1)
  })

  it("orders nesting levels down the canvas, one gap apart", () => {
    const { agents, edges } = fanOut(6, 2)
    const heights = mixedHeights(agents)
    const positions = layoutGraph(agents, edges, heights)

    for (const e of edges) {
      const parent = positions.get(e.fromAgentId) as Position
      const child = positions.get(e.toAgentId) as Position
      const gap = child.y - (parent.y + (heights.get(e.fromAgentId) as number))
      expect(gap).toBeGreaterThanOrEqual(LAYER_GAP)
    }
  })

  it("centres a parent between its first and last child", () => {
    const { agents, edges } = depthThree()
    const positions = layoutGraph(agents, edges)

    for (const [parent, children] of [
      ["root", ["a0", "a1"]],
      ["a0", ["a0b0", "a0b1"]],
      ["a1", ["a1b0", "a1b1"]],
    ] as const) {
      const first = centre(positions, children[0])
      const last = centre(positions, children[children.length - 1] as string)
      expect(centre(positions, parent)).toBeCloseTo((first + last) / 2, 0)
    }
  })

  it("centres a parent over its children rather than over their sub-trees", () => {
    // One leaf beside one deep branch. Centring over the band the family
    // occupies would drag the parent across the canvas towards the wider
    // branch, and it would stop reading as the thing that spawned both.
    const agents = [agent("root", null), agent("leaf", "root", 1), agent("branch", "root", 2)]
    const edges = [edge("root", "leaf"), edge("root", "branch")]
    for (let i = 0; i < 6; i++) {
      agents.push(agent(`k${i}`, "branch", 10 + i))
      edges.push(edge("branch", `k${i}`))
    }
    const positions = layoutGraph(agents, edges)

    expect(centre(positions, "root")).toBeCloseTo(
      (centre(positions, "leaf") + centre(positions, "branch")) / 2,
      0,
    )
  })

  it("sits a parent directly above an only child", () => {
    const agents = [agent("root", null), agent("only", "root")]
    const positions = layoutGraph(agents, [edge("root", "only")])
    expect((positions.get("root") as Position).x).toBe((positions.get("only") as Position).x)
  })

  it("keeps a fan-out on one row at its own nesting level", () => {
    const { agents, edges } = fanOut(20)
    const positions = layoutGraph(agents, edges)

    const subs = agents.slice(1).map((a) => positions.get(a.id) as Position)
    expect(new Set(subs.map((p) => p.y)).size).toBe(1)
    expect(subs.map((p) => p.x).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i * (NODE_WIDTH + NODE_GAP)),
    )
  })

  it("holds two sub-trees further apart than two leaves", () => {
    // Siblings sit shoulder to shoulder; a family gets room around it, so a
    // fan-out is never mistaken for one long row of cousins.
    const { agents, edges } = fanOut(2, 2)
    const positions = layoutGraph(agents, edges)

    const leftEdge = (id: string): number => (positions.get(id) as Position).x
    const rightEdge = (id: string): number => leftEdge(id) + NODE_WIDTH
    expect(leftEdge("s0k1") - rightEdge("s0k0")).toBe(NODE_GAP)
    expect(leftEdge("s1k0") - rightEdge("s0k1")).toBe(SUBTREE_GAP)
  })

  it("gives every sub-tree a horizontal band no sibling sub-tree enters", () => {
    // This is why non-overlap is structural rather than a swept assertion:
    // a collision needs a shared nesting level, and same-level nodes are
    // always inside disjoint bands.
    const { agents, edges } = fanOut(5, 3)
    const positions = layoutGraph(agents, edges)

    const extent = (root: string, members: string[]): { left: number; right: number } => {
      const xs = [root, ...members].map((id) => (positions.get(id) as Position).x)
      return { left: Math.min(...xs), right: Math.max(...xs) + NODE_WIDTH }
    }
    const bands = Array.from({ length: 5 }, (_, i) =>
      extent(`s${i}`, [`s${i}k0`, `s${i}k1`, `s${i}k2`]),
    ).sort((a, b) => a.left - b.left)

    for (let i = 1; i < bands.length; i++) {
      expect((bands[i] as (typeof bands)[number]).left).toBeGreaterThanOrEqual(
        (bands[i - 1] as (typeof bands)[number]).right,
      )
    }
  })

  it("orders siblings by spawn time, so a new subagent joins the right-hand end", () => {
    const agents = [agent("root", null), agent("late", "root", 20), agent("early", "root", 10)]
    const edges = [edge("root", "late"), edge("root", "early")]
    const positions = layoutGraph(agents, edges)

    expect((positions.get("early") as Position).x).toBeLessThan((positions.get("late") as Position).x)
  })

  it("respects the reserved height, so a taller seated node still clears the layer below", () => {
    const { agents, edges } = depthThree()
    const short = new Map(agents.map((a) => [a.id, NODE_HEIGHT]))
    const tallRoot = new Map(short)
    tallRoot.set("root", SEATED_NODE_HEIGHT)

    const shortChild = (layoutGraph(agents, edges, short).get("a0") as Position).y
    const tallChild = (layoutGraph(agents, edges, tallRoot).get("a0") as Position).y
    expect(tallChild - shortChild).toBe(SEATED_NODE_HEIGHT - NODE_HEIGHT)
  })

  it("lays out identically on repeated runs", () => {
    const { agents, edges } = depthThree()
    for (let i = 0; i < 12; i++) {
      agents.push(agent(`f${i}`, i % 2 === 0 ? "root" : "a0", i + 1))
      edges.push(edge(i % 2 === 0 ? "root" : "a0", `f${i}`))
    }
    const heights = mixedHeights(agents)

    const first = layoutGraph(agents, edges, heights)
    const second = layoutGraph(agents, edges, heights)
    expect(second.size).toBe(first.size)
    for (const [id, pos] of first) expect(second.get(id)).toEqual(pos)
  })

  it("handles a deep chain of subagents without overlap at any depth", () => {
    const agents: AgentEntity[] = [agent("n0", null)]
    const edges: EdgeEntity[] = []
    for (let i = 1; i < 8; i++) {
      agents.push(agent(`n${i}`, `n${i - 1}`))
      edges.push(edge(`n${i - 1}`, `n${i}`))
    }
    const heights = mixedHeights(agents)
    const positions = layoutGraph(agents, edges, heights)

    let previousBottom = -Infinity
    for (const a of agents) {
      const pos = positions.get(a.id) as Position
      expect(pos.y).toBeGreaterThan(previousBottom)
      previousBottom = pos.y + (heights.get(a.id) as number)
    }
  })

  it("returns nothing for an empty graph", () => {
    expect(layoutGraph([], []).size).toBe(0)
  })

  it("still places agents whose parent edge has not been reconciled", () => {
    // An orphan must not vanish from the canvas, and must not be drawn as
    // though it belonged to the tree beside it.
    const agents = [agent("root", null), agent("orphan", null, 5)]
    const positions = layoutGraph(agents, [], new Map())

    expect(positions.size).toBe(2)
    expect((positions.get("orphan") as Position).x).toBe(NODE_WIDTH + ROOT_GAP)
    expect((positions.get("orphan") as Position).y).toBe(0)
  })

  it("draws an agent whose parent is not on the canvas as a root", () => {
    // The canvas renders a filtered slice of a session. A child hanging one
    // level below nothing is worse than a second root.
    const positions = layoutGraph([agent("stray", "filtered-out")], [])
    expect((positions.get("stray") as Position).y).toBe(0)
  })
})

/**
 * The layout constants are a copy of numbers that really live in the
 * stylesheet, and the stylesheet is edited without this file. These pin the
 * two together so the drift is a failing test rather than overlapping nodes.
 */
describe("layout constants against app-surfaces.css", () => {
  const css = readFileSync(new URL("../src/app-surfaces.css", import.meta.url), "utf8")

  function rule(selector: string): string {
    const match = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css)
    if (!match) throw new Error(`no ${selector} rule in app-surfaces.css`)
    return match[1] as string
  }

  function pixels(body: string, property: string): number {
    const match = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*(\\d+)px`).exec(body)
    if (!match) throw new Error(`no ${property} in rule body`)
    return Number(match[1])
  }

  it("reserves exactly the width the CSS gives a node", () => {
    expect(NODE_WIDTH).toBe(pixels(rule(".employee-node"), "width"))
  })

  it("reserves at least the minimum height the CSS gives a node", () => {
    // An unseated node has nothing but a header and a footer, so `min-height`
    // is what it renders at. Reserving less would overlap the layer below.
    expect(NODE_HEIGHT).toBeGreaterThanOrEqual(pixels(rule(".employee-node"), "min-height"))
  })

  it("reserves more for a seated node, which grows a tone block and chips", () => {
    expect(SEATED_NODE_HEIGHT).toBeGreaterThan(NODE_HEIGHT)
  })

  it("keeps the lineage accents out of the reserved height", () => {
    // Both are absolutely positioned, so neither can push a node past the
    // reservation the layout made for it.
    expect(rule(".node-lineage")).toContain("position: absolute")
    expect(rule(".node-lineage-mark")).toContain("position: absolute")
  })
})

describe("buildHierarchy", () => {
  it("builds one tree per root, with children under their parent", () => {
    const { agents, edges } = depthThree()
    const [tree, ...rest] = buildHierarchy(agents, edges)

    expect(rest).toEqual([])
    expect(tree?.id).toBe("root")
    expect(tree?.children.map((child) => child.id)).toEqual(["a0", "a1"])
    expect(tree?.children[0]?.children.map((child) => child.id)).toEqual(["a0b0", "a0b1"])
  })

  it("prefers the reconciled parent field over an observed edge", () => {
    const agents = [agent("root", null), agent("mid", "root", 1), agent("leaf", "mid", 2)]
    // A stale edge claims the root spawned the leaf; the entity says otherwise.
    const [tree] = buildHierarchy(agents, [edge("root", "mid"), edge("root", "leaf"), edge("mid", "leaf")])

    expect(tree?.children.map((child) => child.id)).toEqual(["mid"])
    expect(tree?.children[0]?.children.map((child) => child.id)).toEqual(["leaf"])
  })
})

describe("computeDepths", () => {
  it("measures distance from the root agent", () => {
    const { agents, edges } = depthThree()
    const depths = computeDepths(agents, edges)
    expect(depths.get("root")).toBe(0)
    expect(depths.get("a0")).toBe(1)
    expect(depths.get("a0b1")).toBe(2)
  })

  it("measures every agent on a wide graph of nested sub-trees", () => {
    const { agents, edges } = fanOut(14, 1)
    const depths = computeDepths(agents, edges)
    expect(depths.size).toBe(agents.length)
    expect(depths.get("root")).toBe(0)
    expect(depths.get("s7")).toBe(1)
    expect(depths.get("s7k0")).toBe(2)
  })

  it("breaks a parent cycle instead of hanging or stacking its members", () => {
    // Both agents claim the other as their parent. The forest breaks the cycle
    // at its earliest member, which has to leave them on different levels —
    // same level plus the same band would mean two cards on top of each other.
    const depths = computeDepths([agent("x", "y", 1), agent("y", "x", 2)], [])
    expect([...depths.values()].sort()).toEqual([0, 1])
  })

  it("does not turn a peer message into parentage", () => {
    const depths = computeDepths(
      [agent("root", null), agent("first", "root"), agent("second", null)],
      [edge("root", "first"), edge("first", "second", "messaged")],
    )

    expect(depths.get("first")).toBe(1)
    expect(depths.get("second")).toBe(0)
  })

  it("classifies communication separately from hierarchy edges", () => {
    expect(edgeAffectsHierarchy(edge("a", "b", "spawned"))).toBe(true)
    expect(edgeAffectsHierarchy(edge("a", "b", "delegated"))).toBe(true)
    expect(edgeAffectsHierarchy(edge("a", "b", "forked"))).toBe(true)
    expect(edgeAffectsHierarchy(edge("a", "b", "messaged"))).toBe(false)
  })
})

describe("graphSignature", () => {
  it("is stable when nothing about the graph shape changed", () => {
    const { agents, edges } = depthThree()
    expect(graphSignature(agents, edges)).toBe(graphSignature(agents, edges))
  })

  it("changes when an agent is spawned", () => {
    const { agents, edges } = depthThree()
    const before = graphSignature(agents, edges)
    expect(graphSignature([...agents, agent("a2", "root")], edges)).not.toBe(before)
  })

  it("changes when an edge is recorded", () => {
    const { agents, edges } = depthThree()
    const before = graphSignature(agents, edges)
    expect(graphSignature(agents, [...edges, edge("root", "a0b0")])).not.toBe(before)
  })

  it("does not relayout when a peer message is recorded", () => {
    const { agents, edges } = depthThree()
    const before = graphSignature(agents, edges)

    expect(graphSignature(agents, [...edges, edge("a0", "a1", "messaged")])).toBe(before)
  })

  it("ignores status and activity churn, which must not trigger a relayout", () => {
    // The graph re-renders every second while an agent is live. Relaying out
    // on each tick would fight the developer, so the signature must not move.
    const { agents, edges } = depthThree()
    const before = graphSignature(agents, edges)
    const busy = agents.map((a) => ({ ...a, status: "completed" as const, updatedAt: 999, totalTokens: 42 }))
    expect(graphSignature(busy, edges)).toBe(before)
  })
})
