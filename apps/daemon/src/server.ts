import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, extname, join, normalize, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify"
import websocket from "@fastify/websocket"
import { AgentStatus, HOST_CAPABILITIES, HostId, IngestBatch, MAIN_AGENT_KEY, PROTOCOL_VERSION } from "@observer-ai/protocol"
import type { AgentAssignment, AgentDetail, AgentMail, SessionSnapshot } from "@observer-ai/protocol"
import { behaviorDirective, ROSTER, rankEmployees } from "@observer-ai/roster"
import type { Store } from "@observer-ai/storage"
import { z } from "zod"
import { ConfigPatchSchema, loadConfig, saveConfig } from "./config.js"
import type { ObserverConfig } from "./config.js"
import type { Pipeline } from "./pipeline.js"
import type { Diagnostics } from "./diagnostics.js"
import { applySeatSkills, diagnoseSeats } from "./seats.js"
import { Broadcaster } from "./broadcaster.js"
import { describeCatalogue, listModels } from "./models.js"
import { seatAdapters } from "./adapters/index.js"
import { subagentAdmissionError } from "./subagent-limits.js"
import type { HostCapabilities as SeatHostCapabilities, HostProfile, HostSeatAdapter, ModelCatalogue } from "./adapters/index.js"

const HookRequestSchema = z.object({
  host: HostId,
  event: z.string().min(1),
  payload: z.unknown(),
  deliveryId: z.string().min(1),
  workspaceRoot: z.string().optional(),
  hostVersion: z.string().optional(),
  payloadError: z.string().optional(),
  context: z.record(z.unknown()).optional(),
})

const AssignmentSchema = z.object({
  id: z.string().min(1).max(200),
  host: HostId,
  rootSessionKey: z.string().min(1).max(500),
  runtimeId: z.string().min(1).max(500).nullable().optional(),
  parentRuntimeId: z.string().min(1).max(500),
  callId: z.string().min(1).max(500).nullable().optional(),
  agentType: z.string().min(1).max(200),
  hostAgentType: z.string().min(1).max(200),
  description: z.string().max(20_000).nullable().optional(),
  prompt: z.string().max(64_000).nullable().optional(),
  status: AgentStatus.default("starting"),
  resumed: z.boolean().optional(),
})

const AgentMailSchema = z.object({
  id: z.string().min(1).max(200),
  host: HostId,
  rootSessionKey: z.string().min(1).max(500),
  fromRuntimeId: z.string().min(1).max(500),
  toRuntimeId: z.string().min(1).max(500),
  text: z.string().min(1).max(32_000),
})

const MAIL_RATE_LIMIT = 30
const INBOX_PAGE_BYTES = 64 * 1024
/** A pasted screenshot is well under this; anything above is not a transcript. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".gltf": "model/gltf+json",
  ".glb": "model/gltf-binary",
  ".bin": "application/octet-stream",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
}

/** Raster formats only: an SVG served inline is a script that runs as Observer. */
const INLINE_ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"])

/** Header-safe and directory-free: the name is host-supplied, the header is ours. */
function attachmentFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "attachment"
  const safe = base.replace(/[^\w.\- ]+/g, "_").slice(0, 100)
  return safe.length > 0 ? safe : "attachment"
}

export interface ServerOptions {
  store: Store
  pipeline: Pipeline
  config: ObserverConfig
  broadcaster: Broadcaster
  diagnostics: Diagnostics
  webDir?: string
  /**
   * The host adapters `/v1/hosts` enumerates. Defaults to the shipped registry.
   *
   * Injected so a test can exercise the endpoints against a host that is
   * missing, slow or broken without installing (or spawning) a real CLI.
   * Nothing in a test run should ever launch `codex` or `claude`, and nothing
   * does.
   */
  adapters?: readonly HostSeatAdapter[]
}

/**
 * Locates the built UI.
 *
 * Observer runs from two different layouts: the monorepo during development
 * and a flat published package after `npm i -g`. Both are probed rather than
 * assumed, so a release never silently serves a 503.
 */
export function defaultWebDir(): string {
  const override = process.env["OBSERVER_WEB_DIR"]
  if (override) return override
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(here, "../web"), // published package: dist/../web
    resolve(here, "../../web/dist"), // monorepo: apps/daemon/dist -> apps/web/dist
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return candidate
  }
  return candidates[0] as string
}

