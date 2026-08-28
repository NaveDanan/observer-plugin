import { createHash } from "node:crypto"
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { IngestEvent, MessageAttachment } from "@observer-ai/protocol"
import type { Store } from "@observer-ai/storage"
import type { Pipeline } from "./pipeline.js"

interface TailState {
  offset: number
  partial: string
  /**
   * `agentId` -> the `sub:<name>` key the hook adapter files that subagent
   * under. Built from `subagent.started`, which is the only log entry that
   * states both. Rebuilt from byte zero whenever the file is re-read, so a
   * daemon restart mid-session recovers the whole mapping rather than
   * orphaning every subagent line after the restart point.
   */
  agentKeys: Map<string, string>
}

function copilotHome(): string {
  const override = process.env["COPILOT_HOME"]
  return override && override.length > 0 ? override : join(homedir(), ".copilot")
}

/**
 * Recovers Copilot CLI data that its hooks do not expose.
 *
 * Copilot fires no hook containing message text — not the main agent's replies,
 * and not the user's own turns in a form that can be counted once (see the
 * adapter's fidelity notes). The CLI does persist a full event log per session.
 * Observer tails that log for sessions it already knows about from hooks, and
 * marks everything it finds as `reconciled` so the UI never presents it as a
 * first-class hook signal.
 *
 * Subagent lines carry an `agentId`, which `subagent.started` ties to the
 * `agentName` the hooks key their node by. Holding that mapping is what lets a
 * subagent's own transcript — its delegation prompt, the files handed to it,
 * and its replies — land on the node the canvas already draws, instead of being
 * dropped for want of an identity.
 */
export class CopilotTailer {
  private readonly states = new Map<string, TailState>()
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly store: Store,
    private readonly pipeline: Pipeline,
    private readonly intervalMs = 1_000,
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      try {
        this.tick()
      } catch {
        // Tailing is best effort; never take the daemon down for it.
      }
    }, this.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Exposed for tests and for a one-shot catch-up at startup. */
  tick(): number {
    const sessions = this.store.listSessions({ host: "copilot", limit: 25 })
    let ingested = 0
    for (const session of sessions) {
      if (session.status === "ended") continue
      ingested += this.tailSession(session.sessionKey, session.workspaceRoot)
    }
    return ingested
  }

  private tailSession(sessionKey: string, workspaceRoot: string): number {
    const path = join(copilotHome(), "session-state", sessionKey, "events.jsonl")
    if (!existsSync(path)) return 0

    const state = this.states.get(sessionKey) ?? { offset: 0, partial: "", agentKeys: new Map<string, string>() }
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return 0
    }
    // A shrinking file means the session was reset; start over.
    if (size < state.offset) {
      state.offset = 0
      state.partial = ""
      state.agentKeys.clear()
    }
    if (size === state.offset) {
      this.states.set(sessionKey, state)
      return 0
    }

    const length = Math.min(size - state.offset, 4_000_000)
    const buffer = Buffer.allocUnsafe(length)
    let read = 0
    const fd = openSync(path, "r")
    try {
      read = readSync(fd, buffer, 0, length, state.offset)
    } finally {
      closeSync(fd)
    }
    state.offset += read

    const text = state.partial + buffer.subarray(0, read).toString("utf8")
    const lines = text.split("\n")
    state.partial = lines.pop() ?? ""
    this.states.set(sessionKey, state)

    const events: IngestEvent[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      const event = this.toEvent(trimmed, sessionKey, workspaceRoot, state)
      if (event) events.push(...event)
    }
    if (events.length === 0) return 0
    return this.pipeline.ingestEvents(events).accepted
  }

  private toEvent(
    line: string,
    sessionKey: string,
    workspaceRoot: string,
    state: TailState,
  ): IngestEvent[] | undefined {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      return undefined
    }
    if (parsed["ephemeral"] === true) return undefined

    const type = typeof parsed["type"] === "string" ? (parsed["type"] as string) : ""
    const data = (parsed["data"] ?? {}) as Record<string, unknown>
    const id = typeof parsed["id"] === "string" ? (parsed["id"] as string) : undefined
    const at = typeof parsed["timestamp"] === "string" ? Date.parse(parsed["timestamp"] as string) : Date.now()
    const agentId = typeof parsed["agentId"] === "string" ? (parsed["agentId"] as string) : undefined

    // `subagent.started` is the only line that ties an agentId to the name the
    // hooks key the node by, so it is learned before anything is filtered on it.
    if (type === "subagent.started" && agentId) {
      const name = typeof data["agentName"] === "string" ? (data["agentName"] as string) : undefined
      if (!name) return undefined
      const agentKey = `sub:${name}`
      state.agentKeys.set(agentId, agentKey)
      return [
        {
          id: `copilot-log:${id ?? `subagent:${agentId}`}`,
          host: "copilot",
          adapter: "copilot-session-log@1",
          workspaceRoot,
          sessionKey,
          agentKey,
          at: Number.isFinite(at) ? at : Date.now(),
          provenance: "reconciled",
          body: {
            kind: "agent.started",
            runtimeId: agentId,
            agentType: name,
            parentAgentKey: "main",
          },
        },
      ]
    }

    if (!id) return undefined

    // A subagent line whose id was never introduced belongs to an agent
    // Observer cannot name. Guessing a node for it would put one agent's words
    // in another's mouth, so it is dropped.
    const agentKey = agentId === undefined ? "main" : state.agentKeys.get(agentId)
    if (!agentKey) return undefined

    const base = {
      id: `copilot-log:${id}`,
      host: "copilot" as const,
      adapter: "copilot-session-log@1",
      workspaceRoot,
      sessionKey,
      agentKey,
      at: Number.isFinite(at) ? at : Date.now(),
      provenance: "reconciled" as const,
    }

    if (type === "assistant.message") {
      const content = typeof data["content"] === "string" ? (data["content"] as string) : ""
      if (content.trim().length === 0) return undefined
      const messageKey = typeof data["messageId"] === "string" ? (data["messageId"] as string) : id
      return [{ ...base, body: { kind: "message.assistant", messageKey, text: content, final: true } }]
    }

    /**
     * The user's own turn, and the files that came with it.
     *
     * `content` and not `transformedContent`: the transformed form is what the
     * model was handed, complete with injected reminders and environment
     * blocks, and reading it back is how a two-line question turns into a wall
     * of machine text in the transcript. What the human typed is the honest
     * answer to "what was said here".
     */
    if (type === "user.message") {
      const content =
        typeof data["content"] === "string"
          ? (data["content"] as string)
          : typeof data["transformedContent"] === "string"
            ? (data["transformedContent"] as string)
            : ""
      const attachments = attachmentsFrom(data["attachments"])
      if (content.trim().length === 0 && attachments.length === 0) return undefined
      return [
        {
          ...base,
          body: {
            kind: "message.user",
            messageKey: id,
            text: content,
            ...(attachments.length > 0 ? { attachments } : {}),
          },
        },
      ]
    }

    // The model, in the three places Copilot states it. Older builds emitted
    // `assistant.usage` per turn; 1.0.x dropped it and instead names the model
    // once at session start or resume, then again whenever the user switches
    // with `/model`. Reading only the first of those is why a current Copilot
    // session showed no model at all.
    const model = modelFor(type, data)
    if (model !== undefined) {
      return [{ ...base, body: { kind: "agent.model", model, confidence: "reconciled" } }]
    }

    if (type === "session.task_complete") {
      const summary = typeof data["summary"] === "string" ? (data["summary"] as string) : undefined
      if (!summary) return undefined
      return [{ ...base, body: { kind: "goal.updated", objective: summary, source: "task_complete" } }]
    }

    return undefined
  }
}

