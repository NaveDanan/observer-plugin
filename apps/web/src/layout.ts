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

export const NODE_WIDTH = 320
export const NODE_HEIGHT = 168

export interface Position {
  x: number
  y: number
}

/**
 * Lays the agent graph out top-down.
 *
 * Agents with no recorded parent are treated as roots, which keeps orphaned
 * nodes visible: a subagent whose parent edge has not been reconciled yet must
 * still appear on the canvas rather than vanish.
 */
export async function layoutGraph(agents: AgentEntity[], edges: EdgeEntity[]): Promise<Map<string, Position>> {
  const positions = new Map<string, Position>()
  if (agents.length === 0) return positions

  const ids = new Set(agents.map((agent) => agent.id))
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "90",
      "elk.spacing.nodeNode": "48",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: agents.map((agent) => ({ id: agent.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
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
    for (const [depth, row] of byDepth) {
      row.forEach((agent, index) => {
        positions.set(agent.id, {
          x: Math.round(index * (NODE_WIDTH + 48)),
          y: Math.round(depth * (NODE_HEIGHT + 90)),
        })
      })
    }
  }
  return positions
}

/** Distance from a root agent, used by the fallback layout. */
function computeDepths(agents: AgentEntity[], edges: EdgeEntity[]): Map<string, number> {
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
