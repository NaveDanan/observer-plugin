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
 *  - Seats the company roster: offers the employees to the root agent as
 *    subagent staffing, records the seated employee (or `subcontractor` when
 *    nobody fits) as the node type, and appends a persona directive whenever a
 *    subagent is spawned.
 *  - Manual activation: typing `@observer` in a message turns staffing on for
 *    the session (`@observer off` turns it off), overriding `"guidance": false`
 *    in ~/.observer/config.json for that session.
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

/**
 * Renders the roster section appended to the root agent's system prompt.
 *
 * This is the offer: it tells the model subagents are available and names the
 * employees it can staff them with. Declining is legitimate — an unstaffed
 * subagent is recorded as a "subcontractor" rather than given a made-up
 * identity.
 */
function briefingFromProfiles(profiles) {
  if (!Array.isArray(profiles) || profiles.length === 0) return undefined
  const rows = profiles.map((profile) => {
    const strengths = (profile.fields ?? []).slice(0, 4).join(", ")
    return `- ${profile.fullName} — ${profile.title}: strong at ${strengths}.`
  })
  return [
    "## Team roster",
    "You can delegate work to subagents. These employees are available to staff them: pick the teammate whose strengths fit the task and describe the task in their terms, so Observer seats them on the node:",
    ...rows,
    'If no teammate fits a task, delegate anyway without naming one: that subagent is recorded as a "subcontractor".',
  ].join("\n")
}

/**
 * Detects a manual activation mention in the user's message text.
 *
 * "@observer" turns staffing on for the session, "@observer off" turns it
 * back off. Returns "on", "off", or undefined when no mention is present.
 */
function observerMention(text) {
  const match = /(?:^|\s)@observer\b(?:\s+(off|on))?(?=\s|$)/i.exec(text)
  if (!match) return undefined
  return (match[1] ?? "on").toLowerCase()
}

export const ObserverPlugin = async ({ client, directory, worktree }) => {
  const config = readConfig()
  if (!config) return {}

  const endpoint = `http://127.0.0.1:${config.port}/v1/hooks`
  const headers = { "content-type": "application/json", authorization: `Bearer ${config.token}` }
  const workspaceRoot = worktree || directory || process.cwd()

  /**
   * Roster guidance: off with `"guidance": false` in ~/.observer/config.json.
   * Every failure is swallowed — advice Observer fails to give must never
   * break the session it is advising.
   */
  const guidanceEnabled = config.guidance !== false
  let briefing = undefined

  const apiGet = async (path) => {
    const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
      headers: { authorization: `Bearer ${config.token}` },
    })
    if (!response.ok) throw new Error(`${path}: ${response.status}`)
    return response.json()
  }

  const loadBriefing = async () => {
    if (briefing) return briefing
    try {
      const data = await apiGet("/v1/roster")
      briefing = briefingFromProfiles(data.profiles)
    } catch {
      briefing = undefined
    }
    return briefing
  }
  void loadBriefing()

  /**
   * Asks the daemon to seat the best employee on a delegated task. Returns
   * the employee's id plus a ready-to-append persona directive, or undefined
   * when nobody scores above the confidence floor — the caller then records
   * the delegation as a "subcontractor".
   */
  const seatFor = async (task) => {
    const response = await fetch(`http://127.0.0.1:${config.port}/v1/roster/match`, {
      method: "POST",
      headers,
      body: JSON.stringify({ task, limit: 1 }),
    })
    if (!response.ok) return undefined
    const data = await response.json()
    const match = Array.isArray(data.matches) ? data.matches[0] : undefined
    if (!match || match.score < 2) return undefined
    return { id: match.id, directive: match.directive }
  }

  /** sessionID -> { root, agentKey, parentAgentKey } */
  const sessions = new Map()
  /** messageID -> role */
  const roles = new Map()
  /** description -> { prompt, agentType }, used to staff a child session by its task title */
  const pendingTasks = new Map()
  /** sessionID -> whether the user activated staffing with @observer */
  const activated = new Map()

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
          const staffed = info.title ? pendingTasks.get(info.title) : undefined
          if (staffed) pendingTasks.delete(info.title)
          await forward(
            type,
            properties,
            info.id,
            staffed ? { prompt: staffed.prompt, agentType: staffed.agentType } : {},
          )
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
      // Manual activation. The synthetic part reaches the model but not the
      // user-message capture above, which filters synthetic parts out.
      const mention = observerMention(text)
      if (mention && Array.isArray(output?.parts)) {
        activated.set(sessionID, mention !== "off")
        output.parts.push({
          type: "text",
          synthetic: true,
          text:
            mention === "off"
              ? "Observer staffing deactivated (@observer off): run the rest of this session without roster guidance."
              : "Observer staffing activated (@observer): for the rest of this session, delegate work through subagents whenever it helps and staff them with the best-fitting teammate from your team roster.",
        })
      }
    },

    /**
     * Read-only capture of the composed system prompt, then roster guidance:
     * the root agent is briefed on who is on the team so it can pick the
     * right subagent for each task. A manual @observer activation injects
     * the briefing even when guidance is disabled in config.
     */
    async "experimental.chat.system.transform"(input, output) {
      if (!input?.sessionID || !Array.isArray(output?.system)) return
      await forward("observer.system", { system: output.system.slice(0, 12) }, input.sessionID)
      const manual = activated.get(input.sessionID)
      if (guidanceEnabled || manual) {
        const text = await loadBriefing()
        if (text) output.system.push(text)
        if (manual && text) {
          output.system.push(
            "The user activated Observer staffing with @observer: look for chances to delegate to subagents and seat them from the roster.",
          )
        }
      }
    },

    /**
     * Staffs every delegated task. The chosen employee — or "subcontractor"
     * when nobody fits — is recorded so the child node carries the decision
     * as its type, and the prompt gains a persona directive so the subagent
     * knows how to behave before its first token.
     */
    async "tool.execute.before"(input, output) {
      if (!guidanceEnabled && !activated.get(input?.sessionID)) return
      const tool = String(input?.tool ?? "").toLowerCase()
      if (tool !== "task") return
      const args = output?.args
      if (!args || typeof args.prompt !== "string" || args.prompt.length === 0) return
      try {
        // A delegation to the @observer agent is the activation ack, not work:
        // the node keeps its own type instead of wearing an employee persona.
        if (typeof args.subagentType === "string" && args.subagentType.toLowerCase() === "observer") {
          if (typeof args.description === "string" && args.description.length > 0) {
            pendingTasks.set(args.description, { prompt: args.prompt, agentType: "observer" })
          }
          return
        }
        const seat = await seatFor(args.prompt)
        if (typeof args.description === "string" && args.description.length > 0) {
          pendingTasks.set(args.description, {
            prompt: args.prompt,
            agentType: seat ? seat.id : "subcontractor",
          })
        }
        if (seat?.directive) {
          args.prompt = `${args.prompt}\n\n---\nObserver staffing note:\n${seat.directive}`
        }
      } catch {
        // Guidance is best-effort; a down daemon changes nothing.
      }
    },

    async dispose() {
      if (timer) clearTimeout(timer)
      await flush()
    },
  }
}

export default ObserverPlugin
