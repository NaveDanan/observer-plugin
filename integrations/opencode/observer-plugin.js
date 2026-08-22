/**
 * Observer plugin for OpenCode.
 *
 * Installed to `~/.config/opencode/plugins/observer.js` by `observer install opencode`.
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
 *    subagent is spawned. The seating decision is made on the parent side, at
 *    `tool.execute.before`, and joined to the child session the task spawns by
 *    the task description — which the host then decorates into the session
 *    title, so the join has to normalise before it compares.
 *  - Manual activation: typing `@observer` in a message turns staffing on for
 *    the session (`@observer off` turns it off), overriding the `"guidance"`
 *    setting in ~/.observer/config.json for that session in either direction.
 *    The activation is carried into the model through the system prompt, never
 *    by adding message parts: the host builds and identifies its own parts
 *    before plugins are called, so a part a plugin appends has no id and fails
 *    the host's save-time schema check, which aborts the whole turn.
 *  - Seat control (`"seats": { "control": true }`, off by default): points a
 *    seated delegation at the hidden per-employee agent definition the
 *    installer generated, so the employee runs on the model and reasoning
 *    effort the user assigned. This is the only thing the plugin does that
 *    changes what the host runs rather than what it is told, and it is the
 *    only thing that can fail a delegation, so it never rewrites
 *    `subagent_type` without first confirming the target exists — and it only
 *    ever replaces a `subagent_type` in `NEUTRAL_AGENT_TYPES`, because every
 *    other agent carries a prompt or a tool restriction that is not Observer's
 *    to discard.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const FLUSH_INTERVAL_MS = 120
const MAX_BATCH = 200

/** Delegations waiting for their child session. Bounded so a missed join cannot leak. */
const MAX_PENDING_TASKS = 256
const PENDING_TASK_TTL_MS = 15 * 60 * 1000
/** Child sessions whose staffing decision we still need to re-send on updates. */
const MAX_STAFFED_SESSIONS = 512
/** A session we could not identify is re-checked rather than assumed to be a root forever. */
const UNKNOWN_SESSION_RETRY_MS = 5000
/** Guards the parent walk against a malformed parentID chain. */
const MAX_SESSION_DEPTH = 32

/**
 * How long the host's agent list is trusted before it is asked again.
 *
 * OpenCode globs its agent directory once, at startup, and does not rescan —
 * a definition written mid-session is invisible until the host restarts. So
 * this is really a one-shot lookup, and the TTL exists for two narrower
 * reasons: it collapses a burst of parallel delegations into a single loopback
 * request, and it stops an answer taken before the host finished registering
 * its agents from being believed for the rest of the session.
 */
const AGENT_LIST_TTL_MS = 30 * 1000

const MAIN_AGENT_KEY = "main"

/**
 * The `subagent_type` values seat control is allowed to replace.
 *
 * `subagent_type` does not select a model. It selects a whole agent definition
 * — prompt, tool permissions, mode, everything — so substituting Observer's
 * generated seat agent for it discards whatever the named agent was for.
 * `general` is the only built-in that carries no prompt and no tool
 * restriction, which makes the swap genuinely lossless: it changes the model
 * and nothing else. Every other agent, built-in or user-written, encodes
 * intent Observer did not author. `explore` is the case that decides this:
 * it ships a specialised prompt *and* a deny-by-default permission set that
 * allows only reads and searches, and silently
 * trading a read-only guarantee for a model preference is not a trade Observer
 * gets to make on the user's behalf.
 *
 * A delegation to anything else is therefore left alone, exactly as if the
 * generated agent were missing. If OpenCode ever ships another agent with no
 * prompt and no tool restriction, adding it here is the whole change.
 *
 * **This list is duplicated as `NEUTRAL_AGENT_TYPES` in
 * `packages/cli/src/seat-agents.ts`**, which describes the rule to the user in
 * the installer's notes. The plugin is dependency-free plain JavaScript copied
 * verbatim into the user's config directory, so it cannot import the original.
 * Change one, change both.
 */
const NEUTRAL_AGENT_TYPES = new Set(["general"])

/**
 * OpenCode names a child session after the delegation that spawned it and then
 * decorates it, e.g. `Audit the build (@general subagent)`. The plugin stores
 * delegations under the raw `description`, so the suffix has to come off before
 * the two can be joined.
 */
const SUBAGENT_TITLE_SUFFIX = /\s*\(\s*@?[\w.\-]+\s+subagent\s*\)\s*$/i

