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
 * Reserved node width, in sync with `.employee-node` in `app-surfaces.css`.
 *
 * Unlike height this genuinely is one number: every node is the same width by
 * CSS, and only the height varies with content. It still has to be kept in
 * step with the stylesheet by hand — if `.employee-node`'s width moves and
 * this does not, ELK reserves the wrong column and the gap between siblings
 * silently changes.
 */
export const NODE_WIDTH = 300

/**
 * Reserved heights, in sync with `.employee-node` in `app-surfaces.css`.
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
 * So no ELK algorithm wraps a wide layer without drawing a child above its
 * parent. `layered` is kept because it is the narrowest option that never
 * inverts a parent and child, and because it reserves a uniform LAYER_GAP
 * band between depths — `mrtree` compacts subtrees independently and lets
 * that gap collapse to NODE_GAP, so "which depth is this Agent at" stops
 * being readable off the y coordinate.
 *
 * Width is solved downstream instead: `layoutGraph` keeps ELK's
 * crossing-minimised left-to-right order per depth band untouched and folds
 * each band into rows of at most MAX_BAND_COLUMNS columns itself, where the
 * depth ordering makes the parent-above-child invariant structural rather
 * than something the layout algorithm has to be talked into.
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
 * Columns per wrapped row within one depth band.
 *
 * Since no ELK algorithm wraps a layer without inverting a parent and child
 * (see `LAYOUT_OPTIONS` above), `layoutGraph` runs ELK purely for its
 * crossing-minimised sibling order, then re-lays each depth band onto a grid
 * of at most this many columns. The wrap cannot invert anything: bands are
 * laid out strictly in depth order, so every row of band d sits entirely
 * above every row of band d+1, and depth(child) = depth(parent) + 1 is a
 * structural property of `computeDepths`, not something to re-prove per edge.
 *
 * The value is a flat cap rather than a per-band `ceil(sqrt(n · aspect))`
 * because a derived K makes every existing position in a band depend on the
 * band's population: the 21st sibling bumps K from 6 to 7 and re-chunks the
 * entire band under a developer who is reading one of its nodes. A flat cap
 * is append-only — a new sibling joins the last row that has room, or opens
 * the next one — which is the same stability rule `considerModelOrder` buys
 * upstream. Measured on the flagship fan-out, root + 20 subagents (all
 * unseated, so 150px rows), laid out under each candidate cap:
 *
 * | K | rows      | canvas      | zoom to fit a 1800x1000 pane |
 * | - | --------- | ----------- | ---------------------------- |
 * | 4 | 5 rows    | 1344 x 1182 | 0.85                         |
 * | 5 | 4 x 5     | 1692 x 984  | 1.02                         |
 * | 6 | 6,6,6,2   | 2040 x 984  | 0.88                         |
 *
 * 5 wins: five columns span 5·(NODE_WIDTH + NODE_GAP) − NODE_GAP = 1692px,
 * which fits a ~1800px canvas pane at zoom 1.0 — a full band reads without
 * any zoom-out — and it is the only cap whose wrapped flagship graph fits
 * BOTH dimensions of that pane without zooming out (aspect 1.72 ≈ 16:9,
 * versus 6912 x 570 unwrapped). Four columns goes tall enough to force
 * zoom-out anyway; six needs a wider pane than most windows give the canvas
 * once the worker card is open, and leaves a ragged row of 2.
 *
 * Rows are left-aligned, not centred: centring shifts every node in a row
 * sideways whenever that row's population changes — which during a spawn
 * burst is constantly — while left-align never moves a placed node.
 *
 * Rows inside a band are separated by NODE_GAP and depth bands by
 * LAYER_GAP, so a wrapped band still reads as ONE depth: tight vertical
 * spacing = same depth, loose = new depth. The cost of wrapping, accepted:
 * an edge from an upper row to a lower band passes behind the rows between
 * it and its child. React Flow draws edges under nodes, so that reads as a
 * line slipping behind a sibling rather than a broken graph; unwrapping to
 * avoid it was the single endless row this constant exists to fix.
 */
export const MAX_BAND_COLUMNS = 5

/** An agent ELK has placed, carrying its x as the within-band order key. */
interface Placed {
  id: string
  order: number
}

/**
 * Folds each depth band into rows of at most MAX_BAND_COLUMNS columns.
 *
 * `placed` arrives in any order; within a band it is sorted by `order` (the
 * ELK x coordinate, or array index on the fallback path), which preserves
 * exactly the left-to-right order the layout algorithm decided — only the
 * geometry is re-flowed. Bands are laid out strictly in depth order and rows
 * are assigned y monotonically, so a parent can never be drawn below its
 * child: every row of band d ends above where band d+1 begins.
 *
 * Both paths (ELK and fallback) go through here, so their shapes stay
 * identical by construction.
 */
function wrapDepthBands(
  placed: Placed[],
  depths: Map<string, number>,
  heightOf: (id: string) => number,
): Map<string, Position> {
  const bands = new Map<number, Placed[]>()
  for (const node of placed) {
    const depth = depths.get(node.id) ?? 0
    const band = bands.get(depth)
    if (band) band.push(node)
    else bands.set(depth, [node])
  }

  const positions = new Map<string, Position>()
  let y = 0
  for (const depth of [...bands.keys()].sort((a, b) => a - b)) {
    const band = (bands.get(depth) ?? []).sort((a, b) => a.order - b.order)
    for (let start = 0; start < band.length; start += MAX_BAND_COLUMNS) {
      const row = band.slice(start, start + MAX_BAND_COLUMNS)
      row.forEach((node, column) => {
        positions.set(node.id, { x: Math.round(column * (NODE_WIDTH + NODE_GAP)), y: Math.round(y) })
      })
      // The next row starts below the tallest node in this one, so a row of
      // seated nodes does not overlap the row beneath it.
      const tallest = row.reduce((max, node) => Math.max(max, heightOf(node.id)), NODE_HEIGHT)
      y += tallest + NODE_GAP
    }
    // The loop above left a NODE_GAP after the deepest row; widen it to the
    // LAYER_GAP that separates this depth band from the next.
    y += LAYER_GAP - NODE_GAP
  }
  return positions
}

/**
 * Lays the agent graph out top-down.
 *
 * Agents with no recorded parent are treated as roots, which keeps orphaned
 * nodes visible: a subagent whose parent edge has not been reconciled yet must
 * still appear on the canvas rather than vanish.
 *
 * ELK decides sibling order and crossing minimisation; its coordinates are
 * then folded into wrapped depth bands (see `MAX_BAND_COLUMNS`), because ELK
 * itself will not wrap a wide layer without drawing children above parents.
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
  if (agents.length === 0) return new Map()

  const heightOf = (id: string): number => heights?.get(id) ?? NODE_HEIGHT
  const depths = computeDepths(agents, edges)
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
    const placed: Placed[] = (result.children ?? []).map((child) => ({
      id: child.id,
      order: child.x ?? 0,
    }))
    if (placed.length !== agents.length) throw new Error("incomplete layout")
    return wrapDepthBands(placed, depths, heightOf)
  } catch {
    // Layout must never blank the canvas. Fall back to depth-ordered rows so
    // the parent/child structure stays readable even without ELK, wrapped by
    // the same bands as the ELK path. Array order stands in for ELK's x.
    const placed: Placed[] = agents.map((agent, index) => ({ id: agent.id, order: index }))
    return wrapDepthBands(placed, depths, heightOf)
  }
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
