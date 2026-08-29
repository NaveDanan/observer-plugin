import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Background,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStoreApi,
  useViewport,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import type { AgentEntity, EdgeEntity, ToolCallEntity } from "@observer-ai/protocol"
import type { EmployeeMatch } from "@observer-ai/roster"
import { AgentNode, taskTitleOf, type AgentNodeData } from "./AgentNode"
import { PEER_EDGE_TYPE, toFlowEdges } from "./canvasEdges"
import { computeLineage } from "./lineage"
import { PeerEdge } from "./PeerEdge"
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  SEATED_NODE_HEIGHT,
  SEATED_TASK_NODE_HEIGHT,
  TASK_NODE_HEIGHT,
  graphSignature,
  layoutGraph,
  type Position,
} from "./layout"

const nodeTypes = { agent: AgentNode }
const edgeTypes = { [PEER_EDGE_TYPE]: PeerEdge }

/** Where a node sits before it has ever been laid out. */
const ORIGIN: Position = { x: 0, y: 0 }


export interface CanvasProps {
  agents: AgentEntity[]
  edges: EdgeEntity[]
  /** Seated employee per agent id. */
  matches: Map<string, EmployeeMatch | undefined>
  runningTools: Map<string, ToolCallEntity>
  hostLabel: string
  selectedAgentId: string | undefined
  now: number
  /** Double-click, or Shift+Enter on a focused node: raises the ID card. */
  onOpenCard: (agentId: string) => void
  /** Single click, or Enter on a focused node: selects and docks the panels. */
  onSelectAgent: (agentId: string) => void
  /**
   * Brings one agent into view when this value changes.
   *
   * Deliberately separate from `selectedAgentId`: clicking a node on the
   * canvas also selects it, and yanking a node you just clicked into the
   * centre is exactly the viewport theft this canvas is trying to stop.
   * A node that is already fully visible is left where it is.
   */
  focusAgentId?: string | undefined
}

function snapPosition(pos: Position): Position {
  return { x: Math.round(pos.x), y: Math.round(pos.y) }
}

/**
 * Zoom bounds, not zoom stops. Everything between them is reachable: the
 * wheel, pinch, HUD buttons and keyboard all land on any value in range and
 * nothing snaps back to preset levels. React Flow clamps wheel/pinch zoom to
 * these itself via its `minZoom`/`maxZoom` props.
 */
const MIN_ZOOM = 0.25
const MAX_ZOOM = 3

/**
 * Tracks `prefers-reduced-motion`.
 *
 * React Flow takes `animated` as a prop on every edge and reads `duration`
 * on its viewport calls, so CSS cannot reach either. Motion preference has
 * to be a value in JavaScript.
 */
function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)"
  const [reduced, setReduced] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false,
  )

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
    const media = window.matchMedia(query)
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches)
    media.addEventListener("change", onChange)
    setReduced(media.matches)
    return () => media.removeEventListener("change", onChange)
  }, [])

  return reduced
}

interface ZoomHudProps {
  reducedMotion: boolean
  /** Number of agents that appeared off-screen since the last time the developer looked. */
  offscreenCount: number
  onRevealOffscreen: () => void
  onDismissOffscreen: () => void
}

/**
 * The floating zoom HUD.
 *
 * The +/− buttons call React Flow's own `zoomIn`/`zoomOut`, which multiply the
 * current zoom by 1.2 and clamp to the canvas bounds. Wheel, pinch, buttons
 * and keyboard all land anywhere in [MIN_ZOOM, MAX_ZOOM]; no gesture is ever
 * snapped back to a preset level. FIT frames the graph, 1:1 returns to 100%.
 */