export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
  const { store, pipeline, config, broadcaster, diagnostics } = options
  const webDir = options.webDir ?? defaultWebDir()
  /**
   * Host lookup for the two `/v1/hosts` routes.
   *
   * A `Map` and not an object literal: the key arrives from a URL path
   * segment, and `{}["toString"]` is a function. Same reasoning as the
   * registry's `Object.hasOwn` guard one layer down, and the reason
   * `/v1/hosts/constructor/models` is a 404 rather than a 500.
   *
   * Built once at boot. `seatAdapters()` constructs adapters; constructing one
   * spawns nothing, so this costs a `$HOME` read and no subprocess.
   */
  const adapterByHost = new Map<string, HostSeatAdapter>()
  for (const adapter of options.adapters ?? seatAdapters()) {
    if (!adapter || typeof adapter.kind !== "string" || adapter.kind.length === 0) continue
    if (!adapterByHost.has(adapter.kind)) adapterByHost.set(adapter.kind, adapter)
  }
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 })
  await app.register(websocket)

  /**
   * Blocks DNS rebinding: a malicious page resolving its own hostname to
   * 127.0.0.1 would otherwise reach the daemon from the browser.
   */
  app.addHook("onRequest", async (request, reply) => {
    const host = (request.headers.host ?? "").split(":")[0]
    const allowed = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1"
    if (!allowed) {
      await reply.code(403).send({ error: "forbidden host" })
    }
  })

  const authorize = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const header = request.headers.authorization ?? ""
    const query = (request.query as Record<string, unknown> | undefined)?.["token"]
    const token = header.startsWith("Bearer ") ? header.slice(7) : typeof query === "string" ? query : ""
    if (token !== config.token) {
      void reply.code(401).send({ error: "unauthorized" })
      return false
    }
    return true
  }

  app.get("/health", async () => ({
    ok: true,
    protocol: PROTOCOL_VERSION,
    cursor: broadcaster.cursor,
    events: store.countEvents(),
    accepted: diagnostics.snapshot(0).accepted,
    faults: diagnostics.faults,
  }))

  /**
   * Why deliveries did not become events.
   *
   * Hooks must never fail a session, so failures are swallowed at every layer.
   * This is the one place that says what was thrown away and why.
   */
  app.get("/v1/diagnostics", async (request, reply) => {
    if (!authorize(request, reply)) return
    return reply.send(diagnostics.snapshot())
  })

  app.get("/v1/config", async (request, reply) => {
    if (!authorize(request, reply)) return
    return reply.send(configPayload(config))
  })

  app.put("/v1/config", async (request, reply) => {
    if (!authorize(request, reply)) return
    const parsed = ConfigPatchSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "invalid config patch" })

    const previous = {
      capture: config.capture,
      retentionDays: config.retentionDays,
      redaction: config.redaction,
      guidance: config.guidance,
      passAllSkills: config.passAllSkills,
      subagentLimits: config.subagentLimits,
      seats: config.seats,
      providers: config.providers,
    }
    try {
      if (parsed.data.capture !== undefined) config.capture = parsed.data.capture
      if (parsed.data.retentionDays !== undefined) {
        config.retentionDays = parsed.data.retentionDays
        store.setRetentionDays(parsed.data.retentionDays)
      }
      if (parsed.data.redaction !== undefined) config.redaction = parsed.data.redaction
      if (parsed.data.guidance !== undefined) config.guidance = parsed.data.guidance
      if (parsed.data.passAllSkills !== undefined) config.passAllSkills = parsed.data.passAllSkills
      if (parsed.data.subagentLimits !== undefined) config.subagentLimits = parsed.data.subagentLimits
      if (parsed.data.seats !== undefined) config.seats = parsed.data.seats
      if (parsed.data.providers !== undefined) config.providers = parsed.data.providers
      // Merge the patch into a fresh disk read. The TUI may have written
      // another declared field or a forward-compatible key since this daemon
      // started, and a live limit update must not replace either with the
      // daemon's older in-memory copy.
      const persisted = loadConfig()
      if (parsed.data.capture !== undefined) persisted.capture = parsed.data.capture
      if (parsed.data.retentionDays !== undefined) persisted.retentionDays = parsed.data.retentionDays
      if (parsed.data.redaction !== undefined) persisted.redaction = parsed.data.redaction
      if (parsed.data.guidance !== undefined) persisted.guidance = parsed.data.guidance
      if (parsed.data.passAllSkills !== undefined) persisted.passAllSkills = parsed.data.passAllSkills
      if (parsed.data.subagentLimits !== undefined) persisted.subagentLimits = parsed.data.subagentLimits
      if (parsed.data.seats !== undefined) persisted.seats = parsed.data.seats
      if (parsed.data.providers !== undefined) persisted.providers = parsed.data.providers
      saveConfig(persisted)
    } catch (error) {
      config.capture = previous.capture
      config.retentionDays = previous.retentionDays
      config.redaction = previous.redaction
      config.guidance = previous.guidance
      config.passAllSkills = previous.passAllSkills
      config.subagentLimits = previous.subagentLimits
      config.seats = previous.seats
      config.providers = previous.providers
      store.setRetentionDays(previous.retentionDays)
      throw error
    }

    return reply.send(configPayload(config))
  })

  app.get("/v1/models", async (request, reply) => {
    if (!authorize(request, reply)) return
    const parsed = z
      .object({ probe: z.enum(["true", "false"]).optional() })
      .safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: "invalid models query" })
    const models = listModels({ probeHost: parsed.data.probe === "true" })
    return reply.send({
      sources: describeCatalogue(models),
      count: models.length,
      models: models.map((model) => ({
        id: model.id,
        provider: model.provider,
        providerLabel: model.providerLabel,
        label: model.label,
        contextWindow: model.contextWindow,
        variants: model.variants,
        releaseDate: model.releaseDate,
        known: model.known,
      })),
    })
  })

  app.get("/v1/providers/status", async (request, reply) => {
    if (!authorize(request, reply)) return
    const sessions = store.listSessions({ limit: 500 })
    const configured = Object.entries(config.providers).filter(
      ([, instance]) => typeof instance.driver === "string" && instance.driver.length > 0,
    )
    const ids = Object.keys(HOST_CAPABILITIES)
    for (const [, instance] of configured) {
      if (!ids.includes(instance.driver)) ids.push(instance.driver)
    }

    return reply.send({
      hosts: ids.map((id) => {
        const capability = HOST_CAPABILITIES[id as keyof typeof HOST_CAPABILITIES]
        const instances = configured.filter(([, instance]) => instance.driver === id)
        const hostSessions = sessions.filter((session) => session.host === id)
        const lastActiveAt = hostSessions.reduce<number | null>(
          (latest, session) => (latest === null ? session.updatedAt : Math.max(latest, session.updatedAt)),
          null,
        )
        return {
          id,
          label: capability?.label ?? instances[0]?.[1].displayName ?? id,
          notes: capability?.notes ?? [],
          sessions: hostSessions.length,
          lastActiveAt,
          configured: instances.length > 0,
          enabledInstances: instances.filter(([, instance]) => instance.enabled).length,
        }
      }),
    })
  })

  /**
   * Every host Observer has an adapter for, with what it can actually do.
   *
   * Deliberately spawn-free. `profiles()` and `capabilities()` read the
   * environment and return; the one call that can launch a CLI is
   * `catalogue()`, and it lives on the route below. So the first paint of a
   * host picker never waits on a subprocess, and a developer laptop with no
   * Codex installed pays nothing to find that out.
   *
   * Distinct from `/v1/providers/status`, which answers "which hosts have sent
   * us telemetry". This one answers "which hosts can Observer configure, and
   * how honestly" — the control fields a seat editor must not overclaim.
   */
  app.get("/v1/hosts", async (request, reply) => {
    if (!authorize(request, reply)) return
    return reply.send({ hosts: [...adapterByHost.values()].map(hostSummary) })
  })

  /**
   * One host's model catalogue, with the option descriptors a picker renders.
   *
   * The only route in the daemon that can start a process, so it is the only
   * one that needs a containment story:
   *
   *  - one host per request, never a fan-out, so a missing CLI cannot delay a
   *    host that is present;
   *  - every adapter call wrapped, so a throw becomes an empty list plus a
   *    sentence rather than a 500;
   *  - the adapters own their own timeouts (Codex a whole-probe budget, Claude
   *    a 4s `--version`), and a blown budget comes back as a warning attached
   *    to a real, if partial, answer.
   *
   * An unregistered host is a 404. A registered host whose binary is absent is
   * a 200 with no models and a warning — that is a normal state on a machine
   * where the user only installed one of these tools, not an error.
   */
  app.get<{ Params: { host: string } }>("/v1/hosts/:host/models", async (request, reply) => {
    if (!authorize(request, reply)) return
    const parsed = z.object({ profile: z.string().max(200).optional() }).safeParse(request.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: "invalid host models query" })
    const adapter = adapterByHost.get(request.params.host)
    if (!adapter) return reply.code(404).send({ error: "unknown host" })
    // An empty `?profile=` is "unspecified", not a bad request: a picker with
    // nothing selected yet should get the default profile's list, not a 400.
    const requested = parsed.data.profile?.trim()
    return reply.send(hostCatalogue(adapter, requested !== undefined && requested.length > 0 ? requested : undefined))
  })

  /**
   * Hands the local UI its token. Safe because the daemon binds to loopback,
   * the Host header is validated above, and no CORS headers are ever sent, so
   * another origin cannot read this response.
   */
  app.get("/v1/bootstrap", async () => ({
    token: config.token,
    cursor: broadcaster.cursor,
    protocol: PROTOCOL_VERSION,
    hosts: Object.values(HOST_CAPABILITIES),
    capture: config.capture,
    retentionDays: config.retentionDays,
    redaction: config.redaction,
  }))

  app.post("/v1/hook", async (request, reply) => {
    if (!authorize(request, reply)) return
    const parsed = HookRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "invalid hook request" })
    const result = pipeline.ingestHook({ ...parsed.data, payload: parsed.data.payload ?? {} })
    return reply.send(result)
  })

  /**
   * Batch variant used by the OpenCode plugin, which forwards token-level
   * deltas and would otherwise issue one request per token.
   */
  app.post("/v1/hooks", async (request, reply) => {
    if (!authorize(request, reply)) return
    const parsed = z.object({ deliveries: z.array(HookRequestSchema).min(1).max(500) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "invalid hook batch" })
    const total = { accepted: 0, duplicates: 0, rejected: 0 }
    for (const delivery of parsed.data.deliveries) {
      const result = pipeline.ingestHook({ ...delivery, payload: delivery.payload ?? {} })
      total.accepted += result.accepted
      total.duplicates += result.duplicates
      total.rejected += result.rejected
    }
    return reply.send(total)
  })

  app.post("/v1/ingest", async (request, reply) => {
    if (!authorize(request, reply)) return
    const parsed = IngestBatch.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "invalid ingest batch" })
    return reply.send(pipeline.ingestEvents(parsed.data.events))
  })

  app.get("/v1/sessions", async (request, reply) => {
    if (!authorize(request, reply)) return
    const query = request.query as Record<string, string | undefined>
    const host = query["host"] ? HostId.safeParse(query["host"]) : undefined
    return reply.send({
      sessions: store.listSessions({
        limit: query["limit"] ? Number(query["limit"]) : 50,
        host: host?.success ? host.data : undefined,
        active: query["active"] === "true",
      }),
    })
  })

  app.get<{ Params: { id: string } }>("/v1/sessions/:id", async (request, reply) => {
    if (!authorize(request, reply)) return
    const session = store.getSession(request.params.id)
    if (!session) return reply.code(404).send({ error: "not found" })
    const snapshot: SessionSnapshot = {
      session,
      agents: store.listAgents(session.id),
      edges: store.listEdges(session.id),
      todos: store.listSessionTodos(session.id),
      counts: store.countsByAgent(session.id),
      runningTools: store.runningToolsByAgent(session.id),
    }
    return reply.send(snapshot)
  })

  app.get<{ Params: { id: string } }>("/v1/sessions/:id/events", async (request, reply) => {
    if (!authorize(request, reply)) return
    return reply.send({ events: store.listRawEvents(request.params.id, 200) })
  })

  app.delete<{ Params: { id: string } }>("/v1/sessions/:id", async (request, reply) => {
    if (!authorize(request, reply)) return
    store.deleteSession(request.params.id)
    return reply.send({ ok: true })
  })

  app.get<{ Params: { id: string } }>("/v1/agents/:id", async (request, reply) => {
    if (!authorize(request, reply)) return
    const agent = store.getAgent(decodeURIComponent(request.params.id))
    if (!agent) return reply.code(404).send({ error: "not found" })
    const detail: AgentDetail = {
      agent,
      messages: store.listMessages(agent.id),
      toolCalls: store.listToolCalls(agent.id),
      todos: store.listTodos(agent.id),
      promptFragments: store.listPromptFragments(agent.id),
    }
    return reply.send(detail)
  })

  /**
   * The bytes behind one message attachment.
   *
   * The browser addresses an attachment by the id Observer minted for it, never
   * by path: the daemon reads local files, and a path parameter would turn that
   * into an arbitrary-file-read endpoint sitting on localhost. An id that no
   * message references does not resolve, so the reachable set is exactly the
   * files some transcript already names.
   */
  app.get<{ Params: { id: string } }>("/v1/attachments/:id", async (request, reply) => {
    if (!authorize(request, reply)) return
    const attachment = store.getAttachment(decodeURIComponent(request.params.id))
    if (!attachment?.path) return reply.code(404).send({ error: "not found" })
    let size: number
    try {
      size = statSync(attachment.path).size
    } catch {
      // The host owns these files and may have cleaned them up. That is not a
      // fault, it is an attachment whose bytes are gone.
      return reply.code(410).send({ error: "gone" })
    }
    if (size > MAX_ATTACHMENT_BYTES) return reply.code(413).send({ error: "too large" })
    // Attachment bytes are arbitrary host-side files served from Observer's own
    // origin, so anything renderable as a document — SVG most of all — would run
    // script next to the token that fetched it. Only raster images the UI needs
    // inline keep their type; everything else is a download.
    const declared = attachment.mimeType ?? MIME[extname(attachment.path).toLowerCase()]
    const inline = declared && INLINE_ATTACHMENT_TYPES.has(declared)
    return reply
      .header("content-type", inline ? declared : "application/octet-stream")
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", inline ? "inline" : `attachment; filename="${attachmentFilename(attachment.name)}"`)
      .header("cache-control", "private, max-age=3600")
      .send(readFileSync(attachment.path))
  })

  /**
   * Durable subagent coordination. Runtime ids are host-owned resume tokens;
   * assignment ids correlate the parent tool call before that token exists.
   */
  app.post("/v1/coordination/assignments", async (request, reply) => {
    if (!authorize(request, reply)) return
    const parsed = AssignmentSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "invalid assignment" })
    const input = parsed.data
    const existing =
      (input.runtimeId ? store.getAgentAssignmentByRuntime(input.host, input.runtimeId) : undefined) ??
      (input.callId ? store.getAgentAssignmentByCall(input.host, input.rootSessionKey, input.callId) : undefined) ??
      store.getAgentAssignment(input.id)
    if (existing && existing.rootSessionKey !== input.rootSessionKey) {
      return reply.code(409).send({ error: "assignment belongs to another session" })
    }
    if (existing && existing.parentRuntimeId !== input.parentRuntimeId) {
      return reply.code(409).send({ error: "assignment parent cannot change" })
    }
    if (existing?.runtimeId && input.runtimeId && existing.runtimeId !== input.runtimeId) {
      return reply.code(409).send({ error: "assignment runtime id cannot change" })
    }
    if (input.runtimeId === input.rootSessionKey) {
      return reply.code(409).send({ error: "root session cannot be a subagent assignment" })
    }
    if (input.runtimeId && input.parentRuntimeId === input.runtimeId) {
      return reply.code(409).send({ error: "subagent cannot be its own parent" })
    }
    const at = Date.now()
    const capturedDescription =
      input.description === undefined ? (existing?.description ?? null) : pipeline.captureCoordinationPrompt(input.description)
    const capturedPrompt =
      input.prompt === undefined ? (existing?.prompt ?? null) : pipeline.captureCoordinationPrompt(input.prompt)
    const unchanged =
      existing &&
      existing.rootSessionKey === input.rootSessionKey &&
      existing.runtimeId === (input.runtimeId ?? existing.runtimeId) &&
      existing.parentRuntimeId === (input.parentRuntimeId ?? existing.parentRuntimeId) &&
      existing.callId === (input.callId ?? existing.callId) &&
      existing.agentType === input.agentType &&
      existing.hostAgentType === input.hostAgentType &&
      existing.description === capturedDescription &&
      existing.prompt === capturedPrompt &&
      existing.status === input.status
    const row: AgentAssignment = {
      id: existing?.id ?? input.id,
      host: input.host,
      rootSessionKey: input.rootSessionKey,
      runtimeId: input.runtimeId ?? existing?.runtimeId ?? null,
      parentRuntimeId: input.parentRuntimeId,
      callId: input.callId ?? existing?.callId ?? null,
      agentType: input.agentType,
      hostAgentType: input.hostAgentType,
      description: capturedDescription,
      prompt: capturedPrompt,
      status: input.status,
      createdAt: existing?.createdAt ?? at,
      updatedAt: unchanged ? existing.updatedAt : at,
    }
    if (
      existing &&
      ["completed", "failed", "interrupted"].includes(existing.status) &&
      !["completed", "failed", "interrupted"].includes(row.status) &&
      !(row.status === "running" && input.resumed === true)
    ) {
      row.status = existing.status
      row.updatedAt = existing.updatedAt
    }
    if (existing?.status === "running" && row.status === "starting") {
      row.status = "running"
      row.updatedAt = existing.updatedAt
    }
    if (!existing) {
      const assignments = store.listAgentAssignments(row.host, row.rootSessionKey)
      if (row.host === "opencode" && row.parentRuntimeId === row.rootSessionKey) {
        const coordinator = assignments.find((assignment) => assignment.parentRuntimeId === row.rootSessionKey)
        if (coordinator) {
          const detail = coordinator.runtimeId
            ? `root coordinator already exists (task_id ${coordinator.runtimeId}); resume it and use agent_spawn for additional workers`
            : "root coordinator is already being created; wait for its task_id, then resume it and use agent_spawn for additional workers"
          return reply.code(409).send({ error: detail })
        }
      }
      const admissionError = subagentAdmissionError(assignments, row, config.subagentLimits)
      if (admissionError) return reply.code(409).send({ error: admissionError })
      const activeChildren = assignments.filter(
        (assignment) => assignment.parentRuntimeId === row.parentRuntimeId && ["starting", "running"].includes(assignment.status),
      )
      if (activeChildren.length >= 16) return reply.code(409).send({ error: "subagent fan-out limit reached" })
    }
    store.putAgentAssignment(row)
    if (row.runtimeId) {
      const runtimeBound = existing?.runtimeId !== row.runtimeId
      const body = runtimeBound
        ? {
            kind: "agent.started" as const,
            agentType: row.agentType,
            runtimeId: row.runtimeId,
            parentAgentKey:
              row.parentRuntimeId === row.rootSessionKey
                ? MAIN_AGENT_KEY
                : runtimeAgentKey(row.host, row.parentRuntimeId),
            description: row.description ?? undefined,
            prompt: row.prompt ?? undefined,
          }
        : existing?.status !== row.status
          ? ({ kind: "agent.status" as const, status: row.status })
          : undefined
      if (body) {
        pipeline.ingestEvents([
          {
            id: `assignment:${row.id}:${body.kind}:${row.status}:${row.updatedAt}`,
            host: row.host,
            adapter: "observer-coordination@1",
            workspaceRoot: workspaceRootFor(store, row.host, row.rootSessionKey),
            sessionKey: row.rootSessionKey,
            agentKey: runtimeAgentKey(row.host, row.runtimeId),
            at: row.updatedAt,
            provenance: "authoritative",
            body,
          },
        ])
      }
    }
    return reply.send({ assignment: row })
  })

  app.get("/v1/coordination/assignments", async (request, reply) => {
    if (!authorize(request, reply)) return
    const parsed = z
      .object({
        host: HostId,
        assignmentId: z.string().min(1).optional(),
        rootSessionKey: z.string().min(1).optional(),
        runtimeId: z.string().min(1).optional(),
        callId: z.string().min(1).optional(),
      })
      .safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: "invalid assignment query" })
    if (parsed.data.assignmentId) {
      const assignment = store.getAgentAssignment(parsed.data.assignmentId)
      if (!assignment || assignment.host !== parsed.data.host) {
        return reply.code(404).send({ error: "assignment not found" })
      }
      return reply.send({ assignment: publicAssignment(assignment) })
    }
    if (parsed.data.runtimeId) {
      const assignment = store.getAgentAssignmentByRuntime(parsed.data.host, parsed.data.runtimeId)
      if (!assignment || (parsed.data.rootSessionKey && assignment.rootSessionKey !== parsed.data.rootSessionKey)) {
        return reply.code(404).send({ error: "assignment not found" })
      }
      return reply.send({ assignment: publicAssignment(assignment) })
    }
    if (parsed.data.callId && parsed.data.rootSessionKey) {
      const assignment = store.getAgentAssignmentByCall(parsed.data.host, parsed.data.rootSessionKey, parsed.data.callId)
      if (!assignment) return reply.code(404).send({ error: "assignment not found" })
      return reply.send({ assignment: publicAssignment(assignment) })
    }
    if (!parsed.data.rootSessionKey) return reply.code(400).send({ error: "rootSessionKey is required" })
    return reply.send({
      assignments: store.listAgentAssignments(parsed.data.host, parsed.data.rootSessionKey).map(publicAssignment),
    })
  })

  app.post("/v1/coordination/mail", async (request, reply) => {
    if (!authorize(request, reply)) return
    const parsed = AgentMailSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "invalid agent message" })
    const input = parsed.data
    const sender = store.getAgentAssignmentByRuntime(input.host, input.fromRuntimeId)
    const recipient = store.getAgentAssignmentByRuntime(input.host, input.toRuntimeId)
    if (
      !sender ||
      !recipient ||
      sender.rootSessionKey !== input.rootSessionKey ||
      recipient.rootSessionKey !== input.rootSessionKey
    ) {
      return reply.code(404).send({ error: "agent address not found in this session" })
    }
    const at = Date.now()
    if (store.countRecentAgentMail(input.host, input.rootSessionKey, input.fromRuntimeId, at - 60_000) >= MAIL_RATE_LIMIT) {
      return reply.code(429).send({ error: "direct message rate limit reached" })
    }
    if (store.countRecentAgentMailTo(input.host, input.rootSessionKey, input.toRuntimeId, at - 60_000) >= MAIL_RATE_LIMIT) {
      return reply.code(429).send({ error: "direct message recipient rate limit reached" })
    }
    const capturedText = pipeline.captureCoordinationMessage(input.text)
    const mail: AgentMail = {
      id: input.id,
      host: input.host,
      rootSessionKey: input.rootSessionKey,
      fromRuntimeId: input.fromRuntimeId,
      toRuntimeId: input.toRuntimeId,
      text: capturedText ?? "",
      createdAt: at,
      deliveredAt: null,
      readAt: capturedText === null ? at : null,
    }
    if (!store.putAgentMail(mail)) {
      return reply.code(409).send({ error: "message id already exists" })
    }
    pipeline.ingestEvents([
      {
        id: `coordination:${mail.id}`,
        host: input.host,
        adapter: "observer-coordination@1",
        workspaceRoot: workspaceRootFor(store, input.host, input.rootSessionKey),
        sessionKey: input.rootSessionKey,
        agentKey: runtimeAgentKey(input.host, input.fromRuntimeId),
        at: mail.createdAt,
        provenance: "authoritative",
        body: {
          kind: "edge.observed",
          fromAgentKey: runtimeAgentKey(input.host, input.fromRuntimeId),
          toAgentKey: runtimeAgentKey(input.host, input.toRuntimeId),
          edgeType: "messaged",
          label: "direct message",
        },
      },
    ])
    return reply.send({ mail, retained: capturedText !== null })
  })

  app.get("/v1/coordination/mail", async (request, reply) => {
    if (!authorize(request, reply)) return
    const parsed = z
      .object({ host: HostId, rootSessionKey: z.string().min(1), runtimeId: z.string().min(1) })
      .safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: "invalid inbox query" })
    const assignment = store.getAgentAssignmentByRuntime(parsed.data.host, parsed.data.runtimeId)
    if (!assignment || assignment.rootSessionKey !== parsed.data.rootSessionKey) {
      return reply.code(404).send({ error: "agent address not found in this session" })
    }
    const messages: AgentMail[] = []
    let bytes = 0
    for (const message of store.listUnreadAgentMail(parsed.data.host, parsed.data.rootSessionKey, parsed.data.runtimeId, 100)) {
      const size = Buffer.byteLength(JSON.stringify(message), "utf8")
      if (messages.length > 0 && bytes + size > INBOX_PAGE_BYTES) break
      messages.push(message)
      bytes += size
    }
    return reply.send({ messages, hasMore: store.listUnreadAgentMail(parsed.data.host, parsed.data.rootSessionKey, parsed.data.runtimeId, messages.length + 1).length > messages.length })
  })

  app.post("/v1/coordination/mail/read", async (request, reply) => {
    if (!authorize(request, reply)) return
    const parsed = z
      .object({
        host: HostId,
        rootSessionKey: z.string().min(1),
        runtimeId: z.string().min(1),
        ids: z.array(z.string().min(1)).max(100),
      })
      .safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "invalid inbox acknowledgement" })
    const assignment = store.getAgentAssignmentByRuntime(parsed.data.host, parsed.data.runtimeId)
    if (!assignment || assignment.rootSessionKey !== parsed.data.rootSessionKey) {
      return reply.code(404).send({ error: "agent address not found in this session" })
    }
    store.markAgentMailRead(parsed.data.ids, parsed.data.runtimeId)
    return reply.send({ ok: true })
  })

  app.post<{ Params: { id: string } }>("/v1/coordination/mail/:id/delivered", async (request, reply) => {
    if (!authorize(request, reply)) return
    const parsed = z
      .object({ host: HostId, rootSessionKey: z.string().min(1), runtimeId: z.string().min(1) })
      .safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "invalid delivery acknowledgement" })
    const assignment = store.getAgentAssignmentByRuntime(parsed.data.host, parsed.data.runtimeId)
    if (!assignment || assignment.rootSessionKey !== parsed.data.rootSessionKey) {
      return reply.code(404).send({ error: "agent address not found in this session" })
    }
    store.markAgentMailDelivered(decodeURIComponent(request.params.id), parsed.data.runtimeId)
    return reply.send({ ok: true })
  })

  /**
   * The employee roster and the task matcher behind it.
   *
   * The UI renders these profiles on nodes and worker cards; the OpenCode
   * plugin calls /match to seat the right persona on a delegated task and
   * receives a ready-to-append behaviour directive.
   */
  app.get("/v1/roster", async (request, reply) => {
    if (!authorize(request, reply)) return
    return reply.send({ profiles: ROSTER })
  })

  app.post("/v1/roster/match", async (request, reply) => {
    if (!authorize(request, reply)) return
    const parsed = z
      .object({ task: z.string().max(20_000), limit: z.number().int().min(1).max(14).optional() })
      .safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "invalid match request" })
    const matches = rankEmployees(parsed.data.task, parsed.data.limit ?? 3)
    return reply.send({
      matches: matches.map((match) => ({
        id: match.profile.id,
        fullName: match.profile.fullName,
        title: match.profile.title,
        score: match.score,
        reasons: match.reasons,
        // Configured skills are folded in here, at match time, so the
        // directive the plugin appends already carries them. The roster
        // package stays config-free and the plugin needs no change.
        directive: behaviorDirective(applySeatSkills(match.profile, config.seats), parsed.data.task),
      })),
    })
  })

  app.get("/v1/stream", { websocket: true }, (socket, request) => {
    const query = request.query as Record<string, string | undefined>
    if (query["token"] !== config.token) {
      socket.close(4401, "unauthorized")
      return
    }
    const client = {
      send: (data: string) => socket.send(data),
      close: () => socket.close(),
    }
    broadcaster.add(client)
    const requested = Number(query["cursor"] ?? "0")
    const replayed = Number.isFinite(requested) && requested > 0 ? broadcaster.replay(client, requested) : true
    socket.send(
      JSON.stringify({
        type: replayed ? "hello" : "resync",
        cursor: broadcaster.cursor,
        hosts: Object.keys(HOST_CAPABILITIES),
      }),
    )
    socket.on("close", () => broadcaster.remove(client))
    socket.on("error", () => broadcaster.remove(client))
  })

  // Static UI, served last so API routes always win.
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/v1/") || request.url.startsWith("/health")) {
      return reply.code(404).send({ error: "not found" })
    }
    return serveStatic(webDir, request.url, reply)
  })

  return app
}

