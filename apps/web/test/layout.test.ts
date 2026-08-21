import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { AgentEntity, EdgeEntity } from "@observer-ai/protocol"
import {
  LAYER_GAP,
  NODE_GAP,
  NODE_HEIGHT,
  NODE_WIDTH,
  SEATED_NODE_HEIGHT,
  computeDepths,
  graphSignature,
  layoutGraph,
  type Position,
} from "../src/layout"

function agent(id: string, parentAgentId: string | null): AgentEntity {
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
    startedAt: 0,
    endedAt: null,
    updatedAt: 0,
    totalTokens: null,
    durationMs: null,
  }
}

function edge(from: string, to: string): EdgeEntity {
  return {
    id: `${from}->${to}`,
    sessionId: "opencode:s1",
    fromAgentId: from,
    toAgentId: to,
    edgeType: "spawned",
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

/** Alternates seated and unseated so the layout is exercised with mixed heights. */
function mixedHeights(agents: AgentEntity[]): Map<string, number> {
  return new Map(agents.map((a, index) => [a.id, index % 2 === 0 ? SEATED_NODE_HEIGHT : NODE_HEIGHT]))
}

function overlaps(a: { pos: Position; h: number }, b: { pos: Position; h: number }): boolean {
  const overlapX = Math.min(a.pos.x + NODE_WIDTH, b.pos.x + NODE_WIDTH) - Math.max(a.pos.x, b.pos.x)
  const overlapY = Math.min(a.pos.y + a.h, b.pos.y + b.h) - Math.max(a.pos.y, b.pos.y)
  return overlapX > 0 && overlapY > 0
}

describe("layoutGraph", () => {
  it("places every agent exactly once", async () => {
    const { agents, edges } = depthThree()
    const positions = await layoutGraph(agents, edges, mixedHeights(agents))
    expect(positions.size).toBe(agents.length)
    for (const a of agents) expect(positions.get(a.id)).toBeDefined()
  })

  it("never overlaps two nodes in a depth-3 graph with mixed heights", async () => {
    const { agents, edges } = depthThree()
    const heights = mixedHeights(agents)
    const positions = await layoutGraph(agents, edges, heights)

    const boxes = agents.map((a) => ({
      id: a.id,
      pos: positions.get(a.id) as Position,
      h: heights.get(a.id) as number,
    }))
    const collisions: string[] = []
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const first = boxes[i] as (typeof boxes)[number]
        const second = boxes[j] as (typeof boxes)[number]
        if (overlaps(first, second)) collisions.push(`${first.id}/${second.id}`)
      }
    }
    expect(collisions).toEqual([])
  })

  it("keeps depth reading vertically: every subagent sits below its parent", async () => {
    const { agents, edges } = depthThree()
    const heights = mixedHeights(agents)
    const positions = await layoutGraph(agents, edges, heights)

    for (const e of edges) {
      const parent = positions.get(e.fromAgentId) as Position
      const child = positions.get(e.toAgentId) as Position
      const parentBottom = parent.y + (heights.get(e.fromAgentId) as number)
      expect(child.y).toBeGreaterThanOrEqual(parentBottom)
    }
  })

  it("keeps depth bands from interleaving", async () => {
    const { agents, edges } = depthThree()
    const heights = mixedHeights(agents)
    const positions = await layoutGraph(agents, edges, heights)
    const depths = computeDepths(agents, edges)

    // ELK centres nodes of differing heights within a layer, so same-depth
    // agents do not share a top edge. What has to hold for depth to read
    // vertically is stronger and simpler: every agent at depth N+1 starts
    // below every agent at depth N.
    const bands = new Map<number, { top: number; bottom: number }>()
    for (const a of agents) {
      const depth = depths.get(a.id) as number
      const pos = positions.get(a.id) as Position
      const bottom = pos.y + (heights.get(a.id) as number)
      const band = bands.get(depth)
      bands.set(depth, {
        top: Math.min(band?.top ?? Infinity, pos.y),
        bottom: Math.max(band?.bottom ?? -Infinity, bottom),
      })
    }

    const ordered = [...bands.entries()].sort((a, b) => a[0] - b[0])
    expect(ordered.map(([depth]) => depth)).toEqual([0, 1, 2])
    for (let i = 1; i < ordered.length; i++) {
      const above = (ordered[i - 1] as (typeof ordered)[number])[1]
      const below = (ordered[i] as (typeof ordered)[number])[1]
      expect(below.top).toBeGreaterThanOrEqual(above.bottom)
    }
  })

  it("separates depth bands by at least the configured layer gap", async () => {
    const { agents, edges } = depthThree()
    const heights = mixedHeights(agents)
    const positions = await layoutGraph(agents, edges, heights)

    for (const e of edges) {
      const parent = positions.get(e.fromAgentId) as Position
      const child = positions.get(e.toAgentId) as Position
      const gap = child.y - (parent.y + (heights.get(e.fromAgentId) as number))
      expect(gap).toBeGreaterThanOrEqual(LAYER_GAP)
    }
  })

  it("respects the reserved height, so a taller seated node still clears the layer below", async () => {
    // Same graph laid out twice: once with every node short, once with the
    // root seated and therefore much taller. The layer below has to move down.
    const { agents, edges } = depthThree()
    const short = new Map(agents.map((a) => [a.id, NODE_HEIGHT]))
    const tallRoot = new Map(short)
    tallRoot.set("root", SEATED_NODE_HEIGHT)

    const shortPositions = await layoutGraph(agents, edges, short)
    const tallPositions = await layoutGraph(agents, edges, tallRoot)

    const shortChild = (shortPositions.get("a0") as Position).y
    const tallChild = (tallPositions.get("a0") as Position).y
    expect(tallChild - shortChild).toBe(SEATED_NODE_HEIGHT - NODE_HEIGHT)
  })

  it("lays a wide fan-out out in a single row, which is what zooming out is for", async () => {
    // 20 subagents under one root: the product's central scenario. Nothing
    // wraps it, so this pins the width the canvas must be able to zoom to fit.
    const agents = [agent("root", null)]
    const edges: EdgeEntity[] = []
    for (let i = 0; i < 20; i++) {
      agents.push(agent(`a${i}`, "root"))
      edges.push(edge("root", `a${i}`))
    }
    const positions = await layoutGraph(agents, edges, new Map(agents.map((a) => [a.id, NODE_HEIGHT])))

    const subs = agents.slice(1).map((a) => positions.get(a.id) as Position)
    expect(new Set(subs.map((p) => p.y)).size).toBe(1)

    const xs = subs.map((p) => p.x).sort((a, b) => a - b)
    const width = (xs[xs.length - 1] as number) + NODE_WIDTH - (xs[0] as number)
    expect(width).toBe(20 * NODE_WIDTH + 19 * NODE_GAP)
    // Fitting that into a ~1800px viewport needs to zoom out well past 1,
    // which is why Canvas.tsx sets minZoom to 0.25 and not 1. It also pins
    // how far 0.25 gets us: this is roughly the widest graph Fit can frame.
    expect(1800 / width).toBeLessThan(0.5)
    expect(1800 / width).toBeGreaterThan(0.24)
  })

  it("handles a deep chain of subagents without overlap at any depth", async () => {
    const agents: AgentEntity[] = [agent("n0", null)]
    const edges: EdgeEntity[] = []
    for (let i = 1; i < 8; i++) {
      agents.push(agent(`n${i}`, `n${i - 1}`))
      edges.push(edge(`n${i - 1}`, `n${i}`))
    }
    const heights = mixedHeights(agents)
    const positions = await layoutGraph(agents, edges, heights)

    let previousBottom = -Infinity
    for (const a of agents) {
      const pos = positions.get(a.id) as Position
      expect(pos.y).toBeGreaterThan(previousBottom)
      previousBottom = pos.y + (heights.get(a.id) as number)
    }
  })

  it("returns nothing for an empty graph", async () => {
    expect((await layoutGraph([], [])).size).toBe(0)
  })

  it("still places agents whose parent edge has not been reconciled", async () => {
    // An orphan must not vanish from the canvas.
    const agents = [agent("root", null), agent("orphan", null)]
    const positions = await layoutGraph(agents, [], new Map())
    expect(positions.size).toBe(2)
  })
})

