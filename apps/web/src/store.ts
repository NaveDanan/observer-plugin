import { useCallback, useSyncExternalStore } from "react"
import type {
  AgentCounts,
  AgentEntity,
  Change,
  EdgeEntity,
  HostCapabilities,
  MessageEntity,
  PromptFragmentEntity,
  SessionEntity,
  TodoEntity,
  ToolCallEntity,
} from "@observer-ai/protocol"
import { MAIN_AGENT_KEY } from "@observer-ai/protocol"
import type { EmployeeMatch, RosterProfile } from "@observer-ai/roster"
import { getEmployee, matchEmployee } from "@observer-ai/roster"
import * as api from "./api"

type ConnectionState = "connecting" | "live" | "offline"

/**
 * Which subagents the canvas shows.
 *
 * Both non-"all" modes keep every root agent visible: a canvas with no anchor
 * is disorienting. See `agentMatchesFilter` for the exact membership.
 */
export type AgentFilterMode = "all" | "active" | "finished"

const AGENT_FILTER_MODES: readonly AgentFilterMode[] = ["all", "active", "finished"]

interface State {
  ready: boolean
  connection: ConnectionState
  error: string | undefined
  hosts: HostCapabilities[]
  capture: Record<string, boolean>
  retentionDays: number
  cursor: number
  sessions: Map<string, SessionEntity>
  agents: Map<string, AgentEntity>
  edges: Map<string, EdgeEntity>
  todos: Map<string, TodoEntity>
  messages: Map<string, MessageEntity>
  toolCalls: Map<string, ToolCallEntity>
  promptFragments: Map<string, PromptFragmentEntity>
  /** The employee roster; empty until the daemon answers. */
  roster: RosterProfile[]
  /** Activity totals per agent, kept for every node on the canvas. */
  counts: Map<string, AgentCounts>
  /** The tool currently running for each agent, if any. Null means idle / unknown. */
  runningTools: Map<string, ToolCallEntity>
  /**
   * Ids already counted, so live updates increment each row once.
   * Ids are far cheaper to keep than full rows for agents nobody has opened.
   */
  countedMessages: Set<string>
  countedToolCalls: Set<string>
  selectedSessionId: string | undefined
  selectedAgentId: string | undefined
  /** Which subagents the canvas shows. A view preference, not a session fact. */
  agentFilter: AgentFilterMode
  /**
   * The agent whose NJ-LABS employee card modal is open.
   *
   * Separate from `selectedAgentId` because selection and openness are no
   * longer the same event: a click selects an agent and docks its panels, a
   * double-click additionally raises the card over the top of them. Folding
   * this into the selection would make every click open a modal.
   */
  cardAgentId: string | undefined
  loadedAgents: Set<string>
  /** Memoized agent→employee matches, keyed by id + updatedAt. */
  matchCache: Map<string, EmployeeMatch | undefined>
  /**
   * The host this view is bound to, taken from the URL.
   *
   * Observer is opened by a host and stays connected to it; there is no
   * in-app host picker.
   */
  scopeHost: string | undefined
  scopeSession: string | undefined
  /** Deliveries the daemon could not record; surfaced as a banner. */
  diagnostics: api.DeliveryDiagnostics | undefined
  diagnosticsDismissed: boolean
  /** For testing: injectable clock. */
  _now?: () => number
}

function readScope(): { host: string | undefined; session: string | undefined } {
  try {
    const params = new URLSearchParams(window.location.search)
    return { host: params.get("host") ?? undefined, session: params.get("session") ?? undefined }
  } catch {
    return { host: undefined, session: undefined }
  }
}

const initialScope = readScope()

