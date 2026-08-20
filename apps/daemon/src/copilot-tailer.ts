import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { IngestEvent } from "@observer-ai/protocol"
import type { Store } from "@observer-ai/storage"
import type { Pipeline } from "./pipeline.js"

interface TailState {
  offset: number
  partial: string
}

function copilotHome(): string {
  const override = process.env["COPILOT_HOME"]
  return override && override.length > 0 ? override : join(homedir(), ".copilot")
}

/**
 * Recovers Copilot CLI data that its hooks do not expose.
 *
 * Copilot fires no hook containing the main agent's reply text, but the CLI
 * persists a full event log per session. Observer tails that log for sessions
 * it already knows about from hooks, and marks everything it finds as
 * `reconciled` so the UI never presents it as a first-class hook signal.
 *
 * Only main-agent events are ingested: subagent nodes are keyed by name from
 * hooks, and the log's `agentId` cannot be mapped back to them reliably.
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

    const state = this.states.get(sessionKey) ?? { offset: 0, partial: "" }
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
      const event = this.toEvent(trimmed, sessionKey, workspaceRoot)
      if (event) events.push(...event)
    }
    if (events.length === 0) return 0
    return this.pipeline.ingestEvents(events).accepted
  }

  private toEvent(line: string, sessionKey: string, workspaceRoot: string): IngestEvent[] | undefined {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      return undefined
    }
    // Sub-agent originated events carry agentId; skip them (see class docs).
    if (typeof parsed["agentId"] === "string") return undefined
    if (parsed["ephemeral"] === true) return undefined

    const type = typeof parsed["type"] === "string" ? (parsed["type"] as string) : ""
    const data = (parsed["data"] ?? {}) as Record<string, unknown>
    const id = typeof parsed["id"] === "string" ? (parsed["id"] as string) : undefined
    const at = typeof parsed["timestamp"] === "string" ? Date.parse(parsed["timestamp"] as string) : Date.now()
    if (!id) return undefined

    const base = {
      id: `copilot-log:${id}`,
      host: "copilot" as const,
      adapter: "copilot-session-log@1",
      workspaceRoot,
      sessionKey,
      agentKey: "main",
      at: Number.isFinite(at) ? at : Date.now(),
      provenance: "reconciled" as const,
    }

    if (type === "assistant.message") {
      const content = typeof data["content"] === "string" ? (data["content"] as string) : ""
      if (content.trim().length === 0) return undefined
      const messageKey = typeof data["messageId"] === "string" ? (data["messageId"] as string) : id
      return [{ ...base, body: { kind: "message.assistant", messageKey, text: content, final: true } }]
    }

    if (type === "assistant.usage") {
      const model = typeof data["model"] === "string" ? (data["model"] as string) : undefined
      if (!model) return undefined
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
