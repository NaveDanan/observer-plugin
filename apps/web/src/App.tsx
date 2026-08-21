import { useEffect } from "react"
import { Canvas } from "./Canvas"
import { DetailPanel } from "./DetailPanel"
import { WorkerCard } from "./WorkerCard"
import type { DeliveryDiagnostics } from "./api"
import {
  dismissDiagnostics,
  getState,
  initialise,
  removeSession,
  selectActiveSession,
  selectAgent,
  selectAgents,
  selectEdges,
  selectEmployeeMatch,
  selectHostCapabilities,
  selectMessages,
  selectPromptFragments,
  selectSession,
  selectSessions,
  selectToolCalls,
  selectTodos,
  useStoreVersion,
} from "./store"

export function App(): JSX.Element {
  useStoreVersion()
  const state = getState()
  const now = Date.now()

  useEffect(() => {
    void initialise()
  }, [])

  const sessions = selectSessions(state)
  const session = selectActiveSession(state)
  const agents = selectAgents(state, session?.id)
  const edges = selectEdges(state, session?.id)
  const capabilities = selectHostCapabilities(state, session?.host)
  const boundHost = selectHostCapabilities(state, state.scopeHost)
  const selectedAgent = state.selectedAgentId ? state.agents.get(state.selectedAgentId) : undefined
  /** Employee seated per node, computed once per agent revision. */
  const matches = new Map(agents.map((agent) => [agent.id, selectEmployeeMatch(state, agent)]))

  if (state.error && !state.ready) {
    return (
      <div className="fatal">
        <h1>Observer cannot reach its daemon</h1>
        <p className="mono">{state.error}</p>
        <p>
          Start it with <code>observer start</code>, then reload this page.
        </p>
      </div>
    )
  }

  return (
    <div className={`app${selectedAgent ? " has-panel" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          <strong>Observer</strong>
          <span className="brand-sub">canvas</span>
        </div>

        {session && (
          <div className="topbar-goal" title={session.goal ?? undefined}>
            <span className="topbar-goal-label">Goal</span>
            <span className="topbar-goal-text">{session.goal ?? "No goal recorded yet."}</span>
          </div>
        )}

        <div className="topbar-right">
          {boundHost && (
            <span className="bound" title={boundHost.notes.join("\n")}>
              connected to <strong>{boundHost.label}</strong>
            </span>
          )}
          <span className={`status status-${state.connection}`}>{state.connection}</span>
        </div>
      </header>

      {state.diagnostics && state.diagnostics.faults > 0 && !state.diagnosticsDismissed && (
        <div className="alert" role="status">
          <span>
            <strong>{state.diagnostics.faults}</strong> deliveries arrived but could not be recorded
            {topFaultHosts(state.diagnostics)}. Run <code>observer doctor</code> to see which events and why.
          </span>
          <button className="icon-button" onClick={dismissDiagnostics} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      <div className="body">
        <nav className="sidebar" aria-label="Agent sessions">
          <div className="section-header">
            <span>Agent sessions</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx="5" cy="6" r="2.5" />
              <circle cx="19" cy="6" r="2.5" />
              <circle cx="12" cy="18" r="2.5" />
              <path d="M6.5 8l4 8M17.5 8l-4 8" />
            </svg>
          </div>

          <div className="session-list">
            {sessions.length === 0 && (
              <p className="muted small" style={{ padding: "8px" }}>
                No agent sessions captured yet.
              </p>
            )}
            {sessions.map((entry) => {
              const isActive = entry.id === session?.id
              const hostLabel =
                entry.host === "opencode"
                  ? "OpenCode"
                  : entry.host === "claude"
                    ? "Claude"
                    : entry.host === "codex"
                      ? "Codex"
                      : entry.host
              const liveCount = isActive
                ? agents.filter((a) => a.status === "running" || a.status === "starting").length
                : 0
              return (
                <div
                  key={entry.id}
                  className={`session-item ${isActive ? "is-active" : ""}`}
                  onClick={() => void selectSession(entry.id)}
                >
                  <div className="session-title">{entry.title ?? entry.goal ?? entry.sessionKey}</div>
                  <div className="session-meta">
                    <span className="host-tag">{hostLabel}</span>
                    <span>{new Date(entry.updatedAt).toLocaleDateString()}</span>
                    {isActive && agents.length > 0 && (
                      <span className="diff-badge">
                        <span className="diff-add">
                          {agents.length} agent{agents.length === 1 ? "" : "s"}
                          {liveCount > 0 ? ` · ${liveCount} live` : ""}
                        </span>
                      </span>
                    )}
                  </div>

                  {isActive && agents.length > 0 && (
                    <div className="agent-mini-list">
                      {agents.map((agent) => {
                        const match = matches.get(agent.id)
                        const name = match?.profile.fullName ?? agent.displayName ?? agent.agentType
                        return (
                          <button
                            key={agent.id}
                            className={`agent-mini${agent.id === state.selectedAgentId ? " is-selected" : ""}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              void selectAgent(agent.id)
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
                      className="danger small"
                      style={{ marginTop: "6px" }}
                      onClick={(e) => {
                        e.stopPropagation()
                        void removeSession(entry.id)
                      }}
                    >
                      Delete session
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          <div className="sidebar-footer">
            <div className="connection-row">
              <span className={`status status-${state.connection}`}>{state.connection}</span>
              <span className="muted small">{boundHost ? boundHost.label : "all hosts"}</span>
            </div>
          </div>
        </nav>

        {selectedAgent && (
          <WorkerCard
            agent={selectedAgent}
            match={matches.get(selectedAgent.id)}
            messages={selectMessages(state, selectedAgent.id)}
            toolCalls={selectToolCalls(state, selectedAgent.id)}
            todos={selectTodos(state, selectedAgent.id)}
            onClose={() => void selectAgent(undefined)}
          />
        )}

        <main className="stage">
          {session ? (
            <div className="canvas-wrap">
              <div className="preview-badge">
                {session.host} · {agents.length} agents · {session.model ?? "model unknown"}
              </div>
              <Canvas
                agents={agents}
                edges={edges}
                matches={matches}
                runningTools={state.runningTools}
                hostLabel={capabilities?.label ?? session.host}
                selectedAgentId={state.selectedAgentId}
                now={now}
                onOpenAgent={(id) => void selectAgent(id)}
                onSelectAgent={(id) => void selectAgent(id)}
              />
            </div>
          ) : (
            <div className="canvas empty">
              <p>
                {boundHost
                  ? `Waiting for a ${boundHost.label} session. Run a prompt and it will appear here.`
                  : "Run an agent in OpenCode, Codex, Claude Code or Copilot CLI to see it here."}
              </p>
            </div>
          )}
        </main>

        {selectedAgent && (
          <DetailPanel
            agent={selectedAgent}
            match={matches.get(selectedAgent.id)}
            messages={selectMessages(state, selectedAgent.id)}
            toolCalls={selectToolCalls(state, selectedAgent.id)}
            todos={selectTodos(state, selectedAgent.id)}
            promptFragments={selectPromptFragments(state, selectedAgent.id)}
            capabilities={capabilities}
            onClose={() => void selectAgent(undefined)}
          />
        )}
      </div>
    </div>
  )
}

/** Names the hosts responsible for failed deliveries, when they are known. */
function topFaultHosts(diagnostics: DeliveryDiagnostics): string {
  const hosts = [...new Set(diagnostics.recent.map((entry) => entry.host))].slice(0, 3)
  return hosts.length > 0 ? ` (${hosts.join(", ")})` : ""
}

function initialsOf(name: string): string {
  const parts = name.replace(/^Dr\.\s*/, "").split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase()
}
