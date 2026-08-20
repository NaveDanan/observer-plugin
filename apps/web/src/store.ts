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
import * as api from "./api"

type ConnectionState = "connecting" | "live" | "offline"

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
  /** Activity totals per agent, kept for every node on the canvas. */
  counts: Map<string, AgentCounts>
  /**
   * Ids already counted, so live updates increment each row once.
   * Ids are far cheaper to keep than full rows for agents nobody has opened.
   */
  countedMessages: Set<string>
  countedToolCalls: Set<string>
  selectedSessionId: string | undefined
  selectedAgentId: string | undefined
  loadedAgents: Set<string>
  /**
   * The harness this view is bound to, taken from the URL.
   *
   * Observer is opened by a harness and stays connected to it; there is no
   * in-app harness picker.
   */
  scopeHost: string | undefined
  scopeSession: string | undefined
  /** Deliveries the daemon could not record; surfaced as a banner. */
  diagnostics: api.DeliveryDiagnostics | undefined
  diagnosticsDismissed: boolean
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
  counts: new Map(),
  countedMessages: new Set(),
  countedToolCalls: new Set(),
  selectedSessionId: undefined,
  selectedAgentId: undefined,
  loadedAgents: new Set(),
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
  notify()
  const snapshot = await api.getSnapshot(sessionId)
  state.sessions.set(snapshot.session.id, snapshot.session)
  for (const agent of snapshot.agents) state.agents.set(agent.id, agent)
  for (const edge of snapshot.edges) state.edges.set(edge.id, edge)
  for (const todo of snapshot.todos) state.todos.set(todo.id, todo)
  for (const [agentId, counts] of Object.entries(snapshot.counts ?? {})) {
    state.counts.set(agentId, { ...counts })
  }
  notify()
}

export async function selectAgent(agentId: string | undefined): Promise<void> {
  state.selectedAgentId = agentId
  notify()
  if (!agentId || state.loadedAgents.has(agentId)) return
  await loadAgentDetail(agentId)
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
      case "tool_call":
        countOnce(state.countedToolCalls, change.row.id, change.row.agentId, "toolCalls")
        if (state.loadedAgents.has(change.row.agentId)) state.toolCalls.set(change.row.id, change.row)
        break
      case "prompt_fragment":
        if (state.loadedAgents.has(change.row.agentId)) state.promptFragments.set(change.row.id, change.row)
        break
    }
  }
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

export function selectSessions(current: Readonly<State>): SessionEntity[] {
  return [...current.sessions.values()]
    .filter((session) => !current.scopeHost || session.host === current.scopeHost)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function selectActiveSession(current: Readonly<State>): SessionEntity | undefined {
  return current.selectedSessionId ? current.sessions.get(current.selectedSessionId) : undefined
}

export function selectAgents(current: Readonly<State>, sessionId: string | undefined): AgentEntity[] {
  if (!sessionId) return []
  return [...current.agents.values()]
    .filter((agent) => agent.sessionId === sessionId)
    .sort((a, b) => a.startedAt - b.startedAt)
}

export function selectEdges(current: Readonly<State>, sessionId: string | undefined): EdgeEntity[] {
  if (!sessionId) return []
  return [...current.edges.values()].filter((edge) => edge.sessionId === sessionId)
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

export function selectCounts(current: Readonly<State>, agentId: string): AgentCounts {
  return current.counts.get(agentId) ?? { messages: 0, toolCalls: 0, todos: 0 }
}
