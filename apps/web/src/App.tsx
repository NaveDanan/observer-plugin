import { Suspense, lazy, useEffect, useState } from "react"
import { SettingsIcon } from "lucide-react"
import { Canvas } from "./Canvas"
import { EmployeeCardModal } from "./EmployeeCardModal"
import { SessionSidebar, useSidebarCollapsed } from "./SessionSidebar"
import { SettingsPage, isSettingsTab, type SettingsTab } from "./settings/SettingsPage"
import { LandingPage } from "./LandingPage"
import type { DeliveryDiagnostics } from "./api"
import {
  closeEmployeeCard,
  dismissDiagnostics,
  getState,
  initialise,
  openEmployeeCard,
  removeSession,
  selectActiveSession,
  selectAgent,
  selectAgents,
  selectEdges,
  selectEmployeeMatch,
  selectFilterCounts,
  selectHostCapabilities,
  selectMessages,
  selectPromptFragments,
  selectSession,
  selectSessions,
  selectToolCalls,
  selectTodos,
  selectVisibleAgents,
  setAgentFilter,
  useStoreVersion,
  type AgentFilterMode,
} from "./store"

/**
 * The activity panel, fetched on first use.
 *
 * It only mounts once an agent is selected, and it drags the whole markdown
 * pipeline behind it — a parser, GFM, and the transcript renderers. None of
 * that is needed to draw the canvas, which is what the first paint is for, so
 * it stays out of the entry chunk and arrives on the click that needs it. The
 * daemon is on localhost, so that fetch is not a meaningful wait.
 */
const DetailPanel = lazy(() => import("./DetailPanel").then((m) => ({ default: m.DetailPanel })))

export function App(): JSX.Element {
  useStoreVersion()
  const state = getState()
  const now = Date.now()
  const settingsTab = useSettingsRoute()
  const [sidebarCollapsed, toggleSidebar] = useSidebarCollapsed()
  const [goalExpanded, setGoalExpanded] = useState(false)
  const landingRequested = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("landing") === "1"

  useEffect(() => {
    void initialise()
  }, [])

  const sessions = selectSessions(state)
  const session = selectActiveSession(state)
  const agents = selectAgents(state, session?.id)
  /**
   * What the canvas draws: every agent, or the active/finished slice.
   *
   * The sidebar keeps the full roster — hiding a node on the canvas must not
   * pretend it stopped existing in the session. Matches stay keyed off the
   * full list so re-revealing a filtered node does not re-run seating.
   */
  const visibleAgents = selectVisibleAgents(state, session?.id)
  /** Hidden nodes take their edges with them; layout already ignores edges whose endpoints are absent. */
  const visibleIds = new Set(visibleAgents.map((agent) => agent.id))
  const visibleEdges = selectEdges(state, session?.id).filter(
    (edge) => visibleIds.has(edge.fromAgentId) && visibleIds.has(edge.toAgentId),
  )
  const filterCounts = selectFilterCounts(state, session?.id)
  const capabilities = selectHostCapabilities(state, session?.host)
  const boundHost = selectHostCapabilities(state, state.scopeHost)
  const selectedAgent = state.selectedAgentId ? state.agents.get(state.selectedAgentId) : undefined
  /** Employee seated per node, computed once per agent revision. */
  const matches = new Map(agents.map((agent) => [agent.id, selectEmployeeMatch(state, agent)]))
  /**
   * The card only exists for a seated employee, so an unseated node or a
   * subcontractor double-clicks to nothing. The Worker card already says why
   * nobody is there; inventing an ID card for them would contradict it.
   */
  const cardProfile = state.cardAgentId ? matches.get(state.cardAgentId)?.profile : undefined

  const openCard = (agentId: string): void => {
    if (!matches.get(agentId)?.profile) return
    void selectAgent(agentId)
    openEmployeeCard(agentId)
  }

  if (state.error && !state.ready) {
    if (state.scopeSession) {
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
  }

  if ((landingRequested || !session) && !settingsTab) {
    return <LandingPage connection={state.connection} error={state.error} onOpenSettings={() => openSettings("general")} />
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
          <div className={`topbar-goal${goalExpanded ? " is-expanded" : ""}`} title={session.goal ?? undefined}>
            <span className="topbar-goal-label">Goal</span>
            <button
              type="button"
              className="topbar-goal-toggle"
              aria-expanded={goalExpanded}
              aria-controls="topbar-goal-text"
              onClick={() => setGoalExpanded((expanded) => !expanded)}
            >
              {goalExpanded ? "Hide goal" : "Show goal"}
            </button>
            <span id="topbar-goal-text" className="topbar-goal-text">{session.goal ?? "No goal recorded yet."}</span>
          </div>
        )}

        <div className="topbar-right">
          {session && (
            <CanvasFilterControl
              mode={state.agentFilter}
              counts={filterCounts}
              onChange={setAgentFilter}
            />
          )}
          {session && (
            <span className="tip-pill">
              {selectedAgent ? "Double-click an Agent for their ID card" : "Click an Agent to open its panel"}
            </span>
          )}
          {boundHost && (
            <span className="bound" title={boundHost.notes.join("\n")}>
              connected to <strong>{boundHost.label}</strong>
            </span>
          )}
          <span className={`status-pill status-${state.connection}`}>{state.connection}</span>
          <button
            className="icon-button"
            aria-label="Settings"
            title="Settings"
            onClick={() => openSettings("general")}
          >
            <SettingsIcon size={14} aria-hidden="true" />
          </button>
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
        <SessionSidebar
          sessions={sessions}
          activeSessionId={session?.id}
          agents={agents}
          matches={matches}
          selectedAgentId={state.selectedAgentId}
          connection={state.connection}
          boundHostLabel={boundHost?.label}
          now={now}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={toggleSidebar}
          onSelectSession={(id) => void selectSession(id)}
          onSelectAgent={(id) => void selectAgent(id)}
          onRemoveSession={(id) => void removeSession(id)}
        />

        <main className="stage">
          {session ? (
            <div className="canvas-wrap">
              <div className="preview-badge">
                {session.host} · {agents.length} agents · {session.model ?? "model unknown"}
              </div>
              <Canvas
                key={session.id}
                agents={visibleAgents}
                edges={visibleEdges}
                matches={matches}
                runningTools={state.runningTools}
                hostLabel={capabilities?.label ?? session.host}
                selectedAgentId={state.selectedAgentId}
                focusAgentId={state.selectedAgentId}
                now={now}
                onOpenCard={openCard}
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
          /* The fallback is the panel's own empty shell, not a spinner: the
             layout must not shift when the real one arrives. */
          <Suspense fallback={<aside className="panel" aria-busy="true" />}>
            <DetailPanel
              agent={selectedAgent}
              match={matches.get(selectedAgent.id)}
              messages={selectMessages(state, selectedAgent.id)}
              toolCalls={selectToolCalls(state, selectedAgent.id)}
              todos={selectTodos(state, selectedAgent.id)}
              promptFragments={selectPromptFragments(state, selectedAgent.id)}
              capabilities={capabilities}
              onOpenCard={() => openCard(selectedAgent.id)}
              onClose={() => void selectAgent(undefined)}
            />
          </Suspense>
        )}
      </div>

      {cardProfile && state.cardAgentId && (
        <EmployeeCardModal
          key={state.cardAgentId}
          profile={cardProfile}
          onClose={closeEmployeeCard}
          returnFocus={nodeElement(state.cardAgentId)}
        />
      )}

      {settingsTab && (
        <SettingsPage tab={settingsTab} onTabChange={openSettings} onClose={closeSettings} />
      )}
    </div>
  )
}

