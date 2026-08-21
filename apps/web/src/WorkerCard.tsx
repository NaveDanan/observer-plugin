import { useEffect, useRef, useState } from "react"
import type { AgentEntity, MessageEntity, TodoEntity, ToolCallEntity } from "@observer-ai/protocol"
import type { EmployeeMatch } from "@observer-ai/roster"
import { describeReason } from "@observer-ai/roster"

export interface WorkerCardProps {
  agent: AgentEntity
  match: EmployeeMatch | undefined
  messages: MessageEntity[]
  toolCalls: ToolCallEntity[]
  todos: TodoEntity[]
  onClose: () => void
}

/**
 * The seated employee's profile card, docked left of the canvas.
 *
 * Identity and behaviour live here (photo, tone, strengths, why they were
 * seated); the right-hand panel carries the work (chat, tools, todos).
 */
export function WorkerCard({ agent, match, messages, toolCalls, todos, onClose }: WorkerCardProps): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  const employee = match?.profile
  const name = employee?.fullName ?? agent.displayName ?? agent.agentType
  // A photo that 404s must degrade to initials rather than a broken-image box.
  const [brokenPhotoUrl, setBrokenPhotoUrl] = useState<string | undefined>(undefined)
  const photoSrc = employee && employee.imageUrl !== brokenPhotoUrl ? employee.imageUrl : undefined
  // Two different states, two different sentences. A subcontractor was staffed
  // with nobody on purpose; an unseated node is the matcher declining to guess.
  const isSubcontractor = agent.agentType === "subcontractor"

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <aside className="worker-card" role="complementary" aria-label={`Worker ${name}`}>
      <header className="worker-head">
        <div className={`employee-photo large status-${agent.status}`}>
          {photoSrc ? (
            <img
              src={photoSrc}
              alt={employee?.fullName ?? name}
              draggable={false}
              onError={() => setBrokenPhotoUrl(photoSrc)}
            />
          ) : (
            <span className="employee-initials" aria-hidden="true">
              ?
            </span>
          )}
          <span className={`dot status-${agent.status} photo-dot`} aria-hidden="true" />
        </div>
        <div className="worker-id">
          <h2>{name}</h2>
          <p className="worker-title">{employee?.title ?? (isSubcontractor ? "subcontractor" : "no employee seated")}</p>
          {employee && (
            <p className="muted small">
              {employee.experienceSummary} · {employee.animal}
            </p>
          )}
        </div>
        <button ref={closeRef} className="icon-button" onClick={onClose} aria-label="Close worker card">
          ✕
        </button>
      </header>

      {!employee && (
        <div className="empty">
          <p className="empty-title">{isSubcontractor ? "Subcontractor" : "No employee seated"}</p>
          <p className="muted small">
            {isSubcontractor
              ? "Subcontractor — this Agent runs without an employee. Nobody was seated here on purpose, so the node states its type instead of borrowing a persona."
              : "No employee seated — nothing on the roster scored high enough for this task. The node keeps the host's own name rather than being given a made-up identity."}
          </p>
        </div>
      )}

      {employee && (
        <>
          {match && match.reasons.length > 0 && (
            <section className="worker-section">
              <h3>Why seated here</h3>
              <ul className="reasons">
                {match.reasons.slice(0, 3).map((reason, index) => (
                  <li key={index}>{describeReason(reason)}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="worker-section">
            <h3>Tone</h3>
            <p className="worker-tone">{employee.tone}</p>
          </section>

          <section className="worker-section">
            <h3>Good at</h3>
            <div className="chip-row">
              {employee.fields.map((field) => (
                <span key={field} className="chip">
                  {field}
                </span>
              ))}
            </div>
          </section>

          {employee.skills.length > 0 && (
            <section className="worker-section">
              <h3>Skills</h3>
              <ul className="skills">
                {employee.skills.map((skill) => (
                  <li key={skill.name}>
                    <strong>{skill.name}</strong>
                    <span className="muted small">{skill.description}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="worker-section">
            <h3>You call them when</h3>
            <ul className="call-when">
              {employee.youCallThemWhen.slice(0, 4).map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          </section>

          <section className="worker-section">
            <h3>On this node</h3>
            <dl className="facts">
              <dt>Status</dt>
              <dd>
                <span
                  className={`badge status-${agent.status}${agent.status === "running" || agent.status === "starting" ? " badge-running" : ""}`}
                >
                  {(agent.status === "running" || agent.status === "starting") && (
                    <span className="pulse-dot" aria-hidden="true" />
                  )}
                  {agent.status}
                </span>
              </dd>
              <dt>Model</dt>
              <dd className="mono">{agent.model ?? "unknown"}</dd>
              {agent.totalTokens ? (
                <>
                  <dt>Tokens</dt>
                  <dd>{agent.totalTokens.toLocaleString()}</dd>
                </>
              ) : null}
              <dt>Messages</dt>
              <dd>{messages.length}</dd>
              <dt>Tool calls</dt>
              <dd>{toolCalls.length}</dd>
              <dt>Todos</dt>
              <dd>{todos.length}</dd>
            </dl>
          </section>
        </>
      )}
    </aside>
  )
}
