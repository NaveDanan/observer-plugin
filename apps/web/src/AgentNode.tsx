import { Handle, Position } from "@xyflow/react"
import type { NodeProps } from "@xyflow/react"
import type { AgentCounts, AgentEntity, TodoEntity } from "@observer-ai/protocol"

export interface AgentNodeData extends Record<string, unknown> {
  agent: AgentEntity
  todos: TodoEntity[]
  counts: AgentCounts
  hostLabel: string
  isRoot: boolean
  selected: boolean
  onOpen: () => void
}

const STATUS_LABEL: Record<AgentEntity["status"], string> = {
  starting: "starting",
  running: "running",
  idle: "idle",
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
}

/**
 * One agent on the canvas.
 *
 * Shows the model per node (a core requirement) and never invents data: an
 * unknown model renders as "model unknown" rather than a plausible guess.
 */
export function AgentNode({ data }: NodeProps): JSX.Element {
  const { agent, todos, counts, hostLabel, isRoot, selected, onOpen } = data as AgentNodeData
  const open = todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled").length
  const live = agent.status === "running" || agent.status === "starting"

  return (
    <div
      className={`node status-${agent.status}${selected ? " is-selected" : ""}${live ? " is-live" : ""}`}
      tabIndex={0}
      role="button"
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onOpen()
        }
      }}
      aria-label={`${agent.displayName ?? agent.agentType} agent, ${STATUS_LABEL[agent.status]}. Press Enter for details.`}
    >
      {!isRoot && <Handle type="target" position={Position.Top} />}
      <header className="node-head">
        <span className={`dot status-${agent.status}`} aria-hidden="true" />
        <span className="node-title" title={agent.displayName ?? agent.agentType}>
          {agent.displayName ?? agent.agentType}
        </span>
        <span className="node-host">{hostLabel}</span>
      </header>

      <div className="node-model" title={agent.model ?? undefined}>
        {agent.model ? (
          <>
            <span className="node-model-name">{agent.model}</span>
            {agent.modelConfidence && agent.modelConfidence !== "authoritative" && (
              <span className="badge badge-soft" title={`Model attribution is ${agent.modelConfidence}`}>
                {agent.modelConfidence}
              </span>
            )}
          </>
        ) : (
          <span className="node-unknown">model unknown</span>
        )}
      </div>

      <footer className="node-foot">
        <span className={`badge status-${agent.status}`}>{STATUS_LABEL[agent.status]}</span>
        {counts.messages > 0 && (
          <span className="badge badge-soft" title={`${counts.messages} messages`}>
            {counts.messages} msg
          </span>
        )}
        {counts.toolCalls > 0 && (
          <span className="badge badge-soft" title={`${counts.toolCalls} tool calls`}>
            {counts.toolCalls} tools
          </span>
        )}
        {todos.length > 0 && (
          <span className="badge badge-soft" title={`${open} of ${todos.length} still open`}>
            {todos.length - open}/{todos.length} todos
          </span>
        )}
        {isRoot && <span className="badge badge-soft">root</span>}
      </footer>

      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}
