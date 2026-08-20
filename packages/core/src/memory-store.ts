import type {
  AgentEntity,
  EdgeEntity,
  EntityStore,
  MessageEntity,
  PromptFragmentEntity,
  SessionEntity,
  TodoEntity,
  ToolCallEntity,
} from "@observer-ai/protocol"

/**
 * In-memory `EntityStore`.
 *
 * Used by tests and by `observer replay --dry-run` so reducer behaviour can be
 * verified without touching the on-disk database.
 */
export class MemoryStore implements EntityStore {
  readonly sessions = new Map<string, SessionEntity>()
  readonly agents = new Map<string, AgentEntity>()
  readonly edges = new Map<string, EdgeEntity>()
  readonly messages = new Map<string, MessageEntity>()
  readonly toolCalls = new Map<string, ToolCallEntity>()
  readonly todos = new Map<string, TodoEntity[]>()
  readonly promptFragments = new Map<string, PromptFragmentEntity>()

  getSession(id: string) {
    return this.sessions.get(id)
  }
  putSession(row: SessionEntity) {
    this.sessions.set(row.id, row)
  }

  getAgent(id: string) {
    return this.agents.get(id)
  }
  getAgentByKey(sessionId: string, agentKey: string) {
    for (const agent of this.agents.values()) {
      if (agent.sessionId === sessionId && agent.agentKey === agentKey) return agent
    }
    return undefined
  }
  listAgents(sessionId: string) {
    return [...this.agents.values()]
      .filter((agent) => agent.sessionId === sessionId)
      .sort((a, b) => a.startedAt - b.startedAt)
  }
  putAgent(row: AgentEntity) {
    this.agents.set(row.id, row)
  }

  getEdge(id: string) {
    return this.edges.get(id)
  }
  putEdge(row: EdgeEntity) {
    this.edges.set(row.id, row)
  }
  listEdges(sessionId: string) {
    return [...this.edges.values()].filter((edge) => edge.sessionId === sessionId)
  }

  getMessage(id: string) {
    return this.messages.get(id)
  }
  putMessage(row: MessageEntity) {
    this.messages.set(row.id, row)
  }
  nextMessageSeq(agentId: string) {
    let max = 0
    for (const message of this.messages.values()) {
      if (message.agentId === agentId && message.seq > max) max = message.seq
    }
    return max + 1
  }
  listMessages(agentId: string) {
    return [...this.messages.values()].filter((m) => m.agentId === agentId).sort((a, b) => a.seq - b.seq)
  }

  getToolCall(id: string) {
    return this.toolCalls.get(id)
  }
  putToolCall(row: ToolCallEntity) {
    this.toolCalls.set(row.id, row)
  }
  listToolCalls(agentId: string) {
    return [...this.toolCalls.values()].filter((t) => t.agentId === agentId).sort((a, b) => a.startedAt - b.startedAt)
  }

  listTodos(agentId: string) {
    return this.todos.get(agentId) ?? []
  }
  replaceTodos(agentId: string, rows: TodoEntity[]) {
    this.todos.set(agentId, rows)
  }

  getPromptFragment(id: string) {
    return this.promptFragments.get(id)
  }
  putPromptFragment(row: PromptFragmentEntity) {
    this.promptFragments.set(row.id, row)
  }
  listPromptFragments(agentId: string) {
    return [...this.promptFragments.values()].filter((p) => p.agentId === agentId)
  }
}
