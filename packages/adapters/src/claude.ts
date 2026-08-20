import { MAIN_AGENT_KEY } from "@observer-ai/protocol"
import { normalizeTodoStatus } from "@observer-ai/core"
import { type Adapter, type AdapterEvent, type HookRequest, asRecord, pickNumber, pickString, toText } from "./types.js"

/**
 * Claude Code adapter.
 *
 * Fidelity notes that shaped this mapping:
 * - `MessageDisplay` is the only live text signal and delivers completed lines.
 *   `Stop` therefore does *not* also emit a message, which would duplicate it.
 * - `SubagentStart` carries no parent id. The edge is recovered from the
 *   `Agent` tool call's `PostToolUse`, which returns `tool_response.agentId`.
 * - The built-in system prompt is not exposed; `InstructionsLoaded` gives file
 *   paths only, recorded as `partial`.
 */
export const claudeAdapter: Adapter = {
  host: "claude",
  adapterId: "claude-hooks@1",
  normalize(request: HookRequest): AdapterEvent[] {
    const p = asRecord(request.payload)
    const sessionKey = pickString(p, "session_id")
    if (!sessionKey) return []

    const agentId = pickString(p, "agent_id")
    const agentKey = agentId ? `agent:${agentId}` : MAIN_AGENT_KEY
    const at = pickNumber(p, "timestamp") ?? Date.now()
    const out: AdapterEvent[] = []
    const push = (body: AdapterEvent["body"], overrides: Partial<AdapterEvent> = {}) =>
      out.push({ sessionKey, agentKey, at, body, ...overrides })

    switch (request.event) {
      case "SessionStart": {
        push({
          kind: "session.started",
          source: pickString(p, "source"),
          title: pickString(p, "session_title"),
          model: pickString(p, "model"),
          cwd: pickString(p, "cwd"),
          agentType: pickString(p, "agent_type"),
        })
        break
      }

      case "SessionEnd": {
        push({ kind: "session.ended", reason: pickString(p, "reason") })
        break
      }

      case "UserPromptSubmit": {
        const text = pickString(p, "prompt") ?? ""
        push({ kind: "message.user", messageKey: pickString(p, "prompt_id") ?? `u:${at}`, text })
        push({ kind: "session.status", status: "active" })
        break
      }

      case "UserPromptExpansion": {
        const command = pickString(p, "command_name")
        if (command) {
          push({
            kind: "message.user",
            messageKey: `cmd:${pickString(p, "prompt_id") ?? at}`,
            text: `/${command} ${pickString(p, "command_args") ?? ""}`.trim(),
          })
        }
        break
      }

      case "MessageDisplay": {
        const messageKey = pickString(p, "message_id") ?? `turn:${pickString(p, "turn_id") ?? at}`
        const delta = typeof p["delta"] === "string" ? (p["delta"] as string) : ""
        const final = p["final"] === true
        push({
          kind: "message.assistant.delta",
          messageKey,
          delta,
          index: pickNumber(p, "index"),
          final,
        })
        break
      }

      case "Stop": {
        // Text already arrived through MessageDisplay; only the state changes.
        push({ kind: "agent.status", status: "idle" })
        push({ kind: "session.status", status: "idle" })
        break
      }

      case "StopFailure": {
        push({ kind: "session.error", message: pickString(p, "error") ?? "turn failed", code: pickString(p, "error") })
        break
      }

      case "SubagentStart": {
        push({
          kind: "agent.started",
          agentType: pickString(p, "agent_type") ?? "subagent",
          displayName: pickString(p, "agent_type"),
        })
        break
      }

      case "SubagentStop": {
        const text = pickString(p, "last_assistant_message")
        if (text) {
          push({ kind: "message.assistant", messageKey: `final:${agentId ?? at}`, text, final: true })
        }
        const transcript = pickString(p, "agent_transcript_path")
        if (transcript) {
          push({
            kind: "prompt.fragment",
            fragmentKey: "transcript",
            promptKind: "instructions",
            label: "Subagent transcript",
            path: transcript,
            availability: "partial",
            note: "Path reported by Claude Code; file contents are not captured.",
          })
        }
        push({ kind: "agent.stopped", status: "completed", summary: text })
        break
      }

      case "PreToolUse": {
        const tool = pickString(p, "tool_name") ?? "unknown"
        const callId = pickString(p, "tool_use_id") ?? `${tool}:${at}`
        push({ kind: "tool.started", callId, tool, input: p["tool_input"] })
        emitTodoWrite(p, tool, push)
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
          durationMs: pickNumber(p, "duration_ms"),
        })
        emitTodoWrite(p, tool, push)
        emitAgentSpawn(p, tool, agentKey, push)
        break
      }

      case "PostToolUseFailure": {
        const tool = pickString(p, "tool_name") ?? "unknown"
        const callId = pickString(p, "tool_use_id") ?? `${tool}:${at}`
        push({
          kind: "tool.finished",
          callId,
          tool,
          ok: false,
          error: pickString(p, "error") ?? "tool failed",
          durationMs: pickNumber(p, "duration_ms"),
        })
        break
      }

      case "InstructionsLoaded": {
        const path = pickString(p, "file_path")
        if (path) {
          push({
            kind: "prompt.fragment",
            fragmentKey: `instructions:${path}`,
            promptKind: "instructions",
            label: `${pickString(p, "memory_type") ?? "Instructions"}: ${basename(path)}`,
            path,
            availability: "partial",
            note: `Loaded because: ${pickString(p, "load_reason") ?? "unknown"}. Contents are not captured.`,
          })
        }
        break
      }

      default:
        break
    }

    return out
  },
}

function emitTodoWrite(
  payload: Record<string, unknown>,
  tool: string,
  push: (body: AdapterEvent["body"], overrides?: Partial<AdapterEvent>) => void,
): void {
  if (tool !== "TodoWrite") return
  const input = asRecord(payload["tool_input"])
  const todos = Array.isArray(input["todos"]) ? (input["todos"] as unknown[]) : []
  if (todos.length === 0) return
  push({
    kind: "todos.updated",
    todos: todos.map((entry) => {
      const todo = asRecord(entry)
      const rawStatus = pickString(todo, "status")
      return {
        content: pickString(todo, "content", "activeForm", "text") ?? "",
        status: normalizeTodoStatus(rawStatus),
        originalStatus: rawStatus,
        priority: pickString(todo, "priority"),
      }
    }),
  })
}

/**
 * Recovers the parent -> child edge for a delegated subagent.
 *
 * `SubagentStart` does not report who spawned it, so the link is only knowable
 * once the `Agent` tool call returns an `agentId`.
 */
function emitAgentSpawn(
  payload: Record<string, unknown>,
  tool: string,
  parentAgentKey: string,
  push: (body: AdapterEvent["body"], overrides?: Partial<AdapterEvent>) => void,
): void {
  if (tool !== "Agent" && tool !== "Task") return
  const response = asRecord(payload["tool_response"])
  const childId = pickString(response, "agentId")
  if (!childId) return
  const input = asRecord(payload["tool_input"])
  push(
    {
      kind: "agent.started",
      agentType: pickString(input, "subagent_type") ?? "subagent",
      parentAgentKey,
      prompt: pickString(input, "prompt"),
      description: pickString(input, "description"),
      model: pickString(response, "resolvedModel") ?? pickString(input, "model"),
      modelConfidence: "reconciled",
    },
    { agentKey: `agent:${childId}`, provenance: "reconciled" },
  )
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}