function serveStatic(webDir: string, url: string, reply: FastifyReply): FastifyReply {
  if (!existsSync(webDir)) {
    return reply
      .code(503)
      .type("text/plain; charset=utf-8")
      .send("Observer UI is not built. Run `pnpm build` (or `pnpm --filter @observer-ai/web build`).")
  }
  const requested = decodeURIComponent((url.split("?")[0] ?? "/").replace(/^\/+/, ""))
  const candidate = resolve(webDir, normalize(requested))
  // Path traversal guard: never serve anything outside the built UI. The
  // separator must be the platform's — on Windows `resolve` yields backslashes,
  // so a hardcoded "/" rejects every real asset and falls back to index.html,
  // which serves HTML in place of the JS bundle and renders a blank canvas.
  const inside = candidate === resolve(webDir) || candidate.startsWith(`${resolve(webDir)}${sep}`)
  const target = inside && requested.length > 0 && isFile(candidate) ? candidate : join(webDir, "index.html")
  if (!isFile(target)) return reply.code(404).type("text/plain").send("not found")
  const type = MIME[extname(target)] ?? "application/octet-stream"
  return reply.type(type).send(readFileSync(target))
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function runtimeAgentKey(host: HostId, runtimeId: string): string {
  return host === "opencode" ? `session:${runtimeId}` : `agent:${runtimeId}`
}

function workspaceRootFor(store: Store, host: HostId, rootSessionKey: string): string {
  return store.getSession(`${host}:${rootSessionKey}`)?.workspaceRoot ?? process.cwd()
}

function publicAssignment(row: AgentAssignment) {
  const { prompt: _prompt, callId: _callId, ...safe } = row
  return safe
}

function configPayload(config: ObserverConfig) {
  return {
    capture: config.capture,
    retentionDays: config.retentionDays,
    redaction: config.redaction,
    guidance: config.guidance,
    passAllSkills: config.passAllSkills,
    subagentLimits: config.subagentLimits,
    seats: config.seats,
    providers: config.providers,
    autostart: config.autostart,
    diagnosis: diagnoseSeats(config.seats),
  }
}

/* -------------------------------------------------------------------------- */
/* Host adapter surface                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Runs one adapter call, converting any throw into a fallback plus a sentence.
 *
 * The thrown value is never inspected and never reaches the response. An
 * adapter that dies mid-probe may be holding a path, an account name or a
 * fragment of a token in its error, and every one of these adapters is careful
 * not to read a credential in the first place — echoing `error.message` into a
 * JSON body would undo that from the outside. The caller supplies a fixed
 * sentence that is true of the failure and says nothing about its contents.
 */
function contain<T>(work: () => T, fallback: T, warnings: string[], warning: string): T {
  try {
    return work()
  } catch {
    warnings.push(warning)
    return fallback
  }
}

const UNAVAILABLE_CATALOGUE: ModelCatalogue = {
  models: [],
  source: "unavailable",
  freshness: "unknown",
  warnings: [],
}

/**
 * One host as `/v1/hosts` reports it.
 *
 * `capabilities` is nullable, and the null is load-bearing. `types.ts` draws a
 * hard line between "no adapter has claimed this host" and "an adapter looked
 * and the host cannot do it" — `unsupported` is a finding, not a default.
 * Substituting a conservative all-`unsupported` block for an adapter that
 * failed to answer would forge that finding, so the endpoint says null and
 * lets the UI render "unknown" instead of a claim nobody made.
 *
 * `capabilities(profileId)` is asked about the first profile, which is the one
 * a picker defaults to. No adapter varies its answer by profile today; the
 * parameter exists so one can later.
 */
function hostSummary(adapter: HostSeatAdapter) {
  const warnings: string[] = []
  const profiles = contain(
    () => adapter.profiles().map(publicProfile),
    [],
    warnings,
    "Observer could not list this host's profiles, so none are shown.",
  )
  const capabilities = contain<SeatHostCapabilities | null>(
    () => adapter.capabilities(profiles[0]?.id ?? ""),
    null,
    warnings,
    "Observer could not read what this host supports, so no control status is claimed for it.",
  )
  return {
    id: adapter.kind,
    label: adapter.label ?? adapter.kind,
    profiles,
    capabilities:
      capabilities === null
        ? null
        : {
            discovery: capabilities.discovery,
            childModel: capabilities.childModel,
            childReasoning: capabilities.childReasoning,
            requiresReload: capabilities.requiresReload,
          },
    warnings,
  }
}

/** One host's catalogue as `/v1/hosts/:host/models` reports it. */
function hostCatalogue(adapter: HostSeatAdapter, requested: string | undefined) {
  const warnings: string[] = []
  const profiles = contain(
    () => adapter.profiles(),
    [] as HostProfile[],
    warnings,
    "Observer could not list this host's profiles, so the default one was used.",
  )
  // An explicit `?profile=` wins so a two-account user can list either. Absent,
  // the first profile is the picker's default. Empty only when the adapter
  // could not enumerate anything — the adapters all treat an unknown profile id
  // as a warning plus their best available list, which is the right answer for
  // a config screen and better than a 404 on a host that is plainly installed.
  const profileId = requested ?? profiles[0]?.id ?? ""
  const catalogue = contain(
    () => adapter.catalogue(profileId),
    UNAVAILABLE_CATALOGUE,
    warnings,
    "Observer could not read this host's model list. The host may not be installed on this machine; type a model id instead.",
  )
  return {
    host: adapter.kind,
    label: adapter.label ?? adapter.kind,
    profile: profileId,
    models: catalogue.models.map((model) => ({
      id: model.id,
      label: model.label,
      contextWindow: model.contextWindow,
      available: model.available,
      options: (model.options ?? []).map((option) => ({
        id: option.id,
        label: option.label,
        type: option.type,
        choices: option.choices,
        currentValue: option.currentValue,
      })),
    })),
    source: catalogue.source,
    freshness: catalogue.freshness,
    // Containment warnings first: they say the answer below is degraded, and
    // the adapter's own warnings explain the rest.
    warnings: [...warnings, ...catalogue.warnings],
  }
}

/**
 * A profile as the wire carries it, field by field.
 *
 * Spelled out rather than spread so an adapter that later grows a private
 * field on `HostProfile` cannot publish it by accident. `binaryPath` and
 * `homePath` are paths the user configured and already visible in
 * `/v1/config`; neither is a secret, and both are what distinguishes two
 * profiles of the same host in a picker.
 */
function publicProfile(profile: HostProfile) {
  return {
    id: profile.id,
    host: profile.host,
    label: profile.label,
    binaryPath: profile.binaryPath,
    homePath: profile.homePath,
  }
}
