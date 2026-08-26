import type { AgentEntity, EdgeEntity } from "@observer-ai/protocol"

/**
 * Reserved node width, in sync with `.employee-node` in `app-surfaces.css`.
 *
 * Unlike height this genuinely is one number: every node is the same width by
 * CSS, and only the height varies with content. It still has to be kept in
 * step with the stylesheet by hand — if `.employee-node`'s width moves and
 * this does not, the tree reserves the wrong column and the gap between
 * siblings silently changes.
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
 * Under-reserving is the visible mistake: the next depth sits LAYER_GAP below
 * the tallest reservation in this one, so a node that renders taller than its
 * reservation eats that gap and the spawn edges kink through its neighbours.
 *
 * These are first-paint estimates only. `Canvas.tsx` feeds React Flow's
 * measured heights back in and reserves the larger of the two, so the
 * stylesheet stays the source of truth even when these numbers drift — which
 * they do, because the stylesheet is not edited alongside this file.
 */
export const NODE_HEIGHT = 150
export const SEATED_NODE_HEIGHT = 220
export const TASK_NODE_HEIGHT = 190
export const SEATED_TASK_NODE_HEIGHT = 260

/** Horizontal gap between two leaf siblings. */
export const NODE_GAP = 48

/**
 * Horizontal gap between two adjacent blocks when either carries children of
 * its own.
 *
 * Wider than NODE_GAP so a family reads as a family: siblings sit shoulder to
 * shoulder, but two sub-trees are held apart far enough that their fan-outs
 * are not mistaken for one row of cousins.
 */
export const SUBTREE_GAP = 96

/** Vertical gap between one depth band and the next. */
export const LAYER_GAP = 90

/**
 * Horizontal gap between two independent trees.
 *
 * A session can hold several roots — an orphan whose spawn edge has not been
 * reconciled is drawn as one — and they are separate graphs, not siblings.
 */
export const ROOT_GAP = 200

export interface Position {
  x: number
  y: number
}

/** Communication is an overlay between peers, not evidence of parentage. */
export function edgeAffectsHierarchy(edge: Pick<EdgeEntity, "edgeType">): boolean {
  return edge.edgeType !== "messaged"
}

/**
 * One agent in the spawn tree, with its cycles already broken.
 *
 * `depth` is the distance from this tree's root, and it is authoritative: the
 * whole layout keys y off it, so it has to come from the same traversal that
 * decides who is whose child. Deriving it separately by walking parent links
 * is what used to let a parent cycle put two nodes on the same y at the same
 * x.
 */
export interface HierarchyNode {
  id: string
  depth: number
  children: HierarchyNode[]
}

/**
 * Parent per agent id, from the reconciled entity field and hierarchy edges.
 *
 * A parent that is not itself on the canvas is dropped rather than followed.
 * The canvas only ever renders a filtered slice of a session, and an agent
 * whose parent was filtered out has to be drawn as a root — the alternative is
 * a child hanging one depth below nothing.
 */
function parentMap(agents: AgentEntity[], edges: EdgeEntity[]): Map<string, string> {
  const ids = new Set(agents.map((agent) => agent.id))
  const parents = new Map<string, string>()
  for (const edge of edges) {
    if (!edgeAffectsHierarchy(edge)) continue
    if (edge.fromAgentId === edge.toAgentId) continue
    if (!ids.has(edge.fromAgentId) || !ids.has(edge.toAgentId)) continue
    parents.set(edge.toAgentId, edge.fromAgentId)
  }
  // The entity field is the reconciled truth and outranks an observed edge.
  for (const agent of agents) {
    const parent = agent.parentAgentId
    if (parent && parent !== agent.id && ids.has(parent)) parents.set(agent.id, parent)
  }
  return parents
}

/**
 * Append-only sibling order.
 *
 * Spawn time, then id as the tie-break. A subagent that appears mid-read joins
 * the right-hand end of its row instead of shuffling the siblings a developer
 * is in the middle of reading.
 */
