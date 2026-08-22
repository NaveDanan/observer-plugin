import { useState } from "react"
import type { AgentEntity, MessageEntity, TodoEntity, ToolCallEntity } from "@observer-ai/protocol"
import type { EmployeeMatch } from "@observer-ai/roster"
import { describeReason } from "@observer-ai/roster"
import { CARD_LAYOUT } from "./employeeCard"

export interface ProfileTabProps {
  agent: AgentEntity
  match: EmployeeMatch | undefined
  messages: MessageEntity[]
  toolCalls: ToolCallEntity[]
  todos: TodoEntity[]
  /** Raises the NJ-LABS ID card. Only offered when somebody is seated. */
  onOpenCard: () => void
}

/**
 * Who is seated on this node, and why.
 *
 * This used to be a third docked panel between the session list and the
 * canvas. Three permanent columns spent 940px of a 1440px screen on chrome
 * before the canvas — the thing the app is for — got any, and the profile was
 * the column paying the least rent: it is read once when a node is selected
 * and then ignored while its work is followed on the right. Folding it into
 * the activity panel as a tab gives the canvas that width back and puts every
 * question about one agent behind the same set of tabs.
 *
 * It is a plain section, not a dialog: the panel around it owns the heading,
 * the close button and the dismiss layer, and a second Escape handler in here
 * would race the one out there.
 */
export function ProfileTab(props: ProfileTabProps): JSX.Element {
  const { agent, match, messages, toolCalls, todos, onOpenCard } = props
  const employee = match?.profile
  const name = employee?.fullName ?? agent.displayName ?? agent.agentType
  // A photo that 404s must degrade to initials rather than a broken-image box.
  // Keyed by URL, not a boolean, so re-seating this node retries the new one.
  const [brokenPhotoUrl, setBrokenPhotoUrl] = useState<string | undefined>(undefined)
  const photoSrc = employee && employee.imageUrl !== brokenPhotoUrl ? employee.imageUrl : undefined
  // Two different states, two different sentences. A subcontractor was staffed
  // with nobody on purpose; an unseated node is the matcher declining to guess.
  const isSubcontractor = agent.agentType === "subcontractor"

  return (
    <div className="stack profile">
      <header className="profile-head">
        <div className={`employee-photo large status-${agent.status}`}>
          {photoSrc ? (
            <img
              src={photoSrc}
              alt={employee?.fullName ?? name}
              draggable={false}
              loading="lazy"
              decoding="async"
              /* Intrinsic size of every roster portrait. Without it the photo
                 well has no height until the source decodes, and everything
                 below it reflows once it does. */
              width={CARD_LAYOUT.portrait.width}
              height={CARD_LAYOUT.portrait.height}
              onError={() => setBrokenPhotoUrl(photoSrc)}
            />
          ) : (
            <span className="employee-initials" aria-hidden="true">
              ?
            </span>
          )}
          <span className={`dot status-${agent.status} photo-dot`} aria-hidden="true" />
        </div>
        <div className="profile-id">
          <h3 className="profile-name">{name}</h3>
          <p className="worker-title">
            {employee?.title ?? (isSubcontractor ? "subcontractor" : "no employee seated")}
          </p>
          {employee && (
            <p className="muted small">
              {employee.experienceSummary} · {employee.animal}
            </p>
          )}
          {employee && (
            <button className="pixel-btn" onClick={onOpenCard} title="Also: double-click the Agent on the canvas">
              ID CARD
            </button>
          )}
        </div>
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
    </div>
  )
}
