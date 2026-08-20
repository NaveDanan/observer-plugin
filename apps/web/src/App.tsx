import { useEffect, useMemo } from "react"
import { Canvas } from "./Canvas"
import { DetailPanel } from "./DetailPanel"
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
  selectHostCapabilities,
  selectMessages,
  selectPromptFragments,
  selectSession,
  selectSessionTodos,
  selectSessions,
  selectToolCalls,
  selectTodos,
  useStoreVersion,
} from "./store"

export function App(): JSX.Element {
  useStoreVersion()
  const state = getState()

  useEffect(() => {
    void initialise()
  }, [])

  const sessions = selectSessions(state)
  const session = selectActiveSession(state)
  const agents = selectAgents(state, session?.id)
  const edges = selectEdges(state, session?.id)
  const sessionTodos = selectSessionTodos(state, session?.id)
  const capabilities = selectHostCapabilities(state, session?.host)
  const boundHost = selectHostCapabilities(state, state.scopeHost)
  const selectedAgent = state.selectedAgentId ? state.agents.get(state.selectedAgentId) : undefined

  const rootTodos = useMemo(() => {
    const root = agents.find((agent) => !agent.parentAgentId)
    return root ? sessionTodos.filter((todo) => todo.agentId === root.id) : []
  }, [agents, sessionTodos])

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
        </div>

        {/*
          No harness picker: this view is bound to the harness that opened it,
          passed through as ?host= by `observer open`.
        */}
        {boundHost && (
          <span className="bound" title={boundHost.notes.join("\n")}>
            connected to <strong>{boundHost.label}</strong>
          </span>
        )}

        <span className={`status status-${state.connection}`}>{state.connection}</span>
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
        <nav className="sidebar" aria-label="Sessions">
          <h2 className="sidebar-title">Sessions</h2>
          {sessions.length === 0 && <p className="muted small">No sessions captured yet.</p>}
          <ul>
            {sessions.map((entry) => (
              <li key={entry.id}>
                <button
                  className={entry.id === session?.id ? "session is-active" : "session"}
                  onClick={() => void selectSession(entry.id)}
                >
                  <span className="session-title">{entry.title ?? entry.goal ?? entry.sessionKey}</span>
                  <span className="session-meta">
                    <span className={`badge status-${entry.status}`}>{entry.status}</span>
                    <span className="muted small">{entry.host}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <main className="stage">
          {session ? (
            <>
              <section className="overview" aria-label="Session goal and tasks">
                <div className="overview-goal">
                  <h2>Goal</h2>
                  <p>{session.goal ?? "No goal recorded yet."}</p>
                  <p className="muted small">
                    {session.goalStatus === "derived"
                      ? "Derived from the first user prompt."
                      : session.goalStatus
                        ? `Reported by host (${session.goalStatus}).`
                        : ""}
                  </p>
                </div>
                <div className="overview-todos">
                  <h2>Todos</h2>
                  {rootTodos.length === 0 ? (
                    <p className="muted small">No task list captured.</p>
                  ) : (
                    <ul>
                      {rootTodos.slice(0, 8).map((todo) => (
                        <li key={todo.id} className={`todo status-${todo.status}`}>
                          <span className={`marker status-${todo.status}`} aria-hidden="true" />
                          {todo.content}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="overview-meta">
                  <h2>Session</h2>
                  <dl>
                    <dt>Host</dt>
                    <dd>{capabilities?.label ?? session.host}</dd>
                    <dt>Model</dt>
                    <dd className="mono">{session.model ?? "unknown"}</dd>
                    <dt>Agents</dt>
                    <dd>{agents.length}</dd>
                    <dt>Workspace</dt>
                    <dd className="mono small">{session.workspaceRoot}</dd>
                  </dl>
                  <button className="danger" onClick={() => void removeSession(session.id)}>
                    Delete session data
                  </button>
                </div>
              </section>

              <Canvas
                agents={agents}
                edges={edges}
                todos={sessionTodos}
                counts={state.counts}
                hostLabel={capabilities?.label ?? session.host}
                selectedAgentId={state.selectedAgentId}
                onOpenAgent={(id) => void selectAgent(id)}
                onSelectAgent={(id) => void selectAgent(id)}
              />

              {capabilities && (
                <footer className="fidelity">
                  <strong>{capabilities.label} fidelity:</strong> graph {capabilities.agentGraph}, replies{" "}
                  {capabilities.liveAssistantText}, todos {capabilities.todos}, model {capabilities.model}, system prompt{" "}
                  {capabilities.systemPrompt}
                </footer>
              )}
            </>
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
