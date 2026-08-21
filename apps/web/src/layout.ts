import ELK from "elkjs/lib/elk.bundled.js"
import type { AgentEntity, EdgeEntity } from "@observer-ai/protocol"

interface ElkResult {
  children?: Array<{ id: string; x?: number; y?: number }>
}

/**
 * ELK is imported statically on purpose.
 *
 * It is a CommonJS bundle, and its default export does not survive Vite's
 * dynamic-import interop reliably, which silently degraded the graph to the
 * fallback layout. A slightly larger initial bundle is worth a correct graph.
 */
const elk = new (ELK as unknown as new () => { layout(graph: unknown): Promise<ElkResult> })()

/**
 * Reserved node width, in sync with `.employee-node` in `styles.css`.
 *
 * Unlike height this genuinely is one number: every node is the same width by
 * CSS, and only the height varies with content. It still has to be kept in
 * step with the stylesheet by hand — if `.employee-node`'s width moves and
 * this does not, ELK reserves the wrong column and the gap between siblings
 * silently changes.
 */
export const NODE_WIDTH = 300

/**
 * Reserved heights, in sync with `.employee-node` in `styles.css`.
 *
 * An unseated node is header + footer only — 30 (border + padding) + 54
 * (header) + 8 + 20 (footer) = 112 — so the CSS `min-height: 150px` governs.
 * A seated node adds a tone block and a strengths row:
 * 30 + 54 (header) + 8 + 48 (2-line tone, with its own padding and border)
 * + 8 + 44 (two chip rows) + 8 + 20 (footer) = 220.
 *
 * Under-reserving is the visible mistake: ELK stacks the next layer LAYER_GAP
 * below the reserved bottom edge, so a node that renders taller than its
 * reservation eats that gap and the spawn edges kink through its neighbours.
 *
 * These are first-paint estimates only. `Canvas.tsx` feeds React Flow's
 * measured heights back in and reserves the larger of the two, so the
 * stylesheet stays the source of truth even when these numbers drift — which
 * they do, because the stylesheet is not edited alongside this file.
 */
export const NODE_HEIGHT = 150
export const SEATED_NODE_HEIGHT = 220

/** Horizontal gap between two Agents at the same depth. */
export const NODE_GAP = 48
/** Vertical gap between one depth band and the next. */
export const LAYER_GAP = 90

export interface Position {
  x: number
  y: number
}

/**
 * ELK options for the agent graph.
 *
 * `layered` + `DOWN` is kept deliberately, against the obvious alternatives.
 * Measured on this node size (300px wide, 150-220px tall, 48/90px gaps):
 *
 * | graph              | layered     | mrtree      | rectpacking          |
 * | ------------------ | ----------- | ----------- | -------------------- |
 * | root + 20 subs     | 6912 x 570  | 6912 x 418  | 2040 x 1024, 5 bad   |
 * | depth-3 (4 then 3) | 4128 x 770  | 4128 x 686  | 1692 x 1024, 4 bad   |
 * | depth-4 (3,2,2)    | 4128 x 1080 | 4128 x 954  | 2040 x 1024, 5 bad   |
 *
 * "bad" counts parent/child pairs where the child was placed above its
 * parent. Three things fall out of that:
 *
 * 1. Width is identical for `layered` and `mrtree`. Neither wraps a wide
 *    sibling row; the width of a depth band is just its Agent count times
 *    (NODE_WIDTH + NODE_GAP). `mrtree` does not "wrap naturally" here — it is
 *    exactly the same width and merely shorter, i.e. a worse aspect ratio.
 * 2. `elk.aspectRatio` changes nothing at all under `layered`, and
 *    `elk.layered.wrapping.strategy` wraps a long *chain of layers*, not a
 *    wide layer — and when it does wrap it places a child above its parent,
 *    which destroys the one thing the canvas has to communicate.
 * 3. `rectpacking` is the only algorithm that genuinely wraps, and it inverts
 *    parents and children in every scenario measured. Depth stops reading
 *    vertically.
 *
 * So layout cannot solve width; zooming out solves width. `layered` is kept
 * because it is the narrowest option that never inverts a parent and child,
 * and because it reserves a uniform LAYER_GAP band between depths — `mrtree`
 * compacts subtrees independently and lets that gap collapse to NODE_GAP, so
 * "which depth is this Agent at" stops being readable off the y coordinate.
 */
const LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.layered.spacing.nodeNodeBetweenLayers": String(LAYER_GAP),
  "elk.spacing.nodeNode": String(NODE_GAP),
  // Keeps spawn order stable as the graph grows, so an Agent appearing does
  // not reshuffle its siblings under a developer who is reading one of them.
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
}

/**
 * Lays the agent graph out top-down.
 *
 * Agents with no recorded parent are treated as roots, which keeps orphaned
 * nodes visible: a subagent whose parent edge has not been reconciled yet must
 * still appear on the canvas rather than vanish.
 *
 * `heights` carries the reserved height per agent id, because a seated node is
 * substantially taller than an unseated one. Anything missing falls back to
 * the unseated height.
 */
export async function layoutGraph(
  agents: AgentEntity[],
  edges: EdgeEntity[],
  heights?: ReadonlyMap<string, number>,
): Promise<Map<string, Position>> {
  const positions = new Map<string, Position>()
  if (agents.length === 0) return positions

  const heightOf = (id: string): number => heights?.get(id) ?? NODE_HEIGHT
  const ids = new Set(agents.map((agent) => agent.id))
  const graph = {
    id: "root",
    layoutOptions: LAYOUT_OPTIONS,
    children: agents.map((agent) => ({ id: agent.id, width: NODE_WIDTH, height: heightOf(agent.id) })),
    edges: edges
      .filter((edge) => ids.has(edge.fromAgentId) && ids.has(edge.toAgentId))
      .map((edge) => ({ id: edge.id, sources: [edge.fromAgentId], targets: [edge.toAgentId] })),
  }

  try {
    const result = await elk.layout(graph)
    for (const child of result.children ?? []) {
      positions.set(child.id, { x: Math.round(child.x ?? 0), y: Math.round(child.y ?? 0) })
    }
    if (positions.size === agents.length) return positions
    throw new Error("incomplete layout")
  } catch {
    // Layout must never blank the canvas. Fall back to depth-ordered rows so
    // the parent/child structure stays readable even without ELK.
    positions.clear()
    const depths = computeDepths(agents, edges)
    const byDepth = new Map<number, AgentEntity[]>()
    for (const agent of agents) {
      const depth = depths.get(agent.id) ?? 0
      const row = byDepth.get(depth) ?? []
      row.push(agent)
      byDepth.set(depth, row)
    }
    // Each row starts below the tallest node in the row above, so a deep tree
    // of seated nodes does not overlap itself.
    let y = 0
    for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
      const row = byDepth.get(depth) ?? []
      row.forEach((agent, index) => {
        positions.set(agent.id, { x: Math.round(index * (NODE_WIDTH + NODE_GAP)), y: Math.round(y) })
      })
      const tallest = row.reduce((max, agent) => Math.max(max, heightOf(agent.id)), NODE_HEIGHT)
      y += tallest + LAYER_GAP
    }
  }
  return positions
}

/** Distance from a root agent. Used by the fallback layout and by tests. */
export function computeDepths(agents: AgentEntity[], edges: EdgeEntity[]): Map<string, number> {
  const parents = new Map<string, string>()
  for (const edge of edges) parents.set(edge.toAgentId, edge.fromAgentId)
  for (const agent of agents) {
    if (agent.parentAgentId) parents.set(agent.id, agent.parentAgentId)
  }
  const depths = new Map<string, number>()
  for (const agent of agents) {
    let depth = 0
    let cursor: string | undefined = parents.get(agent.id)
    const seen = new Set<string>([agent.id])
    while (cursor && !seen.has(cursor) && depth < 16) {
      seen.add(cursor)
      depth++
      cursor = parents.get(cursor)
    }
    depths.set(agent.id, depth)
  }
  return depths
}

/** Signature used to decide whether the layout must be recomputed. */
export function graphSignature(agents: AgentEntity[], edges: EdgeEntity[]): string {
  return `${agents.map((a) => a.id).join("|")}::${edges.map((e) => e.id).join("|")}`
}
