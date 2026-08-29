import { createHash, randomUUID } from "node:crypto"

interface SubagentLimits {
  maxDepth: number
  maxPerSession: number
}

const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = { maxDepth: 2, maxPerSession: 15 }
const MAX_CONFIGURED_SUBAGENT_DEPTH = 32
const MAX_CONFIGURED_SUBAGENTS_PER_SESSION = 256

export type ControlledHost = "claude" | "codex" | "copilot"

export interface AdmissionConfig {
  port: number
  token: string
  subagentLimits?: Partial<SubagentLimits>
}

export interface AdmissionDecision {
  controlled: boolean
  allowed: boolean
  reason?: string
}

interface AssignmentReservation {
  id: string
  host: ControlledHost
  rootSessionKey: string
  runtimeId: null
  parentRuntimeId: string
  callId: string
  agentType: string
  hostAgentType: string
  description?: string
  prompt?: string
  status: "starting"
}

const REQUEST_TIMEOUT_MS = 1_500

/**
 * Reserves one durable creation slot before a host executes its spawn tool.
 * The daemon owns the count and parent walk, so parallel hook processes and
 * different hosts cannot each enforce a divergent local approximation.
 */
export async function admitSubagent(
  host: ControlledHost,
  payload: unknown,
  config: AdmissionConfig,
): Promise<AdmissionDecision> {
  const reservation = reservationFrom(host, payload)
  if (!reservation) return { controlled: false, allowed: true }

  const limits = readLimits(config.subagentLimits)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/v1/coordination/assignments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(reservation),
      signal: controller.signal,
    })
    if (response.ok) return { controlled: true, allowed: true }
    const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined
    const reason = typeof body?.error === "string" ? sentence(body.error) : `Observer rejected subagent creation (${response.status}).`
    return { controlled: true, allowed: false, reason }
  } catch {
    return {
      controlled: true,
      allowed: false,
      reason: `Observer could not verify the configured subagent limits (${limits.maxDepth} levels, ${limits.maxPerSession} per session), so creation was blocked.`,
    }
  } finally {
    clearTimeout(timer)
  }
}

export function readLimits(value: Partial<SubagentLimits> | undefined): SubagentLimits {
  return {
    maxDepth: bounded(value?.maxDepth, 0, MAX_CONFIGURED_SUBAGENT_DEPTH, DEFAULT_SUBAGENT_LIMITS.maxDepth),
    maxPerSession: bounded(
      value?.maxPerSession,
      0,
      MAX_CONFIGURED_SUBAGENTS_PER_SESSION,
      DEFAULT_SUBAGENT_LIMITS.maxPerSession,
    ),
  }
}

function reservationFrom(host: ControlledHost, payload: unknown): AssignmentReservation | undefined {
  if (!isRecord(payload)) return undefined
  const tool = normalizedTool(payload[host === "copilot" ? "toolName" : "tool_name"])
  if (!isSpawnTool(host, tool)) return undefined

  const rootSessionKey = text(payload[host === "copilot" ? "sessionId" : "session_id"])
  if (!rootSessionKey) return undefined
  const input = toolInput(payload[host === "copilot" ? "toolArgs" : "tool_input"])
  if (!input) return undefined

  const explicitCallId = text(
    payload["tool_use_id"] ?? payload["toolUseId"] ?? payload["toolCallId"] ?? payload["callId"],
  )
  const timestamp = payload["timestamp"]
  const callId =
    explicitCallId ??
    (typeof timestamp === "string" || typeof timestamp === "number"
      ? `hook:${digest(`${String(timestamp)}:${JSON.stringify(input)}`)}`
      : `hook:${randomUUID()}`)
  const parentRuntimeId = text(payload["agent_id"] ?? payload["agentId"]) ?? rootSessionKey
  const agentType = text(input["agent_type"] ?? input["subagent_type"] ?? input["agentType"] ?? input["role"]) ?? "subagent"
  const description = text(input["description"] ?? input["name"] ?? input["task_name"])
  const prompt = text(input["prompt"] ?? input["message"] ?? input["task"])
  return {
    id: `hook:${host}:${digest(`${rootSessionKey}:${callId}`)}`,
    host,
    rootSessionKey,
    runtimeId: null,
    parentRuntimeId,
    callId,
    agentType,
    hostAgentType: agentType,
    ...(description ? { description } : {}),
    ...(prompt ? { prompt } : {}),
    status: "starting",
  }
}

function isSpawnTool(host: ControlledHost, tool: string): boolean {
  if (host === "copilot") return tool === "task" || tool === "agent"
  if (host === "claude") return tool === "agent" || tool === "task"
  return tool === "agent" || tool === "spawnagent" || tool === "collaborationspawnagent"
}

function toolInput(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value
  if (typeof value !== "string") return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function normalizedTool(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/g, "") : ""
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function sentence(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return "Observer rejected subagent creation."
  return `${trimmed[0]!.toUpperCase()}${trimmed.slice(1)}${/[.!?]$/.test(trimmed) ? "" : "."}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
