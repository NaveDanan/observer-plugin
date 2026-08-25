import type {
  AgentStatus,
  Availability,
  EdgeType,
  HostId,
  MessageAttachment,
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
  /** Host-owned stable id. For OpenCode this is also the task_id resume token. */
  runtimeId?: string | null
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
  /**
   * Lines this agent's completed file-editing tool calls added, summed.
   *
   * Deliberately optional rather than `number | null`: **absent means no edit
   * was ever observed**, while `0` means edits were observed and cancelled out.
   * A UI that renders `+0 -0` for an agent that has only read files is lying
   * about what it knows, so the two cases must stay distinguishable.
   *
   * The two sides are **independently** optional. A `write` states the file's
   * new contents and nothing about what it replaced, so it yields `linesAdded`
   * with `linesRemoved` still absent — `-0` there would be a fabricated
   * number, not a measurement. Render whichever side is present.
   *
   * This is *gross churn per completed tool call*, not the repository's net
   * diff: two calls that edit the same file both count, because they are two
   * distinct host operations and the reducer has no view of the file itself.
   */
  linesAdded?: number
  /** Lines removed, on the same absent-is-not-zero rule as `linesAdded`. */
  linesRemoved?: number
  /**
   * How the churn totals were obtained — a **floor**, never an overstatement.
   *
   * `inferred` for anything derived from tool arguments: the arguments state
   * what was asked for, not what the file ended up containing. `authoritative`
   * only when a host emitted a normalized churn marker outright.
   *
   * A total is only as good as its worst term, so this takes the *weakest*
   * level ever credited to this agent and never climbs back up. Recomputing an
   * exact weakest after one call's figure is upgraded would mean re-reading
   * every tool call the agent ever made, which the reducer cannot do in bounded
   * time; understating confidence is the safe direction to be wrong in.
   */
  churnConfidence?: Provenance | null
}

/** Durable metadata for one host subagent assignment. */
export interface AgentAssignment {
  /** Observer's unique id for this delegation, minted before the child exists. */
  id: string
  host: HostId
  rootSessionKey: string
  /** Host-owned stable subagent id. For OpenCode this is the task_id. */
  runtimeId: string | null
  /** Required host-owned runtime id of the agent that spawned this subagent. */
  parentRuntimeId: string
  callId: string | null
  agentType: string
  hostAgentType: string
  description: string | null
  prompt: string | null
  status: AgentStatus
  createdAt: number
  updatedAt: number
}

/** A directed, durable message between two subagents in one host session tree. */
export interface AgentMail {
  id: string
  host: HostId
  rootSessionKey: string
  fromRuntimeId: string
  toRuntimeId: string
  text: string
  createdAt: number
  deliveredAt: number | null
  readAt: number | null
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
  /**
   * Files that arrived with this message.
   *
   * Optional and never `null`: absent means the host said nothing about
   * attachments, which is not the same claim as "this turn had none". Only
   * hosts that report them at all can distinguish the two, and a UI that drew
   * "no attachments" for every Claude turn would be inventing a fact.
   */
  attachments?: MessageAttachment[]
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
  /**
   * What this one call is currently credited with in its agent's totals.
   *
   * This is the reducer's contribution ledger, not a display field. It records
   * the *term* this call contributes to the agent's sum, so that a redelivery
   * of the same call can be reconciled against it rather than added to it:
   * a repeat with equal or worse evidence changes nothing, and a repeat with
   * better evidence replaces the term and moves the agent aggregate by the
   * difference. Either way the call is counted exactly once.
   *
   * Keyed by tool call id, because that is the only identifier the
   * `tool.started` and `tool.finished` events for one call share.
   *
   * Each side is independently optional, on the same absent-is-not-zero rule as
   * `AgentEntity.linesAdded`. `churnConfidence` describes the credited term as
   * a whole, and is the weakest level among the sides currently credited.
   */
  linesAdded?: number
  linesRemoved?: number
  churnConfidence?: Provenance | null
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