function bySpawnOrder(a: AgentEntity, b: AgentEntity): number {
  if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Builds the spawn forest: one `HierarchyNode` tree per root.
 *
 * Every agent appears exactly once. Agents caught in a parent cycle are
 * reachable from no root, so once the real roots are planted the remaining
 * agents are planted in spawn order — which breaks each cycle at its earliest
 * member and keeps it on the canvas instead of dropping it.
 */
export function buildHierarchy(agents: AgentEntity[], edges: EdgeEntity[]): HierarchyNode[] {
  const parents = parentMap(agents, edges)
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const childrenOf = new Map<string, AgentEntity[]>()
  const roots: AgentEntity[] = []

  for (const agent of agents) {
    const parent = parents.get(agent.id)
    if (parent === undefined) {
      roots.push(agent)
      continue
    }
    const siblings = childrenOf.get(parent)
    if (siblings) siblings.push(agent)
    else childrenOf.set(parent, [agent])
  }
  for (const siblings of childrenOf.values()) siblings.sort(bySpawnOrder)
  roots.sort(bySpawnOrder)

  const planted = new Set<string>()
  const build = (agent: AgentEntity, depth: number): HierarchyNode | undefined => {
    if (planted.has(agent.id)) return undefined
    planted.add(agent.id)
    const children: HierarchyNode[] = []
    for (const child of childrenOf.get(agent.id) ?? []) {
      const subtree = build(child, depth + 1)
      if (subtree) children.push(subtree)
    }
    return { id: agent.id, depth, children }
  }

  const trees: HierarchyNode[] = []
  for (const root of roots) {
    const tree = build(root, 0)
    if (tree) trees.push(tree)
  }
  for (const agent of [...agents].sort(bySpawnOrder)) {
    const tree = build(agent, 0)
    if (tree) trees.push(tree)
  }
  return trees
}

/** Visits every node of every tree, parents before children. */
export function forEachHierarchyNode(trees: HierarchyNode[], visit: (node: HierarchyNode) => void): void {
  const stack = [...trees].reverse()
  while (stack.length > 0) {
    const node = stack.pop() as HierarchyNode
    visit(node)
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i] as HierarchyNode)
  }
}

/**
 * The y coordinate of every depth, shared by every node at that depth.
 *
 * This is the whole point of the vertical axis: a node's y says nothing except
 * how deeply nested it is. Two agents sit on the same line if and only if they
 * are the same number of spawns away from a root, so nesting level is legible
 * without following a single edge. A band is as tall as its tallest reserved
 * node, which is what keeps a seated node from eating the layer gap below it.
 */
function levelOffsets(trees: HierarchyNode[], heightOf: (id: string) => number): Map<number, number> {
  const tallest = new Map<number, number>()
  forEachHierarchyNode(trees, (node) => {
    tallest.set(node.depth, Math.max(tallest.get(node.depth) ?? NODE_HEIGHT, heightOf(node.id)))
  })

  const offsets = new Map<number, number>()
  let y = 0
  for (const depth of [...tallest.keys()].sort((a, b) => a - b)) {
    offsets.set(depth, y)
    y += (tallest.get(depth) as number) + LAYER_GAP
  }
  return offsets
}

/** Wider gap once either side carries a sub-tree, so families stay distinct. */
function siblingGap(left: number, right: number): number {
  return left > NODE_WIDTH || right > NODE_WIDTH ? SUBTREE_GAP : NODE_GAP
}

/** Total width of the row of children, gaps included. */
function childSpan(widths: number[]): number {
  let span = 0
  for (let i = 0; i < widths.length; i++) {
    if (i > 0) span += siblingGap(widths[i - 1] as number, widths[i] as number)
    span += widths[i] as number
  }
  return span
}

/**
 * Horizontal space a sub-tree reserves: its own width, or the width of its
 * children's row if that is wider.
 *
 * Every sub-tree therefore owns a horizontal band that no other sub-tree
 * touches, which is what makes non-overlap structural. Two nodes can only
 * collide if they share a depth, and two nodes at the same depth are always in
 * disjoint bands.
 */
function measure(node: HierarchyNode, widths: Map<string, number>): number {
  const children = node.children.map((child) => measure(child, widths))
  const width = Math.max(NODE_WIDTH, childSpan(children))
  widths.set(node.id, width)
  return width
}

