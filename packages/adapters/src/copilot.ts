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

/** Copilot accepts both camelCase and VS Code compatible PascalCase event names. */
const EVENT_ALIASES: Record<string, string> = {
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  UserPromptSubmit: "userPromptSubmitted",
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  PostToolUseFailure: "postToolUseFailure",
  Stop: "agentStop",
  SubagentStop: "subagentStop",
  ErrorOccurred: "errorOccurred",
  PreCompact: "preCompact",
}

/**
 * GitHub Copilot CLI adapter.
 *
 * Fidelity notes:
 * - No hook exposes the main agent's reply text. Observer recovers it by
 *   tailing `~/.copilot/session-state/<id>/events.jsonl` (see the session
 *   tailer in the daemon), which is why main-agent text is `reconciled`.
 * - **User turns are not drawn from hooks either.** Copilot announces the same
 *   first prompt twice — once as `sessionStart.initialPrompt` and again as
 *   `userPromptSubmitted.prompt`, byte for byte, with two different timestamps
 *   — so a hook-keyed message is duplicated for every session's opening turn.
 *   There is no key both deliveries share, so the fix is not a better key: it
 *   is to stop having two sources. The session log is the one place a user turn
 *   is stated exactly once, and it is also the only place that names the files
 *   attached to it, so the tailer owns user messages for every agent. Hooks
 *   still drive session status, which is what they are good at.
 * - `preToolUse` has no tool call id, so one is synthesised from the tool name
 *   and a hash of its arguments. Repeated identical calls therefore merge.
 * - `subagentStart` reports only `agentName`, so concurrent subagents with the
 *   same name share a node until `subagentStop` supplies a real `agentId`.
 */
export const copilotAdapter: Adapter = {
  host: "copilot",
  adapterId: "copilot-hooks@1",
  normalize(request: HookRequest): AdapterEvent[] {
    const p = asRecord(request.payload)
    const sessionKey = pickString(p, "sessionId", "session_id")
    if (!sessionKey) return []

    const event = EVENT_ALIASES[request.event] ?? request.event
    const at = pickNumber(p, "timestamp") ?? Date.now()
    const out: AdapterEvent[] = []
    const push = (body: AdapterEvent["body"], overrides: Partial<AdapterEvent> = {}) =>
      out.push({ sessionKey, agentKey: MAIN_AGENT_KEY, at, body, ...overrides })

    switch (event) {
      case "sessionStart": {
        push({
          kind: "session.started",
          source: pickString(p, "source"),
          cwd: pickString(p, "cwd"),
        })
        break
      }

      case "sessionEnd": {
        push({ kind: "session.ended", reason: pickString(p, "reason") })
        break
      }

      case "userPromptSubmitted": {
        push({ kind: "session.status", status: "active" })
        break
      }

      case "userPromptTransformed": {
        break
      }

      case "agentStop": {
        push({ kind: "agent.status", status: "idle" })
        push({ kind: "session.status", status: "idle" })
        const transcript = pickString(p, "transcriptPath", "transcript_path")
        if (transcript) {
          push({
            kind: "prompt.fragment",
            fragmentKey: "transcript",
            promptKind: "instructions",
            label: "Session transcript",
            path: transcript,
            availability: "partial",
            note: "Copilot hooks do not expose main-agent reply text; Observer reads it from the session event log.",
          })
        }
        break
      }

      case "subagentStart": {
        const name = pickString(p, "agentName", "agent_name") ?? "subagent"
        const realId = pickString(p, "agentId", "agent_id")
        push(
          {
            kind: "agent.started",
            runtimeId: realId,
            agentType: name,
            displayName: pickString(p, "agentDisplayName", "agent_display_name") ?? name,
            description: pickString(p, "agentDescription", "agent_description"),
            parentAgentKey: MAIN_AGENT_KEY,
          },
          { agentKey: `sub:${name}`, provenance: "reconciled" },
        )
        break
      }

      case "subagentStop": {
        const name = pickString(p, "agentName", "agent_name") ?? "subagent"
        const agentKey = `sub:${name}`
        const text = pickString(p, "response", "last_assistant_message")
        const realId = pickString(p, "agentId", "agent_id")
        if (text) {
          push(
            { kind: "message.assistant", messageKey: `final:${realId ?? at}`, text, final: true },
            { agentKey, provenance: "authoritative" },
          )
        }
        push(
          {
            kind: "agent.started",
            runtimeId: realId,
            agentType: pickString(p, "agentType", "agent_type") ?? name,
            displayName: pickString(p, "agentDisplayName", "agent_display_name") ?? name,
            parentAgentKey: MAIN_AGENT_KEY,
          },
          { agentKey, provenance: "reconciled" },
        )
        push({ kind: "agent.stopped", status: "completed", summary: text }, { agentKey })
        break
      }

      case "preToolUse": {
        const tool = pickString(p, "toolName", "tool_name") ?? "unknown"
        const args = p["toolArgs"] ?? p["tool_input"]
        push({ kind: "tool.started", callId: callIdFor(tool, args), tool, input: args })
        emitTodos(tool, args, push)
        break
      }

      case "postToolUse": {
        const tool = pickString(p, "toolName", "tool_name") ?? "unknown"
        const args = p["toolArgs"] ?? p["tool_input"]
        const result = asRecord(p["toolResult"] ?? p["tool_result"])
        push({
          kind: "tool.finished",
          callId: callIdFor(tool, args),
          tool,
          ok: true,
          output: toText(pickString(result, "textResultForLlm", "text_result_for_llm") ?? result),
        })
        emitTodos(tool, args, push)
        break
      }

      case "postToolUseFailure": {
        const tool = pickString(p, "toolName", "tool_name") ?? "unknown"
        const args = p["toolArgs"] ?? p["tool_input"]
        push({
          kind: "tool.finished",
          callId: callIdFor(tool, args),
          tool,
          ok: false,
          error: pickString(p, "error") ?? "tool failed",
        })
        break
      }

      case "errorOccurred": {
        const error = asRecord(p["error"])
        push({
          kind: "session.error",
          message: pickString(error, "message") ?? pickString(p, "error") ?? "error",
          code: pickString(p, "errorContext", "error_context"),
        })
        break
      }

      default:
        break
    }

    return out
  },
}

function callIdFor(tool: string, args: unknown): string {
  return `${tool}:${shortHash(args)}`
}

function emitTodos(
  tool: string,
  args: unknown,
  push: (body: AdapterEvent["body"], overrides?: Partial<AdapterEvent>) => void,
): void {
  if (tool !== "update_todo" && tool !== "TodoWrite" && tool !== "todo_write") return
  const input = asRecord(args)
  const raw = Array.isArray(input["todos"]) ? (input["todos"] as unknown[]) : []
  if (raw.length === 0) return
  push({
    kind: "todos.updated",
    todos: raw.map((entry) => {
      const todo = asRecord(entry)
      const rawStatus = pickString(todo, "status", "state")
      return {
        content: pickString(todo, "content", "title", "text", "description") ?? "",
        status: normalizeTodoStatus(rawStatus),
        originalStatus: rawStatus,
        priority: pickString(todo, "priority"),
      }
    }),
  })
}