const state: State = {
  ready: false,
  connection: "connecting",
  error: undefined,
  hosts: [],
  capture: {},
  retentionDays: 30,
  cursor: 0,
  sessions: new Map(),
  agents: new Map(),
  edges: new Map(),
  todos: new Map(),
  messages: new Map(),
  toolCalls: new Map(),
  promptFragments: new Map(),
  roster: [],
  counts: new Map(),
  runningTools: new Map(),
  countedMessages: new Set(),
  countedToolCalls: new Set(),
  selectedSessionId: undefined,
  selectedAgentId: undefined,
  agentFilter: "all",
  cardAgentId: undefined,
  loadedAgents: new Set(),
  matchCache: new Map(),
  scopeHost: initialScope.host,
  scopeSession: initialScope.session,
  diagnostics: undefined,
  diagnosticsDismissed: false,
}

let version = 0
const listeners = new Set<() => void>()

function notify(): void {
  version++
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getVersion(): number {
  return version
}

/** Re-renders the caller whenever any store data changes. */
export function useStoreVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion)
}

/** Reads derived data and re-renders on every store update. */
export function useSelector<T>(selector: (state: Readonly<State>) => T): T {
  useStoreVersion()
  const read = useCallback(() => selector(state), [selector])
  return read()
}

export function getState(): Readonly<State> {
  return state
}

// -------------------------------------------------------------------- actions

export async function initialise(): Promise<void> {
  try {
    const boot = await api.bootstrap()
    state.hosts = boot.hosts
    state.capture = boot.capture
    state.retentionDays = boot.retentionDays
    state.cursor = boot.cursor
    const { sessions } = await api.listSessions()
    for (const session of sessions) state.sessions.set(session.id, session)
    state.ready = true
    state.error = undefined
    notify()
    // The roster decorates the canvas; losing it must not lose sessions.
    try {
      const { profiles } = await api.getRoster()
      state.roster = profiles
      notify()
    } catch {
      state.roster = []
    }
    // Open what the harness asked for; otherwise the most recent session it owns.
    const scoped = selectSessions(state)
    const target = state.scopeSession
      ? (scoped.find((session) => session.sessionKey === state.scopeSession || session.id === state.scopeSession) ??
        scoped[0])
      : scoped[0]
    if (target) await selectSession(target.id)
    connect()
    startDiagnosticsPolling()
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
    state.connection = "offline"
    notify()
  }
}

/**
 * Polls delivery diagnostics.
 *
 * An empty canvas has two very different causes: no agent activity, or events
 * arriving that Observer could not translate. Only the daemon knows which.
 */
function startDiagnosticsPolling(): void {
  const poll = async (): Promise<void> => {
    try {
      const next = await api.getDiagnostics()
      const changed = next.faults !== state.diagnostics?.faults
      state.diagnostics = next
      if (changed) notify()
    } catch {
      // Diagnostics are advisory; failing to fetch them changes nothing.
    }
  }
  void poll()
  const timer = setInterval(() => void poll(), 30_000)
  window.addEventListener("beforeunload", () => clearInterval(timer))
}

export function dismissDiagnostics(): void {
  state.diagnosticsDismissed = true
  notify()
}

export async function selectSession(sessionId: string): Promise<void> {
  state.selectedSessionId = sessionId
  state.selectedAgentId = undefined
  state.cardAgentId = undefined
  notify()
  const snapshot = await api.getSnapshot(sessionId)
  state.sessions.set(snapshot.session.id, snapshot.session)
  for (const agent of snapshot.agents) state.agents.set(agent.id, agent)
  for (const edge of snapshot.edges) state.edges.set(edge.id, edge)
  for (const todo of snapshot.todos) state.todos.set(todo.id, todo)
  for (const [agentId, counts] of Object.entries(snapshot.counts ?? {})) {
    state.counts.set(agentId, { ...counts })
  }
  for (const [agentId, tool] of Object.entries(snapshot.runningTools ?? {})) {
    if (tool) state.runningTools.set(agentId, tool as ToolCallEntity)
    else state.runningTools.delete(agentId)
  }
  ensureTick()
  notify()
}