/**
 * Places a sub-tree into the band starting at `left`.
 *
 * Children are laid out first, then the parent is centred between the first
 * and the last of them — over the child *nodes*, not over the band they
 * occupy. The two are the same only when a family is symmetric. When it is
 * not — one leaf beside one deep sub-tree is the common case — centring over
 * the band drags the parent across the canvas towards whichever branch is
 * wider, and it stops reading as the thing that spawned both.
 */
function place(
  node: HierarchyNode,
  left: number,
  widths: Map<string, number>,
  offsets: Map<number, number>,
  positions: Map<string, Position>,
): void {
  const width = widths.get(node.id) as number
  const y = Math.round(offsets.get(node.depth) ?? 0)
  if (node.children.length === 0) {
    positions.set(node.id, { x: Math.round(left + (width - NODE_WIDTH) / 2), y })
    return
  }

  const children = node.children.map((child) => widths.get(child.id) as number)
  // The children's row is centred in the parent's band, so a parent with one
  // narrow child sits directly above it rather than off to one side.
  let cursor = left + (width - childSpan(children)) / 2
  for (let i = 0; i < node.children.length; i++) {
    if (i > 0) cursor += siblingGap(children[i - 1] as number, children[i] as number)
    place(node.children[i] as HierarchyNode, cursor, widths, offsets, positions)
    cursor += children[i] as number
  }

  const first = positions.get((node.children[0] as HierarchyNode).id) as Position
  const last = positions.get((node.children[node.children.length - 1] as HierarchyNode).id) as Position
  positions.set(node.id, { x: Math.round((first.x + last.x) / 2), y })
}

/**
 * Lays the agent graph out as a hierarchy tree.
 *
 * Two invariants carry the whole picture, and both are structural rather than
 * something a layout engine has to be talked into:
 *
 *  1. **y is nesting level, and nothing else.** Every agent at depth N shares
 *     one y, and depth N+1 starts a full LAYER_GAP below the tallest node at
 *     depth N. Reading a row tells you how deep it is without tracing an edge.
 *  2. **Each sub-tree owns a horizontal band nobody else enters,** and a
 *     parent is centred over its children's band. Nodes cannot overlap: a
 *     collision needs a shared depth, and same-depth nodes are always in
 *     disjoint bands.
 *
 * This replaced ELK. ELK was only ever run for its crossing-minimised sibling
 * order, and its coordinates were thrown away and re-flowed into wrapped rows
 * of five — which is what broke the tree read, because a wrapped row put half
 * a fan-out on a second line that looked like a deeper nesting level. A tidy
 * tree has no crossings to minimise in the first place: the hierarchy is a
 * forest, so ordering siblings by spawn time is both crossing-free and stable.
 *
 * Agents with no recorded parent are treated as roots, which keeps orphaned
 * nodes visible: a subagent whose parent edge has not been reconciled yet must
 * still appear on the canvas rather than vanish.
 *
 * `heights` carries the reserved height per agent id, because a seated node is
 * substantially taller than an unseated one. Anything missing falls back to
 * the unseated height.
 */
export function layoutGraph(
  agents: AgentEntity[],
  edges: EdgeEntity[],
  heights?: ReadonlyMap<string, number>,
): Map<string, Position> {
  if (agents.length === 0) return new Map()

  const heightOf = (id: string): number => heights?.get(id) ?? NODE_HEIGHT
  const trees = buildHierarchy(agents, edges)
  const offsets = levelOffsets(trees, heightOf)
  const widths = new Map<string, number>()
  for (const tree of trees) measure(tree, widths)

  const positions = new Map<string, Position>()
  let cursor = 0
  for (const tree of trees) {
    place(tree, cursor, widths, offsets, positions)
    cursor += (widths.get(tree.id) as number) + ROOT_GAP
  }
  return positions
}

/** Distance from a root agent, taken from the same forest the layout uses. */
export function computeDepths(agents: AgentEntity[], edges: EdgeEntity[]): Map<string, number> {
  const depths = new Map<string, number>()
  forEachHierarchyNode(buildHierarchy(agents, edges), (node) => depths.set(node.id, node.depth))
  return depths
}

/** Signature used to decide whether the layout must be recomputed. */
export function graphSignature(agents: AgentEntity[], edges: EdgeEntity[]): string {
  return `${agents.map((a) => a.id).join("|")}::${edges.filter(edgeAffectsHierarchy).map((e) => e.id).join("|")}`
}
