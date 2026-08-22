import type {
  AgentDetail,
  Change,
  HostCapabilities,
  SessionEntity,
  SessionSnapshot,
  StoredEvent,
} from "@observer-ai/protocol"
import type { RosterProfile } from "@observer-ai/roster"

export interface Bootstrap {
  token: string
  cursor: number
  protocol: number
  hosts: HostCapabilities[]
  capture: Record<string, boolean>
  retentionDays: number
  redaction: { enabled: boolean; maxTextLength: number }
}

let token = ""

export function setToken(value: string): void {
  token = value
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status}`)
  return (await response.json()) as T
}

export async function bootstrap(): Promise<Bootstrap> {
  const result = await request<Bootstrap>("/v1/bootstrap")
  setToken(result.token)
  return result
}

export function listSessions(): Promise<{ sessions: SessionEntity[] }> {
  return request("/v1/sessions?limit=50")
}

export function getSnapshot(sessionId: string): Promise<SessionSnapshot> {
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}`)
}

export function getAgentDetail(agentId: string): Promise<AgentDetail> {
  return request(`/v1/agents/${encodeURIComponent(agentId)}`)
}

export function getRoster(): Promise<{ profiles: RosterProfile[] }> {
  return request("/v1/roster")
}

export function getRawEvents(sessionId: string): Promise<{ events: StoredEvent[] }> {
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}/events`)
}

export function deleteSession(sessionId: string): Promise<{ ok: boolean }> {
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" })
}

export interface DeliveryDiagnostics {
  accepted: number
  counters: Record<string, number>
  faults: number
  lastAcceptedByHost: Record<string, number>
  recent: Array<{ at: number; host: string; event: string; reason: string; detail?: string; payloadKeys: string[] }>
}

export function getDiagnostics(): Promise<DeliveryDiagnostics> {
  return request("/v1/diagnostics")
}

/* ---------------------------------------------------------------- settings */

/**
 * The daemon's config, as the settings surfaces see it.
 *
 * These types mirror `apps/daemon/src/config.ts` rather than importing them:
 * the daemon package pulls in fastify and node builtins, and the browser needs
 * the shapes, not the code. The daemon is the authority — every one of these
 * fields is re-validated there before it reaches disk.
 */
export interface CaptureConfig {
  messages: boolean
  reasoning: boolean
  toolInput: boolean
  toolOutput: boolean
  prompts: boolean
  rawEvents: boolean
}

export interface SeatSkill {
  name: string
  description: string
}

/** One employee's desired model, reasoning effort and skills. */
export interface SeatSpec {
  model?: string
  variant?: string
  skills?: SeatSkill[]
  [extra: string]: unknown
}

export interface SeatsConfig {
  control: boolean
  employees: Record<string, SeatSpec>
}

export type SeatIssueSeverity = "error" | "warning" | "info"

export interface SeatIssue {
  code: string
  severity: SeatIssueSeverity
  path: string
  employeeId?: string
  message: string
}

export interface SeatDiagnosis {
  ok: boolean
  effective: boolean
  issues: SeatIssue[]
}

/** A provider the plugin has access to. `driver` names the host adapter. */
export interface ProviderInstanceConfig {
  driver: string
  displayName?: string
  accentColor?: string
  enabled: boolean
}

export interface ObserverConfigView {
  capture: CaptureConfig
  retentionDays: number
  redaction: { enabled: boolean; maxTextLength: number }
  guidance: boolean
  seats: SeatsConfig
  providers: Record<string, ProviderInstanceConfig>
  diagnosis: SeatDiagnosis
}

export type ConfigPatch = Partial<Omit<ObserverConfigView, "diagnosis">>

export function getConfig(): Promise<ObserverConfigView> {
  return request("/v1/config")
}

export function updateConfig(patch: ConfigPatch): Promise<ObserverConfigView> {
  return request("/v1/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  })
}

/**
 * What Observer knows about a model's reasoning efforts. Three states, never
 * two: "takes no effort" and "we could not tell" are different answers.
 */
export type ModelVariants = { kind: "efforts"; values: string[] } | { kind: "none" } | { kind: "unknown" }

export interface ModelInfo {
  /** `providerID/modelID`, exactly as a seat spec stores it. */
  id: string
  provider: string
  providerLabel: string
  label: string
  contextWindow?: number
  variants: ModelVariants
  releaseDate?: string
  known: boolean
}

export interface ModelCatalogue {
  count: number
  models: ModelInfo[]
  sources?: Record<string, unknown>
}

export function getModels(probe = false): Promise<ModelCatalogue> {
  return request(`/v1/models?probe=${probe ? "true" : "false"}`)
}

export interface ProviderHostStatus {
  id: string
  label: string
  notes: string[]
  sessions: number
  lastActiveAt: number | null
  configured: boolean
  enabledInstances: number
}

export function getProviderStatus(): Promise<{ hosts: ProviderHostStatus[] }> {
  return request("/v1/providers/status")
}

export function streamUrl(cursor: number): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}/v1/stream?token=${encodeURIComponent(token)}&cursor=${cursor}`
}

export type { Change }