/**
 * The card that survives a selection change.
 *
 * Clicking a different node moves the docked panels to that agent, so a card
 * still showing the previous one would be lying about what is selected. The
 * card stays open only when the selection lands back on its own agent, which
 * is what a double-click does: it fires a click before it fires itself.
 */
export function nextCardAgentId(cardAgentId: string | undefined, selectedAgentId: string | undefined): string | undefined {
  return cardAgentId !== undefined && cardAgentId === selectedAgentId ? cardAgentId : undefined
}

export async function selectAgent(agentId: string | undefined): Promise<void> {
  state.selectedAgentId = agentId
  state.cardAgentId = nextCardAgentId(state.cardAgentId, agentId)
  notify()
  if (!agentId || state.loadedAgents.has(agentId)) return
  await loadAgentDetail(agentId)
}

/**
 * Raises the employee card over the canvas.
 *
 * The card is the seated employee's identity, so an agent nobody is seated
 * on has no card to show; `App` decides that from the match and this stays a
 * plain id.
 */
export function openEmployeeCard(agentId: string): void {
  state.cardAgentId = agentId
  notify()
}

export function closeEmployeeCard(): void {
  if (state.cardAgentId === undefined) return
  state.cardAgentId = undefined
  notify()
}

/** Switches which subagents the canvas shows. */
export function setAgentFilter(mode: AgentFilterMode): void {
  if (!AGENT_FILTER_MODES.includes(mode) || state.agentFilter === mode) return
  state.agentFilter = mode
  notify()
}

export async function loadAgentDetail(agentId: string): Promise<void> {
  try {
    const detail = await api.getAgentDetail(agentId)
    state.agents.set(detail.agent.id, detail.agent)
    for (const message of detail.messages) {
      state.messages.set(message.id, message)
      state.countedMessages.add(message.id)
    }
    for (const call of detail.toolCalls) {
      state.toolCalls.set(call.id, call)
      state.countedToolCalls.add(call.id)
    }
    for (const todo of detail.todos) state.todos.set(todo.id, todo)
    for (const fragment of detail.promptFragments) state.promptFragments.set(fragment.id, fragment)
    // Authoritative counts for this agent now that every row is present.
    state.counts.set(agentId, {
      messages: detail.messages.length,
      toolCalls: detail.toolCalls.length,
      todos: detail.todos.length,
    })
    state.loadedAgents.add(agentId)
    notify()
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
    notify()
  }
}

export async function removeSession(sessionId: string): Promise<void> {
  await api.deleteSession(sessionId)
  state.sessions.delete(sessionId)
  for (const [id, agent] of state.agents) if (agent.sessionId === sessionId) state.agents.delete(id)
  for (const [id, edge] of state.edges) if (edge.sessionId === sessionId) state.edges.delete(id)
  for (const [id, todo] of state.todos) if (todo.sessionId === sessionId) state.todos.delete(id)
  if (state.selectedSessionId === sessionId) {
    const next = [...state.sessions.values()][0]
    state.selectedSessionId = next?.id
    state.selectedAgentId = undefined
    state.cardAgentId = undefined
  }
  notify()
}

// ---------------------------------------------------------------- live stream

let socket: WebSocket | undefined
let retryDelay = 500

function connect(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  state.connection = "connecting"
  notify()
  socket = new WebSocket(api.streamUrl(state.cursor))

  socket.onopen = () => {
    retryDelay = 500
    state.connection = "live"
    notify()
  }

  socket.onmessage = (raw) => {
    let message: { type: string; cursor?: number; changes?: Change[] }
    try {
      message = JSON.parse(String(raw.data)) as typeof message
    } catch {
      return
    }
    if (message.type === "changes" && message.changes) {
      applyChanges(message.changes)
      if (typeof message.cursor === "number") state.cursor = message.cursor
      notify()
      return
    }
    if (message.type === "resync") {
      // The replay buffer no longer covers our position; reload from REST.
      if (typeof message.cursor === "number") state.cursor = message.cursor
      void resync()
      return
    }
    if (message.type === "hello" && typeof message.cursor === "number") {
      state.cursor = message.cursor
      notify()
    }
  }

  socket.onclose = () => {
    state.connection = "offline"
    notify()
    // Exponential backoff keeps a stopped daemon from spinning the browser.
    setTimeout(connect, retryDelay)
    retryDelay = Math.min(retryDelay * 2, 10_000)
  }

  socket.onerror = () => socket?.close()
}

