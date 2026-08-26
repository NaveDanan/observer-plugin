import { readFileSync, statSync } from "node:fs"
import { MAIN_AGENT_KEY } from "@observer-ai/protocol"
import { normalizeTodoStatus } from "@observer-ai/core"
import {
  type Adapter,
  type AdapterEvent,
  type HookRequest,
  asRecord,
  pickNumber,
  pickString,
  shortHash,
  toText,
} from "./types.js"

const MAX_TRANSCRIPT_BYTES = 32_000_000
const MAX_TRANSCRIPT_MESSAGES = 500

interface PendingCollaborationSpawn {
  callId: string
  parentAgentKey: string
  prompt: string | undefined
  taskName: string | undefined
  path: string | undefined
  acknowledged: boolean
  childAgentKey: string | undefined
}

interface CodexCollaborationSession {
  pending: Map<string, PendingCollaborationSpawn>
  order: string[]
  spawnByChild: Map<string, PendingCollaborationSpawn>
  agentByPath: Map<string, string>
  pathByAgent: Map<string, string>
}

/**
 * Joins Codex's collaboration hooks into the graph facts no single hook has.
 *
 * `PreToolUse` names the spawning agent, delegated prompt, and task name.
 * `PostToolUse` returns the canonical `/root/...` address. `SubagentStart`
 * finally supplies the child id, but none of those deliveries repeats all the
 * other fields. The observed hook contract exposes no shared child id across
 * them, so a small per-session creation-order queue reconciles those signals.
 */
class CodexCollaboration {
  private readonly sessions = new Map<string, CodexCollaborationSession>()

  rememberSpawn(sessionKey: string, parentAgentKey: string, payload: Record<string, unknown>): void {
    const callId = pickString(payload, "tool_use_id")
    if (!callId) return
    const input = asRecord(payload["tool_input"])
    const state = this.session(sessionKey)
    const held = state.pending.get(callId)
    const taskName = pickString(input, "task_name", "taskName") ?? held?.taskName
    const path = collaborationPath(taskName, state.pathByAgent.get(parentAgentKey)) ?? held?.path
    const spawn: PendingCollaborationSpawn = {
      callId,
      parentAgentKey,
      prompt: pickString(input, "message", "prompt", "task") ?? held?.prompt,
      taskName,
      path,
      acknowledged: held?.acknowledged ?? false,
      childAgentKey: held?.childAgentKey,
    }
    state.pending.set(callId, spawn)
    if (!held) state.order.push(callId)
    this.trim(state)
  }

  acknowledgeSpawn(sessionKey: string, parentAgentKey: string, payload: Record<string, unknown>): void {
    const callId = pickString(payload, "tool_use_id")
    if (!callId) return
    const state = this.session(sessionKey)
    if (!state.pending.has(callId)) this.rememberSpawn(sessionKey, parentAgentKey, payload)
    const held = state.pending.get(callId)
    if (!held) return
    const response = responseRecord(payload["tool_response"])
    const canonical = pickString(response, "task_name", "taskName", "agent_name", "agentName")
    const path = collaborationPath(canonical, state.pathByAgent.get(held.parentAgentKey)) ?? held.path
    const spawn = { ...held, path, acknowledged: true }
    state.pending.set(callId, spawn)
    if (spawn.childAgentKey) {
      state.spawnByChild.set(spawn.childAgentKey, spawn)
      this.rememberPath(state, spawn.childAgentKey, path)
    }
  }

  start(sessionKey: string, childAgentKey: string): PendingCollaborationSpawn | undefined {
    const state = this.session(sessionKey)
    const existing = state.spawnByChild.get(childAgentKey)
    if (existing) return existing

    const available = state.order
      .map((callId) => state.pending.get(callId))
      .filter((spawn): spawn is PendingCollaborationSpawn => Boolean(spawn && !spawn.childAgentKey))
    const held = available.find((spawn) => spawn.acknowledged) ?? available[0]
    if (!held) return undefined

    const spawn = { ...held, childAgentKey }
    state.pending.set(spawn.callId, spawn)
    state.spawnByChild.set(childAgentKey, spawn)
    this.rememberPath(state, childAgentKey, spawn.path)
    return spawn
  }

  find(sessionKey: string, childAgentKey: string): PendingCollaborationSpawn | undefined {
    return this.session(sessionKey).spawnByChild.get(childAgentKey)
  }

