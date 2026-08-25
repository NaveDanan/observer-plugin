import type { AgentEntity, EdgeEntity } from "@observer-ai/protocol"
import { buildHierarchy, type HierarchyNode } from "./layout"

/**
 * Where one agent sits in the spawn tree, and the colour that says so.
 *
 * `color` is the agent's own hue: every edge it spawns is drawn in it, and the
 * notch where an incoming edge lands wears its spawner's. So the canvas answers
 * "who created this?" by colour alone. A subagent that spawns subagents of its
 * own gets a hue that is nothing like its parent's, which is the case the
 * hierarchy was hardest to read in: three levels of green edges all looked like
 * one fan-out.
 *
 * `familyColor` is the separate question of how a node is *filled*, and most
 * nodes answer it with null — a plain new node is the default card, and a
 * canvas where everything is tinted says nothing. Only a nested spawn crew is
 * tinted: a subagent that spawns subagents of its own, together with the
 * subagents it spawned, share one hue so the crew reads as a block.
 */
export interface Lineage {
  /** Nesting level. 0 is a root agent. */
  depth: number
  /** The agent that spawned this one, or null for a root. */
  parentId: string | null
  /** Ancestors, root first, excluding the agent itself. */
  ancestors: readonly string[]
  /** Stable index this agent's hue is derived from. */
  order: number
  /** Colour of every edge this agent spawns. */
  color: string
  /** Colour of the edge that spawned this agent, or null for a root. */
  parentColor: string | null
  /**
   * Fill hue for this node's card, or null to keep the default card.
   *
   * Set only inside a nested spawn crew: a subagent that spawned subagents
   * takes its own hue, and the subagents it spawned take that same hue. A root
   * agent and its plain, childless subagents stay null — they are the ordinary
   * case, and tinting the ordinary case would leave nothing for the unusual
   * one to stand out against.
   */
  familyColor: string | null
}

/**
 * Golden-angle hue step.
 *
 * Successive spawners land as far apart on the wheel as any sequence can put
 * them, and stay far apart however many there turn out to be — unlike a fixed
 * palette of N, which repeats on the N+1th subagent and puts two identical
 * hues on a canvas whose whole job is telling branches apart.
 */
const HUE_STEP = 137.508
/** Offsets the first hue off pure red, which reads as an error state here. */
const HUE_ORIGIN = 24

/**
 * Lightness and chroma are fixed so hue is the only thing that varies.
 *
 * A single mid lightness clears both the light and the dark background, so the
 * canvas does not need one palette per scheme, and it keeps every branch
 * equally loud: varying lightness per branch would read as importance.
 */
const BRANCH_LIGHTNESS = 0.7
const BRANCH_CHROMA = 0.16

/** The hue, in degrees, for the nth spawner on the canvas. */
export function branchHue(order: number): number {
  return (((order * HUE_STEP + HUE_ORIGIN) % 360) + 360) % 360
}

/**
 * The colour for the nth spawner on the canvas.
 *
 * Generated rather than declared in `app-surfaces.css` because it is data, not
 * theme: the number of distinct branches is unbounded and known only at
 * runtime, so there is no fixed set of tokens to name. OKLCH so equal chroma
 * reads as equal saturation across the wheel — the same reason `theme/` stores
 * every role in it.
 */
export function branchColor(order: number): string {
  return `oklch(${BRANCH_LIGHTNESS} ${BRANCH_CHROMA} ${branchHue(order).toFixed(1)})`
}

/**
 * Assigns every agent its place in the spawn tree and its branch colour.
 *
 * Colour index is spawn order across the whole canvas, not position in the
 * tree. That matters: a tree-order index would renumber — and therefore
 * recolour — every agent to the right of a newly spawned one, so the canvas
 * would change colour under a developer mid-read. Spawn order is append-only,
 * so a new agent takes the next unused hue and nothing already drawn moves.
 */
export function computeLineage(agents: AgentEntity[], edges: EdgeEntity[]): Map<string, Lineage> {
  const order = new Map<string, number>()
  const spawnOrdered = [...agents].sort((a, b) => {
    if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  spawnOrdered.forEach((agent, index) => order.set(agent.id, index))

  const lineage = new Map<string, Lineage>()
  const trail: string[] = []

  const walk = (node: HierarchyNode, ancestors: readonly string[]): void => {
    const parentId = ancestors.length > 0 ? (ancestors[ancestors.length - 1] as string) : null
    const index = order.get(node.id) ?? 0
    const parentColor = parentId === null ? null : branchColor(order.get(parentId) ?? 0)
    // Own hue when this subagent spawned a crew of its own; otherwise the
    // spawner's hue when it was spawned by one. Depth carries both tests: at
    // depth 0 there is no crew to join, and at depth 1 the parent is the root,
    // whose children are the ordinary case rather than a nested crew.
    const familyColor =
      node.depth >= 1 && node.children.length > 0 ? branchColor(index) : node.depth >= 2 ? parentColor : null
    lineage.set(node.id, {
      depth: node.depth,
      parentId,
      ancestors,
      order: index,
      color: branchColor(index),
      parentColor,
      familyColor,
    })
    if (node.children.length === 0) return
    trail.push(node.id)
    const nested = Object.freeze([...trail])
    for (const child of node.children) walk(child, nested)
    trail.pop()
  }

  for (const tree of buildHierarchy(agents, edges)) walk(tree, [])
  return lineage
}

/** True when one agent is an ancestor of the other, in either direction. */
export function sharesBloodline(lineage: ReadonlyMap<string, Lineage>, a: string, b: string): boolean {
  return (lineage.get(a)?.ancestors.includes(b) ?? false) || (lineage.get(b)?.ancestors.includes(a) ?? false)
}
