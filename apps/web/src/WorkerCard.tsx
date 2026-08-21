import { useEffect, useRef } from "react"
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
          {employee ? (
            <img src={employee.imageUrl} alt={employee.fullName} draggable={false} />
          ) : (
            <span className="employee-initials" aria-hidden="true">
              ?
            </span>
          )}
          <span className={`dot status-${agent.status} photo-dot`} aria-hidden="true" />
        </div>
        <div className="worker-id">
          <h2>{name}</h2>
          <p className="worker-title">{employee?.title ?? "Unassigned"}</p>
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
          <p className="empty-title">No employee seated</p>
          <p className="muted small">
            The matcher found no roster fit for this agent's task. It is shown with a placeholder identity.
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
                <span className={`badge status-${agent.status}`}>{agent.status}</span>
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
