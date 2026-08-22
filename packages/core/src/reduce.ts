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
 *   Accumulating totals (code churn) hold this by keying each contribution to
 *   the tool call id that produced it — see "churn" at the foot of this file.
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
        runtimeId: body.runtimeId ?? now.runtimeId,
        agentType: body.agentType || now.agentType,
        displayName: body.displayName ?? now.displayName,
        parentAgentId,
        status: isResumable(now.status) && body.resumed ? "running" : isTerminal(now.status) ? now.status : "running",
        model: body.model ?? now.model,
        modelConfidence: body.model ? (body.modelConfidence ?? event.provenance) : now.modelConfidence,
        description: body.description ?? now.description,
        delegationPrompt: body.prompt ?? now.delegationPrompt,
        startedAt: Math.min(now.startedAt, event.at),
        endedAt: isResumable(now.status) && body.resumed ? null : now.endedAt,
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
        // Merged, not replaced. A host may describe the same call twice with
        // different amounts of detail (a retried hook, the Copilot tailer
        // re-reading a region), and `??` alone would let the sparser delivery
        // overwrite arguments we had already captured in full.
        input: mergeToolInput(existing?.input, body.input),
        output: existing?.output ?? null,
        error: existing?.error ?? null,
        status: existing?.status ?? "running",
        startedAt: existing?.startedAt ?? event.at,
        endedAt: existing?.endedAt ?? null,
        durationMs: existing?.durationMs ?? null,
        // Carried forward verbatim: this is the term the call is already
        // credited with, and `creditChurn` reconciles against it below.
        linesAdded: existing?.linesAdded,
        linesRemoved: existing?.linesRemoved,
        churnConfidence: existing?.churnConfidence,
      })
      // A result can arrive before its call (see "Order tolerance"). When it
      // does, the finish had no arguments to read churn from; this late start
      // supplies them, and the ledger above is what keeps that from becoming a
      // second contribution.
      creditChurn(store, changes, agent, store.getToolCall(id))
      break
    }

    case "tool.finished": {
      const id = buildToolCallId(agent.id, body.callId)
      const existing = store.getToolCall(id)
      const startedAt = existing?.startedAt ?? event.at
      // A call the host already confirmed succeeded stays succeeded. A later
      // `ok: false` for the same call id is a stale redelivery of an earlier
      // view, not an undo — hooks retry and the tailer re-reads, and neither
      // reports a rollback. Letting it through would strand the row as `error`
      // while the churn it produced stayed in the agent's total, and would let
      // a duplicate erase captured data, which "Order tolerance" forbids.
      // The reverse, error then ok, is a genuine upgrade and is allowed.
      const ok = existing?.status === "ok" || body.ok
      putToolCall(store, changes, {
        id,
        sessionId: session.id,
        agentId: agent.id,
        callId: body.callId,
        tool: existing?.tool ?? body.tool ?? "unknown",
        title: existing?.title ?? null,
        input: existing?.input ?? null,
        output: body.output ?? existing?.output ?? null,
        error: ok ? null : (body.error ?? existing?.error ?? null),
        status: ok ? "ok" : "error",
        startedAt,
        endedAt: event.at,
        durationMs: body.durationMs ?? Math.max(0, event.at - startedAt),
        linesAdded: existing?.linesAdded,
        linesRemoved: existing?.linesRemoved,
        churnConfidence: existing?.churnConfidence,
      })
      creditChurn(store, changes, agent, store.getToolCall(id))
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

function isResumable(status: AgentEntity["status"]): boolean {
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
    runtimeId: null,
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

/**
 * The inverse rule, and it applies to sums rather than to facts.
 *
 * For an edge, two events describe the *same* thing, so the better-evidenced
 * claim supersedes the worse one. A churn total is not one claim: it is the
 * addition of many, and one guessed term makes the whole figure a guess. So a
 * total that mixes an authoritative contribution with an inferred one is
 * reported as `inferred`, which is the only level the UI can honestly badge it.
 */
function weakestProvenance(a: Provenance | undefined, b: Provenance): Provenance {
  if (!a) return b
  return PROVENANCE_RANK[a] <= PROVENANCE_RANK[b] ? a : b
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

// -------------------------------------------------------------------- churn

/**
 * Code churn accounting.
 *
 * Three rules shape everything below, and they pull against each other:
 *
 * 1. **Never count twice.** The event log replays after a crash, hooks retry,
 *    and the Copilot tailer re-reads regions of a file, so the reducer must
 *    assume it will see every tool result more than once (docs/architecture.md,
 *    "Idempotency"). A counter that merely adds is wrong by construction.
 * 2. **Never invent a number.** An absent figure is not a zero, and the two
 *    sides of a change are absent independently. A `write` states the file's
 *    new contents and nothing about what it replaced, so it reports additions
 *    only; `-0` there would be a fabrication. Count zero only where an empty
 *    string was actually present.
 * 3. **Better evidence wins, once.** Rule 1 cannot be a one-way latch, because
 *    a call is described by two events that may arrive in either order and in
 *    varying detail. So each call carries the *term* it is currently credited
 *    with, and a redelivery is reconciled against that term rather than added
 *    to it: equal or worse evidence changes nothing, better evidence replaces
 *    the term and moves the agent's aggregate by the difference.
 *
 * Rule 3 is what makes rule 1 hold without freezing the first guess in place.
 */
interface Churn {
  /** Absent means "this side was not stated", which is never the same as 0. */
  linesAdded?: number
  linesRemoved?: number
  provenance: Provenance
}

/**
 * Reconciles one completed edit's churn into its agent's totals.
 *
 * The ledger is the tool call row itself: its `linesAdded`/`linesRemoved` are
 * the term this call currently contributes to the agent's sum. Every write to
 * the row carries that term forward untouched, and this function is the only
 * thing that changes it.
 *
 * A delivery is accepted per side, and only when it tells us something we do
 * not already have: the side is absent, or this delivery is better evidenced
 * than the term on record. Anything else returns without a write, which is the
 * replay path. When a side is replaced, the agent aggregate moves by the
 * difference, so the call is counted exactly once no matter how often or in
 * what order its events arrive.
 *
 * Keyed on the call id rather than the event id, because deduplicating events
 * would still let a `tool.started` and a `tool.finished` describing the same
 * edit both contribute.
 */
function creditChurn(
  store: EntityStore,
  changes: Change[],
  agent: AgentEntity,
  call: ToolCallEntity | undefined,
): void {
  if (!call) return
  // Only a call the host confirmed succeeded moved any lines. A still-running
  // call may yet fail, and a failed one is a request, not an edit. A call that
  // errors and is only later reported ok is still eligible, because nothing was
  // credited the first time round. The reverse cannot happen: `tool.finished`
  // refuses to move an `ok` call back to `error`.
  if (call.status !== "ok") return

  const next = extractChurn(call)
  // Silence is not zero. An argument the redactor rewrote, a result that landed
  // before its call, a tool Observer does not model: all leave the agent
  // untouched *and* leave the call's term as it was, so a later, fuller
  // delivery can still be credited.
  if (!next) return

  // An absent confidence is treated as the weakest level, so a row that came
  // back from storage without one can still be upgraded. The worst that costs
  // is one redundant, value-identical rewrite.
  const heldRank = PROVENANCE_RANK[call.churnConfidence ?? "inferred"]
  const better = PROVENANCE_RANK[next.provenance] > heldRank
  const takeAdded = next.linesAdded !== undefined && (call.linesAdded === undefined || better)
  const takeRemoved = next.linesRemoved !== undefined && (call.linesRemoved === undefined || better)
  // Nothing new to say. This is where every duplicate delivery stops.
  if (!takeAdded && !takeRemoved) return

  const linesAdded = takeAdded ? next.linesAdded : call.linesAdded
  const linesRemoved = takeRemoved ? next.linesRemoved : call.linesRemoved
  // If any credited side was kept from an earlier, weaker delivery, the term as
  // a whole is only as good as that side.
  const kept = (!takeAdded && linesAdded !== undefined) || (!takeRemoved && linesRemoved !== undefined)
  const confidence = kept ? weakestProvenance(call.churnConfidence ?? undefined, next.provenance) : next.provenance

  putToolCall(store, changes, { ...call, linesAdded, linesRemoved, churnConfidence: confidence })

  const now = currentAgent(store, agent)
  putAgent(store, changes, {
    ...now,
    linesAdded: applyDelta(now.linesAdded, call.linesAdded, linesAdded),
    linesRemoved: applyDelta(now.linesRemoved, call.linesRemoved, linesRemoved),
    churnConfidence: weakestProvenance(now.churnConfidence ?? undefined, confidence),
  })
}

/**
 * Moves one side of an agent's total from a call's old term to its new one.
 *
 * Subtracting the old term before adding the new is what makes a *replacement*
 * safe: without it, correcting an inferred figure with a host-stated one would
 * add the edit a second time. The `?? 0` on the total is the only place a zero
 * is created, and only at the moment a real figure first lands.
 */
function applyDelta(total: number | undefined, was: number | undefined, now: number | undefined): number | undefined {
  // This side is still unknown, so the total stays absent rather than becoming
  // a zero the host never stated.
  if (now === undefined) return total
  return (total ?? 0) - (was ?? 0) + now
}

/**
 * The file-editing tools Observer understands, by normalised name.
 *
 * An allowlist rather than a heuristic, for the same reason `Adapter.ignores`
 * is one: a tool nobody has taught Observer about must produce *no* churn, not
 * a guess. `bash` running `sed -i` edits files and is deliberately absent —
 * its arguments do not state what changed.
 */
const CHURN_TOOLS: Record<string, "write" | "edit" | "multiedit" | "patch"> = {
  write: "write",
  writefile: "write",
  createfile: "write",
  filewrite: "write",
  edit: "edit",
  editfile: "edit",
  strreplace: "edit",
  strreplaceeditor: "edit",
  strreplacebasededittool: "edit",
  multiedit: "multiedit",
  applypatch: "patch",
  patch: "patch",
}

/** Hosts spell the same tool `MultiEdit`, `multi_edit` and `multi-edit`. */
function normaliseToolName(tool: string): string {
  return tool.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function extractChurn(call: ToolCallEntity): Churn | null {
  const family = CHURN_TOOLS[normaliseToolName(call.tool)]
  if (!family) return null

  // A host stating its own numbers beats anything we work out from arguments,
  // so it is asked first and is the one path that yields `authoritative`.
  const stated = statedChurn(call.output)
  if (stated) return stated

  const input = asRecord(call.input)
  if (!input) return null

  switch (family) {
    case "write": {
      const content = pickText(input, "content", "contents", "text", "file_text", "fileText")
      if (content === null) return null
      // Additions only, deliberately. A write reveals the file's new contents
      // and says *nothing* about how many lines stood there before, so the
      // removed side stays absent. `-0` would be the fabricated half of a diff
      // Observer never saw; the UI renders one present side quite happily.
      return { linesAdded: countLines(content), provenance: "inferred" }
    }
    case "edit":
      return editChurn(input)
    case "multiedit":
      return multiEditChurn(input)
    case "patch": {
      const patch = pickText(input, "patch", "diff", "input", "content")
      if (patch === null) return null
      return patchChurn(patch)
    }
  }
}

/**
 * One string-replacement edit, counted per side.
 *
 * A missing `oldString` is not an empty `oldString`: it is an argument we never
 * saw, and guessing it as zero would understate a real deletion. So each half
 * is counted only when the host actually supplied that string — an empty one
 * counts as zero lines, because emptiness was stated.
 *
 * `replaceAll` applies the same edit an unknown number of times. The tool
 * guarantees at least one occurrence, so counting one makes the figure a floor;
 * multiplying by a number we do not have would make it a fiction.
 */
function editChurn(input: Record<string, unknown> | null): Churn | null {
  if (!input) return null
  const before = pickText(input, "oldString", "old_string", "old_str", "oldText")
  const after = pickText(input, "newString", "new_string", "new_str", "newText")
  if (before === null && after === null) return null
  const churn: Churn = { provenance: "inferred" }
  if (after !== null) churn.linesAdded = countLines(after)
  if (before !== null) churn.linesRemoved = countLines(before)
  return churn
}

/**
 * A batch of edits under one call id.
 *
 * A side is summed only when *every* entry stated it. A sum with a hole in it
 * is not a smaller number, it is an unknown one, so one entry missing its
 * `old_string` withdraws the removed side for the whole batch rather than
 * quietly understating it.
 */
function multiEditChurn(input: Record<string, unknown>): Churn | null {
  const edits = input["edits"]
  if (!Array.isArray(edits) || edits.length === 0) return null
  // `redactValue` caps arrays at 200 entries, so a batch of exactly that length
  // may be a clipped view of a longer one. Refusing beats undercounting.
  if (edits.length >= REDACTION_ARRAY_CAP) return null

  let linesAdded = 0
  let linesRemoved = 0
  let addedComplete = true
  let removedComplete = true
  for (const entry of edits) {
    const churn = editChurn(asRecord(entry))
    if (!churn) return null // An illegible entry makes the whole batch unknown.
    if (churn.linesAdded === undefined) addedComplete = false
    else linesAdded += churn.linesAdded
    if (churn.linesRemoved === undefined) removedComplete = false
    else linesRemoved += churn.linesRemoved
  }
  if (!addedComplete && !removedComplete) return null
  const churn: Churn = { provenance: "inferred" }
  if (addedComplete) churn.linesAdded = linesAdded
  if (removedComplete) churn.linesRemoved = linesRemoved
  return churn
}

/**
 * A unified diff or an apply_patch envelope, counted from its grammar.
 *
 * Matching a bare `@@` or `*** ` prefix is not enough: `"@@ not a hunk"`
 * followed by `"+fabricated"` is prose that happens to be shaped like a patch,
 * and counting it invents churn out of formatting. So a `+`/`-` line is only
 * counted while a *validated* hunk is open — a real unified hunk header, or an
 * apply_patch file directive inside a `*** Begin Patch` envelope.
 *
 * A patch that opens correctly but states no changed line contributes nothing
 * either. Zero changed lines is not a measurement of zero churn; it means this
 * string was not a description of a change.
 */
function patchChurn(patch: string): Churn | null {
  let linesAdded = 0
  let linesRemoved = 0
  let open = false
  let envelope = false
  for (const line of patch.split("\n")) {
    if (APPLY_PATCH_BEGIN.test(line)) {
      envelope = true
      open = false
      continue
    }
    // File directives only open a hunk inside an envelope, so a stray
    // `*** Update File: x` in prose stays inert.
    if (APPLY_PATCH_FILE.test(line)) {
      open = envelope
      continue
    }
    if (APPLY_PATCH_END.test(line)) {
      open = false
      continue
    }
    if (UNIFIED_HUNK.test(line)) {
      open = true
      continue
    }
    // `@@` inside an apply_patch envelope is a context marker, not a hunk
    // header, and does not carry line ranges. It keeps an open hunk open and
    // cannot open one by itself.
    if (line.startsWith("@@")) {
      if (!open) return null
      continue
    }
    if (!open) continue
    // `+++`/`---` are file headers, not content lines.
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) linesAdded++
    else if (line.startsWith("-")) linesRemoved++
  }
  if (linesAdded === 0 && linesRemoved === 0) return null
  // Both sides are genuinely stated here: a diff enumerates every changed line,
  // so a real zero on one side is a measurement rather than an absence.
  return { linesAdded, linesRemoved, provenance: "inferred" }
}

/** `@@ -12,3 +12,4 @@ optional section heading` */
const UNIFIED_HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/
const APPLY_PATCH_BEGIN = /^\*\*\* Begin Patch\s*$/
const APPLY_PATCH_END = /^\*\*\* End Patch\s*$/
const APPLY_PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: \S/

/**
 * Churn the host stated itself, rather than churn we worked out.
 *
 * This requires an adapter to have *identified* the numbers as churn, under an
 * explicit normalized marker. Reading bare `additions`/`deletions` off any JSON
 * tool output was the earlier mistake: plenty of unrelated results carry those
 * keys, and promoting a package manager's summary to `authoritative` churn is
 * worse than reporting no churn at all. `authoritative` means the host said so;
 * nothing less earns the word.
 *
 * No adapter emits the marker today. This is the seam, so that when one does
 * its numbers land without the reducer changing.
 *
 * Each side is optional but must be a non-negative *integer*. `1.9` is not a
 * count of lines, and truncating it to `1` would report a number the host never
 * stated under the strongest provenance Observer has.
 */
function statedChurn(output: string | null): Churn | null {
  if (!output || !output.includes(CHURN_MARKER_KEY)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    // Adapters truncate long outputs, so an unparseable string is ordinary.
    return null
  }
  const marker = asRecord(asRecord(parsed)?.[CHURN_MARKER_KEY])
  if (!marker) return null
  const linesAdded = pickCount(marker, "linesAdded")
  const linesRemoved = pickCount(marker, "linesRemoved")
  if (linesAdded === undefined && linesRemoved === undefined) return null
  const churn: Churn = { provenance: "authoritative" }
  if (linesAdded !== undefined) churn.linesAdded = linesAdded
  if (linesRemoved !== undefined) churn.linesRemoved = linesRemoved
  return churn
}

/**
 * The key an adapter must use to declare host-stated churn:
 * `{"observerChurn": {"linesAdded": 12, "linesRemoved": 3}}`.
 */
export const CHURN_MARKER_KEY = "observerChurn"

/** `""` is zero lines, and a trailing newline does not open a further one. */
function countLines(text: string): number {
  if (text.length === 0) return 0
  const body = text.endsWith("\n") ? text.slice(0, -1) : text
  return body.split("\n").length
}

/**
 * Keeps the fullest view of a call's arguments across redeliveries.
 *
 * Two `tool.started` events for one call id need not carry the same detail. The
 * later one may be a retry that lost a field, or a tailer's partial re-read, and
 * plain `??` would let it overwrite arguments already captured in full — which
 * silently changes churn that was derived from them.
 */
function mergeToolInput(held: unknown, incoming: unknown): unknown {
  if (incoming === undefined || incoming === null) return held ?? null
  const a = asRecord(held)
  const b = asRecord(incoming)
  if (!a || !b) return incoming
  const merged: Record<string, unknown> = { ...a }
  for (const [key, value] of Object.entries(b)) {
    if (value !== undefined && value !== null) merged[key] = value
  }
  return merged
}

/**
 * Markers the ingest pipeline leaves on a string it rewrote.
 *
 * Capture policy does not blank a redacted argument, it *substitutes* one:
 * `redactText` swaps a secret for `[redacted]` — collapsing a multi-line PEM
 * key to a single line — and appends a truncation notice past
 * `maxTextLength`; `redactValue` replaces a too-deep branch with
 * `[depth limit]`. Counting lines in any of those measures the redactor, not
 * the file, so a marked string is treated as never captured at all.
 *
 * These are the literals from `redact.ts`, pinned by a test that runs the real
 * redactor and asserts the result yields no churn, because drift here would be
 * silent and would show up only as quietly wrong numbers.
 */
const PIPELINE_MARKERS = ["[redacted]", "\u2026 [truncated ", "[depth limit]"]

/** `redactValue` keeps only the first 200 entries of an array. */
const REDACTION_ARRAY_CAP = 200

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * Reads a string argument, refusing anything the pipeline rewrote.
 *
 * Returning `null` for a marked string is what keeps redaction out of the
 * counts: it makes that side *absent*, exactly as if the host had never sent
 * it, rather than a number derived from a placeholder.
 */
function pickText(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value !== "string") continue
    if (PIPELINE_MARKERS.some((marker) => value.includes(marker))) return null
    return value
  }
  return null
}

/** Only a non-negative integer is a line count; a decimal is not a count at all. */
function pickCount(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined
  return value
}
