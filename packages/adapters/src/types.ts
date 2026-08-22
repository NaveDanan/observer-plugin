import { createHash } from "node:crypto"
import type { EventBody, HostId, IngestEvent, Provenance } from "@observer-ai/protocol"

/** One hook delivery, exactly as forwarded by `observer-emit` or a host plugin. */
export interface HookRequest {
  host: HostId
  /** Host-native event name, e.g. `PreToolUse`, `postToolUse`, `message.part.updated`. */
  event: string
  payload: unknown
  /** Unique per delivery; used to derive idempotent event ids. */
  deliveryId: string
  workspaceRoot?: string
  hostVersion?: string
  /** Set when the emitter could not parse the payload as JSON. */
  payloadError?: string
  /** Extra context a rich plugin can supply (OpenCode). */
  context?: Record<string, unknown>
}

/** Partial event produced by an adapter; the daemon fills in the rest. */
export interface AdapterEvent {
  sessionKey: string
  agentKey?: string
  at?: number
  provenance?: Provenance
  body: EventBody
}

export interface Adapter {
  host: HostId
  adapterId: string
  normalize(request: HookRequest): AdapterEvent[]
  /**
   * Whether this delivery is one the adapter recognises and deliberately draws
   * nothing for.
   *
   * `normalize` returning an empty list is ambiguous: it means either "I have
   * no use for this" or "I failed to translate this". The first is normal
   * operation and must stay silent; the second is the signal that the host
   * gained something Observer should start drawing, and is worth showing a
   * user. Only the adapter knows which of the two it just did, so it says so
   * here rather than leaving the daemon to guess from an empty array.
   *
   * Answer from an allowlist of known-uninteresting deliveries, never a
   * denylist, or a genuinely new host event will be silently swallowed.
   */
  ignores?(request: HookRequest): boolean
}

// ------------------------------------------------------------------ helpers

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function pickString(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

export function pickNumber(source: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string" && value.length > 0) {
      const parsed = Date.parse(value)
      if (Number.isFinite(parsed)) return parsed
      const numeric = Number(value)
      if (Number.isFinite(numeric)) return numeric
    }
  }
  return undefined
}

export function pickBoolean(source: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "boolean") return value
  }
  return undefined
}

/** Stable short hash, used to synthesise ids for hosts that do not provide them. */
export function shortHash(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null)
  return createHash("sha1").update(text).digest("hex").slice(0, 12)
}

export function toText(value: unknown, limit = 20_000): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value.slice(0, limit)
  try {
    return JSON.stringify(value).slice(0, limit)
  } catch {
    return String(value).slice(0, limit)
  }
}
