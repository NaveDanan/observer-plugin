import type { CSSProperties } from "react"
import type { EdgeEntity, EdgeType, Provenance } from "@observer-ai/protocol"
import type { Edge } from "@xyflow/react"
import { sharesBloodline, type Lineage } from "./lineage"

export const MESSAGE_SOURCE_HANDLE = "message-source"
export const MESSAGE_TARGET_HANDLE = "message-target"

/** React Flow edge type name for the peer-message arc drawn by `PeerEdge`. */
export const PEER_EDGE_TYPE = "peer"

export interface AgentFlowEdgeData extends Record<string, unknown> {
  edgeType: EdgeType
  provenance: Provenance
  label: string | null
  /** True when this is a message between agents outside each other's bloodline. */
  peer: boolean
  /** Both directions have been observed between this pair of agents. */
  bidirectional: boolean
}

/** Identifies a conversation, not a direction: A to B and B to A share one key. */
function messagePairKey(edge: Pick<EdgeEntity, "sessionId" | "fromAgentId" | "toAgentId">): string {
  const [first, second] = [edge.fromAgentId, edge.toAgentId].sort()
  return `${edge.sessionId}:${first}<->${second}`
}

/**
 * Collapses a conversation into one drawn connection.
 *
 * The reducer stores one edge per direction, so a back-and-forth between two
 * agents arrives as two edges that would be drawn as two arcs bowing opposite
 * ways around the same pair of nodes. That reads as two separate relationships.
 * One arc per pair, marked as two-way when both directions have been seen, is
 * the same information without the double count. The most recent direction is
 * kept as the representative, so a one-way arrow points the way the last
 * message went.
 */
function conversations(edges: readonly EdgeEntity[]): Array<{ edge: EdgeEntity; bidirectional: boolean }> {
  const messages = new Map<string, { edge: EdgeEntity; directions: Set<string> }>()

  for (const edge of edges) {
    if (edge.edgeType !== "messaged") continue
    const key = messagePairKey(edge)
    const held = messages.get(key)
    const direction = `${edge.fromAgentId}>${edge.toAgentId}`
    if (!held) {
      messages.set(key, { edge, directions: new Set([direction]) })
      continue
    }
    held.directions.add(direction)
    if (edge.createdAt >= held.edge.createdAt) held.edge = edge
  }

  return edges.flatMap((edge) => {
    if (edge.edgeType !== "messaged") return [{ edge, bidirectional: false }]
    const held = messages.get(messagePairKey(edge))
    return held?.edge.id === edge.id ? [{ edge, bidirectional: held.directions.size > 1 }] : []
  })
}

/**
 * True when a message crosses branches rather than running up or down one.
 *
 * A subagent messaging its own parent is saying something the hierarchy edge
 * between them already says, so it stays a plain line beside that edge. A
 * message to a cousin or a sibling is the only relationship on the canvas the
 * tree cannot show at all, and it is the one that gets its own geometry.
 *
 * An endpoint the lineage does not know about is not a peer. Before the first
 * layout the map is empty, and calling every message a peer then would make
 * the whole canvas flip geometry one frame later.
 */
export function isPeerMessage(
  edge: Pick<EdgeEntity, "edgeType" | "fromAgentId" | "toAgentId">,
  lineage: ReadonlyMap<string, Lineage>,
): boolean {
  if (edge.edgeType !== "messaged") return false
  if (edge.fromAgentId === edge.toAgentId) return false
  if (!lineage.has(edge.fromAgentId) || !lineage.has(edge.toAgentId)) return false
  return !sharesBloodline(lineage, edge.fromAgentId, edge.toAgentId)
}

/**
 * Preserves Observer's relationship semantics when adapting edges for React Flow.
 *
 * Three channels, none of them competing for the same one:
 *
 *  - **Hue is lineage.** A hierarchy edge takes the colour of the agent it
 *    leaves, so every line out of one spawner matches, and matches the accent
 *    on that spawner's node. Tracing a subagent back to whoever created it is
 *    a colour match rather than a walk up the canvas.
 *  - **Dash rhythm is provenance.** Unchanged: a guess still breaks stride.
 *  - **Geometry is the kind of relationship.** Orthogonal steps run down the
 *    hierarchy; a peer message is an arc. See `PeerEdge`.
 *
 * `lineage` may be empty — the first paint of a session has no layout yet — in
 * which case edges fall back to the per-type colours in `app-surfaces.css` and
 * no message is treated as a peer message.
 */
export function toFlowEdges(
  edges: readonly EdgeEntity[],
  reducedMotion: boolean,
  lineage: ReadonlyMap<string, Lineage> = new Map(),
): Edge<AgentFlowEdgeData>[] {
  return conversations(edges).map(({ edge, bidirectional }) => {
    const label = edge.label ?? (edge.provenance === "authoritative" ? undefined : edge.provenance)
    const message = edge.edgeType === "messaged"
    const peer = message
    // The spawner's hue, not the child's: the line belongs to whoever drew it.
    // A message is nobody's lineage, so it never takes a branch colour.
    const color = message ? undefined : lineage.get(edge.fromAgentId)?.color
    const ends = `${edge.fromAgentId} ${bidirectional ? "and" : "to"} ${edge.toAgentId}`

    return {
      // One id per conversation, so the two directions of a back-and-forth do
      // not fight over which arc React Flow keeps.
      id: message ? `message-pair:${messagePairKey(edge)}` : edge.id,
      source: edge.fromAgentId,
      target: edge.toAgentId,
      type: message ? PEER_EDGE_TYPE : "step",
      // Motion belongs to communication only: a single flare moves between
      // the agents while the dotted hierarchy stays still.
      animated: !reducedMotion && message,
      // A peer arc says what it is by its shape, and repeating "direct
      // message" over every one of them buries the canvas in identical text.
      label: message ? undefined : label,
      ariaLabel: message
        ? (edge.label ?? `${bidirectional ? "peer messages between" : "peer message from"} ${ends}`)
        : (label ?? `${edge.edgeType} relationship from ${edge.fromAgentId} to ${edge.toAgentId}`),
      className: `edge-${edge.edgeType} edge-${edge.provenance}${color ? " edge-lineage" : ""}${peer ? " edge-peer" : ""}`,
      data: {
        edgeType: edge.edgeType,
        provenance: edge.provenance,
        label: edge.label,
        peer,
        bidirectional,
      },
      pathOptions: { borderRadius: 0 },
      // Handed to CSS as a custom property rather than as `stroke` directly,
      // so the selected and hover rules in the stylesheet still outrank it.
      ...(color ? { style: { "--app-lineage": color } as CSSProperties } : {}),
      ...(message ? { sourceHandle: MESSAGE_SOURCE_HANDLE, targetHandle: MESSAGE_TARGET_HANDLE } : {}),
    }
  })
}
