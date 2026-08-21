import { useEffect, useMemo, useRef, useState } from "react"
import { Background, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node } from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import type { AgentEntity, EdgeEntity, ToolCallEntity } from "@observer-ai/protocol"
import type { EmployeeMatch } from "@observer-ai/roster"
import { AgentNode, type AgentNodeData } from "./AgentNode"
import { NODE_HEIGHT, NODE_WIDTH, graphSignature, layoutGraph, type Position } from "./layout"

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
}

function snapPosition(pos: Position): Position {
  return { x: Math.round(pos.x), y: Math.round(pos.y) }
}

function snapZoom(value: number): number {
  // Pixel crispness: only integer zoom levels. Clamped to available range.
  const snapped = Math.round(value)
  return Math.max(1, Math.min(4, snapped))
}

/**
 * Interactive agent graph.
 *
 * Double-click (or Enter on a focused node) opens the agent detail panel, which
 * is the primary interaction described in the product brief.
 */
function CanvasInner(props: CanvasProps): JSX.Element {
  const { agents, edges, matches, runningTools, hostLabel, selectedAgentId, now, onOpenAgent, onSelectAgent } = props
  const [positions, setPositions] = useState<Map<string, Position>>(new Map())
  const signature = graphSignature(agents, edges)
  const requested = useRef("")
  const flow = useReactFlow()

  useEffect(() => {
    if (requested.current === signature) return
    requested.current = signature
    void layoutGraph(agents, edges).then((next) => {
      if (requested.current !== signature) return
      const snapped = new Map<string, Position>()
      for (const [id, pos] of next) snapped.set(id, snapPosition(pos))
      setPositions(snapped)
      requestAnimationFrame(() => {
        // Fit then snap to integer zoom so default view is crisp.
        flow.fitView({ padding: 0.18, duration: 0 })
        requestAnimationFrame(() => {
          const vp = flow.getViewport()
          const z = snapZoom(vp.zoom)
          if (z !== vp.zoom) flow.setViewport({ ...vp, zoom: z }, { duration: 0 })
        })
      })
    })
  }, [signature, agents, edges, flow])

  const nodes: Node<AgentNodeData>[] = useMemo(
    () =>
      agents.map((agent, index) => {
        const raw = positions.get(agent.id) ?? { x: (index % 4) * (NODE_WIDTH + 48), y: Math.floor(index / 4) * (NODE_HEIGHT + 90) }
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
    [agents, positions, matches, runningTools, hostLabel, selectedAgentId, now, onOpenAgent],
  )

  const flowEdges: Edge[] = useMemo(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.fromAgentId,
        target: edge.toAgentId,
        type: "step",
        animated: edge.edgeType === "spawned",
        label: edge.provenance === "authoritative" ? undefined : edge.provenance,
        className: `edge-${edge.provenance}`,
        pathOptions: { borderRadius: 0 },
      })),
    [edges],
  )

  if (agents.length === 0) {
    return (
      <div className="canvas empty">
        <p>No agents recorded for this session yet.</p>
      </div>
    )
  }

  return (
    <div className="canvas">
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={1}
        maxZoom={4}
        proOptions={{ hideAttribution: true }}
        onNodeDoubleClick={(_event, node) => onOpenAgent(node.id)}
        onNodeClick={(_event, node) => onSelectAgent(node.id)}
        onMoveEnd={(_e, vp) => {
          const z = snapZoom(vp.zoom)
          if (z !== vp.zoom) flow.setViewport({ ...vp, zoom: z })
        }}
      >
        <Background gap={16} size={1} />
      </ReactFlow>
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
