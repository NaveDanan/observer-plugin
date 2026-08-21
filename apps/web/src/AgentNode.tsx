import { useState } from "react"
import { Handle, Position } from "@xyflow/react"
import type { NodeProps } from "@xyflow/react"
import type { AgentEntity, ToolCallEntity } from "@observer-ai/protocol"
import type { EmployeeMatch } from "@observer-ai/roster"

export interface AgentNodeData extends Record<string, unknown> {
  agent: AgentEntity
  hostLabel: string
  isRoot: boolean
  selected: boolean
  onOpen: () => void
  /** The tool currently running, if any. Null means idle / no data. */
  activity?: { tool: ToolCallEntity; elapsedMs: number }
  /** The employee seated on this node, if the matcher found one. */
  match?: EmployeeMatch
}

const STATUS_LABEL: Record<AgentEntity["status"], string> = {
  starting: "starting",
  running: "running",
  idle: "idle",
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m < 60) return `${m}m ${r}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function initialsOf(name: string): string {
  const parts = name.replace(/^Dr\.\s*/, "").split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase()
}

/**
 * The node's second line.
 *
 * A subcontractor and a node nobody could be seated on are different states,
 * and the node says which. The short form fits the 11px role line; the long
 * form is the tooltip and the screen-reader label.
 */
function roleOf(
  agent: AgentEntity,
  hostLabel: string,
  isRoot: boolean,
  employee: { title: string } | undefined,
): { short: string; long: string } {
  if (employee) return { short: employee.title, long: employee.title }
  if (agent.agentType === "subcontractor") {
    return { short: "subcontractor", long: "Subcontractor — this Agent runs without an employee." }
  }
  // The root agent is the developer's own agent; it is never seated, so it
  // reports the host rather than a failed seating.
  if (isRoot) return { short: hostLabel, long: hostLabel }
  return {
    short: "no employee seated",
    long: "No employee seated — nothing on the roster scored high enough for this task.",
  }
}

/**
 * One agent on the canvas, drawn as its seated employee.
 *
 * The node carries the employee's photo, name, tone and top strengths. When
 * the matcher cannot seat anyone confidently the node says so plainly rather
 * than inventing a persona.
 */
export function AgentNode({ data }: NodeProps): JSX.Element {
  const { agent, hostLabel, isRoot, selected, onOpen, activity, match } = data as AgentNodeData
  const live = agent.status === "running" || agent.status === "starting"
  const failed = agent.status === "failed"
  const employee = match?.profile
  const elapsedText = activity ? formatElapsed(activity.elapsedMs) : undefined
  // A photo that 404s must degrade to initials rather than a broken-image box.
  // Keyed by URL, not a boolean, so re-seating the node with a different
  // employee gives the new photo a fresh chance to load.
  const [brokenPhotoUrl, setBrokenPhotoUrl] = useState<string | undefined>(undefined)
  const photoSrc = employee && employee.imageUrl !== brokenPhotoUrl ? employee.imageUrl : undefined

  let activityText: string
  let activityTitle: string | undefined
  if (failed) {
    activityText = "failed"
    activityTitle = agent.summary ?? undefined
  } else if (activity) {
    activityText = `${activity.tool.tool} · ${elapsedText}`
    activityTitle = activity.tool.title ?? activity.tool.tool
  } else if (live) {
    activityText = "running — no tool data"
    activityTitle = "Host does not report the current tool for this agent"
  } else {
    activityText = "idle"
  }

  const name = employee?.fullName ?? agent.displayName ?? agent.agentType
  const role = roleOf(agent, hostLabel, isRoot, employee)
  const tone = employee?.tone
  const strengths = employee ? employee.fields.slice(0, 3) : []

  return (
    <div
      className={`node employee-node status-${agent.status}${selected ? " is-selected" : ""}${live ? " is-live" : ""}${isRoot ? " is-root" : ""}${failed ? " is-failed" : ""}`}
      tabIndex={0}
      role="button"
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onOpen()
        }
      }}
      aria-label={`${name}, ${role.long} ${STATUS_LABEL[agent.status]}. ${activityText}. Press Enter for details.`}
    >
      {!isRoot && <Handle type="target" position={Position.Top} />}

      <header className="employee-head">
        <div className={`employee-photo status-${agent.status}`}>
          {photoSrc ? (
            <img
              src={photoSrc}
              alt={employee?.fullName ?? name}
              draggable={false}
              loading="lazy"
              onError={() => setBrokenPhotoUrl(photoSrc)}
            />
          ) : (
            <span className="employee-initials" aria-hidden="true">
              {initialsOf(name)}
            </span>
          )}
          <span className={`dot status-${agent.status} photo-dot`} aria-hidden="true" />
        </div>
        <div className="employee-id">
          <span className="node-title" title={name}>
            {name}
          </span>
          <span className="node-role" title={role.long}>
            {role.short}
          </span>
          <span className={`badge status-${agent.status}${live ? " badge-running" : ""}`}>
            {live && <span className="pulse-dot" aria-hidden="true" />}
            {STATUS_LABEL[agent.status]}
          </span>
        </div>
        {isRoot && <span className="badge badge-root">root</span>}
      </header>

      {tone && <p className="node-tone">{tone}</p>}

      {strengths.length > 0 && (
        <div className="node-chips">
          {strengths.map((field) => (
            <span key={field} className="chip">
              {field}
            </span>
          ))}
        </div>
      )}

      <footer className="node-foot">
        <span className="node-model" title={agent.model ?? undefined}>
          {agent.model ?? <span className="node-unknown">model unknown</span>}
        </span>
        <span className="node-activity" title={activityTitle}>
          {activityText}
        </span>
      </footer>

      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}