function ZoomHud(props: ZoomHudProps): JSX.Element {
  const { reducedMotion, offscreenCount, onRevealOffscreen, onDismissOffscreen } = props
  const { zoom } = useViewport()
  const flow = useReactFlow()
  const duration = reducedMotion ? 0 : 160
  // Percent-rounded bounds absorb float noise from the multiplicative steps,
  // so a button never disables one tick early or late.
  const percent = Math.round(zoom * 100)
  const canZoomOut = percent > MIN_ZOOM * 100
  const canZoomIn = percent < MAX_ZOOM * 100

  return (
    <div className="zoom-controls" role="group" aria-label="Zoom and framing">
      {offscreenCount > 0 && (
        <>
          <button
            type="button"
            className="pixel-btn zoom-new"
            onClick={onRevealOffscreen}
            aria-label={`${offscreenCount} new agent${offscreenCount === 1 ? "" : "s"} off-screen. Fit them into view.`}
            title={`${offscreenCount} new agent${offscreenCount === 1 ? "" : "s"} off-screen`}
          >
            {`▸ ${offscreenCount} NEW`}
          </button>
          <button
            type="button"
            className="pixel-btn zoom-dismiss"
            onClick={onDismissOffscreen}
            aria-label="Dismiss the off-screen agent notice"
            title="Dismiss"
          >
            ✕
          </button>
        </>
      )}

      <button
        type="button"
        className="pixel-btn zoom-out"
        onClick={() => flow.zoomOut({ duration })}
        disabled={!canZoomOut}
        aria-label="Zoom out"
      >
        −
      </button>

      <span className="zoom-level-text" aria-live="polite" aria-label={`Zoom ${percent} percent`}>
        {percent}%
      </span>

      <button
        type="button"
        className="pixel-btn zoom-in"
        onClick={() => flow.zoomIn({ duration })}
        disabled={!canZoomIn}
        aria-label="Zoom in"
      >
        +
      </button>

      <button
        type="button"
        className="pixel-btn zoom-fit"
        onClick={() => flow.fitView({ padding: 0.15, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM, duration })}
        aria-label="Fit the whole agent graph into view"
      >
        FIT
      </button>

      <button
        type="button"
        className="pixel-btn zoom-reset"
        onClick={() => flow.zoomTo(1, { duration })}
        aria-label="Reset zoom to 100 percent"
      >
        1:1
      </button>
    </div>
  )
}

/**
 * Interactive agent graph.
 *
 * Two interactions, two results. A single click — or Enter on a focused node —
 * selects an agent and docks its Worker card and activity panel. A double
 * click, or Shift+Enter, additionally raises that employee's NJ-LABS ID card
 * over the canvas. The two used to be wired to the same closure, which made
 * the double-click path dead code.
 */
