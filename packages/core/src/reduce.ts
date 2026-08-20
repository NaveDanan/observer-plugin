import {
  MAIN_AGENT_KEY,
  agentId as buildAgentId,
  edgeId as buildEdgeId,
  messageId as buildMessageId,
  promptFragmentId as buildPromptFragmentId,
  sessionId as buildSessionId,
  todoId as buildTodoId,
  toolCallId as buildToolCallId,
} from "@observer-ai/protocol"
import type {
  AgentEntity,
  Availability,
  Change,
  EdgeEntity,
  EdgeType,
  EntityStore,
  MessageEntity,
  PromptFragmentEntity,
  PromptKind,
  Provenance,
  SessionEntity,
  StoredEvent,
  TodoEntity,
  ToolCallEntity,
} from "@observer-ai/protocol"
import { deriveGoal } from "./normalize.js"

/**
 * Projects one stored event onto the entity model.
 *
 * Properties this function guarantees:
 * - **Idempotent**: applying the same event twice produces the same state.
 * - **Order tolerant**: a child agent may arrive before its parent, a tool
 *   result before its call, or a session start after its first message.
 * - **Non-destructive**: late or unknown data never erases known-good data.
 */
export function reduce(store: EntityStore, event: StoredEvent): Change[] {
  const changes: Change[] = []
  const session = ensureSession(store, event, changes)
  const agent = ensureAgent(store, session, event.agentKey, event, changes)
  const body = event.body

  switch (body.kind) {
    case "session.started": {
      putSession(store, changes, {
        ...current(store, session),
        title: body.title ?? session.title,
        model: body.model ?? session.model,
        cwd: body.cwd ?? session.cwd,
        status: session.status === "ended" ? session.status : "active",
        startedAt: Math.min(session.startedAt, event.at),
      })
      if (body.model || body.agentType) {
        const now = currentAgent(store, agent)
        putAgent(store, changes, {
          ...now,
          agentType: body.agentType ?? now.agentType,
          model: now.model ?? body.model ?? null,
          modelConfidence: now.model ? now.modelConfidence : body.model ? event.provenance : null,
        })
      }
      break
    }

    case "session.ended": {
      putSession(store, changes, { ...current(store, session), status: "ended", endedAt: event.at })
      // Agents that never reported a stop become "idle", not "completed": the
      // host never confirmed success, so Observer does not claim it did.
      for (const other of store.listAgents(session.id)) {
        if (other.status === "running" || other.status === "starting") {
          putAgent(store, changes, { ...other, status: "idle", endedAt: other.endedAt ?? event.at })
        }
      }
      break
    }

    case "session.status": {
      if (session.status !== "ended") putSession(store, changes, { ...current(store, session), status: body.status })
      break
    }

    case "agent.started": {
      let parentAgentId = agent.parentAgentId
      if (body.parentAgentKey && body.parentAgentKey !== agent.agentKey) {
        const parent = ensureAgent(store, session, body.parentAgentKey, event, changes)
        parentAgentId = parent.id
        upsertEdge(store, changes, session.id, parent.id, agent.id, "spawned", body.description ?? null, event)
      }
      const now = currentAgent(store, agent)
      putAgent(store, changes, {
        ...now,
        agentType: body.agentType || now.agentType,
        displayName: body.displayName ?? now.displayName,
        parentAgentId,
        status: isTerminal(now.status) ? now.status : "running",
        model: body.model ?? now.model,
        modelConfidence: body.model ? (body.modelConfidence ?? event.provenance) : now.modelConfidence,
        description: body.description ?? now.description,
        delegationPrompt: body.prompt ?? now.delegationPrompt,
        startedAt: Math.min(now.startedAt, event.at),
      })
      if (body.prompt) {
        putPromptFragment(store, changes, {
          sessionId: session.id,
          agentId: agent.id,
          fragmentKey: "delegation",
          promptKind: "delegation",
          label: "Delegated task",
          text: body.prompt,
          availability: "available",
          at: event.at,
        })
      }
      break
    }

    case "agent.stopped": {
      const now = currentAgent(store, agent)
      putAgent(store, changes, {
        ...now,
        status: body.status,
        endedAt: event.at,
        summary: body.summary ?? now.summary,
        durationMs: body.durationMs ?? now.durationMs,
        totalTokens: body.totalTokens ?? now.totalTokens,
        model: body.model ?? now.model,
        modelConfidence: body.model && !now.model ? event.provenance : now.modelConfidence,
      })
      break
    }

    case "agent.model": {
      putAgent(store, changes, {
        ...currentAgent(store, agent),
        model: body.model,
        modelConfidence: body.confidence,
      })
      if (agent.agentKey === MAIN_AGENT_KEY && !session.model) {
        putSession(store, changes, { ...current(store, session), model: body.model })
      }
      break
    }

    case "agent.status": {
      const now = currentAgent(store, agent)
      if (isTerminal(now.status) && !isTerminal(body.status)) break
      putAgent(store, changes, { ...now, status: body.status })
      break
    }

    case "message.user": {
      upsertMessage(store, changes, session, agent, {
        role: "user",
        messageKey: body.messageKey,
        text: body.text,
        streaming: false,
        at: event.at,
      })
      const now = current(store, session)
      if (!now.goal && agent.agentKey === MAIN_AGENT_KEY && body.text.trim().length > 0) {
        putSession(store, changes, {
          ...now,
          goal: deriveGoal(body.text),
          goalStatus: now.goalStatus ?? "derived",
        })
      }
      break
    }

    case "message.assistant": {
      upsertMessage(store, changes, session, agent, {
        role: "assistant",
        messageKey: body.messageKey,
        text: body.text,
        streaming: !body.final,
        at: event.at,
      })
      break
    }

    case "message.assistant.delta": {
      const existing = store.getMessage(buildMessageId(agent.id, body.messageKey))
      upsertMessage(store, changes, session, agent, {
        role: "assistant",
        messageKey: body.messageKey,
        text: (existing?.text ?? "") + body.delta,
        streaming: body.final !== true,
        at: event.at,
      })
      break
    }

    case "message.reasoning": {
      upsertMessage(store, changes, session, agent, {
        role: "reasoning",
        messageKey: body.messageKey,
        text: body.text,
        streaming: !body.final,
        at: event.at,
      })
      break
    }

    case "tool.started": {
      const id = buildToolCallId(agent.id, body.callId)
      const existing = store.getToolCall(id)
      putToolCall(store, changes, {
        id,
        sessionId: session.id,
        agentId: agent.id,
        callId: body.callId,
        tool: body.tool,
        title: body.title ?? existing?.title ?? null,
        input: body.input ?? existing?.input ?? null,
        output: existing?.output ?? null,
        error: existing?.error ?? null,
        status: existing?.status ?? "running",
        startedAt: existing?.startedAt ?? event.at,
        endedAt: existing?.endedAt ?? null,
        durationMs: existing?.durationMs ?? null,
      })
      break
    }

    case "tool.finished": {
      const id = buildToolCallId(agent.id, body.callId)
      const existing = store.getToolCall(id)
      const startedAt = existing?.startedAt ?? event.at
      putToolCall(store, changes, {
        id,
        sessionId: session.id,
        agentId: agent.id,
        callId: body.callId,
        tool: existing?.tool ?? body.tool ?? "unknown",
        title: existing?.title ?? null,
        input: existing?.input ?? null,
        output: body.output ?? existing?.output ?? null,
        error: body.error ?? null,
        status: body.ok ? "ok" : "error",
        startedAt,
        endedAt: event.at,
        durationMs: body.durationMs ?? Math.max(0, event.at - startedAt),
      })
      break
    }

    case "todos.updated": {
      replaceTodos(
        store,
        changes,
        session,
        agent,
        body.todos.map((todo) => ({
          content: todo.content,
          status: todo.status,
          originalStatus: todo.originalStatus ?? null,
          priority: todo.priority ?? null,
        })),
        event.at,
      )
      break
    }

    case "plan.updated": {
      replaceTodos(
        store,
        changes,
        session,
        agent,
        body.steps.map((step) => ({
          content: step.step,
          status: step.status,
          originalStatus: step.originalStatus ?? null,
          priority: null,
        })),
        event.at,
      )
      break
    }

    case "goal.updated": {
      putSession(store, changes, {
        ...current(store, session),
        goal: body.objective,
        goalStatus: body.status ?? body.source ?? "reported",
      })
      break
    }

    case "prompt.fragment": {
      putPromptFragment(store, changes, {
        sessionId: session.id,
        agentId: agent.id,
        fragmentKey: body.fragmentKey,
        promptKind: body.promptKind,
        label: body.label,
        text: body.text ?? null,
        path: body.path ?? null,
        availability: body.availability,
        note: body.note ?? null,
        at: event.at,
      })
      break
    }

    case "edge.observed": {
      const from = ensureAgent(store, session, body.fromAgentKey, event, changes)
      const to = ensureAgent(store, session, body.toAgentKey, event, changes)
      upsertEdge(store, changes, session.id, from.id, to.id, body.edgeType, body.label ?? null, event)
      const child = currentAgent(store, to)
      if (body.edgeType === "spawned" && !child.parentAgentId && from.id !== to.id) {
        putAgent(store, changes, { ...child, parentAgentId: from.id })
      }
      break
    }

    case "session.error": {
      putSession(store, changes, { ...current(store, session), status: "error" })
      break
    }
  }

  touchSession(store, changes, session.id, event)
  return dedupe(changes)
}