/**
 * The OpenCode agent name for an employee's generated definition.
 *
 * **This is a copy of `seatAgentName` in `packages/cli/src/seat-agents.ts`**,
 * which is what writes the files this looks up. The plugin is dependency-free
 * plain JavaScript copied verbatim into the user's config directory, so it
 * cannot import the original. The two must agree exactly: if they drift, the
 * installer writes `observer-a` and the plugin asks for `observer-b`, the
 * lookup misses, and seat control silently stops working. Change one, change
 * both.
 *
 * The character class is a strict subset of the `[\w.\-]` that
 * SUBAGENT_TITLE_SUFFIX accepts, so a generated name never breaks the join
 * between a child session and its delegation.
 */
function seatAgentName(employeeId) {
  const slug = String(employeeId)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `observer-${slug.length > 0 ? slug : "unknown"}`
}

/**
 * Normalises a description or a session title into a join key: whitespace
 * collapsed, case folded. Returns undefined for anything unusable, so an empty
 * title can never claim a delegation.
 */
function taskKey(value) {
  if (typeof value !== "string") return undefined
  const normalized = value.replace(/\s+/g, " ").trim().toLowerCase()
  return normalized.length > 0 ? normalized : undefined
}

/**
 * The keys a child session title may be filed under, most specific first.
 * Exact-after-normalisation only: a substring scan would mis-seat two
 * delegations that share a prefix.
 */
function titleKeys(title) {
  const keys = []
  const add = (value) => {
    const key = taskKey(value)
    if (key && !keys.includes(key)) keys.push(key)
  }
  add(title)
  if (typeof title === "string") add(title.replace(SUBAGENT_TITLE_SUFFIX, ""))
  return keys
}

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
 *
 * The trailing boundary is "not a word character" rather than "whitespace or
 * end": people punctuate. Requiring whitespace made "@observer off, thanks"
 * backtrack past the "off" and activate — the opposite of what was asked.
 */