function CanvasInner(props: CanvasProps): JSX.Element {
  const {
    agents,
    edges,
    matches,
    runningTools,
    hostLabel,
    selectedAgentId,
    now,
    onOpenCard,
    onSelectAgent,
    focusAgentId,
  } = props

  const [positions, setPositions] = useState<Map<string, Position>>(new Map())
  /**
   * Positions the developer dragged a node to.
   *
   * These win over the tree layout for as long as the session is on screen, so
   * relayout on the next spawned agent does not snatch a node back out from
   * under someone who deliberately moved it. `Canvas` is keyed by session in
   * `App.tsx`, so they are dropped when the session changes.
   */
  const [manualPositions, setManualPositions] = useState<Map<string, Position>>(new Map())
  const [offscreenCount, setOffscreenCount] = useState(0)
  /** Drives the stylesheet's `.panning` grabbing cursor. */
  const [panning, setPanning] = useState(false)

  const flow = useReactFlow()
  const storeApi = useStoreApi()
  const viewport = useViewport()
  const reducedMotion = usePrefersReducedMotion()
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const signature = graphSignature(agents, edges)

  /**
   * Every agent's place in the spawn tree, and the branch colour that says so.
   *
   * Keyed off the same signature as the layout, so it is recomputed exactly
   * when the shape of the hierarchy changes and never on the per-second tick
   * that a live agent drives. `signature` stands in for `agents` and the
   * hierarchy edges deliberately.
   */
  const lineage = useMemo(() => computeLineage(agents, edges), [signature])

  /**
   * Reserved height per agent, growing only.
   *
   * `layout.ts` can only estimate a node's height from the stylesheet, and the
   * stylesheet changes without it. React Flow measures every node it renders,
   * so those measurements are folded back in and the CSS stays the source of
   * truth. The map only ever grows: a node whose footer stops wrapping keeps
   * its taller reservation, which costs a little whitespace and buys the
   * guarantee that this cannot oscillate and relayout on every tick.
   */
  const reserved = useRef<Map<string, number>>(new Map())

  /** Guards against relaying out an unchanged graph + height set. */
  const requested = useRef("")
  /**
   * Whether the known-set has been seeded with the agents the session opened
   * with. Everything after that arrival is "new" and announced by the HUD.
   */
  const knownSeeded = useRef(false)
  /** Agents already accounted for: either present at seed time, or seen since. */
  const known = useRef<Set<string>>(new Set())
  /** Agents that arrived after seeding and have not been on screen yet. */
  const pending = useRef<Set<string>>(new Set())

  useEffect(() => {
    // Fold this render's measurements into the monotone reservation map, and
    // build a key that only changes when a reservation actually grows.
    const lookup = storeApi.getState().nodeLookup
    const heights = new Map<string, number>()
    let heightKey = ""
    for (const agent of agents) {
      const hasTask = Boolean(taskTitleOf(agent, agent.parentAgentId === null))
      const estimate = matches.get(agent.id)
        ? (hasTask ? SEATED_TASK_NODE_HEIGHT : SEATED_NODE_HEIGHT)
        : (hasTask ? TASK_NODE_HEIGHT : NODE_HEIGHT)
      const measured = Math.ceil(lookup.get(agent.id)?.measured?.height ?? 0)
      const next = Math.max(reserved.current.get(agent.id) ?? 0, estimate, measured)
      reserved.current.set(agent.id, next)
      heights.set(agent.id, next)
      heightKey += `${agent.id}:${next};`
    }

    const key = `${signature}::${heightKey}`
    if (requested.current === key) return
    requested.current = key

    const snapped = new Map<string, Position>()
    for (const [id, pos] of layoutGraph(agents, edges, heights)) snapped.set(id, snapPosition(pos))
    setPositions(snapped)

    if (!knownSeeded.current) {
      knownSeeded.current = true
      // The graph as it stood on arrival is what the developer came to see;
      // none of it is "new". The viewport stays at React Flow's identity
      // transform, so the default view is always exactly 100% with the root
      // band at the pane's top-left — the layout starts from the flow
      // origin. Framing the graph is FIT's job, not something to spring on
      // load.
      for (const agent of agents) known.current.add(agent.id)
      return
    }

    // Every later layout: anything new is announced, not chased.
    for (const agent of agents) {
      if (!known.current.has(agent.id)) pending.current.add(agent.id)
    }
  }, [signature, agents, edges, matches, storeApi])

  /** The visible area of the canvas, in flow coordinates. */
  const visibleRect = useCallback((): { x1: number; y1: number; x2: number; y2: number } | undefined => {
    const el = wrapRef.current
    if (!el) return undefined
    const box = el.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return undefined
    const topLeft = flow.screenToFlowPosition({ x: box.left, y: box.top })
    const bottomRight = flow.screenToFlowPosition({ x: box.right, y: box.bottom })
    return { x1: topLeft.x, y1: topLeft.y, x2: bottomRight.x, y2: bottomRight.y }
  }, [flow])

  const heightOf = useCallback(
    (id: string): number => reserved.current.get(id) ?? NODE_HEIGHT,
    [],
  )

  // Retire pending agents as they come into view, so the nudge counts only
  // what the developer genuinely has not seen.
  useEffect(() => {
    if (pending.current.size === 0) {
      if (offscreenCount !== 0) setOffscreenCount(0)
      return
    }
    const rect = visibleRect()
    if (!rect) return
    for (const id of [...pending.current]) {
      const pos = manualPositions.get(id) ?? positions.get(id)
      if (!pos) continue
      const inView =
        pos.x >= rect.x1 && pos.y >= rect.y1 && pos.x + NODE_WIDTH <= rect.x2 && pos.y + heightOf(id) <= rect.y2
      if (inView) {
        pending.current.delete(id)
        known.current.add(id)
      }
    }
    setOffscreenCount(pending.current.size)
  }, [positions, manualPositions, viewport, offscreenCount, visibleRect, heightOf])

  const revealOffscreen = useCallback(() => {
    for (const id of pending.current) known.current.add(id)
    pending.current.clear()
    setOffscreenCount(0)
    flow.fitView({ padding: 0.15, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM, duration: reducedMotion ? 0 : 200 })
  }, [flow, reducedMotion])

  const dismissOffscreen = useCallback(() => {
    for (const id of pending.current) known.current.add(id)
    pending.current.clear()
    setOffscreenCount(0)
  }, [])

  // Bring a requested agent into view, but only if it is not already there.
  const lastFocused = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!focusAgentId || focusAgentId === lastFocused.current) return
    const pos = manualPositions.get(focusAgentId) ?? positions.get(focusAgentId)
    // An agent can be selected before its first layout lands. Leave
    // `lastFocused` alone so this runs again once a position exists.
    if (!pos) return
    lastFocused.current = focusAgentId
    const rect = visibleRect()
    const height = heightOf(focusAgentId)
    if (
      rect &&
      pos.x >= rect.x1 &&
      pos.y >= rect.y1 &&
      pos.x + NODE_WIDTH <= rect.x2 &&
      pos.y + height <= rect.y2
    ) {
      return
    }
    flow.setCenter(pos.x + NODE_WIDTH / 2, pos.y + height / 2, {
      zoom: flow.getViewport().zoom,
      duration: reducedMotion ? 0 : 240,
    })
  }, [focusAgentId, positions, manualPositions, flow, visibleRect, heightOf, reducedMotion])

  /**
   * React Flow drives a controlled `nodes` prop, so a drag only commits if the
   * change is handed back. Only position changes are kept: selection is drawn
   * from `data.selected`, and measurements live in React Flow's own node
   * lookup, so neither needs to round-trip through this array.
   */
  const onNodesChange = useCallback((changes: NodeChange<Node<AgentNodeData>>[]) => {
    let moved: Map<string, Position> | undefined
    for (const change of changes) {
      if (change.type !== "position" || !change.position) continue
      moved ??= new Map<string, Position>()
      moved.set(change.id, snapPosition(change.position))
    }
    if (!moved) return
    const applied = moved
    setManualPositions((prev) => {
      const next = new Map(prev)
      for (const [id, pos] of applied) next.set(id, pos)
      return next
    })
  }, [])

  /**
   * The tree as it stands before any node has been measured.
   *
   * The reserved-height pass below runs in an effect, so it cannot land until
   * after the first paint. Seeding from the same layout at estimated heights
   * means that first paint is already the right shape — only the vertical
   * pitch moves once real heights arrive. The canvas used to open on an
   * arbitrary four-column grid and snap into a tree a frame later.
   */
  const seeded = useMemo(() => layoutGraph(agents, edges), [signature])

  const nodes: Node<AgentNodeData>[] = useMemo(
    () =>
      agents.map((agent) => {
        const raw = manualPositions.get(agent.id) ?? positions.get(agent.id) ?? seeded.get(agent.id) ?? ORIGIN
        const tool = runningTools.get(agent.id)
        const activity = tool ? { tool, elapsedMs: Math.max(0, now - tool.startedAt) } : undefined
        return {
          id: agent.id,
          type: "agent",
          position: snapPosition(raw),
          data: {
            agent,
            hostLabel,
            isRoot: !agent.parentAgentId,
            selected: agent.id === selectedAgentId,
            activity,
            match: matches.get(agent.id),
            lineage: lineage.get(agent.id),
            onOpen: () => onSelectAgent(agent.id),
            onOpenCard: () => onOpenCard(agent.id),
          },
          draggable: true,
        }
      }),
    [
      agents,
      positions,
      manualPositions,
      seeded,
      matches,
      lineage,
      runningTools,
      hostLabel,
      selectedAgentId,
      now,
      onSelectAgent,
      onOpenCard,
    ],
  )

  const flowEdges = useMemo(() => toFlowEdges(edges, reducedMotion, lineage), [edges, reducedMotion, lineage])


  /**
   * Pan, zoom and fit from the keyboard.
   *
   * Scoped to the canvas and skipped while a text field has focus, so typing
   * in a panel is never hijacked. Deliberately *not* skipped while a node has
   * focus: React Flow only gives arrow keys to a focused node when that node
   * is `selected`, and selection is drawn here from `data.selected` rather
   * than round-tripped through the controlled `nodes` array, so nothing is
   * competing for the arrow keys. A keyboard user tabbing between agents can
   * pan without first tabbing back out to the pane.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      const tag = target.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return

      const duration = reducedMotion ? 0 : 120
      const stride = event.shiftKey ? 480 : 120
      const vp = flow.getViewport()

      switch (event.key) {
        // Panning is instant: a held arrow key repeats faster than any
        // transition can finish, and ADR 0002 wants motion stepped anyway.
        case "ArrowLeft":
          flow.setViewport({ ...vp, x: vp.x + stride }, { duration: 0 })
          break
        case "ArrowRight":
          flow.setViewport({ ...vp, x: vp.x - stride }, { duration: 0 })
          break
        case "ArrowUp":
          flow.setViewport({ ...vp, y: vp.y + stride }, { duration: 0 })
          break
        case "ArrowDown":
          flow.setViewport({ ...vp, y: vp.y - stride }, { duration: 0 })
          break
        case "+":
        case "=":
          flow.zoomIn({ duration })
          break
        case "-":
        case "_":
          flow.zoomOut({ duration })
          break
        case "f":
        case "F":
          flow.fitView({ padding: 0.15, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM, duration })
          break
        default:
          return
      }
      event.preventDefault()
    },
    [flow, reducedMotion],
  )

  if (agents.length === 0) {
    return (
      <div className="canvas empty">
        <p>No agents recorded for this session yet.</p>
      </div>
    )
  }

  return (
    <div
      /*
       * Both classes on purpose. `.canvas` carries the shared stage styling;
       * `.canvas-container` is what the stylesheet's
       * `:has(.react-flow__background)` rule keys off to drop its own grid in
       * favour of React Flow's, which pans with the viewport. Without it the
       * two grids sit on top of each other and moire.
       */
      className={`canvas canvas-container${panning ? " panning" : ""}`}
      ref={wrapRef}
      tabIndex={0}
      role="group"
      aria-label="Agent graph. Arrow keys pan, plus and minus zoom, F fits the graph into view."
      onKeyDown={onKeyDown}
    >
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode="dark"
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        proOptions={{ hideAttribution: true }}
        /*
         * d3 binds `dblclick.zoom` to the pane, and node events bubble to it,
         * so leaving this on zooms the graph every time a card opens — behind
         * a modal the developer cannot see past. The zoom HUD, the keyboard
         * and the wheel all still zoom, continuously between MIN_ZOOM and
         * MAX_ZOOM.
         */
        zoomOnDoubleClick={false}
        onNodeDoubleClick={(_event, node) => onOpenCard(node.id)}
        onNodeClick={(_event, node) => onSelectAgent(node.id)}
        onMoveStart={() => setPanning(true)}
        onMoveEnd={() => setPanning(false)}
      >
        <Background gap={16} size={1} />
      </ReactFlow>

      <ZoomHud
        reducedMotion={reducedMotion}
        offscreenCount={offscreenCount}
        onRevealOffscreen={revealOffscreen}
        onDismissOffscreen={dismissOffscreen}
      />
    </div>
  )
}

/**
 * `useReactFlow` requires a provider above it, so the public component supplies
 * one. Keyed per session so panning state does not leak between sessions.
 */
export function Canvas(props: CanvasProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}
