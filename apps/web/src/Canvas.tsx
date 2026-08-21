import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Background,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  useStoreApi,
  useViewport,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import type { AgentEntity, EdgeEntity, ToolCallEntity } from "@observer-ai/protocol"
import type { EmployeeMatch } from "@observer-ai/roster"
import { AgentNode, type AgentNodeData } from "./AgentNode"
import {
  LAYER_GAP,
  NODE_GAP,
  NODE_HEIGHT,
  NODE_WIDTH,
  SEATED_NODE_HEIGHT,
  graphSignature,
  layoutGraph,
  type Position,
} from "./layout"

const nodeTypes = { agent: AgentNode }

export interface CanvasProps {
  agents: AgentEntity[]
  edges: EdgeEntity[]
  /** Seated employee per agent id. */
  matches: Map<string, EmployeeMatch | undefined>
  runningTools: Map<string, ToolCallEntity>
  hostLabel: string
  selectedAgentId: string | undefined
  now: number
  onOpenAgent: (agentId: string) => void
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

const MIN_ZOOM = 0.25
const MAX_ZOOM = 3

/**
 * Zoom levels the canvas snaps to.
 *
 * ADR 0002 asks for integer zoom so pixel art stays crisp. Integers alone
 * cannot go below 1, which made the whole graph unreachable: a root agent
 * with 20 subagents lays out 6912px wide, and `fitView` respects `minZoom`,
 * so at `minZoom: 1` Fit did nothing and the only way around the graph was
 * panning. Halving steps below 1 keep the ADR's argument intact — 1/2 and
 * 1/4 are pixel-exact scale factors, so a 300px node lands on 300, 150 and
 * 75 device pixels with no resampling.
 *
 * 0.25 is the floor because it is where the graph stops being readable, not
 * because of a rendering limit. It fits roughly 20 same-depth agents across
 * an 1800px viewport; beyond that Fit tops out and panning is the answer.
 */
const ZOOM_STEPS = [0.25, 0.5, 1, 2, 3] as const

function snapZoom(value: number): number {
  const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value))
  let best: number = ZOOM_STEPS[0]
  for (const step of ZOOM_STEPS) {
    if (Math.abs(step - clamped) < Math.abs(best - clamped)) best = step
  }
  return best
}

/** The next snap step above or below `value`, clamped to the ends. */
function stepZoom(value: number, direction: 1 | -1): number {
  const current = snapZoom(value)
  const index = ZOOM_STEPS.indexOf(current as (typeof ZOOM_STEPS)[number])
  const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction))]
  return next ?? current
}

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
 * Zoom in/out step through `ZOOM_STEPS` rather than calling React Flow's
 * `zoomIn`/`zoomOut`, which multiply by 1.2 and land on fractions like 1.44 —
 * precisely the resampling ADR 0002 rules out. `zoomTo` is still React Flow's
 * own API, it is just handed a crisp target.
 */
