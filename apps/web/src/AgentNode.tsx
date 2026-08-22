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
  /** Selects the agent and docks its panels. Enter, Space, or a single click. */
  onOpen: () => void
  /** Raises the seated employee's ID card. Shift+Enter, or a double click. */
  onOpenCard: () => void
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

/**
 * The status word a node displays, which is not always the protocol's word.
 *
 * A subagent sitting on `idle` has had its work end — the host simply has no
 * "finished" status — so it says *finished* instead of a word that reads as
 * *waiting*. `completed` joins it. The root agent keeps `idle` because
 * between turns it genuinely is waiting for its developer, and calling that
 * finished would be wrong in a way users would notice. `failed` and
 * `interrupted` keep their own names: they are warnings, not completions.
 *
 * Display only — the protocol enum is never rewritten by this.
 */
export function displayStatusLabel(status: AgentEntity["status"], isRoot: boolean): string {
  if (!isRoot && (status === "idle" || status === "completed")) return "finished"
  return STATUS_LABEL[status]
}

/**
 * True when a subagent's work is over and the node should settle down:
 * dimmed photo, steady dot, settled badge. Roots are excluded — an idle root
 * is waiting, not done, and must keep its live look.
 */
export function isDoneNode(status: AgentEntity["status"], isRoot: boolean): boolean {
  return !isRoot && (status === "idle" || status === "completed")
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
  const { agent, hostLabel, isRoot, selected, onOpen, onOpenCard, activity, match } = data as AgentNodeData
  const live = agent.status === "running" || agent.status === "starting"
  const failed = agent.status === "failed"
  const done = isDoneNode(agent.status, isRoot)
  const employee = match?.profile
  const elapsedText = activity ? formatElapsed(activity.elapsedMs) : undefined
  // A photo that 404s must degrade to initials rather than a broken-image box.
  // Keyed by URL, not a boolean, so re-seating the node with a different
  // employee gives the new photo a fresh chance to load.
  const [brokenPhotoUrl, setBrokenPhotoUrl] = useState<string | undefined>(undefined)
  const photoSrc = employee && employee.imageUrl !== brokenPhotoUrl ? employee.imageUrl : undefined

  const statusText = displayStatusLabel(agent.status, isRoot)

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
    // Same mapping as the badge: a finished subagent does not read as waiting.
    activityText = statusText
  }

  const name = employee?.fullName ?? agent.displayName ?? agent.agentType
  const role = roleOf(agent, hostLabel, isRoot, employee)
  const tone = employee?.tone
  const strengths = employee ? employee.fields.slice(0, 3) : []

  return (
    <div
      className={`node employee-node status-${agent.status}${selected ? " is-selected" : ""}${live ? " is-live" : ""}${done ? " is-done" : ""}${isRoot ? " is-root" : ""}${failed ? " is-failed" : ""}`}
      tabIndex={0}
      role="button"
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        // Shift is the keyboard's double-click. The Worker card also carries a
        // real button for it, because a modifier nobody can see is not an
        // affordance — this is the shortcut, that is the discovery path.
        if (event.shiftKey && employee) onOpenCard()
        else onOpen()
      }}
      aria-label={`${name}, ${role.long} ${statusText}. ${activityText}. Press Enter for details${employee ? ", Shift plus Enter for their ID card" : ""}.`}
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
          <span className={`badge status-${agent.status}${live ? " badge-running" : ""}${done ? " badge-done" : ""}`}>
            {live && <span className="pulse-dot" aria-hidden="true" />}
            {statusText}
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
