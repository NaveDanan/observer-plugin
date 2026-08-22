import { MAIN_AGENT_KEY } from "@observer-ai/protocol"
import { normalizeTodoStatus } from "@observer-ai/core"
import { type Adapter, type AdapterEvent, type HookRequest, asRecord, pickNumber, pickString, toText } from "./types.js"

/**
 * OpenCode message part types Observer deliberately draws nothing for.
 *
 * This is the exact complement of the four types `normalize` handles below
 * (`text`, `reasoning`, `tool`, `subtask`); together they cover the whole
 * `Part` union as of OpenCode 1.18.21. The plugin forwards every part it sees,
 * and `step-start` / `step-finish` alone outnumber the drawn types several to
 * one, so without this list routine traffic reads as a fault.
 *
 * A part type in neither list is a genuine gap - OpenCode added something
 * Observer does not yet understand - and must keep counting as `unmapped` so
 * it shows up in `observer doctor`. Only ever add a type here deliberately.
 */
const UNDRAWN_PART_TYPES = new Set([
  "step-start",
  "step-finish",
  "patch",
  "snapshot",
  "file",
  "agent",
  "retry",
  "compaction",
])

/**
 * OpenCode adapter.
 *
 * OpenCode is the highest-fidelity host: the plugin runs in-process with the
 * SDK client, so it can resolve the root session for every child session,
 * label message parts with their role, and forward token-level deltas.
 *
 * Subagents in OpenCode are *child sessions* carrying `parentID`. Observer
 * folds them into a single session graph, one node per child session, which is
 * why the plugin supplies `sessionKey` (root) and `agentKey` in the context.
 */