// ------------------------------------------------------------------ helpers

function isTerminal(status: AgentEntity["status"]): boolean {
  return status === "completed" || status === "failed" || status === "interrupted"
}

/** Re-reads a row so successive writes in one reduce build on each other. */
function current(store: EntityStore, session: SessionEntity): SessionEntity {
  return store.getSession(session.id) ?? session
}

function currentAgent(store: EntityStore, agent: AgentEntity): AgentEntity {
  return store.getAgent(agent.id) ?? agent
}

function putSession(store: EntityStore, changes: Change[], row: SessionEntity): void {
  store.putSession(row)
  changes.push({ table: "session", op: "upsert", row })
}

function putAgent(store: EntityStore, changes: Change[], row: AgentEntity): void {
  store.putAgent(row)
  changes.push({ table: "agent", op: "upsert", row })
}

function putEdge(store: EntityStore, changes: Change[], row: EdgeEntity): void {
  store.putEdge(row)
  changes.push({ table: "edge", op: "upsert", row })
}

function putMessage(store: EntityStore, changes: Change[], row: MessageEntity): void {
  store.putMessage(row)
  changes.push({ table: "message", op: "upsert", row })
}

function putToolCall(store: EntityStore, changes: Change[], row: ToolCallEntity): void {
  store.putToolCall(row)
  changes.push({ table: "tool_call", op: "upsert", row })
}