async function resync(): Promise<void> {
  const { sessions } = await api.listSessions()
  state.sessions.clear()
  for (const session of sessions) state.sessions.set(session.id, session)
  if (state.selectedSessionId) await selectSession(state.selectedSessionId)
  const agentId = state.selectedAgentId
  if (agentId) {
    state.loadedAgents.delete(agentId)
    await loadAgentDetail(agentId)
  }
  notify()
}

export function applyChanges(changes: Change[]): void {
  let tickNeeded = false
  for (const change of changes) {
    if (change.op === "delete") {
      collectionFor(change.table)?.delete(change.id)
      continue
    }
    switch (change.table) {
      case "session":
        state.sessions.set(change.row.id, change.row)
        break
      case "agent":
        state.agents.set(change.row.id, change.row)
        if (!state.counts.has(change.row.id)) {
          state.counts.set(change.row.id, { messages: 0, toolCalls: 0, todos: 0 })
        }
        if (change.row.status === "running" || change.row.status === "starting") tickNeeded = true
        break
      case "edge":
        state.edges.set(change.row.id, change.row)
        break
      case "todo":
        state.todos.set(change.row.id, change.row)
        recountTodos(change.row.agentId)
        break
      case "message":
        countOnce(state.countedMessages, change.row.id, change.row.agentId, "messages")
        // Full rows are only kept for agents whose detail panel has been opened.
        if (state.loadedAgents.has(change.row.agentId)) state.messages.set(change.row.id, change.row)
        break
      case "tool_call": {
        countOnce(state.countedToolCalls, change.row.id, change.row.agentId, "toolCalls")
        if (state.loadedAgents.has(change.row.agentId)) state.toolCalls.set(change.row.id, change.row)
        // Track running tool for canvas regardless of whether detail is loaded.
        if (change.row.status === "running") {
          state.runningTools.set(change.row.agentId, change.row)
          tickNeeded = true
        } else {
          const current = state.runningTools.get(change.row.agentId)
          if (current?.id === change.row.id) state.runningTools.delete(change.row.agentId)
        }
        break
      }
      case "prompt_fragment":
        if (state.loadedAgents.has(change.row.agentId)) state.promptFragments.set(change.row.id, change.row)
        break
    }
  }
  if (tickNeeded) ensureTick()
}

function countsFor(agentId: string): AgentCounts {
  const current = state.counts.get(agentId) ?? { messages: 0, toolCalls: 0, todos: 0 }
  state.counts.set(agentId, current)
  return current
}

/** Increments a counter the first time a given row id is seen. */
function countOnce(seen: Set<string>, id: string, agentId: string, key: "messages" | "toolCalls"): void {
  if (seen.has(id)) return
  seen.add(id)
  countsFor(agentId)[key]++
}

function recountTodos(agentId: string): void {
  let total = 0
  for (const todo of state.todos.values()) if (todo.agentId === agentId) total++
  countsFor(agentId).todos = total
}

function collectionFor(table: string): Map<string, unknown> | undefined {
  switch (table) {
    case "session":
      return state.sessions as Map<string, unknown>
    case "agent":
      return state.agents as Map<string, unknown>
    case "edge":
      return state.edges as Map<string, unknown>
    case "todo":
      return state.todos as Map<string, unknown>
    case "message":
      return state.messages as Map<string, unknown>
    case "tool_call":
      return state.toolCalls as Map<string, unknown>
    case "prompt_fragment":
      return state.promptFragments as Map<string, unknown>
    default:
      return undefined
  }
}

// ------------------------------------------------------------------ selectors