/**
 * Settings live in the URL fragment (`#settings/providers`), not in component
 * state.
 *
 * The canvas is a long-lived surface — a session can run for an hour behind
 * this page — so settings had to be somewhere a reload could restore and a
 * link could point at, without dragging a router into an app that otherwise
 * has exactly one screen.
 */
function useSettingsRoute(): SettingsTab | undefined {
  const [hash, setHash] = useState(() => (typeof window === "undefined" ? "" : window.location.hash))

  useEffect(() => {
    const onHashChange = (): void => setHash(window.location.hash)
    window.addEventListener("hashchange", onHashChange)
    return () => window.removeEventListener("hashchange", onHashChange)
  }, [])

  const [prefix, tab] = hash.replace(/^#\/?/, "").split("/")
  if (prefix !== "settings") return undefined
  return tab !== undefined && isSettingsTab(tab) ? tab : "general"
}

function openSettings(tab: SettingsTab): void {
  window.location.hash = `#settings/${tab}`
}

function closeSettings(): void {
  // `pushState` rather than clearing `location.hash`, which would leave a bare
  // "#" behind and scroll the canvas to the top.
  window.history.pushState(null, "", window.location.pathname + window.location.search)
  window.dispatchEvent(new HashChangeEvent("hashchange"))
}

/**
 * The All / Active / Finished segmented control, in the topbar hint area.
 *
 * Lives here and not in the sidebar because it scopes the canvas — the widest
 * surface on screen — while the sidebar is session navigation; a filter next
 * to the session list would read as filtering that list. The topbar already
 * carries per-session state pills, so counts fit its idiom, and it stays
 * visible when the docked panels eat the stage's width.
 */
function CanvasFilterControl(props: {
  mode: AgentFilterMode
  counts: Record<AgentFilterMode, number>
  onChange: (mode: AgentFilterMode) => void
}): JSX.Element {
  return (
    <div className="filter-group" role="group" aria-label="Which agents the canvas shows">
      {(["all", "active", "finished"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          className={`filter-btn${props.mode === mode ? " is-on" : ""}`}
          aria-pressed={props.mode === mode}
          onClick={() => props.onChange(mode)}
        >
          {mode} <span className="filter-count">{props.counts[mode]}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * Finds the canvas node a card was opened from, so Escape hands focus back to
 * it. React Flow swallows the mousedown that would otherwise have focused the
 * node, so the element focus came *from* is usually the canvas, not the node.
 */
function nodeElement(agentId: string): () => HTMLElement | null {
  const selector = `.react-flow__node[data-id="${agentId.replace(/"/g, String.raw`\"`)}"] .node`
  return () => document.querySelector<HTMLElement>(selector)
}

/** Names the hosts responsible for failed deliveries, when they are known. */
function topFaultHosts(diagnostics: DeliveryDiagnostics): string {
  const hosts = [...new Set(diagnostics.recent.map((entry) => entry.host))].slice(0, 3)
  return hosts.length > 0 ? ` (${hosts.join(", ")})` : ""
}
