import { MAIN_AGENT_KEY } from "@observer-ai/protocol"
import { normalizeTodoStatus } from "@observer-ai/core"
import { type Adapter, type AdapterEvent, type HookRequest, asRecord, pickNumber, pickString, toText } from "./types.js"

/**
 * Codex adapter.
 *
 * Fidelity notes:
 * - Every hook payload includes the active `model` slug, so model attribution
 *   is authoritative.
 * - `Stop` carries `last_assistant_message`, which is the only assistant text
 *   available in hook mode: there is no delta hook.
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

    switch (request.event) {
      case "SessionStart": {
        push({
          kind: "session.started",
          source: pickString(p, "source"),
          model,
          cwd: pickString(p, "cwd"),
        })
        if (model) push({ kind: "agent.model", model, confidence: "authoritative" })
        break
      }

      case "SessionEnd": {
        push({ kind: "session.ended", reason: pickString(p, "reason") })
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
        push({
          kind: "agent.started",
          agentType: pickString(p, "agent_type") ?? "subagent",
          parentAgentKey: MAIN_AGENT_KEY,
          model,
          modelConfidence: "reconciled",
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
            note: "Path reported by Codex; file contents are not captured.",
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

    return out
  },
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