/**
 * The session list, newest-created first.
 *
 * Ordered by `startedAt` and not `updatedAt` on purpose. A session's
 * `updatedAt` moves on every token a live agent emits, so an activity ordering
 * reshuffles the list while it is being read: the row under the pointer slides
 * away mid-click, and a session the reader is watching jumps to the top the
 * instant it says anything. Creation time never changes, so a row's position
 * is a fixed address for as long as the session exists.
 *
 * What that ordering used to communicate — which session is warm — is carried
 * by the per-row "last update" label instead, where it can be read without
 * also being a moving target. See `relativeTime`.
 *
 * `id` breaks ties so two sessions created in the same millisecond still have
 * a total order; without it their relative position is left to the sort's
 * implementation and can differ between renders.
 */
export function selectSessions(current: Readonly<State>): SessionEntity[] {
  return [...current.sessions.values()]
    .filter((session) => !current.scopeHost || session.host === current.scopeHost)
    .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id))
}

export function selectActiveSession(current: Readonly<State>): SessionEntity | undefined {
  return current.selectedSessionId ? current.sessions.get(current.selectedSessionId) : undefined
}

export function selectAgents(current: Readonly<State>, sessionId: string | undefined): AgentEntity[] {
  if (!sessionId) return []
  return [...current.agents.values()]
    .filter(
      (agent) => agent.sessionId === sessionId && (agent.agentKey === MAIN_AGENT_KEY || agent.parentAgentId !== null),
    )
    .sort((a, b) => a.startedAt - b.startedAt)
}

export function selectEdges(current: Readonly<State>, sessionId: string | undefined): EdgeEntity[] {
  if (!sessionId) return []
  return [...current.edges.values()].filter((edge) => edge.sessionId === sessionId)
}

// -------------------------------------------------------------- canvas filter

/**
 * Statuses whose work has ended.
 *
 * `failed` and `interrupted` count as finished for filtering — their work is
 * over, even though they carry their own warning labels visually. Kept as a
 * plain string set so a status the protocol does not know about yet can be
 * classified at runtime rather than vanishing from the canvas.
 */
const FINISHED_STATUSES: ReadonlySet<string> = new Set(["idle", "completed", "failed", "interrupted"])

/**
 * True when an agent's work has ended, whatever its host calls that.
 *
 * Takes a plain string deliberately: hosts drift ahead of the protocol enum,
 * and the fail-safe below only works if an unknown value can reach this
 * function without a cast stripping the doubt away.
 */
export function isFinishedStatus(status: string): boolean {
  return FINISHED_STATUSES.has(status)
}

/**
 * Whether an agent is on the canvas under a filter mode.
 *
 * The root agent is always visible, in every mode: it is the anchor the graph
 * hangs from, and hiding it makes a filtered canvas unreadable. A subagent is
 * shown when its work matches the mode's question — "still going?" for
 * active, "done or dead?" for finished. Active is phrased as *not finished*
 * on purpose, so an unknown future status stays on the canvas instead of
 * silently disappearing; finished is a closed set because claiming work ended
 * when we cannot say so would be a lie of exactly the kind filtering exists
 * to prevent.
 */
export function agentMatchesFilter(
  agent: Pick<AgentEntity, "status" | "parentAgentId">,
  mode: AgentFilterMode,
): boolean {
  if (mode === "all") return true
  // Roots stay put; the filter is about which subagents to show beside them.
  if (!agent.parentAgentId) return true
  const finished = isFinishedStatus(agent.status)
  return mode === "finished" ? finished : !finished
}

/**
 * The agents the canvas draws under the current filter, spawn order kept.
 */
export function selectVisibleAgents(current: Readonly<State>, sessionId: string | undefined): AgentEntity[] {
  return selectAgents(current, sessionId).filter((agent) => agentMatchesFilter(agent, current.agentFilter))
}