export const opencodeAdapter: Adapter = {
  host: "opencode",
  adapterId: "opencode-plugin@1",
  ignores(request: HookRequest): boolean {
    // Scoped to the one event that carries parts: an unrelated event that
    // happens to mention `step-start` in its payload is still unmapped.
    if (request.event !== "message.part.updated") return false
    const type = pickString(asRecord(asRecord(request.payload)["part"]), "type")
    return type !== undefined && UNDRAWN_PART_TYPES.has(type)
  },
  normalize(request: HookRequest): AdapterEvent[] {
    const p = asRecord(request.payload)
    const context = asRecord(request.context)
    const sessionKey = pickString(context, "sessionKey")
    if (!sessionKey) return []

    const agentKey = pickString(context, "agentKey") ?? MAIN_AGENT_KEY
    const at = pickNumber(context, "at") ?? Date.now()
    const out: AdapterEvent[] = []
    const push = (body: AdapterEvent["body"], overrides: Partial<AdapterEvent> = {}) =>
      out.push({ sessionKey, agentKey, at, body, ...overrides })

    switch (request.event) {
      case "session.created":
      case "session.updated": {
        const info = asRecord(p["info"])
        const isChild = typeof info["parentID"] === "string" && (info["parentID"] as string).length > 0
        if (isChild) {
          push({
            kind: "agent.started",
            agentType: pickString(context, "agentType") ?? "subagent",
            displayName: pickString(info, "title"),
            description: pickString(info, "title"),
            parentAgentKey: pickString(context, "parentAgentKey") ?? MAIN_AGENT_KEY,
            prompt: pickString(context, "prompt"),
            model: pickString(context, "model"),
            modelConfidence: "authoritative",
          })
        } else {
          push({
            kind: "session.started",
            title: pickString(info, "title"),
            cwd: pickString(info, "directory"),
            model: pickString(context, "model"),
          })
        }
        break
      }

      case "session.idle": {
        push({ kind: "agent.status", status: "idle" })
        if (agentKey === MAIN_AGENT_KEY) push({ kind: "session.status", status: "idle" })
        break
      }

      case "session.deleted": {
        push({ kind: "session.ended", reason: "deleted" })
        break
      }

      case "session.error": {
        const error = asRecord(p["error"])
        push({
          kind: "session.error",
          message: pickString(asRecord(error["data"]), "message") ?? pickString(error, "name") ?? "session error",
        })
        break
      }

      case "message.updated": {
        const info = asRecord(p["info"])
        if (pickString(info, "role") !== "assistant") break
        const model = pickString(info, "modelID")
        const provider = pickString(info, "providerID")
        if (model) {
          push({
            kind: "agent.model",
            model: provider ? `${provider}/${model}` : model,
            confidence: "authoritative",
          })
        }
        const time = asRecord(info["time"])
        push({ kind: "agent.status", status: time["completed"] ? "idle" : "running" })
        break
      }

      case "message.part.updated": {
        const part = asRecord(p["part"])
        const delta = pickString(p, "delta")
        const type = pickString(part, "type")
        const role = pickString(context, "role")
        const messageKey = pickString(part, "messageID") ?? pickString(part, "id") ?? `part:${at}`
        const time = asRecord(part["time"])
        const final = time["end"] !== undefined && time["end"] !== null

        if (type === "text") {
          if (role === "user") {
            push({ kind: "message.user", messageKey, text: pickString(part, "text") ?? "" })
            break
          }
          if (delta) {
            push({ kind: "message.assistant.delta", messageKey, delta, final })
          } else {
            push({ kind: "message.assistant", messageKey, text: pickString(part, "text") ?? "", final })
          }
          break
        }

        if (type === "reasoning") {
          push({ kind: "message.reasoning", messageKey, text: pickString(part, "text") ?? "", final })
          break
        }

        if (type === "tool") {
          const state = asRecord(part["state"])
          const status = pickString(state, "status")
          const callId = pickString(part, "callID") ?? pickString(part, "id") ?? `tool:${at}`
          const tool = pickString(part, "tool") ?? "unknown"
          if (status === "completed") {
            push({ kind: "tool.finished", callId, tool, ok: true, output: toText(state["output"]) })
          } else if (status === "error") {
            push({ kind: "tool.finished", callId, tool, ok: false, error: toText(state["error"]) })
          } else {
            push({ kind: "tool.started", callId, tool, input: state["input"], title: pickString(state, "title") })
          }
          break
        }

        if (type === "subtask") {
          // The delegation prompt is visible on the parent side before the
          // child session exists; the plugin pairs it up by description.
          push({
            kind: "prompt.fragment",
            fragmentKey: `subtask:${pickString(part, "id") ?? at}`,
            promptKind: "delegation",
            label: `Delegated to ${pickString(part, "agent") ?? "subagent"}`,
            text: pickString(part, "prompt"),
            availability: "available",
          })
        }
        break
      }

      case "todo.updated": {
        const todos = Array.isArray(p["todos"]) ? (p["todos"] as unknown[]) : []
        push({
          kind: "todos.updated",
          todos: todos.map((entry) => {
            const todo = asRecord(entry)
            const rawStatus = pickString(todo, "status")
            return {
              content: pickString(todo, "content") ?? "",
              status: normalizeTodoStatus(rawStatus),
              originalStatus: rawStatus,
              priority: pickString(todo, "priority"),
            }
          }),
        })
        break
      }

      // ------------------------------------------------ synthetic plugin events

      case "observer.user-message": {
        push({
          kind: "message.user",
          messageKey: pickString(p, "messageID") ?? `u:${at}`,
          text: pickString(p, "text") ?? "",
        })
        break
      }

      case "observer.system": {
        const parts = Array.isArray(p["system"]) ? (p["system"] as unknown[]) : []
        parts.forEach((entry, index) => {
          const text = typeof entry === "string" ? entry : toText(entry)
          if (!text) return
          push({
            kind: "prompt.fragment",
            fragmentKey: `system:${index}`,
            promptKind: "system",
            label: `System prompt part ${index + 1}`,
            text,
            availability: "available",
          })
        })
        break
      }

      case "observer.agent": {
        const prompt = pickString(p, "prompt")
        if (prompt) {
          push({
            kind: "prompt.fragment",
            fragmentKey: "agent-definition",
            promptKind: "agent-definition",
            label: `Agent definition: ${pickString(p, "name") ?? "agent"}`,
            text: prompt,
            availability: "available",
          })
        }
        const model = pickString(p, "model")
        if (model) push({ kind: "agent.model", model, confidence: "authoritative" })
        break
      }

      case "observer.agent-status": {
        // The plugin's end-of-delegation signal: the parent's `task` call
        // finished, which is proof the host need not restate as a child
        // `session.idle`. Anything outside the contract stays unmapped so a
        // drifted payload shows up rather than being silently drawn.
        const status = pickString(p, "status")
        if (status === "completed" || status === "failed") {
          push({ kind: "agent.status", status })
        }
        break
      }

      default:
        break
    }

    return out
  },
}
