import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type {
  AgentAssignment,
  AgentCounts,
  AgentEntity,
  AgentMail,
  EdgeEntity,
  EntityStore,
  HostId,
  IngestEvent,
  MessageAttachment,
  MessageEntity,
  PromptFragmentEntity,
  SessionEntity,
  StoredEvent,
  ToolCallEntity,
  TodoEntity,
} from "@observer-ai/protocol"
import { MIGRATIONS } from "./migrations.js"

type Row = Record<string, unknown>

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}
function nstr(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}
function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0)
}
function nnum(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}
function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** Session ids are `<host>:<sessionKey>` and the key may itself contain colons. */
function splitSessionId(sessionId: string): { host: string; sessionKey: string } {
  const separator = sessionId.indexOf(":")
  if (separator < 0) return { host: sessionId, sessionKey: "" }
  return { host: sessionId.slice(0, separator), sessionKey: sessionId.slice(separator + 1) }
}

export interface StoreOptions {
  path: string
  /** Retention window in days; 0 disables pruning. */
  retentionDays?: number
}

/**
 * SQLite-backed event log and entity projection.
 *
 * Uses `node:sqlite` so Observer has no native build step: hook processes and
 * the daemon only need the Node runtime the user already has.
 */
export class Store implements EntityStore {
  private readonly db: DatabaseSync
  private retentionDays: number

  constructor(options: StoreOptions) {
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(options.path)
    this.retentionDays = options.retentionDays ?? 30
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = NORMAL")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.migrate()
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as Row | undefined
    let version = num(row?.["user_version"])
    // Development builds briefly shipped identity and churn together as v2.
    // If all v3 columns already exist, advance the marker instead of replaying
    // ALTER TABLE statements against that pre-release schema.
    if (version === 2 && hasColumns(this.db, "agents", ["lines_added", "lines_removed", "churn_confidence"]) &&
        hasColumns(this.db, "tool_calls", ["lines_added", "lines_removed", "churn_confidence"])) {
      this.db.exec("PRAGMA user_version = 3")
      version = 3
    }
    for (let i = version; i < MIGRATIONS.length; i++) {
      const sql = MIGRATIONS[i]
      if (!sql) continue
      this.db.exec("BEGIN")
      try {
        this.db.exec(sql)
        this.db.exec(`PRAGMA user_version = ${i + 1}`)
        this.db.exec("COMMIT")
      } catch (error) {
        this.db.exec("ROLLBACK")
        throw error
      }
      version = i + 1
    }
  }

  close(): void {
    this.db.close()
  }