function observerMention(text) {
  const match = /(?:^|\s)@observer\b(?:\s+(off|on))?(?![\w-])/i.exec(text)
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

  /**
   * Seat control: whether Observer may point a delegation at the generated
   * agent that carries an employee's model and reasoning effort.
   *
   * Off unless the user says otherwise, because rewriting `subagent_type`
   * changes what they are billed for, changes which agent name the permission
   * prompt names, and — if the target does not exist — fails the delegation
   * outright with "Unknown agent type". Read once at startup, like `guidance`:
   * the generated agent files only load when OpenCode starts, so a config read
   * later in the session could only disagree with what the host has loaded.
   */
  const seatControl = config.seats?.control === true
  const seatSpecs = (config.seats && config.seats.employees) || {}

  /**
   * Names of the agents the host currently knows, or undefined when we could
   * not find out.
   *
   * The host is asked rather than the filesystem, deliberately. The task tool
   * fails a delegation when its own agent registry has no entry for
   * `subagent_type`, and `/agent` is that same registry — a file on disk that
   * the host has not loaded would pass a filesystem check and still fail the
   * task. Only the host's answer is evidence.
   */
  let agentNames = undefined
  let agentNamesAt = 0
  let agentNamesInFlight = undefined

  const knownAgents = async () => {
    if (agentNames && Date.now() - agentNamesAt < AGENT_LIST_TTL_MS) return agentNames
    if (agentNamesInFlight) return agentNamesInFlight
    agentNamesInFlight = (async () => {
      try {
        const response = await client.app.agents()
        const list = response?.data ?? response
        if (!Array.isArray(list)) return undefined
        agentNames = new Set(list.map((agent) => agent?.name).filter((name) => typeof name === "string"))
        agentNamesAt = Date.now()
        return agentNames
      } catch {
        // A failed lookup is never cached as "no agents": that would turn one
        // unlucky request into a session-long refusal to apply any seat.
        return undefined
      } finally {
        agentNamesInFlight = undefined
      }
    })()
    return agentNamesInFlight
  }

  /**
   * Points a delegation at an employee's generated agent, if and only if that
   * agent really exists *and* the delegation is one a seat may replace.
   *
   * Every uncertainty returns without touching `args`: control off, no model
   * configured for this employee, a `subagent_type` outside
   * `NEUTRAL_AGENT_TYPES`, the host unreachable, the definition never
   * generated, or OpenCode not restarted since it was. Leaving
   * `subagent_type` alone costs the user their model preference for one task.
   * Getting it wrong costs them the task, or — worse, for a specialised agent
   * — costs them that agent's tool restrictions without saying so. Those are
   * not close.
   */
  const applySeatAgent = async (args, employeeId) => {
    if (!seatControl) return
    const spec = seatSpecs[employeeId]
    // A seat with no model has nothing to apply — OpenCode honours a variant
    // only alongside an agent's own model, so no file was generated either.
    if (!spec || typeof spec.model !== "string" || spec.model.length === 0) return
    // Rewrite whichever spelling the host used, and never introduce one it did
    // not: a key the host does not read is at best noise.
    const key =
      typeof args.subagent_type === "string"
        ? "subagent_type"
        : typeof args.subagentType === "string"
          ? "subagentType"
          : undefined
    if (!key) return
    // Compared exactly, not case-folded or trimmed. The host resolves
    // `subagent_type` by exact lookup too, so a value this misses is one the
    // host was going to reject anyway — normalising here would only let
    // Observer act on a delegation that was never going to run.
    if (!NEUTRAL_AGENT_TYPES.has(args[key])) return
    const name = seatAgentName(employeeId)
    const agents = await knownAgents()
    if (!agents || !agents.has(name)) return
    args[key] = name
  }

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

  /** sessionID -> { root, agentKey, parentAgentKey, confirmed, at } */
  const sessions = new Map()
  /** messageID -> role */
  const roles = new Map()
  /**
   * Delegations that have not met their child session yet.
   *
   * Keyed by the normalised task description, valued by a FIFO queue so two
   * concurrent delegations sharing a description each keep their own seat.
   * Entries carry the tool `callID` when the host supplies one, which is what
   * lets the two writers (`tool.execute.before` and `message.part.updated`)
   * converge on one entry regardless of which fires first.
   *
   * key -> Array<{ callID, prompt, agentType, at }>
   */
  const pendingTasks = new Map()
  /** child sessionID -> the delegation it claimed, replayed on every session.updated */
  const staffedSessions = new Map()
  /** sessionID -> whether the user activated staffing with @observer */
  const activated = new Map()

  /** Drops expired and overflowing delegations. A missed join must not leak. */
  const prunePendingTasks = () => {
    const deadline = Date.now() - PENDING_TASK_TTL_MS
    let total = 0
    for (const [key, entries] of pendingTasks) {
      const live = entries.filter((entry) => entry.at >= deadline)
      if (live.length === 0) pendingTasks.delete(key)
      else {
        if (live.length !== entries.length) pendingTasks.set(key, live)
        total += live.length
      }
    }
    // Still over the cap after expiry: evict oldest-first.
    while (total > MAX_PENDING_TASKS) {
      const oldest = pendingTasks.keys().next()
      if (oldest.done) break
      total -= (pendingTasks.get(oldest.value) ?? []).length
      pendingTasks.delete(oldest.value)
    }
  }

  /**
   * Records what we know about a delegation, merging rather than replacing.
   *
   * Both writers are additive: a field already decided (notably the seated
   * employee) is never overwritten, so hook ordering does not matter. The tool
   * `callID` is what pairs the two writers up; `authoritative: false` marks the
   * backfilling writer, which must not open a second entry when it cannot tell
   * one delegation from another.
   */
  const recordDelegation = (description, callID, patch, authoritative = true) => {
    const key = taskKey(description)
    if (!key) return
    const entries = pendingTasks.get(key) ?? []
    const existing = callID ? entries.find((entry) => entry.callID === callID) : undefined
    if (existing) {
      if (patch.prompt !== undefined && existing.prompt === undefined) existing.prompt = patch.prompt
      if (patch.agentType !== undefined && existing.agentType === undefined) existing.agentType = patch.agentType
      return
    }
    // A backfill with no call id to tell delegations apart is the same
    // streaming part arriving again, not a second delegation.
    if (!authoritative && !callID && entries.length > 0) return
    entries.push({ callID, prompt: patch.prompt, agentType: patch.agentType, at: Date.now() })
    pendingTasks.set(key, entries)
    prunePendingTasks()
  }

  /**
   * Claims the delegation behind a child session, FIFO within a description.
   * The claim is remembered per session: `session.updated` fires repeatedly and
   * must keep re-sending the decision, otherwise the adapter's `"subagent"`
   * default overwrites the seated employee on the next update.
   */
  const claimDelegation = (sessionID, title) => {
    const held = staffedSessions.get(sessionID)
    if (held) return held
    for (const key of titleKeys(title)) {
      const entries = pendingTasks.get(key)
      if (!entries || entries.length === 0) continue
      const claimed = entries.shift()
      if (entries.length === 0) pendingTasks.delete(key)
      if (staffedSessions.size >= MAX_STAFFED_SESSIONS) {
        const oldest = staffedSessions.keys().next()
        if (!oldest.done) staffedSessions.delete(oldest.value)
      }
      staffedSessions.set(sessionID, claimed)
      return claimed
    }
    return undefined
  }

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

  /**
   * The node a resolved parent should be drawn as.
   *
   * A parent we failed to identify is still a session, so it keeps its own node
   * key rather than collapsing onto the root agent — that collapse is what
   * flattens a subagent-of-a-subagent onto the root and loses the nesting.
   */
  const parentKeyOf = (parent, parentID) => {
    if (parent && (parent.confirmed || parent.agentKey !== MAIN_AGENT_KEY)) return parent.agentKey
    return `session:${parentID}`
  }

  /** Resolves which Observer session and agent node a raw OpenCode session maps to. */
  const resolve = async (sessionID, depth = 0) => {
    if (!sessionID) return undefined
    const cached = sessions.get(sessionID)
    // An unconfirmed entry is a guess made while the host was unreachable; it is
    // cached only to keep the hot path cheap, and re-checked once it goes stale.
    if (cached && (cached.confirmed || Date.now() - cached.at < UNKNOWN_SESSION_RETRY_MS)) return cached
    if (depth >= MAX_SESSION_DEPTH) return cached
    let info
    try {
      const response = await client.session.get({ path: { id: sessionID } })
      info = response?.data ?? response
    } catch {
      info = undefined
    }
    if (!info) {
      const provisional = {
        root: sessionID,
        agentKey: MAIN_AGENT_KEY,
        parentAgentKey: undefined,
        confirmed: false,
        at: Date.now(),
      }
      sessions.set(sessionID, provisional)
      return provisional
    }
    const parentID = info && typeof info.parentID === "string" && info.parentID.length > 0 ? info.parentID : undefined
    let entry
    if (parentID) {
      const parent = await resolve(parentID, depth + 1)
      entry = {
        root: parent ? parent.root : parentID,
        agentKey: `session:${sessionID}`,
        parentAgentKey: parentKeyOf(parent, parentID),
        confirmed: true,
        at: Date.now(),
      }
    } else {
      entry = {
        root: sessionID,
        agentKey: MAIN_AGENT_KEY,
        parentAgentKey: undefined,
        confirmed: true,
        at: Date.now(),
      }
    }
    sessions.set(sessionID, entry)
    return entry
  }

  /**
   * Whether the user activated staffing for this session's tree.
   *
   * `@observer` is typed once, in the root agent's session, but the activation
   * governs every subagent underneath it — including a subagent spawning its
   * own subagent. Resolving to the root is what carries it down.
   */
  const isActivated = async (sessionID) => {
    if (!sessionID) return undefined
    if (activated.has(sessionID)) return activated.get(sessionID)
    const target = await resolve(sessionID)
    const root = target?.root
    if (root && root !== sessionID && activated.has(root)) return activated.get(root)
    return undefined
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
              parentAgentKey: parentKeyOf(parent, info.parentID),
              confirmed: true,
              at: Date.now(),
            })
          } else if (!sessions.get(info.id)?.confirmed) {
            sessions.set(info.id, {
              root: info.id,
              agentKey: MAIN_AGENT_KEY,
              parentAgentKey: undefined,
              confirmed: true,
              at: Date.now(),
            })
          }
          // The title only carries a delegation for a child session, and it is
          // replayed on every update: the adapter's "subagent" default would
          // otherwise overwrite the seated employee on the next one.
          const staffed =
            typeof info.parentID === "string" && info.parentID.length > 0
              ? claimDelegation(info.id, info.title)
              : undefined
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
            // Backfill only. `tool.execute.before` is the authoritative writer —
            // it is the one that knows the seat — but it returns early when
            // staffing is off, so this is the only path that carries the prompt
            // then. It must never open a duplicate or overwrite a decision.
            recordDelegation(
              part.state.input.description,
              part.callID ?? part.id,
              { prompt: part.state.input.prompt },
              false,
            )
          }
          // A finished `task` call is the one deterministic statement that a
          // delegation ran to its end: it ends visibly in the parent's own
          // message stream, while the host's `session.idle` for the child
          // session is not guaranteed. Report the fact to the child's node so
          // the canvas can state it as finished even when that idle never comes.
          if (part.type === "tool" && part.tool === "task") {
            try {
              const status =
                part.state?.status === "completed"
                  ? "completed"
                  : part.state?.status === "error"
                    ? "failed"
                    : undefined
              // Only terminal states report; streaming updates stay silent.
              if (status) {
                // The join reads the same key the backfill writer recorded.
                // A claim without any callID — the backfill path cannot always
                // know it — simply never matches: joining on anything fuzzier
                // could finish the wrong subagent.
                const callID = part.callID ?? part.id
                for (const [childSessionID, claim] of staffedSessions) {
                  if (!claim.callID || claim.statusReported || claim.callID !== callID) continue
                  // One report per delegation: hosts re-send finished parts.
                  claim.statusReported = true
                  await forward("observer.agent-status", { status }, childSessionID)
                  break
                }
              }
            } catch {
              // Telemetry is best-effort; it never breaks the host session.
            }
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
      // Manual activation. Recorded only: the instruction reaches the model
      // through the system prompt on this same turn, because the host composes
      // the system prompt after this hook. Appending a part here instead would
      // abort the turn — see the note at the top of the file.
      const mention = observerMention(text)
      if (mention) activated.set(sessionID, mention !== "off")
    },

    /**
     * Read-only capture of the composed system prompt, then roster guidance:
     * the root agent is briefed on who is on the team so it can pick the
     * right subagent for each task.
     *
     * A manual @observer decision outranks the config in both directions: it
     * briefs even when guidance is disabled, and stays silent after
     * `@observer off` even when guidance is enabled. `undefined` means the
     * user never said, so the config decides.
     */
    async "experimental.chat.system.transform"(input, output) {
      if (!input?.sessionID || !Array.isArray(output?.system)) return
      await forward("observer.system", { system: output.system.slice(0, 12) }, input.sessionID)
      const manual = await isActivated(input.sessionID)
      if (manual === false) return
      if (!guidanceEnabled && !manual) return
      const text = await loadBriefing()
      if (!text) return
      output.system.push(text)
      if (manual) {
        output.system.push(
          "The user activated Observer staffing with @observer: look for chances to delegate to subagents and seat them from the roster.",
        )
      }
    },

    /**
     * Staffs every delegated task. The chosen employee — or "subcontractor"
     * when nobody fits — is recorded so the child node carries the decision
     * as its type, and the prompt gains a persona directive so the subagent
     * knows how to behave before its first token.
     */
    async "tool.execute.before"(input, output) {
      const tool = String(input?.tool ?? "").toLowerCase()
      if (tool !== "task") return
      const args = output?.args
      if (!args || typeof args.prompt !== "string" || args.prompt.length === 0) return
      // Activation is checked against the session tree's root, not the raw
      // session: `@observer` is typed once but governs every subagent below it,
      // including a subagent that spawns its own. An explicit `@observer off`
      // outranks globally enabled guidance, the same way it does for the brief.
      const manual = await isActivated(input?.sessionID)
      if (manual === false) return
      if (!guidanceEnabled && !manual) return
      const callID = input?.callID ?? input?.callId ?? input?.id
      try {
        // A delegation to the @observer agent is the activation ack, not work:
        // the node keeps its own type instead of wearing an employee persona.
        //
        // OpenCode spells this parameter `subagent_type`; `subagentType` never
        // existed, so this branch had never run and every @observer activation
        // was seated as an employee. Both spellings are read anyway: the
        // fallback is one `??`, and the cost of guessing wrong again is a
        // silent behaviour change rather than a visible error.
        const subagentType = args.subagent_type ?? args.subagentType
        if (typeof subagentType === "string" && subagentType.toLowerCase() === "observer") {
          recordDelegation(args.description, callID, { prompt: args.prompt, agentType: "observer" })
          return
        }
        const seat = await seatFor(args.prompt)
        recordDelegation(args.description, callID, {
          prompt: args.prompt,
          agentType: seat ? seat.id : "subcontractor",
        })
        if (seat?.directive) {
          args.prompt = `${args.prompt}\n\n---\nObserver staffing note:\n${seat.directive}`
        }
        // The directive above is the persona's only home. It is deliberately
        // not baked into the generated agent file: it is built per task by the
        // daemon (and carries the seat's configured skills), it has to reach
        // employees who have no generated file at all, and it must survive the
        // fallback below when the file is missing. Putting it in both places
        // would brief the subagent twice; putting it only in the file would
        // lose the persona exactly when seat control quietly declines.
        if (seat) await applySeatAgent(args, seat.id)
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