  message(
    sessionKey: string,
    fromAgentKey: string,
    payload: Record<string, unknown>,
  ): Extract<AdapterEvent["body"], { kind: "edge.observed" }> | undefined {
    const input = asRecord(payload["tool_input"])
    const target = pickString(input, "target", "to", "recipient")
    if (!target) return undefined
    const toAgentKey = this.resolveTarget(this.session(sessionKey), target)
    if (!toAgentKey) return undefined
    return {
      kind: "edge.observed",
      fromAgentKey,
      toAgentKey,
      edgeType: "messaged",
      label: "direct message",
    }
  }

  end(sessionKey: string): void {
    this.sessions.delete(sessionKey)
  }

  private session(sessionKey: string): CodexCollaborationSession {
    const held = this.sessions.get(sessionKey)
    if (held) return held
    // A host crash may omit SessionEnd. Bound stale correlation state rather
    // than letting one daemon lifetime grow with every Codex session it sees.
    if (this.sessions.size >= 128) {
      const oldest = this.sessions.keys().next().value
      if (oldest) this.sessions.delete(oldest)
    }
    const state: CodexCollaborationSession = {
      pending: new Map(),
      order: [],
      spawnByChild: new Map(),
      agentByPath: new Map([["/root", MAIN_AGENT_KEY]]),
      pathByAgent: new Map([[MAIN_AGENT_KEY, "/root"]]),
    }
    this.sessions.set(sessionKey, state)
    return state
  }

  private rememberPath(state: CodexCollaborationSession, agentKey: string, path: string | undefined): void {
    if (!path) return
    state.agentByPath.set(path, agentKey)
    state.pathByAgent.set(agentKey, path)
  }

  private resolveTarget(state: CodexCollaborationSession, target: string): string | undefined {
    const exact = state.agentByPath.get(target)
    if (exact) return exact
    const rooted = target.startsWith("/") ? undefined : state.agentByPath.get(`/root/${target}`)
    if (rooted) return rooted
    const suffix = target.startsWith("/") ? target : `/${target}`
    const matches = [...state.agentByPath].filter(([path]) => path.endsWith(suffix))
    return matches.length === 1 ? matches[0]?.[1] : undefined
  }

  private trim(state: CodexCollaborationSession): void {
    while (state.order.length > 128) {
      const callId = state.order.shift()
      if (!callId) break
      const spawn = state.pending.get(callId)
      state.pending.delete(callId)
      if (spawn?.childAgentKey) state.spawnByChild.delete(spawn.childAgentKey)
    }
  }
}

function collaborationPath(taskName: string | undefined, parentPath: string | undefined): string | undefined {
  if (!taskName) return undefined
  if (taskName.startsWith("/")) return taskName.replace(/\/+$/, "")
  return parentPath ? `${parentPath.replace(/\/+$/, "")}/${taskName.replace(/^\/+/, "")}` : undefined
}

function responseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return asRecord(value)
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return {}
  }
}

