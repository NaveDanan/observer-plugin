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

export function streamUrl(cursor: number): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}/v1/stream?token=${encodeURIComponent(token)}&cursor=${cursor}`
}

export type { Change }