/**
 * Per-segment counts for the filter control.
 *
 * Roots are excluded on purpose: they are visible in all three modes, so
 * counting them would inflate every segment by the same constant and break
 * the arithmetic the counts exist to reassure with — ALL = ACTIVE + FINISHED.
 */
export function selectFilterCounts(
  current: Readonly<State>,
  sessionId: string | undefined,
): Record<AgentFilterMode, number> {
  const counts = { all: 0, active: 0, finished: 0 }
  if (!sessionId) return counts
  for (const agent of current.agents.values()) {
    if (agent.sessionId !== sessionId || !agent.parentAgentId) continue
    counts.all++
    if (isFinishedStatus(agent.status)) counts.finished++
    else counts.active++
  }
  return counts
}

export function selectTodos(current: Readonly<State>, agentId: string | undefined): TodoEntity[] {
  if (!agentId) return []
  return [...current.todos.values()].filter((todo) => todo.agentId === agentId).sort((a, b) => a.position - b.position)
}

export function selectSessionTodos(current: Readonly<State>, sessionId: string | undefined): TodoEntity[] {
  if (!sessionId) return []
  return [...current.todos.values()]
    .filter((todo) => todo.sessionId === sessionId)
    .sort((a, b) => a.agentId.localeCompare(b.agentId) || a.position - b.position)
}

export function selectMessages(current: Readonly<State>, agentId: string | undefined): MessageEntity[] {
  if (!agentId) return []
  return [...current.messages.values()].filter((m) => m.agentId === agentId).sort((a, b) => a.seq - b.seq)
}

export function selectToolCalls(current: Readonly<State>, agentId: string | undefined): ToolCallEntity[] {
  if (!agentId) return []
  return [...current.toolCalls.values()]
    .filter((t) => t.agentId === agentId)
    .sort((a, b) => a.startedAt - b.startedAt)
}

export function selectPromptFragments(current: Readonly<State>, agentId: string | undefined): PromptFragmentEntity[] {
  if (!agentId) return []
  const order = ["system", "developer", "agent-definition", "instructions", "delegation", "skill", "memory"]
  return [...current.promptFragments.values()]
    .filter((p) => p.agentId === agentId)
    .sort((a, b) => order.indexOf(a.promptKind) - order.indexOf(b.promptKind) || a.label.localeCompare(b.label))
}

export function selectHostCapabilities(current: Readonly<State>, host: string | undefined): HostCapabilities | undefined {
  return current.hosts.find((entry) => entry.host === host)
}

export function selectRoster(current: Readonly<State>): RosterProfile[] {
  return current.roster
}

/**
 * The employee seated on an agent node.
 *
 * The task text is whatever the host told us about why this agent exists:
 * its delegation prompt, falling back to its description, then its type.
 * Matches are memoized per revision so live updates do not re-run the
 * matcher on every token.
 */
/**
 * Node types the plugin decided upstream: a subcontractor was deliberately
 * staffed with nobody, and an observer node is the @observer activation ack.
 * The canvas must not contradict either decision with a match of its own.
 */
const EXPLICIT_TYPES = new Set(["subcontractor", "observer"])

/**
 * Native employee definitions use this name on every supported host. When a
 * host reports one, it is authoritative identity rather than task text for the
 * lexical matcher to score.
 */
const EMPLOYEE_AGENT_TYPE_PREFIX = "observer-"

function matchNativeEmployeeAgent(agentType: string): EmployeeMatch | undefined {
  if (!agentType.startsWith(EMPLOYEE_AGENT_TYPE_PREFIX)) return undefined
  const profile = getEmployee(agentType.slice(EMPLOYEE_AGENT_TYPE_PREFIX.length))
  if (!profile) return undefined
  return { profile, score: Number.MAX_SAFE_INTEGER, reasons: [] }
}