function ensureSession(store: EntityStore, event: StoredEvent, changes: Change[]): SessionEntity {
  const id = buildSessionId(event.host, event.sessionKey)
  const existing = store.getSession(id)
  if (existing) return existing
  const row: SessionEntity = {
    id,
    host: event.host,
    hostVersion: event.hostVersion ?? null,
    sessionKey: event.sessionKey,
    workspaceRoot: event.workspaceRoot,
    title: null,
    status: "active",
    model: null,
    goal: null,
    goalStatus: null,
    cwd: null,
    startedAt: event.at,
    endedAt: null,
    updatedAt: event.at,
    lastEventSeq: event.seq,
  }
  putSession(store, changes, row)
  return row
}

function ensureAgent(
  store: EntityStore,
  session: SessionEntity,
  agentKey: string,
  event: StoredEvent,
  changes: Change[],
): AgentEntity {
  const id = buildAgentId(session.id, agentKey)
  const existing = store.getAgent(id)
  if (existing) return existing
  const row: AgentEntity = {
    id,
    sessionId: session.id,
    agentKey,
    agentType: agentKey === MAIN_AGENT_KEY ? "main" : "unknown",
    displayName: null,
    parentAgentId: null,
    status: "running",
    model: agentKey === MAIN_AGENT_KEY ? session.model : null,
    modelConfidence: null,
    description: null,
    delegationPrompt: null,
    summary: null,
    startedAt: event.at,
    endedAt: null,
    updatedAt: event.at,
    totalTokens: null,
    durationMs: null,
  }
  putAgent(store, changes, row)
  return row
}

function upsertEdge(
  store: EntityStore,
  changes: Change[],
  sessionId: string,
  fromAgentId: string,
  toAgentId: string,
  edgeType: EdgeType,
  label: string | null,
  event: StoredEvent,
): void {
  if (fromAgentId === toAgentId) return
  const id = buildEdgeId(sessionId, fromAgentId, toAgentId, edgeType)
  const existing = store.getEdge(id)
  putEdge(store, changes, {
    id,
    sessionId,
    fromAgentId,
    toAgentId,
    edgeType,
    label: label ?? existing?.label ?? null,
    // A stronger claim wins; a later guess must not downgrade solid data.
    provenance: strongestProvenance(existing?.provenance, event.provenance),
    createdAt: existing?.createdAt ?? event.at,
  })
}

