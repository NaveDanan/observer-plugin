import { z } from "zod"

/** Supported agent hosts. */
export const HostId = z.enum(["opencode", "codex", "claude", "copilot"])
export type HostId = z.infer<typeof HostId>

export const HOSTS: HostId[] = ["opencode", "codex", "claude", "copilot"]

/**
 * How trustworthy a piece of data is.
 *
 * - `authoritative`: the host reported it directly with explicit ids.
 * - `reconciled`: joined from two authoritative signals (e.g. a spawn tool call
 *   matched to a subagent start event).
 * - `inferred`: derived heuristically, usually by timing or naming.
 */
export const Provenance = z.enum(["authoritative", "reconciled", "inferred"])
export type Provenance = z.infer<typeof Provenance>

/** Whether a prompt fragment could actually be captured. */
export const Availability = z.enum(["available", "partial", "unavailable"])
export type Availability = z.infer<typeof Availability>

export const PromptKind = z.enum([
  "system",
  "developer",
  "agent-definition",
  "instructions",
  "delegation",
  "skill",
  "memory",
])
export type PromptKind = z.infer<typeof PromptKind>

export const AgentStatus = z.enum(["starting", "running", "idle", "completed", "failed", "interrupted"])
export type AgentStatus = z.infer<typeof AgentStatus>

export const SessionStatus = z.enum(["active", "idle", "ended", "error"])
export type SessionStatus = z.infer<typeof SessionStatus>

/** Normalized todo status shared across hosts. */
export const TodoStatus = z.enum(["pending", "in_progress", "completed", "cancelled", "blocked", "unknown"])
export type TodoStatus = z.infer<typeof TodoStatus>

export const EdgeType = z.enum(["spawned", "delegated", "messaged", "forked"])
export type EdgeType = z.infer<typeof EdgeType>

export const TodoInput = z.object({
  content: z.string(),
  status: TodoStatus,
  /** The host's own status string, preserved so the UI never lies about mapping. */
  originalStatus: z.string().optional(),
  priority: z.string().optional(),
  key: z.string().optional(),
})
export type TodoInput = z.infer<typeof TodoInput>

/**
 * One file a human handed to an agent alongside a message — usually a pasted
 * screenshot.
 *
 * Observer stores the *reference*, never the bytes: hosts already keep the file
 * on disk, and copying megabytes of PNG into the event log would make the
 * transcript unreadable and the database unbounded. `path` is the host's own
 * absolute path, and the daemon is the only thing allowed to read it — the
 * browser addresses an attachment by `id` alone.
 *
 * `id` must be derived from something stable about the file (its digest, or a
 * hash of its path) so redelivering the same message twice does not mint a
 * second attachment for the same image.
 */
export const MessageAttachment = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(500),
  /** The host's own absolute path. Absent when the host names no file. */
  path: z.string().max(4096).optional(),
  mimeType: z.string().max(200).optional(),
  byteLength: z.number().nonnegative().optional(),
})
export type MessageAttachment = z.infer<typeof MessageAttachment>

export const PlanStep = z.object({
  step: z.string(),
  status: TodoStatus,
  originalStatus: z.string().optional(),
})
export type PlanStep = z.infer<typeof PlanStep>

/**
 * Event bodies.
 *
 * These are deliberately small and host-agnostic: every adapter is responsible
 * for translating its host's vocabulary into exactly these shapes.
 */