function ZoomHud(props: ZoomHudProps): JSX.Element {
  const { reducedMotion, offscreenCount, onRevealOffscreen, onDismissOffscreen } = props
  const { zoom } = useViewport()
  const flow = useReactFlow()
  const duration = reducedMotion ? 0 : 160
  const percent = Math.round(zoom * 100)

  return (
    <div className="zoom-controls" role="group" aria-label="Zoom and framing">
      {offscreenCount > 0 && (
        <>
          <button
            type="button"
            className="pixel-btn"
            onClick={onRevealOffscreen}
            aria-label={`${offscreenCount} new agent${offscreenCount === 1 ? "" : "s"} off-screen. Fit them into view.`}
            title={`${offscreenCount} new agent${offscreenCount === 1 ? "" : "s"} off-screen`}
          >
            {`▸ ${offscreenCount} NEW`}
          </button>
          <button
            type="button"
            className="pixel-btn"
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
        className="pixel-btn"
        onClick={() => flow.zoomTo(stepZoom(zoom, -1), { duration })}
        disabled={stepZoom(zoom, -1) >= zoom}
        aria-label="Zoom out"
      >
        −
      </button>

      <span className="zoom-level-text" aria-live="polite" aria-label={`Zoom ${percent} percent`}>
        {percent}%
      </span>

      <button
        type="button"
        className="pixel-btn"
        onClick={() => flow.zoomTo(stepZoom(zoom, 1), { duration })}
        disabled={stepZoom(zoom, 1) <= zoom}
        aria-label="Zoom in"
      >
        +
      </button>

      <button
        type="button"
        className="pixel-btn"
        onClick={() => flow.fitView({ padding: 0.15, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM, duration })}
        aria-label="Fit the whole agent graph into view"
      >
        FIT
      </button>

      <button
        type="button"
        className="pixel-btn"
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
 * Double-click (or Enter on a focused node) opens the agent detail panel, which
 * is the primary interaction described in the product brief.
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
    onOpenAgent,
    onSelectAgent,
    focusAgentId,
  } = props

  const [positions, setPositions] = useState<Map<string, Position>>(new Map())
  /**
   * Positions the developer dragged a node to.
   *
   * These win over the ELK layout for as long as the session is on screen, so
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

  /**
   * Changes whenever a rendered node's measured height changes bucket. Only a
   * trigger — the effect reads the real numbers straight from the store.
   */
  const measuredSignature = useStore((state) => {
    let key = ""
    for (const [id, node] of state.nodeLookup) {
      const height = node.measured?.height ?? 0
      if (height > 0) key += `${id}:${Math.ceil(height / 8)};`
    }
    return key
  })

  const requested = useRef("")
  /** Auto-fit is a one-shot courtesy on the first layout, never a policy. */
  const hasFitted = useRef(false)
  /**
   * The first ELK layout resolves a few milliseconds after mount. If the
   * developer got to the viewport inside that window, the one-shot fit is
   * cancelled rather than fired over the top of them.
   */
  const userMoved = useRef(false)
  /** Agents already accounted for: either present at the first fit, or seen since. */
  const known = useRef<Set<string>>(new Set())
  /** Agents that arrived after the first fit and have not been on screen yet. */
  const pending = useRef<Set<string>>(new Set())

  useEffect(() => {
    // Fold this render's measurements into the monotone reservation map, and
    // build a key that only changes when a reservation actually grows.
    const lookup = storeApi.getState().nodeLookup
    const heights = new Map<string, number>()
    let heightKey = ""
    for (const agent of agents) {
      const estimate = matches.get(agent.id) ? SEATED_NODE_HEIGHT : NODE_HEIGHT
      const measured = Math.ceil(lookup.get(agent.id)?.measured?.height ?? 0)
      const next = Math.max(reserved.current.get(agent.id) ?? 0, estimate, measured)
      reserved.current.set(agent.id, next)
      heights.set(agent.id, next)
      heightKey += `${agent.id}:${next};`
    }

    const key = `${signature}::${heightKey}`
    if (requested.current === key) return
    requested.current = key

    void layoutGraph(agents, edges, heights).then((next) => {
      if (requested.current !== key) return
      const snapped = new Map<string, Position>()
      for (const [id, pos] of next) snapped.set(id, snapPosition(pos))
      setPositions(snapped)

      const isFirstLayout = !hasFitted.current

      if (isFirstLayout) {
        // Hold the one-shot fit until React Flow has measured at least one
        // node. Framing the graph off the estimated heights and then never
        // re-fitting would bake the estimate's error into the default view.
        if (measuredSignature === "") return
        hasFitted.current = true
        // The graph as it stood on arrival is what the developer came to see;
        // none of it is "new".
        for (const agent of agents) known.current.add(agent.id)
        if (userMoved.current) return
        requestAnimationFrame(() => {
          if (userMoved.current) return
          // Fit then snap to a stepped zoom so the default view is crisp.
          flow.fitView({ padding: 0.15, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM, duration: 0 })
          requestAnimationFrame(() => {
            const vp = flow.getViewport()
            const z = snapZoom(vp.zoom)
            if (z !== vp.zoom) flow.setViewport({ ...vp, zoom: z }, { duration: 0 })
          })
        })
        return
      }

      // Every later layout: anything new is announced, not chased.
      for (const agent of agents) {
        if (!known.current.has(agent.id)) pending.current.add(agent.id)
      }
    })
  }, [signature, measuredSignature, agents, edges, matches, flow, storeApi])

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
      zoom: snapZoom(flow.getViewport().zoom),
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

  const nodes: Node<AgentNodeData>[] = useMemo(
    () =>
      agents.map((agent, index) => {
        const fallback = {
          x: (index % 4) * (NODE_WIDTH + NODE_GAP),
          y: Math.floor(index / 4) * (NODE_HEIGHT + LAYER_GAP),
        }
        const raw = manualPositions.get(agent.id) ?? positions.get(agent.id) ?? fallback
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
            onOpen: () => onOpenAgent(agent.id),
          },
          draggable: true,
        }
      }),
    [agents, positions, manualPositions, matches, runningTools, hostLabel, selectedAgentId, now, onOpenAgent],
  )

  const flowEdges: Edge[] = useMemo(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.fromAgentId,
        target: edge.toAgentId,
        type: "step",
        // The flowing dash on a spawn edge is decoration, so it goes when the
        // developer has asked the machine to stop moving things.
        animated: !reducedMotion && edge.edgeType === "spawned",
        label: edge.provenance === "authoritative" ? undefined : edge.provenance,
        className: `edge-${edge.provenance}`,
        pathOptions: { borderRadius: 0 },
      })),
    [edges, reducedMotion],
  )

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
          flow.zoomTo(stepZoom(vp.zoom, 1), { duration })
          break
        case "-":
        case "_":
          flow.zoomTo(stepZoom(vp.zoom, -1), { duration })
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
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.15, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM }}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        proOptions={{ hideAttribution: true }}
        onNodeDoubleClick={(_event, node) => onOpenAgent(node.id)}
        onNodeClick={(_event, node) => onSelectAgent(node.id)}
        onMoveStart={(event) => {
          // `event` is null for our own fitView/setViewport calls, so only a
          // real pointer or wheel gesture counts as the user taking over.
          if (!event) return
          userMoved.current = true
          setPanning(true)
        }}
        onMoveEnd={(_event, vp) => {
          setPanning(false)
          const z = snapZoom(vp.zoom)
          if (z !== vp.zoom) flow.setViewport({ ...vp, zoom: z }, { duration: 0 })
        }}
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
