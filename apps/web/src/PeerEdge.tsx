import { BaseEdge, type EdgeProps } from "@xyflow/react"
import type { AgentFlowEdgeData } from "./canvasEdges"

/**
 * How far the arc leaves and enters a node before it starts curving.
 *
 * Without it a backwards message — one whose sender sits to the right of its
 * recipient — would double back across its own node's edge and read as a line
 * ending nowhere.
 */
const STUB = 20
/** Smallest and largest bow, so a short hop still arcs and a long one stays on screen. */
const MIN_BOW = 46
const MAX_BOW = 190
/** Bow as a fraction of the span it crosses. */
const BOW_RATIO = 0.16
/** Half-diagonal of the diamond that marks the middle of a peer message. */
const DIAMOND = 6
/** Length and half-width of the arrowhead. */
const ARROW_LENGTH = 11
const ARROW_HALF_WIDTH = 5

interface Point {
  x: number
  y: number
}

export interface PeerEdgePath {
  d: string
  /** Midpoint of the arc: where the diamond sits. */
  apex: Point
  /** Arrowhead at the recipient, as an SVG polygon `points` string. */
  arrow: string
  /** Arrowhead back at the sender, drawn only when both directions were seen. */
  backArrow: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * The arc a peer message is drawn as.
 *
 * Deliberately nothing like a hierarchy edge. Spawn edges are orthogonal steps
 * running strictly downwards; a peer message is a single smooth arc between
 * two side handles, marked with a diamond at its midpoint and an arrowhead at
 * the agent that received it. Shape alone separates the two readings, so
 * "who reports to whom" and "who talked to whom" never have to be told apart
 * by colour on a canvas that is already using colour for lineage.
 *
 * The arc bows *away* from the row it spans rather than through it: forwards
 * messages ride above their row, backwards messages below. That gives
 * direction a second, colour-free cue, and stops the two arcs of a
 * back-and-forth conversation from landing on top of each other.
 */
export function peerEdgePath(source: Point, target: Point): PeerEdgePath {
  const forward = target.x >= source.x
  const from = { x: source.x + STUB, y: source.y }
  const to = { x: target.x - STUB, y: target.y }
  const span = Math.abs(to.x - from.x) + Math.abs(to.y - from.y)
  const bow = clamp(MIN_BOW + span * BOW_RATIO, MIN_BOW, MAX_BOW) * (forward ? -1 : 1)

  const midY = (from.y + to.y) / 2 + bow
  const first = { x: from.x + (to.x - from.x) * 0.25, y: midY }
  const second = { x: from.x + (to.x - from.x) * 0.75, y: midY }

  const d =
    `M ${source.x},${source.y} L ${from.x},${from.y}` +
    ` C ${first.x},${first.y} ${second.x},${second.y} ${to.x},${to.y}` +
    ` L ${target.x},${target.y}`

  // The cubic at t = 0.5, which is the flattest, most legible point on the arc.
  const apex = {
    x: (from.x + 3 * first.x + 3 * second.x + to.x) / 8,
    y: (from.y + 3 * first.y + 3 * second.y + to.y) / 8,
  }

  return {
    d,
    apex,
    arrow: arrowPoints(to, target),
    backArrow: arrowPoints(from, source),
  }
}

/**
 * Arrowhead at the recipient.
 *
 * Drawn here rather than as an SVG `marker` so it inherits the edge's own
 * `currentColor` and its hover state. React Flow keys marker definitions by
 * colour string and hoists them into a shared `<defs>`, where a hover on one
 * edge cannot reach them.
 */
function arrowPoints(from: Point, tip: Point): string {
  const dx = tip.x - from.x
  const dy = tip.y - from.y
  const length = Math.hypot(dx, dy) || 1
  const ux = dx / length
  const uy = dy / length
  const baseX = tip.x - ux * ARROW_LENGTH
  const baseY = tip.y - uy * ARROW_LENGTH
  const left = { x: baseX - uy * ARROW_HALF_WIDTH, y: baseY + ux * ARROW_HALF_WIDTH }
  const right = { x: baseX + uy * ARROW_HALF_WIDTH, y: baseY - ux * ARROW_HALF_WIDTH }
  return `${tip.x},${tip.y} ${left.x},${left.y} ${right.x},${right.y}`
}

/**
 * A direct message between two agents that are not each other's ancestor.
 *
 * The one relationship on the canvas that is not hierarchy, so it is the one
 * relationship drawn with a different geometry. One arc per conversation: an
 * arrowhead at each end when both agents have written to each other, one when
 * only one of them has. It carries no visible label — on a busy canvas every
 * peer edge would repeat the same word, and the shape already says what the
 * word would — so the relationship lives in the edge's accessible name for
 * anyone who cannot see the shape.
 */
export function PeerEdge(props: EdgeProps): JSX.Element {
  const { id, sourceX, sourceY, targetX, targetY, style, interactionWidth, data, animated } = props
  const { d, apex, arrow, backArrow } = peerEdgePath({ x: sourceX, y: sourceY }, { x: targetX, y: targetY })
  const bidirectional = (data as AgentFlowEdgeData | undefined)?.bidirectional === true

  return (
    <>
      <BaseEdge id={id} path={d} style={style} interactionWidth={interactionWidth ?? 24} />
      <polygon className="peer-edge-arrow" points={arrow} />
      {bidirectional && <polygon className="peer-edge-arrow" points={backArrow} />}
      {animated ? (
        <path className="peer-edge-flair" d={d} pathLength={100} aria-hidden="true" />
      ) : (
        <rect
          className="peer-edge-node"
          x={apex.x - DIAMOND}
          y={apex.y - DIAMOND}
          width={DIAMOND * 2}
          height={DIAMOND * 2}
          transform={`rotate(45 ${apex.x} ${apex.y})`}
        />
      )}
    </>
  )
}