function normalizedTool(tool: string): string {
  return tool.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function isCollaborationSpawn(tool: string): boolean {
  const normalized = normalizedTool(tool)
  return normalized === "collaborationspawnagent" || normalized === "spawnagent" || normalized === "agent"
}

function isCollaborationMessage(tool: string): boolean {
  return normalizedTool(tool) === "collaborationsendmessage"
}

const collaboration = new CodexCollaboration()

/**
 * Codex adapter.
 *
 * Fidelity notes:
 * - Every hook payload includes the active `model` slug, so model attribution
 *   is authoritative.
 * - `Stop` carries `last_assistant_message`, which is the only assistant text
 *   available in hook mode: there is no delta hook.
 * - A subagent's full user/assistant exchange lives in the JSONL file named by
 *   `agent_transcript_path`; its stop hook otherwise exposes only the last
 *   assistant message.
 * - Subagent hooks report the *parent* `session_id`, so the parent edge is
 *   reconciled to the session's main agent rather than guessed.
 * - Todos come from the `update_plan` tool call.
 */
export const codexAdapter: Adapter = {
  host: "codex",
  adapterId: "codex-hooks@1",
  normalize(request: HookRequest): AdapterEvent[] {
    const p = asRecord(request.payload)
    const sessionKey = pickString(p, "session_id")
    if (!sessionKey) return []

    const agentId = pickString(p, "agent_id")
    const agentKey = agentId ? `agent:${agentId}` : MAIN_AGENT_KEY
    const at = pickNumber(p, "timestamp") ?? Date.now()
    const model = pickString(p, "model")
    const out: AdapterEvent[] = []
    const push = (body: AdapterEvent["body"], overrides: Partial<AdapterEvent> = {}) =>
      out.push({ sessionKey, agentKey, at, body, ...overrides })
    const spawn = agentId
      ? request.event === "SubagentStart"
        ? collaboration.start(sessionKey, agentKey)
        : collaboration.find(sessionKey, agentKey)
      : undefined
    const transcriptPath = agentId
      ? pickString(p, "agent_transcript_path", "transcript_path")
      : pickString(p, "transcript_path")
    const transcriptMessages = readTranscript(transcriptPath, spawn?.prompt)
    const pushTranscript = () => {
      for (const message of transcriptMessages) {
        push(message.body, {
          id: `codex-rollout:${sessionKey}:${agentId}:${message.sourceId}`,
          at: message.at,
          provenance: "reconciled",
        })
      }
    }

    switch (request.event) {
      case "SessionStart": {
        push({
          kind: "session.started",
          source: pickString(p, "source"),
          model,
          cwd: pickString(p, "cwd"),
        })
        if (model) push({ kind: "agent.model", model, confidence: "authoritative" })
        pushTranscript()
        break
      }

      case "SessionEnd": {
        push({ kind: "session.ended", reason: pickString(p, "reason") })
        collaboration.end(sessionKey)
        break
      }

      case "UserPromptSubmit": {
        push({
          kind: "message.user",
          messageKey: `turn:${pickString(p, "turn_id") ?? at}`,
          text: pickString(p, "prompt") ?? "",
        })
        push({ kind: "session.status", status: "active" })
        break
      }

      case "Stop": {
        const text = pickString(p, "last_assistant_message")
        if (text) {
          push({
            kind: "message.assistant",
            messageKey: `turn:${pickString(p, "turn_id") ?? at}:final`,
            text,
            final: true,
          })
        }
        push({ kind: "agent.status", status: "idle" })
        push({ kind: "session.status", status: "idle" })
        break
      }

      case "SubagentStart": {
        push(
          {
            kind: "agent.started",
            runtimeId: agentId,
            agentType: pickString(p, "agent_type") ?? "subagent",
            parentAgentKey: spawn?.parentAgentKey ?? MAIN_AGENT_KEY,
            model,
            modelConfidence: "reconciled",
            prompt: spawn?.prompt,
            displayName: spawn?.path,
          },
          { provenance: "reconciled" },
        )
        pushTranscript()
        break
      }

      case "SubagentStop": {
        const text = pickString(p, "last_assistant_message")
        pushTranscript()
        if (
          text &&
          !transcriptMessages.some(
            (message) => message.body.kind === "message.assistant" && message.body.text === text,
          )
        ) {
          push({ kind: "message.assistant", messageKey: `final:${agentId ?? at}`, text, final: true })
        }
        if (transcriptPath) {
          push({
            kind: "prompt.fragment",
            fragmentKey: "transcript",
            promptKind: "instructions",
            label: "Subagent transcript",
            path: transcriptPath,
            availability: "partial",
            note:
              transcriptMessages.length > 0
                ? "Observer recovered the readable user and assistant messages; Codex's path is retained for provenance."
                : "Path reported by Codex; no readable user or assistant messages were recovered.",
          })
        }
        push({ kind: "agent.stopped", status: "completed", summary: text })
        break
      }

      case "PreToolUse": {
        const tool = pickString(p, "tool_name") ?? "unknown"
        const callId = pickString(p, "tool_use_id") ?? `${tool}:${at}`
        push({ kind: "tool.started", callId, tool, input: p["tool_input"] })
        emitPlan(p, tool, push)
        if (isCollaborationSpawn(tool)) collaboration.rememberSpawn(sessionKey, agentKey, p)
        if (isCollaborationMessage(tool)) {
          const message = collaboration.message(sessionKey, agentKey, p)
          if (message) push(message)
        }
        emitSpawn(p, tool, agentKey, push)
        break
      }

      case "PostToolUse": {
        const tool = pickString(p, "tool_name") ?? "unknown"
        const callId = pickString(p, "tool_use_id") ?? `${tool}:${at}`
        push({
          kind: "tool.finished",
          callId,
          tool,
          ok: true,
          output: toText(p["tool_response"]),
        })
        emitPlan(p, tool, push)
        if (isCollaborationSpawn(tool)) collaboration.acknowledgeSpawn(sessionKey, agentKey, p)
        break
      }

      case "PreCompact": {
        push({ kind: "session.status", status: "active" })
        break
      }

      case "PostCompact": {
        push({ kind: "session.status", status: "active" })
        break
      }

      default:
        break
    }

    // Codex writes subagent response items to its rollout before related tool
    // hooks fire. Reconcile the append-only file whenever a child hook names
    // it, so the Chat tab can update during the run as well as at its end.
    // Stable source ids make previously seen records cheap duplicates.
    if (agentId && request.event !== "SubagentStop" && request.event !== "SubagentStart") pushTranscript()

    return out
  },
}

interface TranscriptMessage {
  sourceId: string
  at: number
  body: Extract<AdapterEvent["body"], { kind: "message.user" | "message.assistant" }>
}

/** Reads user-visible rollout messages, optionally starting at a subagent assignment. */
function readTranscript(path: string | undefined, assignment: string | undefined): TranscriptMessage[] {
  if (!path) return []

  let source: string
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) return []
    source = readFileSync(path, "utf8")
  } catch {
    return []
  }

  const messages: TranscriptMessage[] = []
  for (const line of source.split(/\r?\n/)) {
    if (line.trim().length === 0) continue

    let record: Record<string, unknown>
    try {
      record = asRecord(JSON.parse(line))
    } catch {
      continue
    }
    if (pickString(record, "type") !== "response_item") continue

    const payload = asRecord(record["payload"])
    if (pickString(payload, "type") !== "message") continue
    const role = pickString(payload, "role")
    if (role !== "user" && role !== "assistant") continue

    const text = transcriptText(payload["content"])
    if (text.trim().length === 0) continue
    const sourceId = pickString(payload, "id") ?? shortHash({ role, text, timestamp: record["timestamp"] })
    const messageKey = `rollout:${sourceId}`
    const timestamp = pickNumber(record, "timestamp") ?? Date.now()
    messages.push({
      sourceId,
      at: timestamp,
      body:
        role === "user"
          ? { kind: "message.user", messageKey, text }
          : { kind: "message.assistant", messageKey, text, final: true },
    })
    if (messages.length > MAX_TRANSCRIPT_MESSAGES) messages.shift()
  }
  if (!assignment) return messages
  const expected = assignment.trim()
  const boundary = messages.findLastIndex(
    (message) => message.body.kind === "message.user" && message.body.text.trim() === expected,
  )
  return boundary >= 0 ? messages.slice(boundary) : messages
}