/**
 * Copilot's attachment list, as message attachments.
 *
 * Only entries naming a real file are kept, and the id is a digest of that path
 * so re-reading the log from byte zero after a restart re-mints the same id
 * rather than a second copy of the same screenshot.
 */
function attachmentsFrom(value: unknown): MessageAttachment[] {
  if (!Array.isArray(value)) return []
  const out: MessageAttachment[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    const path = typeof record["path"] === "string" ? record["path"] : undefined
    if (!path) continue
    const name = typeof record["displayName"] === "string" ? record["displayName"] : path
    const mimeType = typeof record["mimeType"] === "string" ? record["mimeType"] : undefined
    const byteLength = typeof record["byteLength"] === "number" ? record["byteLength"] : undefined
    out.push({
      id: createHash("sha1").update(path).digest("hex").slice(0, 32),
      name,
      path,
      ...(mimeType ? { mimeType } : {}),
      ...(byteLength !== undefined ? { byteLength } : {}),
    })
    if (out.length >= 50) break
  }
  return out
}

/**
 * The model named by one session-log event, if it names one.
 *
 * Kept separate from `toEvent` because "which events state the model" is a fact
 * about Copilot's log format that changes with the CLI, and all four spellings
 * have to stay readable side by side: a machine can be running an old Copilot
 * and a new one against the same daemon, so none of these is safe to drop.
 */
function modelFor(type: string, data: Record<string, unknown>): string | undefined {
  const field =
    type === "assistant.usage"
      ? "model" // Copilot <= 0.x: stated per turn.
      : type === "session.start" || type === "session.resume"
        ? "selectedModel"
        : type === "session.model_change"
          ? "newModel"
          : undefined
  if (field === undefined) return undefined
  const value = data[field]
  if (typeof value !== "string") return undefined
  const model = value.trim()
  return model.length > 0 ? model : undefined
}
