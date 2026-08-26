import { useCallback, useEffect, useState } from "react"
import { ChevronDownIcon, ChevronRightIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react"
import type { AgentEntity, SessionEntity } from "@observer-ai/protocol"
import type { EmployeeMatch } from "@observer-ai/roster"
import { PROVIDER_ICON, ProviderTag, providerLabel } from "./Icons"
import { relativeTime } from "./relativeTime"

const STORAGE_KEY = "observer:sidebar-collapsed"

/**
 * Whether the session list is folded to a rail, remembered across reloads.
 *
 * Persisted for the same reason the theme is: a session can run for an hour
 * behind this page, and re-collapsing the sidebar after every reload is a
 * chore the app can simply not impose. Reads are wrapped because Safari throws
 * on `localStorage` in private mode rather than returning null, and a storage
 * quirk must not be able to stop the canvas from rendering.
 */
function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true"
  } catch {
    return false
  }
}

export function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(collapsed))
    } catch {
      // A preference that cannot be saved is still a preference that works
      // for this session.
    }
  }, [collapsed])
  return [collapsed, useCallback(() => setCollapsed((value) => !value), [])]
}

export interface SessionSidebarProps {
  sessions: SessionEntity[]
  activeSessionId: string | undefined
  agents: AgentEntity[]
  matches: Map<string, EmployeeMatch | undefined>
  selectedAgentId: string | undefined
  connection: string
  boundHostLabel: string | undefined
  /** One clock for every row, so no two rows disagree about what "now" is. */
  now: number
  collapsed: boolean
  onToggleCollapsed: () => void
  onSelectSession: (id: string) => void
  onSelectAgent: (id: string) => void
  onRemoveSession: (id: string) => void
}

/**
 * The session list, and its folded form.
 *
 * Collapsing keeps a rail rather than removing the sidebar outright. A rail
 * costs 48px and preserves the two things the expanded list is used for
 * without opening it — knowing which sessions exist, and switching between
 * them — where a full hide would force a round trip through the toggle for
 * every switch. It also keeps the toggle in a fixed place, so re-opening does
 * not become a hunt.
 */
export function SessionSidebar(props: SessionSidebarProps): JSX.Element {
  const { sessions, activeSessionId, agents, matches, selectedAgentId, collapsed, now } = props
  const [expandedAgentSessions, setExpandedAgentSessions] = useState<Set<string>>(() => new Set())

  return (
    <nav className={`sidebar${collapsed ? " is-collapsed" : ""}`} aria-label="Agent sessions">
      <div className="section-header">
        {!collapsed && <span>Agent sessions</span>}
        <button
          type="button"
          className="icon-button sidebar-toggle"
          onClick={props.onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand session list" : "Collapse session list"}
          title={collapsed ? "Expand session list" : "Collapse session list"}
        >
          {collapsed ? (
            <PanelLeftOpenIcon size={14} aria-hidden="true" />
          ) : (
            <PanelLeftCloseIcon size={14} aria-hidden="true" />
          )}
        </button>
      </div>

      {collapsed ? (
        <div className="session-rail">
          {sessions.map((entry) => {
            const Icon = PROVIDER_ICON[entry.host]
            const title = sessionTitle(entry)
            return (
              <button
                key={entry.id}
                type="button"
                className={`session-rail-item${entry.id === activeSessionId ? " is-active" : ""}`}
                onClick={() => props.onSelectSession(entry.id)}
                title={`${title} — ${providerLabel(entry.host)}`}
                aria-current={entry.id === activeSessionId}
              >
                {Icon ? <Icon size={16} /> : <span className="session-rail-initial">{entry.host.slice(0, 2)}</span>}
              </button>
            )
          })}
        </div>
      ) : (
        <div className="session-list">
          {sessions.length === 0 && <p className="muted small session-empty">No agent sessions captured yet.</p>}
          {sessions.map((entry) => {
            const isActive = entry.id === activeSessionId
            const isAgentListExpanded = expandedAgentSessions.has(entry.id)
            const agentListId = `session-agents-${entry.id}`
            const liveCount = isActive
              ? agents.filter((a) => a.status === "running" || a.status === "starting").length
              : 0
            const updated = relativeTime(entry.updatedAt, now)
            return (
              <div
                key={entry.id}
                className={`session-item ${isActive ? "is-active" : ""}`}
                onClick={() => props.onSelectSession(entry.id)}
              >
                <div className="session-title">{sessionTitle(entry)}</div>
                <div className="session-meta">
                  <ProviderTag host={entry.host} />
                  {/* Rows are ordered by creation, which never moves. This says
                      how warm the session is — the fact that ordering used to
                      carry, now stated instead of implied. */}
                  <time className="session-updated" dateTime={new Date(entry.updatedAt).toISOString()} title={`Last update: ${updated.absolute}`}>
                    {updated.label}
                  </time>
                  {isActive && agents.length > 0 && (
                    <button
                      type="button"
                      className="session-agents-toggle"
                      aria-expanded={isAgentListExpanded}
                      aria-controls={agentListId}
                      onClick={(event) => {
                        event.stopPropagation()
                        setExpandedAgentSessions((expanded) => {
                          const next = new Set(expanded)
                          if (next.has(entry.id)) next.delete(entry.id)
                          else next.add(entry.id)
                          return next
                        })
                      }}
                    >
                      <span className="diff-badge">
                        <span className="diff-add">
                          {agents.length} agent{agents.length === 1 ? "" : "s"}
                          {liveCount > 0 ? ` · ${liveCount} live` : ""}
                        </span>
                      </span>
                      {isAgentListExpanded ? (
                        <ChevronDownIcon size={12} aria-hidden="true" />
                      ) : (
                        <ChevronRightIcon size={12} aria-hidden="true" />
                      )}
                    </button>
                  )}
                </div>

                {isActive && isAgentListExpanded && agents.length > 0 && (
                  <div id={agentListId} className="agent-mini-list">
                    {agents.map((agent) => {
                      const match = matches.get(agent.id)
                      const name = match?.profile.fullName ?? agent.displayName ?? agent.agentType
                      return (
                        <button
                          key={agent.id}
                          className={`agent-mini${agent.id === selectedAgentId ? " is-selected" : ""}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            props.onSelectAgent(agent.id)
                          }}
                          title={`${name} — ${agent.status}`}
                        >
                          {match ? (
                            <img className="agent-mini-photo" src={match.profile.imageUrl} alt="" draggable={false} />
                          ) : (
                            <span className="agent-mini-photo agent-mini-initials">{initialsOf(name)}</span>
                          )}
                          <span className="agent-mini-name">{name}</span>
                          <span className={`dot status-${agent.status}`} aria-hidden="true" />
                        </button>
                      )
                    })}
                  </div>
                )}

                {isActive && (
                  <button
                    className="danger small session-delete"
                    onClick={(e) => {
                      e.stopPropagation()
                      props.onRemoveSession(entry.id)
                    }}
                  >
                    Delete session
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {!collapsed && (
        <div className="sidebar-footer">
          <div className="connection-row">
            <span className={`status-pill status-${props.connection}`}>{props.connection}</span>
            <span className="muted small">{props.boundHostLabel ?? "all hosts"}</span>
          </div>
        </div>
      )}
    </nav>
  )
}

/** The harness owns session naming. Observer never substitutes its goal or id. */
export function sessionTitle(session: SessionEntity): string {
  const title = session.title?.trim()
  return title && title.length > 0 ? title : "Title pending from harness"
}

function initialsOf(name: string): string {
  const parts = name
    .replace(/^Dr\.\s*/, "")
    .split(/\s+/)
    .filter(Boolean)
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase()
}