export const EventBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("session.started"),
    source: z.string().optional(),
    title: z.string().optional(),
    model: z.string().optional(),
    cwd: z.string().optional(),
    agentType: z.string().optional(),
  }),
  z.object({
    kind: z.literal("session.title"),
    title: z.string().min(1),
  }),
  z.object({
    kind: z.literal("session.ended"),
    reason: z.string().optional(),
  }),
  z.object({
    kind: z.literal("session.status"),
    status: SessionStatus,
  }),
  z.object({
    kind: z.literal("agent.started"),
    agentType: z.string(),
    /** Host-owned stable id used to address and resume this exact subagent. */
    runtimeId: z.string().optional(),
    /** True only when the host is continuing an existing interrupted run. */
    resumed: z.boolean().optional(),
    parentAgentKey: z.string().optional(),
    model: z.string().optional(),
    modelConfidence: Provenance.optional(),
    prompt: z.string().optional(),
    description: z.string().optional(),
    displayName: z.string().optional(),
  }),
  z.object({
    kind: z.literal("agent.stopped"),
    status: z.enum(["completed", "failed", "interrupted"]),
    summary: z.string().optional(),
    durationMs: z.number().optional(),
    totalTokens: z.number().optional(),
    model: z.string().optional(),
  }),
  z.object({
    kind: z.literal("agent.model"),
    model: z.string(),
    confidence: Provenance.default("authoritative"),
  }),
  z.object({
    kind: z.literal("agent.status"),
    status: AgentStatus,
  }),
  z.object({
    kind: z.literal("message.user"),
    messageKey: z.string(),
    text: z.string(),
    /** Files sent with this turn. Omitted, not empty, when the host names none. */
    attachments: z.array(MessageAttachment).max(50).optional(),
  }),
  z.object({
    kind: z.literal("message.assistant"),
    messageKey: z.string(),
    text: z.string(),
    final: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("message.assistant.delta"),
    messageKey: z.string(),
    delta: z.string(),
    index: z.number().optional(),
    /** Set on the last chunk so the UI can stop showing a streaming cursor. */
    final: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("message.reasoning"),
    messageKey: z.string(),
    text: z.string(),
    final: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("tool.started"),
    callId: z.string(),
    tool: z.string(),
    input: z.unknown().optional(),
    title: z.string().optional(),
  }),
  z.object({
    kind: z.literal("tool.finished"),
    callId: z.string(),
    tool: z.string().optional(),
    ok: z.boolean(),
    output: z.string().optional(),
    error: z.string().optional(),
    durationMs: z.number().optional(),
  }),
  z.object({
    kind: z.literal("todos.updated"),
    todos: z.array(TodoInput),
  }),
  z.object({
    kind: z.literal("goal.updated"),
    objective: z.string(),
    status: z.string().optional(),
    source: z.string().optional(),
  }),
  z.object({
    kind: z.literal("plan.updated"),
    steps: z.array(PlanStep),
    explanation: z.string().optional(),
  }),
  z.object({
    kind: z.literal("prompt.fragment"),
    fragmentKey: z.string(),
    promptKind: PromptKind,
    label: z.string(),
    text: z.string().optional(),
    path: z.string().optional(),
    availability: Availability.default("available"),
    note: z.string().optional(),
  }),
  z.object({
    kind: z.literal("edge.observed"),
    fromAgentKey: z.string(),
    toAgentKey: z.string(),
    edgeType: EdgeType,
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal("session.error"),
    message: z.string(),
    code: z.string().optional(),
  }),
])
export type EventBody = z.infer<typeof EventBody>
export type EventKind = EventBody["kind"]

/** What an adapter sends to the daemon. */
export const IngestEvent = z.object({
  /** Optional client-generated id; used for idempotent replay of the spool. */
  id: z.string().optional(),
  host: HostId,
  hostVersion: z.string().optional(),
  adapter: z.string(),
  workspaceRoot: z.string(),
  sessionKey: z.string(),
  agentKey: z.string().default("main"),
  at: z.number().optional(),
  provenance: Provenance.default("authoritative"),
  body: EventBody,
  raw: z.unknown().optional(),
})
export type IngestEvent = z.infer<typeof IngestEvent>

export const IngestBatch = z.object({
  events: z.array(IngestEvent).min(1).max(500),
})
export type IngestBatch = z.infer<typeof IngestBatch>

/** An event after the daemon has accepted and sequenced it. */
export interface StoredEvent extends Omit<IngestEvent, "id"> {
  id: string
  seq: number
  receivedAt: number
  at: number
}
