import type {
  AgentStatus,
  Availability,
  EdgeType,
  HostId,
  PromptKind,
  Provenance,
  SessionStatus,
  TodoStatus,
} from "./events.js"

export interface SessionEntity {
  id: string
  host: HostId
  hostVersion: string | null
  sessionKey: string
  workspaceRoot: string
  title: string | null
  status: SessionStatus
  model: string | null
  goal: string | null
  goalStatus: string | null
  cwd: string | null
  startedAt: number
  endedAt: number | null
  updatedAt: number
  lastEventSeq: number
}

export interface AgentEntity {
  id: string
  sessionId: string
  agentKey: string
  agentType: string
  displayName: string | null
  parentAgentId: string | null
  status: AgentStatus
  model: string | null
  modelConfidence: Provenance | null
  description: string | null
  delegationPrompt: string | null
  summary: string | null
  startedAt: number
  endedAt: number | null
  updatedAt: number
  totalTokens: number | null
  durationMs: number | null
}

export interface EdgeEntity {
  id: string
  sessionId: string
  fromAgentId: string
  toAgentId: string
  edgeType: EdgeType
  label: string | null
  provenance: Provenance
  createdAt: number
}

export type MessageRole = "user" | "assistant" | "reasoning"

export interface MessageEntity {
  id: string
  sessionId: string
  agentId: string
  role: MessageRole
  messageKey: string
  text: string
  streaming: boolean
  createdAt: number
  updatedAt: number
  seq: number
}

export interface ToolCallEntity {
  id: string
  sessionId: string
  agentId: string
  callId: string
  tool: string
  title: string | null
  input: unknown
  output: string | null
  error: string | null
  status: "running" | "ok" | "error"
  startedAt: number
  endedAt: number | null
  durationMs: number | null
}

export interface TodoEntity {
  id: string
  sessionId: string
  agentId: string
  position: number
  content: string
  status: TodoStatus
  originalStatus: string | null
  priority: string | null
  updatedAt: number
}

export interface PromptFragmentEntity {
  id: string
  sessionId: string
  agentId: string
  fragmentKey: string
  promptKind: PromptKind
  label: string
  text: string | null
  path: string | null
  availability: Availability
  note: string | null
  updatedAt: number
}

export type EntityTable = "session" | "agent" | "edge" | "message" | "tool_call" | "todo" | "prompt_fragment"

export type EntityFor<T extends EntityTable> = T extends "session"
  ? SessionEntity
  : T extends "agent"
    ? AgentEntity
    : T extends "edge"
      ? EdgeEntity
      : T extends "message"
        ? MessageEntity
        : T extends "tool_call"
          ? ToolCallEntity
          : T extends "todo"
            ? TodoEntity
            : PromptFragmentEntity

/** A single projected mutation, broadcast to connected UIs. */
export type Change =
  | { table: "session"; op: "upsert"; row: SessionEntity }
  | { table: "agent"; op: "upsert"; row: AgentEntity }
  | { table: "edge"; op: "upsert"; row: EdgeEntity }
  | { table: "message"; op: "upsert"; row: MessageEntity }
  | { table: "tool_call"; op: "upsert"; row: ToolCallEntity }
  | { table: "todo"; op: "upsert"; row: TodoEntity }
  | { table: "prompt_fragment"; op: "upsert"; row: PromptFragmentEntity }
  | { table: EntityTable; op: "delete"; id: string }

/** Per-agent activity totals, so the canvas can show counts without loading detail. */
export interface AgentCounts {
  messages: number
  toolCalls: number
  todos: number
}

/** Per-agent live activity — the tool currently running, if any. */
export interface AgentActivity {
  tool: ToolCallEntity
  elapsedMs: number
}

/** Full snapshot of one session, used for initial load and reconnect. */
export interface SessionSnapshot {
  session: SessionEntity
  agents: AgentEntity[]
  edges: EdgeEntity[]
  todos: TodoEntity[]
  counts: Record<string, AgentCounts>
  /** The tool call currently running for each agent, if any. Null means idle / no data. */
  runningTools: Record<string, ToolCallEntity | null>
}

export interface AgentDetail {
  agent: AgentEntity
  messages: MessageEntity[]
  toolCalls: ToolCallEntity[]
  todos: TodoEntity[]
  promptFragments: PromptFragmentEntity[]
}

/**
 * Write/read surface the reducer needs.
 *
 * Declared here as a pure type so the reducer stays independent of SQLite and
 * can be unit tested against an in-memory implementation.
 */
export interface EntityStore {
  getSession(id: string): SessionEntity | undefined
  putSession(row: SessionEntity): void

  getAgent(id: string): AgentEntity | undefined
  getAgentByKey(sessionId: string, agentKey: string): AgentEntity | undefined
  listAgents(sessionId: string): AgentEntity[]
  putAgent(row: AgentEntity): void

  getEdge(id: string): EdgeEntity | undefined
  putEdge(row: EdgeEntity): void

  getMessage(id: string): MessageEntity | undefined
  putMessage(row: MessageEntity): void
  nextMessageSeq(agentId: string): number

  getToolCall(id: string): ToolCallEntity | undefined
  putToolCall(row: ToolCallEntity): void

  listTodos(agentId: string): TodoEntity[]
  replaceTodos(agentId: string, rows: TodoEntity[]): void

  getPromptFragment(id: string): PromptFragmentEntity | undefined
  putPromptFragment(row: PromptFragmentEntity): void
}

/** Messages pushed over the WebSocket. */
export type ServerMessage =
  | { type: "hello"; cursor: number; hosts: HostId[] }
  | { type: "changes"; cursor: number; changes: Change[] }
  | { type: "resync"; cursor: number }
  | { type: "ping" }

export type ClientMessage = { type: "subscribe"; cursor?: number } | { type: "pong" }
