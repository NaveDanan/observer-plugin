import { useEffect, useMemo, useRef, useState } from "react"
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import type { AgentCounts, AgentEntity, EdgeEntity, TodoEntity } from "@observer-ai/protocol"
import { AgentNode, type AgentNodeData } from "./AgentNode"
import { NODE_HEIGHT, NODE_WIDTH, graphSignature, layoutGraph, type Position } from "./layout"

const nodeTypes = { agent: AgentNode }

const NO_COUNTS: AgentCounts = { messages: 0, toolCalls: 0, todos: 0 }

export interface CanvasProps {
  agents: AgentEntity[]
  edges: EdgeEntity[]
  todos: TodoEntity[]
  counts: Map<string, AgentCounts>
  hostLabel: string
  selectedAgentId: string | undefined
  onOpenAgent: (agentId: string) => void
  onSelectAgent: (agentId: string) => void
}

/**
 * Interactive agent graph.
 *
 * Double-click (or Enter on a focused node) opens the agent detail panel, which
 * is the primary interaction described in the product brief.
 */
function CanvasInner(props: CanvasProps): JSX.Element {
  const { agents, edges, todos, counts, hostLabel, selectedAgentId, onOpenAgent, onSelectAgent } = props
  const [positions, setPositions] = useState<Map<string, Position>>(new Map())
  const signature = graphSignature(agents, edges)
  const requested = useRef("")
  const flow = useReactFlow()

  useEffect(() => {
    if (requested.current === signature) return
    requested.current = signature
    void layoutGraph(agents, edges).then((next) => {
      // Guard on the signature rather than an effect cleanup flag: `agents`
      // and `edges` are new arrays on every store update, so a cleanup-based
      // cancel would discard the in-flight layout on the next unrelated event.
      if (requested.current !== signature) return
      setPositions(next)
      // Layout resolves after the first paint, so the initial `fitView` ran
      // against placeholder positions; re-fit once the real ones arrive.
      requestAnimationFrame(() => flow.fitView({ padding: 0.18, duration: 220 }))
    })
  }, [signature, agents, edges, flow])

  const todosByAgent = useMemo(() => {
    const map = new Map<string, TodoEntity[]>()
    for (const todo of todos) {
      const list = map.get(todo.agentId) ?? []
      list.push(todo)
      map.set(todo.agentId, list)
    }
    return map
  }, [todos])

  const nodes: Node<AgentNodeData>[] = useMemo(
    () =>
      agents.map((agent, index) => ({
        id: agent.id,
        type: "agent",
        position: positions.get(agent.id) ?? { x: (index % 4) * (NODE_WIDTH + 48), y: Math.floor(index / 4) * (NODE_HEIGHT + 90) },
        data: {
          agent,
          todos: todosByAgent.get(agent.id) ?? [],
          counts: counts.get(agent.id) ?? NO_COUNTS,
          hostLabel,
          isRoot: !agent.parentAgentId,
          selected: agent.id === selectedAgentId,
          onOpen: () => onOpenAgent(agent.id),
        },
        draggable: true,
      })),
    [agents, positions, todosByAgent, counts, hostLabel, selectedAgentId, onOpenAgent],
  )

  const flowEdges: Edge[] = useMemo(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.fromAgentId,
        target: edge.toAgentId,
        animated: edge.edgeType === "spawned",
        label: edge.provenance === "authoritative" ? undefined : edge.provenance,
        className: `edge-${edge.provenance}`,
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
        minZoom={0.2}
        maxZoom={1.75}
        proOptions={{ hideAttribution: true }}
        onNodeDoubleClick={(_event, node) => onOpenAgent(node.id)}
        onNodeClick={(_event, node) => onSelectAgent(node.id)}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="minimap" nodeStrokeWidth={3} />
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