  /** Changes the retention window used by the next pruning pass. */
  setRetentionDays(retentionDays: number): void {
    this.retentionDays = retentionDays
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN")
    try {
      const result = fn()
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  // ---------------------------------------------------------------- event log

  /**
   * Appends an event. Returns undefined when the id was already stored, which
   * makes spool replay and adapter retries safe.
   */
  appendEvent(event: IngestEvent & { id: string; at: number }): StoredEvent | undefined {
    const receivedAt = Date.now()
    const existing = this.db.prepare("SELECT seq FROM events WHERE id = ?").get(event.id) as Row | undefined
    if (existing) return undefined
    const stmt = this.db.prepare(
      `INSERT INTO events (id, host, host_version, adapter, workspace_root, session_key, agent_key, kind, at, received_at, provenance, body, raw)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    stmt.run(
      event.id,
      event.host,
      event.hostVersion ?? null,
      event.adapter,
      event.workspaceRoot,
      event.sessionKey,
      event.agentKey,
      event.body.kind,
      event.at,
      receivedAt,
      event.provenance,
      JSON.stringify(event.body),
      event.raw === undefined ? null : JSON.stringify(event.raw),
    )
    const seqRow = this.db.prepare("SELECT last_insert_rowid() AS seq").get() as Row
    return { ...event, seq: num(seqRow["seq"]), receivedAt }
  }

  cursor(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as Row
    return num(row["seq"])
  }

  countEvents(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as Row
    return num(row["n"])
  }

  listRawEvents(sessionId: string, limit = 200): StoredEvent[] {
    const { host, sessionKey } = splitSessionId(sessionId)
    const rows = this.db
      .prepare("SELECT * FROM events WHERE host = ? AND session_key = ? ORDER BY seq DESC LIMIT ?")
      .all(host, sessionKey, limit) as Row[]
    return rows.map((r) => ({
      id: str(r["id"]),
      seq: num(r["seq"]),
      host: str(r["host"]) as HostId,
      hostVersion: nstr(r["host_version"]) ?? undefined,
      adapter: str(r["adapter"]),
      workspaceRoot: str(r["workspace_root"]),
      sessionKey: str(r["session_key"]),
      agentKey: str(r["agent_key"]),
      at: num(r["at"]),
      receivedAt: num(r["received_at"]),
      provenance: str(r["provenance"]) as StoredEvent["provenance"],
      body: json(r["body"], {} as StoredEvent["body"]),
      raw: r["raw"] === null ? undefined : json(r["raw"], undefined),
    }))
  }

  /** Deletes data older than the retention window. Returns rows removed. */
  prune(now = Date.now()): number {
    if (this.retentionDays <= 0) return 0
    const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1000
    return this.transaction(() => {
      const sessions = this.db
        .prepare("SELECT id FROM sessions WHERE updated_at < ? AND status IN ('ended','error')")
        .all(cutoff) as Row[]
      let removed = 0
      for (const row of sessions) {
        const id = str(row["id"])
        const { host, sessionKey } = splitSessionId(id)
        this.deleteCoordination(host as HostId, sessionKey)
        for (const table of ["message_attachments", "messages", "tool_calls", "todos", "prompt_fragments", "edges", "agents"]) {
          this.db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(id)
        }
        this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id)
        removed++
      }
      this.db.prepare("DELETE FROM events WHERE received_at < ?").run(cutoff)
      this.db.prepare("DELETE FROM agent_mail WHERE created_at < ?").run(cutoff)
      return removed
    })
  }

  /** Removes every trace of a session, including its raw events. */
  deleteSession(sessionId: string): void {
    const { host, sessionKey } = splitSessionId(sessionId)
    this.transaction(() => {
      this.deleteCoordination(host as HostId, sessionKey)
      for (const table of ["message_attachments", "messages", "tool_calls", "todos", "prompt_fragments", "edges", "agents"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId)
      }
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId)
      this.db.prepare("DELETE FROM events WHERE host = ? AND session_key = ?").run(host, sessionKey)
    })
  }

  // ------------------------------------------------------------ EntityStore

  getSession(id: string): SessionEntity | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined
    return row ? toSession(row) : undefined
  }

  putSession(row: SessionEntity): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, host, host_version, session_key, workspace_root, title, status, model, goal, goal_status, cwd, started_at, ended_at, updated_at, last_event_seq)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           host_version=excluded.host_version, workspace_root=excluded.workspace_root, title=excluded.title,
           status=excluded.status, model=excluded.model, goal=excluded.goal, goal_status=excluded.goal_status,
           cwd=excluded.cwd, ended_at=excluded.ended_at, updated_at=excluded.updated_at,
           last_event_seq=excluded.last_event_seq`,
      )
      .run(
        row.id,
        row.host,
        row.hostVersion,
        row.sessionKey,
        row.workspaceRoot,
        row.title,
        row.status,
        row.model,
        row.goal,
        row.goalStatus,
        row.cwd,
        row.startedAt,
        row.endedAt,
        row.updatedAt,
        row.lastEventSeq,
      )
  }

  getAgent(id: string): AgentEntity | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined
    return row ? toAgent(row) : undefined
  }

  getAgentByKey(sessionId: string, agentKey: string): AgentEntity | undefined {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE session_id = ? AND agent_key = ?")
      .get(sessionId, agentKey) as Row | undefined
    return row ? toAgent(row) : undefined
  }

  putAgent(row: AgentEntity): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, session_id, agent_key, runtime_id, agent_type, display_name, parent_agent_id, status, model, model_confidence, description, delegation_prompt, summary, started_at, ended_at, updated_at, total_tokens, duration_ms, lines_added, lines_removed, churn_confidence)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           runtime_id=COALESCE(excluded.runtime_id, agents.runtime_id), agent_type=excluded.agent_type,
           display_name=excluded.display_name, parent_agent_id=excluded.parent_agent_id,
           status=excluded.status, model=excluded.model, model_confidence=excluded.model_confidence,
           description=excluded.description, delegation_prompt=excluded.delegation_prompt, summary=excluded.summary,
           ended_at=excluded.ended_at, updated_at=excluded.updated_at, total_tokens=excluded.total_tokens,
           duration_ms=excluded.duration_ms, lines_added=excluded.lines_added,
           lines_removed=excluded.lines_removed, churn_confidence=excluded.churn_confidence`,
      )
      .run(
        row.id,
        row.sessionId,
        row.agentKey,
        row.runtimeId ?? null,
        row.agentType,
        row.displayName,
        row.parentAgentId,
        row.status,
        row.model,
        row.modelConfidence,
        row.description,
        row.delegationPrompt,
        row.summary,
        row.startedAt,
        row.endedAt,
        row.updatedAt,
        row.totalTokens,
        row.durationMs,
        row.linesAdded ?? null,
        row.linesRemoved ?? null,
        row.churnConfidence ?? null,
      )
  }

  getEdge(id: string): EdgeEntity | undefined {
    const row = this.db.prepare("SELECT * FROM edges WHERE id = ?").get(id) as Row | undefined
    return row ? toEdge(row) : undefined
  }

  putEdge(row: EdgeEntity): void {
    this.db
      .prepare(
        `INSERT INTO edges (id, session_id, from_agent_id, to_agent_id, edge_type, label, provenance, created_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET label=excluded.label, provenance=excluded.provenance`,
      )
      .run(row.id, row.sessionId, row.fromAgentId, row.toAgentId, row.edgeType, row.label, row.provenance, row.createdAt)
  }

  getMessage(id: string): MessageEntity | undefined {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row | undefined
    return row ? toMessage(row) : undefined
  }

  putMessage(row: MessageEntity): void {
    const attachments = row.attachments ?? []
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, agent_id, role, message_key, text, streaming, attachments, created_at, updated_at, seq)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET text=excluded.text, streaming=excluded.streaming,
           attachments=COALESCE(excluded.attachments, messages.attachments), updated_at=excluded.updated_at`,
      )
      .run(
        row.id,
        row.sessionId,
        row.agentId,
        row.role,
        row.messageKey,
        row.text,
        row.streaming ? 1 : 0,
        attachments.length > 0 ? JSON.stringify(attachments) : null,
        row.createdAt,
        row.updatedAt,
        row.seq,
      )
    // The serve-time allowlist. Written after the message so an attachment can
    // never name a file that no transcript refers to.
    for (const attachment of attachments) {
      this.db
        .prepare(
          `INSERT INTO message_attachments (id, session_id, message_id, name, path, mime_type, byte_length, updated_at)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET message_id=excluded.message_id, name=excluded.name,
             path=excluded.path, mime_type=excluded.mime_type, byte_length=excluded.byte_length,
             updated_at=excluded.updated_at`,
        )
        .run(
          attachment.id,
          row.sessionId,
          row.id,
          attachment.name,
          attachment.path ?? null,
          attachment.mimeType ?? null,
          attachment.byteLength ?? null,
          row.updatedAt,
        )
    }
  }

  /**
   * One attachment by id, or nothing.
   *
   * This is what makes serving a file off the agent's machine safe: the daemon
   * never takes a path from the browser, only an id it previously minted, and
   * a path that no message references cannot be named at all.
   */
  getAttachment(id: string): MessageAttachment | undefined {
    const row = this.db.prepare("SELECT * FROM message_attachments WHERE id = ?").get(id) as Row | undefined
    if (!row) return undefined
    const path = nstr(row["path"])
    const mimeType = nstr(row["mime_type"])
    const byteLength = nnum(row["byte_length"])
    return {
      id: str(row["id"]),
      name: str(row["name"]),
      ...(path === null ? {} : { path }),
      ...(mimeType === null ? {} : { mimeType }),
      ...(byteLength === null ? {} : { byteLength }),
    }
  }

  nextMessageSeq(agentId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM messages WHERE agent_id = ?").get(agentId) as Row
    return num(row["n"]) + 1
  }

  getToolCall(id: string): ToolCallEntity | undefined {
    const row = this.db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(id) as Row | undefined
    return row ? toToolCall(row) : undefined
  }

  putToolCall(row: ToolCallEntity): void {
    this.db
      .prepare(
        `INSERT INTO tool_calls (id, session_id, agent_id, call_id, tool, title, input, output, error, status, started_at, ended_at, duration_ms, lines_added, lines_removed, churn_confidence)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           tool=excluded.tool, title=excluded.title, input=COALESCE(excluded.input, tool_calls.input),
           output=excluded.output, error=excluded.error, status=excluded.status,
           ended_at=excluded.ended_at, duration_ms=excluded.duration_ms,
           lines_added=excluded.lines_added, lines_removed=excluded.lines_removed,
           churn_confidence=excluded.churn_confidence`,
      )
      .run(
        row.id,
        row.sessionId,
        row.agentId,
        row.callId,
        row.tool,
        row.title,
        row.input === undefined || row.input === null ? null : JSON.stringify(row.input),
        row.output,
        row.error,
        row.status,
        row.startedAt,
        row.endedAt,
        row.durationMs,
        row.linesAdded ?? null,
        row.linesRemoved ?? null,
        row.churnConfidence ?? null,
      )
  }

  // ---------------------------------------------------- agent coordination

  getAgentAssignment(id: string): AgentAssignment | undefined {
    const row = this.db.prepare("SELECT * FROM agent_assignments WHERE id = ?").get(id) as Row | undefined
    return row ? toAgentAssignment(row) : undefined
  }

  getAgentAssignmentByRuntime(host: HostId, runtimeId: string): AgentAssignment | undefined {
    const row = this.db
      .prepare("SELECT * FROM agent_assignments WHERE host = ? AND runtime_id = ?")
      .get(host, runtimeId) as Row | undefined
    return row ? toAgentAssignment(row) : undefined
  }

  listAgentAssignments(host: HostId, rootSessionKey: string): AgentAssignment[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_assignments WHERE host = ? AND root_session_key = ? ORDER BY created_at")
      .all(host, rootSessionKey) as Row[]
    return rows.map(toAgentAssignment)
  }

  getAgentAssignmentByCall(host: HostId, rootSessionKey: string, callId: string): AgentAssignment | undefined {
    const row = this.db
      .prepare("SELECT * FROM agent_assignments WHERE host = ? AND root_session_key = ? AND call_id = ?")
      .get(host, rootSessionKey, callId) as Row | undefined
    return row ? toAgentAssignment(row) : undefined
  }

  putAgentAssignment(row: AgentAssignment): void {
    if (!row.parentRuntimeId) throw new Error("subagent assignment requires a parent runtime id")
    this.db
      .prepare(
        `INSERT INTO agent_assignments (id, host, root_session_key, runtime_id, parent_runtime_id, call_id, agent_type, host_agent_type, description, prompt, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           root_session_key=excluded.root_session_key, runtime_id=COALESCE(excluded.runtime_id, agent_assignments.runtime_id),
           parent_runtime_id=excluded.parent_runtime_id,
           call_id=COALESCE(excluded.call_id, agent_assignments.call_id), agent_type=excluded.agent_type,
           host_agent_type=excluded.host_agent_type, description=COALESCE(excluded.description, agent_assignments.description),
           prompt=COALESCE(excluded.prompt, agent_assignments.prompt), status=excluded.status,
           updated_at=excluded.updated_at`,
      )
      .run(
        row.id,
        row.host,
        row.rootSessionKey,
        row.runtimeId,
        row.parentRuntimeId,
        row.callId,
        row.agentType,
        row.hostAgentType,
        row.description,
        row.prompt,
        row.status,
        row.createdAt,
        row.updatedAt,
      )
  }

  putAgentMail(row: AgentMail): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO agent_mail (id, host, root_session_key, from_runtime_id, to_runtime_id, text, created_at, delivered_at, read_at)
         VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        row.id,
        row.host,
        row.rootSessionKey,
        row.fromRuntimeId,
        row.toRuntimeId,
        row.text,
        row.createdAt,
        row.deliveredAt,
        row.readAt,
      )
    return Number(result.changes) === 1
  }

  listUnreadAgentMail(host: HostId, rootSessionKey: string, toRuntimeId: string, limit = 100): AgentMail[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM agent_mail WHERE host = ? AND root_session_key = ? AND to_runtime_id = ? AND read_at IS NULL ORDER BY created_at LIMIT ?",
      )
      .all(host, rootSessionKey, toRuntimeId, limit) as Row[]
    return rows.map(toAgentMail)
  }

  markAgentMailDelivered(id: string, toRuntimeId: string, at = Date.now()): void {
    this.db
      .prepare("UPDATE agent_mail SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ? AND to_runtime_id = ?")
      .run(at, id, toRuntimeId)
  }

  markAgentMailRead(ids: string[], toRuntimeId: string, at = Date.now()): void {
    const stmt = this.db.prepare(
      "UPDATE agent_mail SET read_at = COALESCE(read_at, ?) WHERE id = ? AND to_runtime_id = ?",
    )
    for (const id of ids) stmt.run(at, id, toRuntimeId)
  }

  countRecentAgentMail(host: HostId, rootSessionKey: string, fromRuntimeId: string, since: number): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_mail WHERE host = ? AND root_session_key = ? AND from_runtime_id = ? AND created_at >= ?",
      )
      .get(host, rootSessionKey, fromRuntimeId, since) as Row
    return num(row["n"])
  }

  countRecentAgentMailTo(host: HostId, rootSessionKey: string, toRuntimeId: string, since: number): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_mail WHERE host = ? AND root_session_key = ? AND to_runtime_id = ? AND created_at >= ?",
      )
      .get(host, rootSessionKey, toRuntimeId, since) as Row
    return num(row["n"])
  }

  countRecentAgentAssignments(host: HostId, rootSessionKey: string, since: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM agent_assignments WHERE host = ? AND root_session_key = ? AND created_at >= ?")
      .get(host, rootSessionKey, since) as Row
    return num(row["n"])
  }

  private deleteCoordination(host: HostId, rootSessionKey: string): void {
    this.db.prepare("DELETE FROM agent_mail WHERE host = ? AND root_session_key = ?").run(host, rootSessionKey)
    this.db.prepare("DELETE FROM agent_assignments WHERE host = ? AND root_session_key = ?").run(host, rootSessionKey)
  }

  listTodos(agentId: string): TodoEntity[] {
    const rows = this.db.prepare("SELECT * FROM todos WHERE agent_id = ? ORDER BY position").all(agentId) as Row[]
    return rows.map(toTodo)
  }

  replaceTodos(agentId: string, rows: TodoEntity[]): void {
    this.db.prepare("DELETE FROM todos WHERE agent_id = ?").run(agentId)
    const stmt = this.db.prepare(
      `INSERT INTO todos (id, session_id, agent_id, position, content, status, original_status, priority, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    for (const row of rows) {
      stmt.run(
        row.id,
        row.sessionId,
        row.agentId,
        row.position,
        row.content,
        row.status,
        row.originalStatus,
        row.priority,
        row.updatedAt,
      )
    }
  }

  getPromptFragment(id: string): PromptFragmentEntity | undefined {
    const row = this.db.prepare("SELECT * FROM prompt_fragments WHERE id = ?").get(id) as Row | undefined
    return row ? toPromptFragment(row) : undefined
  }

  putPromptFragment(row: PromptFragmentEntity): void {
    this.db
      .prepare(
        `INSERT INTO prompt_fragments (id, session_id, agent_id, fragment_key, prompt_kind, label, text, path, availability, note, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           prompt_kind=excluded.prompt_kind, label=excluded.label, text=excluded.text, path=excluded.path,
           availability=excluded.availability, note=excluded.note, updated_at=excluded.updated_at`,
      )
      .run(
        row.id,
        row.sessionId,
        row.agentId,
        row.fragmentKey,
        row.promptKind,
        row.label,
        row.text,
        row.path,
        row.availability,
        row.note,
        row.updatedAt,
      )
  }

  // --------------------------------------------------------------- read APIs

  listSessions(options: { limit?: number; host?: HostId; active?: boolean } = {}): SessionEntity[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (options.host) {
      clauses.push("host = ?")
      params.push(options.host)
    }
    if (options.active) clauses.push("status IN ('active','idle')")
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    params.push(options.limit ?? 50)
    const rows = this.db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...(params as never[])) as Row[]
    return rows.map(toSession)
  }

  listAgents(sessionId: string): AgentEntity[] {
    const rows = this.db.prepare("SELECT * FROM agents WHERE session_id = ? ORDER BY started_at").all(sessionId) as Row[]
    return rows.map(toAgent)
  }

  listEdges(sessionId: string): EdgeEntity[] {
    const rows = this.db.prepare("SELECT * FROM edges WHERE session_id = ?").all(sessionId) as Row[]
    return rows.map(toEdge)
  }

  listSessionTodos(sessionId: string): TodoEntity[] {
    const rows = this.db
      .prepare("SELECT * FROM todos WHERE session_id = ? ORDER BY agent_id, position")
      .all(sessionId) as Row[]
    return rows.map(toTodo)
  }

  listMessages(agentId: string, limit = 500): MessageEntity[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE agent_id = ? ORDER BY seq DESC LIMIT ?")
      .all(agentId, limit) as Row[]
    return rows.map(toMessage).reverse()
  }

  listToolCalls(agentId: string, limit = 200): ToolCallEntity[] {
    const rows = this.db
      .prepare("SELECT * FROM tool_calls WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(agentId, limit) as Row[]
    return rows.map(toToolCall).reverse()
  }

  listPromptFragments(agentId: string): PromptFragmentEntity[] {
    const rows = this.db.prepare("SELECT * FROM prompt_fragments WHERE agent_id = ?").all(agentId) as Row[]
    return rows.map(toPromptFragment)
  }

  /**
   * Activity totals per agent for one session.
   *
   * Counted in SQL rather than by loading rows, so the canvas can show how busy
   * each node is without fetching every message and tool call.
   */
  countsByAgent(sessionId: string): Record<string, AgentCounts> {
    const counts: Record<string, AgentCounts> = {}
    const bump = (agentId: string): AgentCounts => {
      const current = counts[agentId] ?? { messages: 0, toolCalls: 0, todos: 0 }
      counts[agentId] = current
      return current
    }
    for (const agent of this.listAgents(sessionId)) bump(agent.id)

    const tables: Array<[string, keyof AgentCounts]> = [
      ["messages", "messages"],
      ["tool_calls", "toolCalls"],
      ["todos", "todos"],
    ]
    for (const [table, key] of tables) {
      const rows = this.db
        .prepare(`SELECT agent_id AS id, COUNT(*) AS n FROM ${table} WHERE session_id = ? GROUP BY agent_id`)
        .all(sessionId) as Row[]
      for (const row of rows) bump(str(row["id"]))[key] = num(row["n"])
    }
    return counts
  }

  /**
   * The tool call currently running for each agent in a session, if any.
   *
   * Not folded into countsByAgent: a method named for counts that also returns
   * a tool call would be one name doing two jobs.
   */
  runningToolsByAgent(sessionId: string): Record<string, ToolCallEntity | null> {
    const result: Record<string, ToolCallEntity | null> = {}
    for (const agent of this.listAgents(sessionId)) result[agent.id] = null
    const rows = this.db
      .prepare(
        `SELECT * FROM tool_calls WHERE session_id = ? AND status = 'running' ORDER BY started_at DESC`,
      )
      .all(sessionId) as Row[]
    const seen = new Set<string>()
    for (const row of rows) {
      const tool = toToolCall(row)
      if (seen.has(tool.agentId)) continue
      seen.add(tool.agentId)
      result[tool.agentId] = tool
    }
    return result
  }
}

function hasColumns(db: DatabaseSync, table: string, expected: string[]): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Row[]
  const names = new Set(rows.map((row) => str(row["name"])))
  return expected.every((name) => names.has(name))
}

// ------------------------------------------------------------------ mappers

function toSession(r: Row): SessionEntity {
  return {
    id: str(r["id"]),
    host: str(r["host"]) as HostId,
    hostVersion: nstr(r["host_version"]),
    sessionKey: str(r["session_key"]),
    workspaceRoot: str(r["workspace_root"]),
    title: nstr(r["title"]),
    status: str(r["status"]) as SessionEntity["status"],
    model: nstr(r["model"]),
    goal: nstr(r["goal"]),
    goalStatus: nstr(r["goal_status"]),
    cwd: nstr(r["cwd"]),
    startedAt: num(r["started_at"]),
    endedAt: nnum(r["ended_at"]),
    updatedAt: num(r["updated_at"]),
    lastEventSeq: num(r["last_event_seq"]),
  }
}

function toAgent(r: Row): AgentEntity {
  return {
    id: str(r["id"]),
    sessionId: str(r["session_id"]),
    agentKey: str(r["agent_key"]),
    runtimeId: nstr(r["runtime_id"]),
    agentType: str(r["agent_type"]),
    displayName: nstr(r["display_name"]),
    parentAgentId: nstr(r["parent_agent_id"]),
    status: str(r["status"]) as AgentEntity["status"],
    model: nstr(r["model"]),
    modelConfidence: nstr(r["model_confidence"]) as AgentEntity["modelConfidence"],
    description: nstr(r["description"]),
    delegationPrompt: nstr(r["delegation_prompt"]),
    summary: nstr(r["summary"]),
    startedAt: num(r["started_at"]),
    endedAt: nnum(r["ended_at"]),
    updatedAt: num(r["updated_at"]),
    totalTokens: nnum(r["total_tokens"]),
    durationMs: nnum(r["duration_ms"]),
    linesAdded: r["lines_added"] === null || r["lines_added"] === undefined ? undefined : num(r["lines_added"]),
    linesRemoved: r["lines_removed"] === null || r["lines_removed"] === undefined ? undefined : num(r["lines_removed"]),
    churnConfidence: nstr(r["churn_confidence"]) as AgentEntity["churnConfidence"],
  }
}

function toEdge(r: Row): EdgeEntity {
  return {
    id: str(r["id"]),
    sessionId: str(r["session_id"]),
    fromAgentId: str(r["from_agent_id"]),
    toAgentId: str(r["to_agent_id"]),
    edgeType: str(r["edge_type"]) as EdgeEntity["edgeType"],
    label: nstr(r["label"]),
    provenance: str(r["provenance"]) as EdgeEntity["provenance"],
    createdAt: num(r["created_at"]),
  }
}

function toMessage(r: Row): MessageEntity {
  const attachments = json<MessageAttachment[]>(r["attachments"], [])
  return {
    id: str(r["id"]),
    sessionId: str(r["session_id"]),
    agentId: str(r["agent_id"]),
    role: str(r["role"]) as MessageEntity["role"],
    messageKey: str(r["message_key"]),
    text: str(r["text"]),
    streaming: num(r["streaming"]) === 1,
    ...(attachments.length > 0 ? { attachments } : {}),
    createdAt: num(r["created_at"]),
    updatedAt: num(r["updated_at"]),
    seq: num(r["seq"]),
  }
}

function toToolCall(r: Row): ToolCallEntity {
  return {
    id: str(r["id"]),
    sessionId: str(r["session_id"]),
    agentId: str(r["agent_id"]),
    callId: str(r["call_id"]),
    tool: str(r["tool"]),
    title: nstr(r["title"]),
    input: r["input"] === null ? null : json(r["input"], null),
    output: nstr(r["output"]),
    error: nstr(r["error"]),
    status: str(r["status"]) as ToolCallEntity["status"],
    startedAt: num(r["started_at"]),
    endedAt: nnum(r["ended_at"]),
    durationMs: nnum(r["duration_ms"]),
    linesAdded: r["lines_added"] === null || r["lines_added"] === undefined ? undefined : num(r["lines_added"]),
    linesRemoved: r["lines_removed"] === null || r["lines_removed"] === undefined ? undefined : num(r["lines_removed"]),
    churnConfidence: nstr(r["churn_confidence"]) as ToolCallEntity["churnConfidence"],
  }
}

function toAgentAssignment(r: Row): AgentAssignment {
  return {
    id: str(r["id"]),
    host: str(r["host"]) as HostId,
    rootSessionKey: str(r["root_session_key"]),
    runtimeId: nstr(r["runtime_id"]),
    parentRuntimeId: str(r["parent_runtime_id"]),
    callId: nstr(r["call_id"]),
    agentType: str(r["agent_type"]),
    hostAgentType: str(r["host_agent_type"]),
    description: nstr(r["description"]),
    prompt: nstr(r["prompt"]),
    status: str(r["status"]) as AgentAssignment["status"],
    createdAt: num(r["created_at"]),
    updatedAt: num(r["updated_at"]),
  }
}

function toAgentMail(r: Row): AgentMail {
  return {
    id: str(r["id"]),
    host: str(r["host"]) as HostId,
    rootSessionKey: str(r["root_session_key"]),
    fromRuntimeId: str(r["from_runtime_id"]),
    toRuntimeId: str(r["to_runtime_id"]),
    text: str(r["text"]),
    createdAt: num(r["created_at"]),
    deliveredAt: nnum(r["delivered_at"]),
    readAt: nnum(r["read_at"]),
  }
}

function toTodo(r: Row): TodoEntity {
  return {
    id: str(r["id"]),
    sessionId: str(r["session_id"]),
    agentId: str(r["agent_id"]),
    position: num(r["position"]),
    content: str(r["content"]),
    status: str(r["status"]) as TodoEntity["status"],
    originalStatus: nstr(r["original_status"]),
    priority: nstr(r["priority"]),
    updatedAt: num(r["updated_at"]),
  }
}

function toPromptFragment(r: Row): PromptFragmentEntity {
  return {
    id: str(r["id"]),
    sessionId: str(r["session_id"]),
    agentId: str(r["agent_id"]),
    fragmentKey: str(r["fragment_key"]),
    promptKind: str(r["prompt_kind"]) as PromptFragmentEntity["promptKind"],
    label: str(r["label"]),
    text: nstr(r["text"]),
    path: nstr(r["path"]),
    availability: str(r["availability"]) as PromptFragmentEntity["availability"],
    note: nstr(r["note"]),
    updatedAt: num(r["updated_at"]),
  }
}