function transcriptText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => pickString(asRecord(part), "text"))
    .filter((text): text is string => text !== undefined)
    .join("\n")
}

/** `update_plan` is Codex's todo list. */
function emitPlan(
  payload: Record<string, unknown>,
  tool: string,
  push: (body: AdapterEvent["body"], overrides?: Partial<AdapterEvent>) => void,
): void {
  if (tool !== "update_plan") return
  const input = asRecord(payload["tool_input"])
  const steps = Array.isArray(input["plan"]) ? (input["plan"] as unknown[]) : []
  if (steps.length === 0) return
  push({
    kind: "plan.updated",
    explanation: pickString(input, "explanation"),
    steps: steps.map((entry) => {
      const step = asRecord(entry)
      const rawStatus = pickString(step, "status")
      return {
        step: pickString(step, "step", "content", "text") ?? "",
        status: normalizeTodoStatus(rawStatus),
        originalStatus: rawStatus,
      }
    }),
  })
}

/** `spawn_agent` carries the delegated instruction before the child reports in. */
function emitSpawn(
  payload: Record<string, unknown>,
  tool: string,
  parentAgentKey: string,
  push: (body: AdapterEvent["body"], overrides?: Partial<AdapterEvent>) => void,
): void {
  if (tool !== "spawn_agent" && tool !== "Agent") return
  const input = asRecord(payload["tool_input"])
  const childId = pickString(input, "agent_id", "id")
  const prompt = pickString(input, "prompt", "input", "task")
  if (!childId) return
  push(
    {
      kind: "agent.started",
      agentType: pickString(input, "agent_type", "role") ?? "subagent",
      parentAgentKey,
      prompt,
      modelConfidence: "reconciled",
    },
    { agentKey: `agent:${childId}`, provenance: "reconciled" },
  )
}