/**
 * OpenCode titles a child session `"<task> (@<type> subagent)"`. That suffix
 * names the host's own agent definition, not the work, so it must not become
 * match evidence.
 *
 * Scoring is additive, so the suffix cannot lower a score — it seats the wrong
 * person. `"Tidy up the accessibility of the settings screen (@k8s subagent)"`
 * seats the devops profile over the designer, because "k8s" expands to
 * "kubernetes", which is a whole roster field.
 */
const HOST_TITLE_SUFFIX = /\s*\(@[^)]*\bsubagent\s*\)\s*$/i

export function stripHostTitleSuffix(text: string): string {
  return text.replace(HOST_TITLE_SUFFIX, "").trim()
}

export function selectEmployeeMatch(current: Readonly<State>, agent: AgentEntity): EmployeeMatch | undefined {
  if (EXPLICIT_TYPES.has(agent.agentType)) return undefined
  const key = `${agent.id}:${agent.updatedAt}`
  if (current.matchCache.has(key)) return current.matchCache.get(key)
  const nativeMatch = matchNativeEmployeeAgent(agent.agentType)
  if (nativeMatch) {
    current.matchCache.set(key, nativeMatch)
    return nativeMatch
  }
  const task = [agent.delegationPrompt, agent.description, agent.agentType]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map(stripHostTitleSuffix)
    .filter((part) => part.length > 0)
    .join(". ")
  const match = matchEmployee(task)
  current.matchCache.set(key, match)
  return match
}

export function selectCounts(current: Readonly<State>, agentId: string): AgentCounts {
  return current.counts.get(agentId) ?? { messages: 0, toolCalls: 0, todos: 0 }
}

// ------------------------------------------------------------------ activity

export interface CurrentActivity {
  tool: ToolCallEntity
  elapsedMs: number
}

/**
 * Pure selector for current activity. Returns the running tool call plus
 * elapsed milliseconds for a supplied now, or undefined when idle.
 * Hosts that never report tool calls produce the same idle result.
 */
export function selectCurrentActivity(
  current: Readonly<State>,
  agentId: string,
  now: number,
): CurrentActivity | undefined {
  const tool = current.runningTools.get(agentId)
  if (!tool) return undefined
  return { tool, elapsedMs: Math.max(0, now - tool.startedAt) }
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rem = seconds % 60
  if (minutes < 60) return `${minutes}m ${rem}s`
  const hours = Math.floor(minutes / 60)
  const minRem = minutes % 60
  return `${hours}h ${minRem}m`
}

function hasRunningAgents(current: Readonly<State>): boolean {
  for (const agent of current.agents.values()) {
    if (agent.status === "running" || agent.status === "starting") return true
  }
  return current.runningTools.size > 0
}

// One-second tick that runs only while at least one agent is live.
let tickTimer: ReturnType<typeof setInterval> | undefined

function ensureTick(): void {
  if (tickTimer) return
  if (!hasRunningAgents(state)) return
  tickTimer = setInterval(() => {
    if (!hasRunningAgents(state)) {
      if (tickTimer) clearInterval(tickTimer)
      tickTimer = undefined
      return
    }
    notify()
  }, 1000)
  // Do not keep the process alive in tests.
  if (tickTimer && typeof (tickTimer as unknown as { unref?: () => void }).unref === "function") {
    ;(tickTimer as unknown as { unref: () => void }).unref!()
  }
}

export function __resetForTests(): void {
  state.sessions.clear()
  state.agents.clear()
  state.edges.clear()
  state.todos.clear()
  state.messages.clear()
  state.toolCalls.clear()
  state.promptFragments.clear()
  state.roster = []
  state.counts.clear()
  state.runningTools.clear()
  state.countedMessages.clear()
  state.countedToolCalls.clear()
  state.loadedAgents.clear()
  state.matchCache.clear()
  state.selectedSessionId = undefined
  state.selectedAgentId = undefined
  state.agentFilter = "all"
  state.cardAgentId = undefined
  state.diagnostics = undefined
  state.diagnosticsDismissed = false
  state.cursor = 0
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = undefined
  }
  version = 0
}

export function __stopTick(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = undefined
  }
}
