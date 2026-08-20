/**
 * Observer plugin for OpenCode.
 *
 * Installed to `~/.config/opencode/plugin/observer.js` by `observer install opencode`.
 *
 * Deliberately dependency-free plain JavaScript so it can be copied verbatim
 * into a user's config directory and loaded by any OpenCode version.
 *
 * Responsibilities beyond a plain hook forwarder:
 *  - Folds OpenCode's *child sessions* (how subagents are represented) into a
 *    single Observer session graph by resolving each session's root.
 *  - Labels message parts with their role so user text is not misfiled as
 *    assistant output.
 *  - Coalesces token deltas and batches deliveries, so a fast stream costs a
 *    few requests per second instead of one per token.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const FLUSH_INTERVAL_MS = 120
const MAX_BATCH = 200

function dataDir() {
  const override = process.env.OBSERVER_HOME
  return override && override.length > 0 ? override : join(homedir(), ".observer")
}

function readConfig() {
  try {
    const raw = readFileSync(join(dataDir(), "config.json"), "utf8")
    const parsed = JSON.parse(raw)
    if (typeof parsed.port === "number" && typeof parsed.token === "string") return parsed
  } catch {
    // Observer is optional; if it is not set up the plugin stays dormant.
  }
  return undefined
}

export const ObserverPlugin = async ({ client, directory, worktree }) => {
  const config = readConfig()
  if (!config) return {}

  const endpoint = `http://127.0.0.1:${config.port}/v1/hooks`
  const headers = { "content-type": "application/json", authorization: `Bearer ${config.token}` }
  const workspaceRoot = worktree || directory || process.cwd()

  /** sessionID -> { root, agentKey, parentAgentKey } */
  const sessions = new Map()
  /** messageID -> role */
  const roles = new Map()
  /** description -> delegation prompt, used to attach a task prompt to its child session */
  const pendingTasks = new Map()

  let queue = []
  let timer = undefined
  let sequence = 0

  const flush = async () => {
    timer = undefined
    if (queue.length === 0) return
    const deliveries = queue.slice(0, MAX_BATCH)
    queue = queue.slice(deliveries.length)
    try {
      await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ deliveries }) })
    } catch {
      // Dropping telemetry is always preferable to disturbing the session.
    }
    if (queue.length > 0) schedule()
  }

  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      void flush()
    }, FLUSH_INTERVAL_MS)
    if (typeof timer.unref === "function") timer.unref()
  }

  const send = (event, payload, context) => {
    sequence++
    queue.push({
      host: "opencode",
      event,
      payload,
      deliveryId: `oc-${Date.now()}-${sequence}`,
      workspaceRoot,
      context: { at: Date.now(), ...context },
    })
    if (queue.length >= MAX_BATCH) void flush()
    else schedule()
  }

  /** Resolves which Observer session and agent node a raw OpenCode session maps to. */
  const resolve = async (sessionID) => {
    if (!sessionID) return undefined
    const cached = sessions.get(sessionID)
    if (cached) return cached
    let info
    try {
      const response = await client.session.get({ path: { id: sessionID } })
      info = response?.data ?? response
    } catch {
      info = undefined
    }
    const parentID = info && typeof info.parentID === "string" ? info.parentID : undefined
    let entry
    if (parentID) {
      const parent = await resolve(parentID)
      entry = {
        root: parent ? parent.root : parentID,
        agentKey: `session:${sessionID}`,
        parentAgentKey: parent ? parent.agentKey : "main",
      }
    } else {
      entry = { root: sessionID, agentKey: "main", parentAgentKey: undefined }
    }
    sessions.set(sessionID, entry)
    return entry
  }

  const forward = async (event, payload, sessionID, extra = {}) => {
    const target = await resolve(sessionID)
    if (!target) return
    send(event, payload, {
      sessionKey: target.root,
      agentKey: target.agentKey,
      parentAgentKey: target.parentAgentKey,
      ...extra,
    })
  }

  return {
    async event({ event }) {
      const type = event?.type
      const properties = event?.properties ?? {}

      switch (type) {
        case "session.created":
        case "session.updated": {
          const info = properties.info
          if (!info?.id) return
          // Register before forwarding so the child resolves against its parent.
          if (typeof info.parentID === "string" && info.parentID.length > 0) {
            const parent = await resolve(info.parentID)
            sessions.set(info.id, {
              root: parent ? parent.root : info.parentID,
              agentKey: `session:${info.id}`,
              parentAgentKey: parent ? parent.agentKey : "main",
            })
          } else if (!sessions.has(info.id)) {
            sessions.set(info.id, { root: info.id, agentKey: "main", parentAgentKey: undefined })
          }
          const prompt = info.title ? pendingTasks.get(info.title) : undefined
          if (prompt) pendingTasks.delete(info.title)
          await forward(type, properties, info.id, prompt ? { prompt } : {})
          return
        }

        case "session.idle":
        case "session.deleted":
        case "session.error": {
          await forward(type, properties, properties.sessionID ?? properties.info?.id)
          return
        }

        case "message.updated": {
          const info = properties.info
          if (!info?.id) return
          roles.set(info.id, info.role)
          if (info.role !== "assistant") return
          await forward(type, properties, info.sessionID)
          return
        }

        case "message.removed": {
          roles.delete(properties.messageID)
          return
        }

        case "message.part.updated": {
          const part = properties.part
          if (!part?.sessionID) return
          const role = roles.get(part.messageID)
          // Text with an unknown role is skipped: user text already arrives
          // through the chat.message hook and must not be duplicated.
          if (part.type === "text" && !role) return
          if (part.type === "text" && role === "user") return
          if (part.type === "tool" && part.state?.input?.description && part.state?.input?.prompt) {
            pendingTasks.set(part.state.input.description, part.state.input.prompt)
          }
          await forward(type, properties, part.sessionID, { role })
          return
        }

        case "todo.updated": {
          await forward(type, properties, properties.sessionID)
          return
        }

        default:
          return
      }
    },

    async "chat.message"(input, output) {
      const sessionID = input?.sessionID ?? output?.message?.sessionID
      if (!sessionID) return
      const text = (output?.parts ?? [])
        .filter((part) => part.type === "text" && !part.synthetic)
        .map((part) => part.text)
        .join("\n")
        .trim()
      if (text.length === 0) return
      const messageID = output?.message?.id
      if (messageID) roles.set(messageID, "user")
      await forward("observer.user-message", { messageID, text, agent: input?.agent }, sessionID)
      if (input?.model) {
        await forward(
          "observer.agent",
          { name: input.agent, model: `${input.model.providerID}/${input.model.modelID}` },
          sessionID,
        )
      }
    },

    /**
     * Read-only capture of the composed system prompt.
     * The output object is never modified, so agent behaviour is unchanged.
     */
    async "experimental.chat.system.transform"(input, output) {
      if (!input?.sessionID || !Array.isArray(output?.system)) return
      await forward("observer.system", { system: output.system.slice(0, 12) }, input.sessionID)
    },

    async dispose() {
      if (timer) clearTimeout(timer)
      await flush()
    },
  }
}

export default ObserverPlugin