/**
 * The layout constants are ELK's copy of numbers that really live in the
 * stylesheet, and the stylesheet is edited without this file. These pin the
 * two together so the drift is a failing test rather than overlapping nodes.
 */
describe("layout constants against styles.css", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8")

  function rule(selector: string): string {
    const match = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css)
    if (!match) throw new Error(`no ${selector} rule in styles.css`)
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
})

describe("computeDepths", () => {
  it("measures distance from the root agent", () => {
    const { agents, edges } = depthThree()
    const depths = computeDepths(agents, edges)
    expect(depths.get("root")).toBe(0)
    expect(depths.get("a0")).toBe(1)
    expect(depths.get("a0b1")).toBe(2)
  })

  it("does not hang on a parent cycle", () => {
    const a = agent("x", "y")
    const b = agent("y", "x")
    expect(() => computeDepths([a, b], [])).not.toThrow()
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

  it("ignores status and activity churn, which must not trigger a relayout", () => {
    // The graph re-renders every second while an agent is live. Relaying out
    // on each tick would fight the developer, so the signature must not move.
    const { agents, edges } = depthThree()
    const before = graphSignature(agents, edges)
    const busy = agents.map((a) => ({ ...a, status: "completed" as const, updatedAt: 999, totalTokens: 42 }))
    expect(graphSignature(busy, edges)).toBe(before)
  })
})