const PROVENANCE_RANK: Record<Provenance, number> = { inferred: 0, reconciled: 1, authoritative: 2 }

function strongestProvenance(a: Provenance | undefined, b: Provenance): Provenance {
  if (!a) return b
  return PROVENANCE_RANK[a] >= PROVENANCE_RANK[b] ? a : b
}

function upsertMessage(
  store: EntityStore,
  changes: Change[],
  session: SessionEntity,
  agent: AgentEntity,
  input: {
    role: MessageEntity["role"]
    messageKey: string
    text: string
    streaming: boolean
    at: number
  },
): void {
  const id = buildMessageId(agent.id, input.messageKey)
  const existing = store.getMessage(id)
  // Never let an empty late payload wipe text we already captured.
  const text = existing && input.text.length === 0 ? existing.text : input.text
  putMessage(store, changes, {
    id,
    sessionId: session.id,
    agentId: agent.id,
    role: input.role,
    messageKey: input.messageKey,
    text,
    streaming: input.streaming,
    createdAt: existing?.createdAt ?? input.at,
    updatedAt: input.at,
    seq: existing?.seq ?? store.nextMessageSeq(agent.id),
  })
}

function replaceTodos(
  store: EntityStore,
  changes: Change[],
  session: SessionEntity,
  agent: AgentEntity,
  todos: Array<{
    content: string
    status: TodoEntity["status"]
    originalStatus: string | null
    priority: string | null
  }>,
  at: number,
): void {
  const previous = store.listTodos(agent.id)
  const rows: TodoEntity[] = todos.map((todo, index) => ({
    id: buildTodoId(agent.id, index),
    sessionId: session.id,
    agentId: agent.id,
    position: index,
    content: todo.content,
    status: todo.status,
    originalStatus: todo.originalStatus,
    priority: todo.priority,
    updatedAt: at,
  }))
  store.replaceTodos(agent.id, rows)
  const keep = new Set(rows.map((row) => row.id))
  for (const row of previous) {
    if (!keep.has(row.id)) changes.push({ table: "todo", op: "delete", id: row.id })
  }
  for (const row of rows) changes.push({ table: "todo", op: "upsert", row })
}

function putPromptFragment(
  store: EntityStore,
  changes: Change[],
  input: {
    sessionId: string
    agentId: string
    fragmentKey: string
    promptKind: PromptKind
    label: string
    text?: string | null
    path?: string | null
    availability: Availability
    note?: string | null
    at: number
  },
): void {
  const id = buildPromptFragmentId(input.agentId, input.fragmentKey)
  const existing = store.getPromptFragment(id)
  const row: PromptFragmentEntity = {
    id,
    sessionId: input.sessionId,
    agentId: input.agentId,
    fragmentKey: input.fragmentKey,
    promptKind: input.promptKind,
    label: input.label,
    text: input.text ?? existing?.text ?? null,
    path: input.path ?? existing?.path ?? null,
    availability: input.availability,
    note: input.note ?? existing?.note ?? null,
    updatedAt: input.at,
  }
  store.putPromptFragment(row)
  changes.push({ table: "prompt_fragment", op: "upsert", row })
}

function touchSession(store: EntityStore, changes: Change[], sessionId: string, event: StoredEvent): void {
  const now = store.getSession(sessionId)
  if (!now) return
  const updatedAt = Math.max(now.updatedAt, event.at)
  if (updatedAt === now.updatedAt && now.lastEventSeq >= event.seq) return
  putSession(store, changes, { ...now, updatedAt, lastEventSeq: Math.max(now.lastEventSeq, event.seq) })
}

/** Collapses repeated writes to the same row so the UI receives one update. */
function dedupe(changes: Change[]): Change[] {
  const index = new Map<string, number>()
  const result: Change[] = []
  for (const change of changes) {
    const id = change.op === "delete" ? change.id : change.row.id
    const key = `${change.table}:${id}`
    const at = index.get(key)
    if (at === undefined) {
      index.set(key, result.length)
      result.push(change)
    } else {
      result[at] = change
    }
  }
  return result
}
