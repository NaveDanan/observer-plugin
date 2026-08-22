import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, extname, join, normalize, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify"
import websocket from "@fastify/websocket"
import { HOST_CAPABILITIES, HostId, IngestBatch, PROTOCOL_VERSION } from "@observer-ai/protocol"
import type { AgentDetail, SessionSnapshot } from "@observer-ai/protocol"
import { behaviorDirective, ROSTER, rankEmployees } from "@observer-ai/roster"
import type { Store } from "@observer-ai/storage"
import { z } from "zod"
import type { ObserverConfig } from "./config.js"
import type { Pipeline } from "./pipeline.js"
import type { Diagnostics } from "./diagnostics.js"
import { applySeatSkills } from "./seats.js"
import { Broadcaster } from "./broadcaster.js"

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

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
}

export interface ServerOptions {
  store: Store
  pipeline: Pipeline
  config: ObserverConfig
  broadcaster: Broadcaster
  diagnostics: Diagnostics
  webDir?: string
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
  // Path traversal guard: never serve anything outside the built UI.
  const inside = candidate === resolve(webDir) || candidate.startsWith(`${resolve(webDir)}/`)
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
